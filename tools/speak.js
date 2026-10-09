// Voiceloop 语音播报工具（v2 App 2.3.0，tools/speak.js）。
//
// 应用负责编排（设置页：合成策略 strategy + 非 edge 链路来源 ttsSource）：
//   edge       -> [edge]
//   edge-local -> [edge, source]   （默认）
//   local      -> [source]
// source：
//   hana   -> HanaAgent 内置媒体引擎（豆包 TTS 等，走 Hana 媒体总线，零配置）
//   custom -> 自配置 OpenAI 兼容 TTS API（apiBaseUrl / apiModel / apiKey）——
//             用户把本地模型（或任何第三方 TTS）部成标准 API，应用连它出声。
//             应用**不**直连本地模型进程：分发到不同用户时，链路就是「部好模型 → 露出 API → 应用连上」。
//
// 随包 speak.py 是原子引擎执行器（--engine edge|api / --play），不做回退；本地模型一律经 API。
//
// speak.py 约定：
//   - 无位置参数时从 stdin 读文本
//   - 退出码 0=播完；1=无文本/-f 读取失败；2=引擎失败或播放失败；3=缺 ffplay/ffmpeg
//   - 状态信息走 stderr，成功时 stdout 为空
//
// v2 App 进程需声明 app/process.spawn 才能 spawn 子进程（见 manifest）。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SPEAK_PY = join(CURRENT_DIR, "..", "speak.py");

const DEFAULTS = {
  python: "py",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+15",
  density: "standard",
  strategy: "edge-local",
  ttsSource: "custom",
  apiBaseUrl: "http://127.0.0.1:8137/v1",
  mediaVoice: "zh_female_qiaopinv_uranus_bigtts",
  style: "playful",
};

const DENSITY_LABELS = {  tight: "紧凑",
  standard: "标准",
  quiet: "安静",
};

const STYLE_LABELS = {
  playful: "俏皮",
  plain: "平实",
  gentle: "温柔",
  crisp: "干练",
};

function densityLabel(raw) {
  const d = String(raw ?? "").trim() || DEFAULTS.density;
  return DENSITY_LABELS[d] || "标准";
}

function styleLabel(raw) {
  const s = String(raw ?? "").trim() || DEFAULTS.style;
  return STYLE_LABELS[s] || "俏皮";
}

// edge 失败后的熔断窗口：这段时间内直接跳过它，避免每句都先白等 8 秒才切走。
let edgeDownUntil = 0;
const EDGE_COOLDOWN_MS = 5 * 60 * 1000;

export const name = "voiceloop_speak";
export const description =
  "把文字念出来（语音播报：开场 + 过程旁白的出口）。" +
  "分工：**开场和过程旁白由你说；收尾由应用自动播，你不用管**。" +
  "用法二选一，两条都过应用的档位闸与去重闸：① 直接调用本工具（text 传要念的字）；" +
  "② exec_command 跑 py \"$env:USERPROFILE\\.hanako\\apps\\voiceloop\\speak.py\" \"要念的字\"。" +
  "**本回合第一句无条件放行**（那就是开场：一句轻问候 + 这轮要干什么）；之后按设置页档位：紧凑每 1 个工具步一句 / 标准每 2 步 / 稀疏每 4 步 / 安静不播。" +
  "被拦是正常的（返回里写“还差 X 步”或“已播过”），继续原流程，不要重试。" +
  "合成链路按设置页执行：云端 Edge TTS 优先 / 只用本地自建 TTS API；非 edge 链路可选 HanaAgent 内置媒体引擎（豆包 TTS）或标准 OpenAI 兼容 TTS API。引擎切换对调用方透明。" +
  "本工具不在常规工具表里，先 tool_search 搜 voiceloop_speak 再调用。";
export const parameters = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "要播报的文字。用口语；长内容只念关键要点，全文在屏幕上",
    },
    voice: {
      type: "string",
      description: "可选：覆盖音色（云端声音名/本地参考音同一选项；媒体引擎用其默认音色）",
    },
    rate: {
      type: "string",
      description: "可选：覆盖语速，如 +20 / 0",
    },
  },
  required: ["text"],
};

