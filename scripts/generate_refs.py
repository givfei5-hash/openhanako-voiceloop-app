"""generate_refs.py — 一次性生成 voiceloop 随包参考音（6 个内置音色的克隆样本）。

用 edge-tts 各自合成一段中性自然语样本，转 16k 单声道 wav，存到 <app>/refs/<key>.wav。
这些参考音随应用打包；本地 llama-tts 兜底时按当前音色克隆，两路指向同一个人。

用法:
  py generate_refs.py                 # 生成全部 6 个到 ../refs/
  py generate_refs.py yunxi siqi      # 只生成指定几个
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REFS_DIR = os.path.join(HERE, "..", "refs")

# 与 speak.py 保持一致的中性样本（约 7s，语速平稳、无情绪、无噪声）
REF_TEXT = ("你好呀，我是你的小助手。今天状态不错，"
            "咱们一起把事情做好，慢慢来，不着急。")

# key -> edge-tts 声音名（全部为 edge-tts 真实存在的 zh-CN 音色，已用 --list-voices 核实）
VOICES = {
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",   # 晓晓 · 女（默认，温暖）
    "yunxi":    "zh-CN-YunxiNeural",      # 云希 · 男（阳光）
    "xiaoyi":   "zh-CN-XiaoyiNeural",     # 晓伊 · 女（活泼）
    "yunjian":  "zh-CN-YunjianNeural",    # 云健 · 男（激情/沉稳）
    "yunyang":  "zh-CN-YunyangNeural",    # 云扬 · 男（专业可靠）
    "yunxia":   "zh-CN-YunxiaNeural",     # 云夏 · 男（少年音）
}


def to_wav16k(mp3, wav):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg 未找到（winget install ffmpeg.ffmpeg）")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", mp3,
                    "-ar", "16000", "-ac", "1", wav], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


async def synth_one(edge, key, voice):
    out_mp3 = os.path.join(tempfile.gettempdir(), "voiceloop_ref_%s.mp3" % key)
    await edge.Communicate(REF_TEXT, voice, rate="+0%").save(out_mp3)
    wav = os.path.join(REFS_DIR, key + ".wav")
    to_wav16k(out_mp3, wav)
    os.unlink(out_mp3)
    kb = os.path.getsize(wav) / 1024
    print(f"  {key:<9} <- {voice:<22} {kb:6.1f} KB  -> {wav}")


def main():
    keys = [k.strip() for k in sys.argv[1:] if k.strip()] or list(VOICES)
    bad = [k for k in keys if k not in VOICES]
    if bad:
        raise SystemExit(f"未知音色: {bad}（可选: {list(VOICES)}）")
    os.makedirs(REFS_DIR, exist_ok=True)
    try:
        import edge_tts
    except ImportError:
        raise SystemExit("edge-tts 未安装（pip install edge-tts）")
    print(f"生成 {len(keys)} 个参考音 -> {os.path.abspath(REFS_DIR)}")
    async def run():
        for k in keys:
            await synth_one(edge_tts, k, VOICES[k])
    asyncio.run(run())
    print("完成。")


if __name__ == "__main__":
    main()
