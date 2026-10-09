"""给某个 edge 音色做一版更口语、更有起伏的参考音（本地克隆用）。

要点：
  1) 素材本身要**有起伏**——短句、问句、感叹、自然停顿，语气活泼；
     克隆是从参考音里学语气的，参考音平，出来的就平。
  2) 时长拉到 **45~60 秒**——越长，模型越能学到音色与韵律。
  3) 云端原生 **+15%** 录制（与设置页默认一致）；24 kHz 单声道。
     参考音必须 24 kHz（引擎原生采样率），16 kHz 会让克隆发闷。

用法：
  py gen_ref_lively.py [voice] [--out <目录或 wav 文件> ...]

默认落到**应用自己的 refs/**（与本脚本同级的 ../refs/<音色>.wav，随包发布）。
要把同一版参考音铺到自建 TTS 部署目录，就多写几个 --out：
  py gen_ref_lively.py zh-CN-XiaoxiaoNeural --out D:\\tts-local\\refs --out D:\\tts-local\\ref
  （--out 给目录时自动用 <音色>.wav；给 .wav 文件时原样使用）
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REF_DIR = os.path.normpath(os.path.join(HERE, "..", "refs"))

argv = sys.argv[1:]
voice = "zh-CN-XiaoxiaoNeural"
outs = []
i = 0
while i < len(argv):
    if argv[i] == "--out" and i + 1 < len(argv):
        outs.append(argv[i + 1])
        i += 2
        continue
    voice = argv[i]
    i += 1

VOICE = voice
REF_RATE = "+15%"


def short_name(voice_id):
    """zh-CN-XiaoxiaoNeural -> xiaoxiao"""
    v = voice_id.strip()
    for p in ("zh-CN-", "zh-TW-", "en-US-", "en-GB-"):
        if v.startswith(p):
            v = v[len(p):]
    if v.endswith("Neural"):
        v = v[: -len("Neural")]
    return v.lower()


# 有起伏的口语：短句 + 问句 + 感叹 + 自然停顿（换行只是可读性，合成前去掉）
TEXT = (
    "唷，来啦来啦！"
    "今天这点事儿，我早就给你记下了。"
    "先干什么呢？我想想……对了，先去把资料翻一遍。"
    "你别急啊，这活儿快得很。"
    "要是碰上卡壳的地方，我立马跟你说，绝不闷头瞎搞。"
    "等结果出来，我第一时间念给你听，数字一个不落。"
    "对了对了，还有个小提醒——记得喝水，别一坐半天。"
    "先说结论再讲过程，省得你听得犯欠。"
    "中间要是要改方向，我先停一下问一句，不乱撞。"
    "遇上慢的步骤，我会提前打声招呼，你忙你的去。"
    "东西做完了，我把结果念一遍，你要的就是这一下。"
    "哪句听得不舒服，随时说一声，我换个说法。"
    "好了，我去忙了，你该干嘛干嘛。"
    "有进展我吱一声，没动静就是一切顺利。"
    "等我好消息吧！"
).replace(" ", "").replace("\n", "")


def resolve_targets():
    name = short_name(VOICE) + ".wav"
    targets = [os.path.join(DEFAULT_REF_DIR, name)]
    for o in outs:
        targets.append(o if o.lower().endswith(".wav") else os.path.join(o, name))
    return targets


def main():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ffmpeg not found", file=sys.stderr)
        return 2
    tmp_mp3 = os.path.join(tempfile.gettempdir(), "voiceloop_ref_lively.mp3")
    tmp_wav = os.path.join(tempfile.gettempdir(), "voiceloop_ref_lively.wav")

    print(f"synth {VOICE} @ {REF_RATE}, {len(TEXT)} chars ...")
    asyncio.run(edge_tts.Communicate(TEXT, VOICE, rate=REF_RATE).save(tmp_mp3))
    if not (os.path.exists(tmp_mp3) and os.path.getsize(tmp_mp3) > 1024):
        print("edge synthesis failed", file=sys.stderr)
        return 2

    r = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", tmp_mp3,
         "-ar", "24000", "-ac", "1", tmp_wav],
        stderr=subprocess.PIPE,
    )
    if r.returncode != 0:
        print("ffmpeg failed: " + (r.stderr or b"").decode("utf-8", "replace")[-200:], file=sys.stderr)
        return 2

    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", tmp_wav],
                         stdout=subprocess.PIPE).stdout.decode().strip()
    print(f"generated {tmp_wav} ({os.path.getsize(tmp_wav)} bytes, {dur} s)")

    for t in resolve_targets():
        d = os.path.dirname(t)
        if d and not os.path.isdir(d):
            print(f"skip (no dir): {t}")
            continue
        if os.path.exists(t):
            shutil.copyfile(t, t + ".bak")
        shutil.copyfile(tmp_wav, t)
        print(f"-> {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