function tail(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function engineLabel(stage) {
  if (stage === "edge") return "edge-tts 云端";
  if (stage === "hana") return "Hana 媒体引擎（豆包）";
  if (stage === "api") return "自定义 TTS API";
  return stage;
}

// "+15" -> 1.15；"-10" -> 0.9；"0" -> 1.0（媒体引擎 speed 用数字）
function rateToSpeed(rate) {
  const r = String(rate ?? "").trim().replace(/%$/, "");
  const n = r === "" ? 15 : parseFloat(r);
  if (!Number.isFinite(n)) return 1.15;
  return Math.round((1 + n / 100) * 100) / 100;
}

// ------------------------------------------------ speak.py 原子引擎

function runSpeakPy(python, args, text, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stderr = "";
    let stdout = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);
    try {
      child = spawn(python, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      });
    } catch (error) {
      finish({ code: -1, stderr: `Python 启动异常：${error.message}` });
      return;
    }
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => {
      finish({ code: -1, stderr: `Python 进程无法启动：${error.message}（检查 Python 命令设置，Windows 默认 py）` });
    });
    child.on("close", (exitCode) => {
      finish({ code: exitCode ?? -1, stderr, stdout, timedOut });
    });
    child.stdin.on("error", () => { /* EPIPE: 进程提前退出，close 会收尾 */ });
    child.stdin.write(text ?? "");
    child.stdin.end();
  });
}

// ------------------------------------------------ Hana 媒体引擎（豆包 TTS）

// 解析语音合成目标（provider + model）。
// ① 先用宿主默认（用户在 Hana 设置里配过的那个）；
// ② 没配默认时**自己发现**一个可用的语音合成供应商（例如豆包）。
//    接口选择是 2026-10-09 真机踩出来的：媒体供应商目录是 `provider:media-providers`
//    （与宿主自己的媒体目录同源，带 models[]）；`provider:models-by-type` 是**语言模型**
//    注册表，拿 speech_generation 去查永远为空，只能当退路。
async function resolveSpeechTarget(ctx) {
  const capability = "speech_generation";
  const diag = [];
  const pick = (providerId, models) => {
    const pid = String(providerId || "").trim();
    if (!pid) return null;
    for (const m of models || []) {
      const model = String(m?.id || m?.modelId || m?.defaultModelId || "").trim();
      if (model) return { provider: pid, model };
    }
    return null;
  };

  try {
    const r = await ctx.providers.resolveMediaModel({ capability });
    if (r && !r.error && r.providerId && r.modelId) {
      return { provider: String(r.providerId), model: String(r.modelId), diag: "默认已配" };
    }
    diag.push(`默认=${r?.error || "未配"}`);
  } catch (e) {
    diag.push(`默认查询异常=${e?.message || e}`);
  }

  // 媒体供应商目录：谁有凭证、各有几个模型
  try {
    const res = await ctx.providers.listMediaProviders?.({ capability });
    const entries = Object.entries(res?.providers || {});
    diag.push(`媒体目录=${entries.length} 个供应商`);
    for (const [pid, entry] of entries) {
      const models = Array.isArray(entry?.models) ? entry.models : [];
      diag.push(`${entry?.providerId || pid}:${models.length} 模型${entry?.unavailableReason ? "(" + entry.unavailableReason + ")" : ""}`);
      if (entry?.unavailableReason) continue;              // 没凭证的先跳过
      const hit = pick(entry?.providerId || pid, models);
      if (hit) return { ...hit, diag: diag.join("；") };
    }
  } catch (e) {
    diag.push(`媒体目录异常=${e?.message || e}`);
  }

  // 兵库：按类型查（对语音合成通常为空，只当退路）
  try {
    const list = await ctx.providers.listModelsByType?.({ type: capability });
    const models = Array.isArray(list?.models) ? list.models : [];
    diag.push(`按类型=${models.length} 模型`);
    for (const m of models) {
      const hit = pick(m?.providerId || m?.provider, [m]);
      if (hit) return { ...hit, diag: diag.join("；") };
    }
  } catch (e) {
    diag.push(`按类型异常=${e?.message || e}`);
  }
  return { provider: null, diag: diag.join("；") };
}

// 引擎计划：策略 + 非 edge 来源 → 这条链按顺序走哪些引擎
function planStages(strategy, source) {
  const src = source === "hana" ? "hana" : "api";
  if (strategy === "edge") return ["edge"];
  if (strategy === "media") return ["hana"];
  if (strategy === "local") return [src];
  return ["edge", src];   // edge-local（默认）
}

