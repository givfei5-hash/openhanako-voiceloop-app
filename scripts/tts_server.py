"""voiceloop local TTS API server — 把本地 llama-tts（Qwen3-TTS）包装成 OpenAI 兼容 TTS API。

端点:
  POST /v1/audio/speech   { model?, input, voice?, response_format?("mp3"|"wav"), speed?(0.5~2.0) }
  GET  /v1/models         模型发现（OpenAI SDK 兼容）
  GET  /health            { ok: true, engine: "ready"|"missing", ... }

协议与 OpenAI /v1/audio/speech 对齐：
  - 任意 OpenAI 兼容 TTS 客户端/网关都能直接接
  - voice 支持短键（yunxi / xiaoxiao ...）或完整 edge 名（zh-CN-YunxiNeural），
    映射到随包参考音 <refs>/<key>.wav；voice 为空 = 模型裸音色
  - speed 通过 ffmpeg atempo 烧进输出（1.0 不处理）

运行:
  py tts_server.py                          # 127.0.0.1:8137，引擎目录自动解析
  py tts_server.py --port 8137 --bridge-home D:\tts-local
  环境变量: TTS_BRIDGE_HOME（引擎目录，与 speak.py 同一约定）

单合成串行队列（防本机资源打满）；合成失败返回 500 + JSON 错误。
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "qwen3-tts-local"
SYNTH_TIMEOUT = 90

# ---------------------------------------------------------------- 引擎解析（与 speak.py 同约定）

def tts_local_home(override=None):
    override = override or os.environ.get("TTS_BRIDGE_HOME")
    if override:
        return os.path.abspath(override)
    # 自布局检测：脚本与引擎同目录部署（tts-local/）时直接用自身目录，无需任何环境变量
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.isdir(os.path.join(here, "llama")) and os.path.isdir(os.path.join(here, "models")):
        return here
    app_data = os.environ.get("LOCALAPPDATA")
    if app_data:
        return os.path.join(app_data, "openhanako-voiceloop-skill")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "openhanako-voiceloop-skill")


def _first_file(base, patterns):
    if not os.path.isdir(base):
        return None
    dirs = [base] + [os.path.join(base, e) for e in sorted(os.listdir(base))
                     if os.path.isdir(os.path.join(base, e))]
    for d in dirs:
        for pat in patterns:
            for rel in sorted(glob.iglob(os.path.join(d, pat))):
                if os.path.isfile(rel):
                    return rel
    return None


def resolve_engine(home):
    binp = None
    for name in ("llama-tts.exe", "llama-tts"):
        p = os.path.join(home, "llama", name)
        if os.path.exists(p):
            binp = p
            break
    if binp is None:
        binp = shutil.which("llama-tts")
    model = None
    mmproj = None
    for base in (os.path.join(home, "models"), os.path.join(home, "llama")):
        if model is None:
            model = _first_file(base, ["*Q4_K_M.gguf", "*-Q4_K_M.gguf", "llm-tts-*.gguf", "*.gguf"])
        if model and mmproj is None:
            mmproj = _first_file(os.path.dirname(model), ["mmproj*.gguf", "mmproj*.bin"])
    return {"home": home, "bin": binp, "model": model, "mmproj": mmproj}


def voice_key(voice):
    voice = (voice or "").strip()
    m = re.search(r"[-_ ]([A-Za-z0-9]+)Neural?$", voice, re.I)
    return (m.group(1) if m else voice).strip().lower()


# ---------------------------------------------------------------- 合成

class SynthError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_ref(refs_dir, voice, extra_refs=None):
    """voice -> 参考音路径。优先随包 refs/，其次 extra_refs（<bridgeHome>/ref/）。"""
    key = voice_key(voice)
    if not key:
        return None
    for d in ([refs_dir] + (extra_refs or [])):
        if not d:
            continue
        for ext in ("wav", "mp3"):
            p = os.path.join(d, key + "." + ext)
            if os.path.isfile(p):
                return p
    return None


def synthesize(text, voice, speed, fmt, refs_dir, extra_refs, eng, temperature=None):
    """返回 (bytes, content_type)。temperature 可由请求覆盖（调克隆相似度）。"""
    if not eng["bin"] or not eng["model"]:
        raise SynthError(500, "local engine not ready: llama-tts or GGUF model missing under "
                              + eng["home"])
    temp = temperature if temperature is not None else eng.get("temp", 0.4)
    ref = resolve_ref(refs_dir, voice, extra_refs)
    tmpdir = tempfile.gettempdir()
    out_wav = os.path.join(tmpdir, "voiceloop_api_%d.wav" % os.getpid())
    out_mp3 = os.path.join(tmpdir, "voiceloop_api_%d.mp3" % os.getpid())
    try:
        cmd = [eng["bin"], "-m", eng["model"], "-ngl", "99",
               "--tts-lang", "zh",
               "--temp", str(temp),
               "--top-k", str(eng.get("top_k", 20)),
               "--top-p", str(eng.get("top_p", 0.9)),
               "--repeat-penalty", "1.0",
               "-p", text, "-o", out_wav]
        if eng["mmproj"]:
            cmd += ["-mm", eng["mmproj"]]
        if ref:
            cmd += ["--tts-speaker-file", ref]
        try:
            subprocess.run(cmd, timeout=SYNTH_TIMEOUT, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            tail = (e.stderr or b"").decode("utf-8", "replace")[-300:]
            raise SynthError(500, "llama-tts failed: " + tail)
        except subprocess.TimeoutExpired:
            raise SynthError(504, "llama-tts timed out (>%ds)" % SYNTH_TIMEOUT)
        if not (os.path.exists(out_wav) and os.path.getsize(out_wav) > 1024):
            raise SynthError(500, "llama-tts produced no audio")
        # 读进内存，之后不再依赖文件留存
        with open(out_wav, "rb") as fh:
            wav = fh.read()
        if fmt == "wav":
            return wav, "audio/wav"

        # mp3（OpenAI 默认）：用 ffmpeg stdin 管道喂内存 wav，speed!=1.0 时 atempo 烧入
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise SynthError(500, "ffmpeg missing (winget install ffmpeg.ffmpeg)")
        fcmd = [ffmpeg, "-y", "-loglevel", "error", "-i", "pipe:0"]
        if speed and abs(speed - 1.0) > 0.01:
            fcmd += ["-af", "atempo=%.2f" % max(0.5, min(2.0, speed))]
        fcmd += ["-codec:a", "libmp3lame", "-qscale:a", "4", out_mp3]
        try:
            subprocess.run(fcmd, input=wav, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            raise SynthError(500, "mp3 conversion failed: "
                             + (e.stderr or b"").decode("utf-8", "replace")[-300:])
        if not (os.path.exists(out_mp3) and os.path.getsize(out_mp3) > 512):
            raise SynthError(500, "mp3 conversion produced no audio")
        with open(out_mp3, "rb") as fh:
            return fh.read(), "audio/mpeg"
    finally:
        for p in (out_wav, out_mp3):
            try:
                if os.path.exists(p):
                    os.unlink(p)
            except OSError:
                pass


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "voiceloop-tts/1.0"
    # handler 级状态由 main() 注入
    engine = None
    refs_dir = None
    extra_refs = None
    synth_lock = threading.Lock()

    def log_message(self, fmt, *args):
        sys.stderr.write("[tts-api] %s %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            eng = self.engine or {}
            self._send(200, {
                "ok": True,
                "engine": "ready" if (eng.get("bin") and eng.get("model")) else "missing",
                "home": eng.get("home"),
                "model": os.path.basename(eng.get("model") or ""),
                "refs": len(os.listdir(self.refs_dir)) if self.refs_dir and os.path.isdir(self.refs_dir) else 0,
            })
        elif path == "/v1/models":
            self._send(200, {
                "object": "list",
                "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}],
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/v1/audio/speech":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": {"message": "invalid JSON body", "type": "invalid_request_error"}})
            return
        text = str(body.get("input") or "").strip()
        if not text:
            self._send(400, {"error": {"message": "'input' is required", "type": "invalid_request_error"}})
            return
        voice = str(body.get("voice") or "").strip()
        fmt = str(body.get("response_format") or "mp3").lower()
        if fmt not in ("mp3", "wav"):
            self._send(400, {"error": {"message": "response_format must be mp3 or wav",
                                       "type": "invalid_request_error"}})
            return
        speed = body.get("speed")
        try:
            speed = float(speed) if speed is not None else 1.0
        except (TypeError, ValueError):
            speed = 1.0
        temperature = body.get("temperature")
        try:
            temperature = float(temperature) if temperature is not None else None
            if temperature is not None and not (0.05 <= temperature <= 1.5):
                temperature = None
        except (TypeError, ValueError):
            temperature = None
        t0 = time.time()
        with self.synth_lock:  # 串行合成，保护本机资源
            try:
                audio, ctype = synthesize(text, voice, speed, fmt,
                                          self.refs_dir, self.extra_refs, self.engine, temperature)
            except SynthError as e:
                self._send(e.code, {"error": {"message": e.message, "type": "server_error"}})
                return
            except Exception as e:  # 未预期错误也按 API 错误返回
                self._send(500, {"error": {"message": "internal: %s" % e.__class__.__name__,
                                           "type": "server_error"}})
                return
        self._send(200, audio, ctype)
        self.log_message("speech %dB %s voice=%r %.2fs",
                         len(audio), fmt, voice or "(raw)", time.time() - t0)


def main():
    parser = argparse.ArgumentParser(description="voiceloop local TTS API (OpenAI-compatible)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8137)
    parser.add_argument("--bridge-home", default=None, help="本地引擎目录（默认 TTS_BRIDGE_HOME/平台默认）")
    parser.add_argument("--refs", default=None, help="参考音目录（默认自动探测 ./refs 或 ../refs）")
    args = parser.parse_args()

    home = tts_local_home(args.bridge_home)
    eng = resolve_engine(home)
    extra_refs = [os.path.join(home, "ref")]
    # 参考音目录：显式 --refs > ./refs > ../refs（兼容 部署根目录/scripts/ 两种布局）
    refs = args.refs
    if refs == parser.get_default("refs"):
        cand = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs"),
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "refs")]
        refs = next((c for c in cand if os.path.isdir(c)), cand[0])
    Handler.engine = eng
    Handler.refs_dir = os.path.abspath(refs)
    Handler.extra_refs = extra_refs

    if not (eng["bin"] and eng["model"]):
        print("[tts-api] WARNING: local engine incomplete under %s (bin=%s model=%s); "
              "/health 会报 missing，合成请求将 500" % (home, eng["bin"], eng["model"]),
              file=sys.stderr)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("[tts-api] serving %s on http://%s:%d (engine home: %s)"
          % (MODEL_ID, args.host, args.port, home), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
