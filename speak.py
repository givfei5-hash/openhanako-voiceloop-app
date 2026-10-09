"""voiceloop/speak.py — text -> natural speech, synthesized then played on the spot.

Engines (atomic, --engine picks one; the App orchestrates the chain):
  edge    -> edge-tts (built-in, cloud): Microsoft neural voices; ~1s to speech when online.
  api     -> OpenAI-compatible TTS endpoint (POST {base}/audio/speech): the deployment
             served by scripts/tts_server.py (default http://127.0.0.1:8137/v1),
             or any other standard TTS API (--local-base/--api-model/--api-key).
  --play FILE -> play an existing audio file (used by the App for Hana media-engine audio).

本地模型不走本文件直连。要本地出声，先把模型部成标准 OpenAI 兼容 API
（scripts/tts_server.py 已封装好这一层），应用用 --engine api 连它。
分发到不同用户时，链路就是「部好模型 → 露出 API → 设置页填 Base URL」。

The App's settings page picks the synthesis strategy (edge / edge-local / local) and the
non-edge source (Hana media engine via the SDK, or a self-configured OpenAI-compatible API);
tools/speak.js runs the engines in order and speaks the first success.

Usage:
  py speak.py "text to speak..."            positional args may be given multiple times
  py speak.py -v zh-CN-YunxiNeural "..."   pick a different edge-tts voice
  py speak.py -f result.md "append one line"  file content first, then positional text
  py speak.py -r +20 "..."                  rate adjust (bare +15 / -5 both work, % auto-appended)
  py speak.py --engine api --local-base http://127.0.0.1:8137/v1 "..."   OpenAI-compatible TTS API
  py speak.py --play out.mp3             play an existing file (no synthesis)
  py speak.py < notes.txt                    read from stdin when no positional text
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"  # Xiao: natural Chinese female voice
EDGE_TIMEOUT = 8      # per-call edge timeout (seconds); steady state is 1-2s
API_TIMEOUT = 30      # per-call custom API timeout (seconds)
EDGE_RATE = "+15%"    # unified speaking rate: +15% on edge, speed=1.15 on the API path
# 参考音是按这个倍速录的（见 tools/gen_refs.py）：克隆出来的声音天然就是 1.15 倍速，
# 所以 API 路径只需要补差（目标语速 / REF_RATE），差为 1 时不加 atempo——避免给音色染色。
REF_RATE = 1.15


CONFIG_NAME = "runtime-tts.json"


def load_runtime_config():
    """读取应用写在本目录的设置快照（runtime-tts.json）。没有就返回 {}。

    应用（index.js）把设置页的值同步成这个文件，CLI 就不需要自己猜策略。
    """
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), CONFIG_NAME)
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def voice_key(voice):
    """zh-CN-YunxiNeural -> yunxi. Unknown shapes pass through lowercased."""
    voice = (voice or "").strip()
    m = re.search(r"[-_ ]([A-Za-z0-9]+)Neural?$", voice, re.I)
    return (m.group(1) if m else voice).strip().lower()


# ------------------------------------------------------------ synthesis / playback

def synthesize_edge(text, voice, rate, out_path):
    """edge-tts synthesis (built-in primary, timeout-guarded). True = OK."""
    try:
        import asyncio
        import edge_tts
    except ImportError:
        print("[tts-bridge] edge-tts not installed (pip install edge-tts); trying next engine...",
              file=sys.stderr)
        return False

    async def _go():
        await edge_tts.Communicate(text, voice, rate=rate).save(out_path)

    try:
        asyncio.run(asyncio.wait_for(_go(), timeout=EDGE_TIMEOUT))
    except Exception as exc:
        print(f"[tts-bridge] edge-tts timed out / failed ({exc.__class__.__name__}); "
              f"trying next engine...", file=sys.stderr)
        return False
    return os.path.exists(out_path) and os.path.getsize(out_path) > 1024


def synthesize_api(text, cfg, out_path):
    """OpenAI-compatible TTS endpoint (POST {base}/audio/speech). True = OK.
    base 两种写法都认：带 /v1 结尾（http://host:port/v1）或裸根（http://host:port）。"""
    base = (cfg.get("base") or "").strip().rstrip("/")
    if not base:
        return False
    suffix = "/audio/speech" if base.lower().endswith("/v1") else "/v1/audio/speech"
    url = base + suffix
    body = {"input": text, "response_format": cfg.get("fmt") or "mp3"}
    if cfg.get("model"):
        body["model"] = cfg["model"]
    if cfg.get("voice"):
        body["voice"] = cfg["voice"]
    # 参考音按 REF_RATE 录，模型裸输出已是该速；这里只补到目标语速的差值
    try:
        pct = float((cfg.get("rate") or "+0%").rstrip("%")) / 100.0
        speed = round((1.0 + pct) / REF_RATE, 3)
        if abs(speed - 1.0) > 0.01:
            body["speed"] = speed
    except ValueError:
        pass
    headers = {"Content-Type": "application/json"}
    if cfg.get("key"):
        headers["Authorization"] = "Bearer " + cfg["key"]
    req = urllib.request.Request(url,
                                 data=json.dumps(body).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT) as r:
            data = r.read()
    except Exception as exc:
        detail = ""
        if hasattr(exc, "read"):
            try:
                detail = exc.read()[:300].decode("utf-8", "replace")
            except Exception:
                pass
        print(f"[tts-bridge] local TTS API failed ({exc.__class__.__name__} {url}) {detail}; "
              f"trying next engine...", file=sys.stderr)
        return False
    if len(data) > 1024:
        with open(out_path, "wb") as fh:
            fh.write(data)
        return True
    print("[tts-bridge] custom TTS API returned an empty body; trying next engine...",
          file=sys.stderr)
    return False