async function hanaStage(ctx, text, rate, python, env, mediaVoice) {
  const target = await resolveSpeechTarget(ctx);
  if (!target.provider || !target.model) {
    return { ok: false, detail: `媒体引擎没有可用的 TTS 供应商（发现结果：${target.diag}。请在 Hana 设置里配置语音合成供应商与密钥）` };
  }
  let res;
  try {
    const speechInput = {
      text,
      speed: rateToSpeed(rate),
      format: "mp3",
      provider: target.provider,
      model: target.model,
    };
    if (mediaVoice) speechInput.voice = mediaVoice; // 豆包音色（仅豆包引擎生效）
    // 请求形态由 SDK 契约定死（2026-10-09 真机踩到）：要么带工具调用的 callToken，
    // 要么带 scope:"app"（应用自持权，产物通过 ctx.media 读回）。
    // 我们的播报由钩子驱动，没有工具调用 → 必须 scope:"app"；
    // 写成扁平对象会被宿主机判为“既无 callToken 也无 scope”而直接拒。
    res = await ctx.media.generateSpeech({ scope: "app", input: speechInput });
  } catch (e) {
    return { ok: false, detail: `媒体引擎调用失败：${e.message}` };
  }
  if (!res || res.ok === false || !res.tasks?.length) {
    return { ok: false, detail: "媒体引擎没有可用的 TTS 供应商（请在 Hana 设置里配置 TTS 供应商与密钥）或请求被拒" };
  }
  const taskId = res.tasks[0].taskId;
  // 轮询等任务完成（60s 超时）
  const deadline = Date.now() + 60_000;
  let task = null;
  while (Date.now() < deadline) {
    try { task = await ctx.media.getTask(taskId); } catch { task = null; }
    const st = String(task?.status ?? "").toLowerCase();
    if (st.includes("fail") || task?.failReason) {
      return { ok: false, detail: `媒体引擎合成失败：${task?.failReason || st}` };
    }
    if (task?.completedAt || st.includes("complet") || st.includes("done") || st.includes("success")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!task) return { ok: false, detail: "媒体引擎超时（60s 未完成）" };
  let resources;
  try {
    ({ resources } = await ctx.media.getTaskResources(taskId));
  } catch (e) {
    return { ok: false, detail: `读取媒体引擎产物失败：${e.message}` };
  }
  const local = (resources || []).find((r) => r.resource?.kind === "local-file");
  if (!local) return { ok: false, detail: "媒体引擎未返回可读的本地文件" };
  // 音频交给 speak.py --play 统一播放（ffplay 探测/变速/错误码都在那边）
  const { code, stderr } = await runSpeakPy(
    python, [SPEAK_PY, "--play", local.resource.path], "", env, 60_000,
  );
  if (code === 0) return { ok: true };
  if (code === 3) return { ok: "no-ffmpeg" };
  return { ok: false, detail: `媒体引擎音频播放失败：${tail(stderr, 160)}` };
}

// ------------------------------------------------ 主流程

export async function execute(input, ctx) {
  const text = String(input?.text ?? "").trim();
  if (!text) {
    return "没有可播报的内容：text 参数为空。";
  }

  const enabled = await ctx.config.get("enabled");
  if (enabled === false) {
    return "语音播报当前已关闭（用户静音）。跳过本次播报，继续原流程，不要重试。";
  }
  const policy = `（当前密度：${densityLabel(await ctx.config.get("density"))}，当前风格：${styleLabel(await ctx.config.get("style"))}，巡检静默：${(await ctx.config.get("inspectionSilent")) === false ? "关" : "开"}，按对应策略执行）`;

  const cfgPython = String(await ctx.config.get("pythonCommand") || "").trim() || DEFAULTS.python;
  const cfgStrategy = String(await ctx.config.get("strategy") || "").trim() || DEFAULTS.strategy;
  const cfgSource = String(await ctx.config.get("ttsSource") || "").trim() || DEFAULTS.ttsSource;
  const cfgApiBase = String(await ctx.config.get("apiBaseUrl") || "").trim() || DEFAULTS.apiBaseUrl;
  const cfgApiModel = String(await ctx.config.get("apiModel") || "").trim();
  const cfgApiKey = String(await ctx.config.get("apiKey") || "").trim();
  const cfgMediaVoice = String(await ctx.config.get("mediaVoice") || "").trim();
  const cfgVoice = String(await ctx.config.get("voice") || "").trim() || DEFAULTS.voice;
  const cfgRate = String(await ctx.config.get("rate") || "").trim() || DEFAULTS.rate;

  const voice = String(input?.voice ?? "").trim() || cfgVoice;
  const rate = String(input?.rate ?? "").trim() || cfgRate;

  const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

  // ── 引擎计划：按「策略 + 非 edge 来源」决定这次走哪条链 ──
  //   edge        -> [edge]
  //   edge-local  -> [edge, 来源]（默认）
  //   local       -> [来源]
  //   media       -> [hana]（纯豆包内部管线，不回退）
  //   来源：hana = HanaAgent 媒体引擎（豆包 TTS） / custom = 自配置 OpenAI 兼容 TTS API
  const plan = planStages(cfgStrategy, cfgSource);

  const runHana = async () => {
    const t0 = Date.now();
    const r = await hanaStage(ctx, text, rate, cfgPython, env, cfgMediaVoice);
    if (r.ok === true) {
      const ms = ((Date.now() - t0) / 1000).toFixed(1);
      return { ok: true, msg: `播报完成（${engineLabel("hana")}，${ms}s，${text.length} 字）${policy}。` };
    }
    if (r.ok === "no-ffmpeg") return { ok: false, msg: "播报失败：系统里没有 ffplay/ffmpeg（winget install ffmpeg.ffmpeg 可补）。告知用户一声，继续原流程，不要重试。" };
    return { ok: false, msg: `播报失败：Hana 媒体引擎：${r.detail}。告知用户语音暂时不可用，继续原流程，不要重试这句。` };
  };

  // 纯豆包（media 策略，或 local + 来源 hana）：不走 speak.py 合成，直接走媒体总线
  if (plan.length === 1 && plan[0] === "hana") {
    return (await runHana()).msg;
  }

  // 其余用**一条命令跑完整条链**（speak.py auto：edge → 自建 API）。
  //
  // 为什么不再由应用分阶段调用（2026-10-09 重要修正）：分开调时，应用会在某个阶段
  // 超时后 SIGKILL 掉它、然后跑去下一阶段——而那个阶段可能**已经把声音放出来了**，
  // 于是同一句被念两遍（speak.log 抓过现行：edge 15:23:30 一遍、api 15:23:39 又一遍）。
  // 交给一个进程内部串行，就不会有两个进程各放一次。
  const needsEdge = plan.includes("edge");
  const needsApi = plan.includes("api");
  const args = [SPEAK_PY, "--local-base", cfgApiBase, "-v", voice, "-r", rate];
  if (cfgApiModel) args.push("--api-model", cfgApiModel);
  if (cfgApiKey) args.push("--api-key", cfgApiKey);
  if (!needsApi) args.push("--only-edge");            // 只跑云端那条链
  if (!needsEdge) args.push("--only-api");            // 只跑自建 API 那条链

  const t0 = Date.now();
  const { code, stderr, stdout } = await runSpeakPy(cfgPython, args, text, env, 240_000);
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  if (code === 0) {
    const line = String(stdout || "").split(/\r?\n/).find((l) => l.includes("[voiceloop]")) || "";
    const engine = /edge/i.test(line) ? "edge-tts 云端" : "自定义 TTS API";
    return `播报完成（${engine}，${ms}s，${text.length} 字）${policy}。`;
  }
  if (code === 3) {
    return "播报失败：系统里没有 ffplay/ffmpeg（winget install ffmpeg.ffmpeg 可补）。告知用户一声，继续原流程，不要重试。";
  }
  // 云端先跑、失败后来源是豆包 → 豆包兜底（edge 失败时不会出声，不会叠声）
  if (needsEdge && plan.includes("hana")) {
    const r = await runHana();
    if (r.ok) return r.msg;
  }
  return `播报失败：合成链路不可用（${(stderr || "").slice(-160)}）。告知用户语音暂时不可用，继续原流程，不要重试这句。`;
}