def play(path, player, tempo=None):
    """ffplay: -nodisp (no window), -autoexit (quit after playback), silent; blocks until done.

    返回 True = 播放器跑过了（音频已经放出来）。
    注意：ffplay 在某些环境会以非零码退出，但声音已经放了；以前把它当失败，
    调用方就会回退到下一个引擎——同一句于是被念两遍。这里只看“播放器有没有跑起来”。
    """
    cmd = [player, "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if tempo:
        cmd += ["-af", "atempo=%.2f" % tempo]
    cmd.append(path)
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return False
    if r.returncode != 0:
        print(f"[tts-bridge] note: player exit={r.returncode} (audio already played; not falling back)",
              file=sys.stderr)
    return True


def resolve_player():
    for name in ("ffplay", "ffmpeg"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _play_log(note, tempo, text, path):
    """每次真的开始播放都记一行，便于排查“同一句被念两遍”。"""
    try:
        import time
        line = ("%s pid=%d note=%s tempo=%s chars=%d text=%s\n"
                % (time.strftime("%H:%M:%S"), os.getpid(), note or "-", tempo or "-",
                   len(text or ""), (text or "")[:40].replace("\n", " ")))
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "speak.log"),
                  "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass


def play_and_exit(path, tempo=None, note=None, cleanup=True, text=""):
    """Play the file, then exit 0 (or 2/3 on failure).
    cleanup=False for files we don't own (--play mode, media-engine artifacts)."""
    _play_log(note, tempo, text, path)
    player = resolve_player()
    if player is None:
        print(f"[tts-bridge] synthesized {path} but no ffplay/ffmpeg found "
              f"(winget install ffmpeg.ffmpeg)", file=sys.stderr)
        sys.exit(3)
    ok = play(path, player, tempo)
    if cleanup:
        try:
            os.unlink(path)
        except OSError:
            pass
    if not ok:
        print(f"[tts-bridge] synthesized but playback failed: {path}", file=sys.stderr)
        sys.exit(2)
    if note:
        print(f"[tts-bridge] note: this line came from the {note}", file=sys.stderr)
    sys.exit(0)


# ---------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(
        description="Speak text aloud: edge-tts (cloud) or a self-configured "
                    "OpenAI-compatible TTS API.")
    parser.add_argument("text", nargs="*", help="text to speak (reads stdin when none given)")
    parser.add_argument("-v", "--voice", default=os.environ.get("VOICE", DEFAULT_VOICE),
                        help=f"voice name (default {DEFAULT_VOICE}; "
                             f"e.g. zh-CN-YunxiNeural for a male voice). Holds for edge-tts "
                             f"and is passed to the TTS API as a short key (yunxi, ...)")
    parser.add_argument("-r", "--rate", default=EDGE_RATE,
                        help="speaking rate; bare +10 / -5 accepted, %% auto-appended; default +15%% "
                             "maps to speed=1.15 on the API path")
    parser.add_argument("-f", "--file", default=None,
                        help="prepend this file's content (UTF-8) before the positional text")
    parser.add_argument("--engine", choices=["auto", "edge", "api"], default="auto",
                        help="edge: Edge TTS (cloud) / api: OpenAI-compatible TTS API / "
                             "auto（默认）: 按应用写下的设置（runtime-tts.json）自己选链路")
    parser.add_argument("--local-base", default=os.environ.get("TTS_LOCAL_BASE", "http://127.0.0.1:8137/v1"),
                        help="TTS API base URL (OpenAI-compatible; the packaged deployment "
                             "serves it on 127.0.0.1:8137 by default)")
    parser.add_argument("--api-model", default=os.environ.get("TTS_API_MODEL", ""),
                        help="model name for the TTS API (empty = server default)")
    parser.add_argument("--api-key", default=os.environ.get("TTS_API_KEY", ""),
                        help="API key sent as Bearer token (local deployment needs none)")
    parser.add_argument("--play", default=None, metavar="FILE",
                        help="play an existing audio file (skips synthesis); optional --tempo")
    parser.add_argument("--tempo", type=float, default=None,
                        help="playback speed for --play mode (e.g. 1.15)")
    parser.add_argument("--only-edge", action="store_true",
                        help="auto 模式下只走 edge（对应设置页「仅云端」策略）")
    parser.add_argument("--only-api", action="store_true",
                        help="auto 模式下只走自建 API（对应设置页「只用本地/自建 API」策略）")
    args = parser.parse_args()

    # auto 模式：应用写下的设置快照优先于默认值，但不覆盖显式传参
    runtime = load_runtime_config() if args.engine == "auto" else {}
    if runtime:
        if args.voice == DEFAULT_VOICE and runtime.get("voice"):
            args.voice = str(runtime["voice"])
        if args.rate == EDGE_RATE and runtime.get("rate"):
            args.rate = str(runtime["rate"])
        if args.local_base == os.environ.get("TTS_LOCAL_BASE", "http://127.0.0.1:8137/v1") \
                and runtime.get("apiBaseUrl"):
            args.local_base = str(runtime["apiBaseUrl"])
        if not args.api_model and runtime.get("apiModel"):
            args.api_model = str(runtime["apiModel"])
        if not args.api_key and runtime.get("apiKey"):
            args.api_key = str(runtime["apiKey"])

    local_base = (args.local_base or "").strip().rstrip("/")
    api_cfg = {
        "base": local_base,
        "key": args.api_key,
        "model": (args.api_model or "").strip(),
        "fmt": "mp3",
        "rate": args.rate,
    }

    # ---------- 0) play-only mode (app orchestration: hana media engine audio) ----------
    if args.play:
        if not os.path.exists(args.play):
            print(f"[tts-bridge] --play file not found: {args.play}", file=sys.stderr)
            sys.exit(2)
        play_and_exit(args.play, tempo=args.tempo, cleanup=False)  # 调用方的文件，播完不删

    # ---------- 1) assemble the text ----------
    chunks = [c.strip() for c in args.text if c and c.strip()]
    if args.file:
        try:
            with open(args.file, encoding="utf-8-sig") as fh:
                chunks.insert(0, fh.read().strip())
        except OSError as e:
            print(f"[tts-bridge] -f read failed: {e}", file=sys.stderr)
            sys.exit(1)
    if not chunks:
        if sys.stdin.isatty():
            parser.print_help()
            sys.exit(1)
        chunks = [(sys.stdin.read() or "").strip()]
    text = "".join(chunks).strip()
    if not text:
        print("[tts-bridge] nothing to speak", file=sys.stderr)
        sys.exit(1)

    # Normalize edge rate: bare +15 / -5 -> +15%; guarantee a leading sign (edge-tts 7.x strict)
    rate = (args.rate or "").strip()
    if rate and "%" not in rate:
        rate += "%"
    if rate == "0%":
        rate = "+0%"
    elif rate and rate[0] not in "+-":
        rate = "+" + rate

    # ---------- 2) 合成（auto = 应用设置快照决定的链路；也可 --engine 显式指定）----------
    tmp = tempfile.gettempdir()
    out_edge = os.path.join(tmp, "tts_bridge_%d.mp3" % os.getpid())
    out_api = os.path.join(tmp, "tts_bridge_%d_api.mp3" % os.getpid())

    def _speak_done(label, path):
        print(f"[voiceloop] 播报完成（{label}，{len(text)} 字）")
        play_and_exit(path, note=label, text=text)

    if args.engine == "auto":
        if args.only_edge:
            stages = ["edge"]
        elif args.only_api:
            stages = ["api"]
        else:
            st = str(runtime.get("strategy") or "edge-local").strip() or "edge-local"
            stages = []
            if st in ("edge", "edge-local"):
                stages.append("edge")
            if st != "edge":
                stages.append("api")
            if not stages:
                stages = ["api"]
    else:
        stages = [args.engine]

    for stage in stages:
        if stage == "edge":
            if synthesize_edge(text, args.voice, rate, out_edge):
                _speak_done("edge-tts 云端", out_edge)  # rate already baked in by edge
        else:
            # OpenAI 兼容 TTS API；voice 传短键（yunxi 等），服务端映射到参考音
            if synthesize_api(text, {**api_cfg, "rate": rate, "voice": voice_key(args.voice)}, out_api):
                _speak_done("自定义 TTS API", out_api)

    # ---------- 3) 全部链路失败 ----------
    print(f"[tts-bridge] engine failed ({'/'.join(stages)}).", file=sys.stderr)
    if "edge" in stages:
        print("  Check edge-tts: network/proxy, and `pip install edge-tts` in this Python.",
              file=sys.stderr)
    if "api" in stages:
        _api_hint = local_base + ("/audio/speech" if local_base.lower().endswith("/v1")
                                else "/v1/audio/speech")
        print(f"  TTS API: is {_api_hint} reachable? model/key correct? "
              f"(check GET /health for the local deployment)", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
