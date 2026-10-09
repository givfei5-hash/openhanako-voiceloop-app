// Voiceloop 语音播报（v2 App 入口）—— v6 重构版
//
// ── 设计原则：应用是唯一的闸门与唯一的声音出口 ──────────────────────────
// 今天所有“复读”，根都是**同一时刻有两个声音**：应用自己在播，助手也在播。
// 所以这一版不再靠“约定”，而是靠结构：
//
//   1) 开场、收尾：应用播（确定性的两个时刻，不依赖助手记性）。
//   2) 过程旁白：助手把要说的话交给应用的工具，**由应用决定播不播**。
//      · 档位闸：本回合已完成的工具步数没到阈值 → 这句不播（密度由应用算，不靠助手自觉）
//      · 去重闸：同一会话同一句话只播一次（标准化后比较，标点/空白不影响）
//      · 串行闸：一次只让一句在响
//   3) 收尾去重：助手下线前刚说过话（25 秒内）→ 应用不再补收尾。
//   4) 单一出口：技能里明确要求助手只走工具，不要再走 exec_command 跑 speak.py
//      （那条路绕过应用，闸门管不到）。
//
// ── 档位（设置页「播报密度」，差异刻意做大）───────────────────────────
//   tight   紧凑：每 1 个工具步就允许一句 → 长任务里很热闹
//   standard 标准：每 3 个工具步允许一句 → 有明显的“几点一报”
//   quiet  安静：过程一句都不播，只留开场 + 收尾
//
// 纪律文本在随包 skills/voiceloop/SKILL.md。

import { defineApp } from "./sdk/app-contract/server-client.js";
import * as toolSpeak from "./tools/speak.js";

export const name = "voiceloop";

// ---------------------------------------------------------------- 状态

const greetedSessions = new Set();        // 开场去重
const toolSteps = new Map();              // 会话 → 本回合已完成的工具步数
const pendingClosing = new Map();         // 会话 → 本轮最后一条纯文本助手消息
const lastSpokeAt = new Map();            // 会话 → 最近一次出声时间
let audioBusy = false;                    // 串行闸

const DENSITY_STEPS = { tight: 1, standard: 2, sparse: 4, quiet: Infinity };
// “刚有声音”的静默窗口：档位越密，允许的间隔越短（仍然不叠声）
const DENSITY_GAP_MS = { tight: 8000, standard: 12000, sparse: 16000 };
// 旧档位名兼容：2026-10-09 之前最密那档叫 loose（标签却写“宽松”，名实相反），已改回 tight（紧凑）
const LEGACY_DENSITY = { loose: "tight" };
function densityKey(v) {
  const k = String(v ?? "").trim() || "standard";
  return LEGACY_DENSITY[k] || k;
}
const CLOSING_GRACE_MS = 10000;           // 助手刚说过话的短宽限（只防“它自己刚结语”，不耽误正常收尾）
const awaitingUserTurn = new Set();       // 本回合在等用户回答（发过 answer_choice）→ 不播收尾
const spokeInTurn = new Set();            // 本回合已经播过（第一句无条件放行用）
const prevTools = new Map();              // 会话 → 上一个跑过的工具（用来报“刚干完什么”）
const userPrompts = new Map();            // 会话 → 用户这轮的要求（给旁白当上下文）
const recentLines = new Map();            // 会话 → 最近说过的几句（避免换词重说）

// ── 旁白句由模型写（应用只给上下文，不自己造句）──
// 要的是“有温度、能讲清进展与接下来”的说法，句式不固定。
const NARRATOR_STYLE = {
  playful: "语气活泼俏皮，可以轻轻自嘲，但事实为先",
  plain: "平实，只讲事实，词尽量少",
  gentle: "语气柔软温和，多一点关心",
  crisp: "短句，信息密度高，不寒暄",
};

async function narratorLine(sdk, key, sessionPath, sessionIdHint, config, payload) {
  const styleHint = NARRATOR_STYLE[String(config.style || "playful")] || NARRATOR_STYLE.playful;
  const systemPrompt = [
    "你在替用户干活，要向他说一句中文口语（这句会被 TTS 直接念出来）。",
    "要求：只一句，不超过 20 个汉字；口语自然，像在跟熟人聊天；",
    `${styleHint}；报“进展/里程碑”或“接下来要做什么”；`,
    "不要说“正在执行命令”“开始处理”这类机械话；不要复制用户原话；不要 emoji、引号、markdown、换行；",
    "只输出这句话本身。",
  ].join("");
  const said = recentLines.get(key) || [];
  const userContent = [
    payload.task ? `任务：${payload.task}` : "",
    payload.justDid ? `刚完成：${payload.justDid}` : "",
    payload.nextDoing ? `接下来：${payload.nextDoing}` : "",
    said.length ? `已经说过的（不要重复或换词重说）：${said.join(" / ")}` : "",
  ].filter(Boolean).join("\n");
  const out = await modelSay(sdk, systemPrompt, userContent, sessionPath, sessionIdHint, 80);
  const line = cleanLine(out, 26);
  if (line) {
    said.push(line);
    while (said.length > 4) said.shift();
    recentLines.set(key, said);
  }
  return line;
}


// 模型调用参数
const GREETING_TIMEOUT_UTILITY_MS = 4000;
const GREETING_TIMEOUT_MAIN_MS = 25000;
const GREETING_TIMEOUT_CONTEXT_MS = 2000;
const UTILITY_COOLDOWN_MS = 10 * 60 * 1000;
let utilityDownUntil = 0;
const GREETING_STYLE_HINT = {
  playful: "语气活泼俏皮，可以轻轻自嘲，但以事实为先",
  plain: "不修饰，只把要做的事说清楚，词尽量少",
  gentle: "语气柔软温和，多一点关心和语气词",
  crisp: "短句、信息密度高，不寒暄",
};

// ---------------------------------------------------------------- 小工具

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function buildToolContext(sdk, config) {
  return {
    config: { get: async (key) => config[key] },
    media: sdk.media,
    providers: sdk.providers,
    logger: sdk.logger,
  };
}

// 去重用：去掉空白与标点，只比字面内容
function normalizeForDedupe(text) {
  return String(text || "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、；：""''（）()【】《》,.!?;:'"()\[\]<>—…~·]/g, "")
    .toLowerCase();
}

// 从 exec_command 的 cmd 里抽出 speak.py 后面那句话（用于去重比较）
function spokenTextFromCommand(cmd) {
  const s = String(cmd || "");
  const i = s.toLowerCase().indexOf("speak.py");
  if (i < 0) return "";
  let rest = s.slice(i + "speak.py".length).trim();
  rest = rest.replace(/^(\.exe)?/i, "").trim();
  // 忽略 -v / -r / -f 等参数，只取第一个引号包裹或裸的字符串
  const q = rest.match(/["']([^"']{2,})["']/);
  if (q) return q[1].trim();
  return rest.replace(/^-\S+\s+(\S+)?/g, "").trim();
}

// 档位闸 + 去重闸：两个入口（工具 / CLI）共用一套判断
function gateSpeak(key, density, text, steps) {
  density = densityKey(density);
  const need = DENSITY_STEPS[density] ?? 2;
  if (steps < need) {
    return {
      block: true,
      reason: density === "quiet"
        ? "安静档：过程旁白不播（只开场+收尾）"
        : `本档位还没到下一个播报点（还差 ${need - steps} 个工具步）`,
    };
  }
  const norm = normalizeForDedupe(text);
  if (isDuplicateText(norm)) {
    return { block: true, reason: "这句刚才已经播过" };
  }
  markSpokenText(norm);
  toolSteps.set(key, 0);
  return { block: false, norm };
}

function sessionKey(invocation, raw) {
  const s = String(
    invocation?.session?.sessionPath ||
    invocation?.session?.sessionId ||
    raw?.context?.sessionPath ||
    raw?.context?.sessionId ||
    "",
  ).trim();
  // 拿不到会话就用同一个桶：宁可全局去重（不会漏拦重复），也不要因键不一致放过第二遍。
  return s || "global";
}

// ── 过程旁白：里程碑口吻（报进展 + 接下来干什么），内容取自真实工具入参 ──
// 不报“正在做什么”，而是“刚干完什么，接下来干什么”。
function _clip(s, n) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function _target(name, input) {
  const i = input || {};
  if (name === "web_search") return _clip(i.query, 16);
  if (name === "web_fetch") {
    try { return _clip(new URL(String(i.url || "")).host, 20); } catch { return ""; }
  }
  if (name === "read" || name === "write" || name === "edit") {
    return _clip(String(i.path || "").split(/[\\/]/).pop(), 16);
  }
  if (name === "exec_command") return _clip(String(i.cmd || "").split(/\s+/).slice(0, 2).join(" "), 14);
  if (name === "grep" || name === "find" || name === "glob") return _clip(i.pattern || i.query, 14);
  if (name === "show_card") return _clip(i.title, 14);
  return "";
}

// 正在做 / 刚做完 / 接下来做
const TOOL_ACT = {
  web_search: ["查一轮资料", "资料查完一轮", "接着再查一轮"],
  web_fetch: ["读一个页面", "页面读完了", "接着去看页面"],
  read: ["看一份文件", "文件看完了", "接着看文件"],
  write: ["落一个文件", "文件写好了", "接着写文件"],
  edit: ["改一处", "这处改好了", "接着改下一处"],
  exec_command: ["跑一条命令", "命令跑完了", "接着跑下一条"],
  grep: ["搜一遍", "搜完一轮", "接着再搜"],
  find: ["找一轮", "找完一轮", "接着再找"],
  show_card: ["整理成卡", "卡片整理好了", "接着补充内容"],
};

function _act(name) {
  return TOOL_ACT[name] || ["推进一点", "这步过了", "接着往下走"];
}

// “刚干完的那件事”用什么词说
function donePhrase(name, input) {
  const t = _target(name, input);
  const d = _act(name)[1];
  if (!name) return "";
  if (name === "web_search") return t ? `${t} 查到了` : "资料查了一轮";
  if (name === "web_fetch") return "那个页面读完了";
  if (name === "read" || name === "write" || name === "edit") return t ? `${t} ${d}` : d;
  if (name === "exec_command") return "命令跑完了";
  return d;
}

// 内部区块（PULSE/REFLECT/思考）绝不能念出来——它们不是给耳朵听的内容。
// 内部块标签（助手/模型的心声类块）：一律不进播报。
// 2026-10-09 真机抓到现行：只剥了 pulse/reflect/think，结果助手发 <mood>…</mood> 时
// 应用把“<mood>”原样念了出来。现在三层：已知名单（配对+落单）→ 任何成对标签块兜底 → 内心白名单行。
const INTERNAL_TAGS =
  "pulse|mood|reflect|think|thinking|inner|feeling|feelings|emotion|state|analysis|reasoning|meta|scratch|draft|plan|note|notes|aside|private|self|comment|context|memory";
const RE_INTERNAL_PAIRED = new RegExp(`<(${INTERNAL_TAGS})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, "gi");
const RE_INTERNAL_LONE = new RegExp(`<\\/?(?:${INTERNAL_TAGS})(?:\\s[^>]*)?>`, "gi");
// 兜底：任何“成对标签块”（未知内部标签也算），如 <whatever>…</whatever>
const RE_ANY_PAIRED_BLOCK = /<([a-z][a-z0-9_-]{0,15})(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

function stripInternalBlocks(text) {
  return String(text || "")
    .replace(RE_INTERNAL_PAIRED, " ")
    .replace(RE_INTERNAL_LONE, " ")
    .replace(RE_ANY_PAIRED_BLOCK, " ")
    .replace(/^(?:Vibe|Echo|Read|Will)[:\uFF1A][\s\S]*$/gim, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 系统 / 活动回合（心跳巡检就跑在这类会话里）：不接手会话文件，就不该出声。
// 2026-10-09 真机补修：心跳跑在 `agents/<agent>/activity/<时间戳>.jsonl` 这种**桌面活动会话**里
// （有会话文件、提示词里也未必带“巡检”字样），原来的三条判据全部认不出来 → 照播。
// 现在把「活动/心跳/巡检/定时任务」的会话也当系统回合；用户会话在 sessions/ 下，不会误伤。
const PATROL_MARKERS = ["巡检", "心跳", "工作台巡检", "patrol", "体检"];
const SYSTEM_PATH_RE = /(?:^|[\\/])(activity|activities|desk|heartbeat|patrol|automation|automations|schedule[d]?)(?:[\\/]|$)/i;
const SYSTEM_ID_RE = /heartbeat|patrol|desk[-_]|automation|定时/i;
// 助理之间转发的消息 / 群聊频道回合（不是用户本人说的）：也不该报到用户耳朵里。
// 2026-10-09 真机：助理们在一个频道里群聊（agents/<id>/phone/sessions/ch_xxx/），
// 应用把那些回合也念了（“回复已发到 Truth 频道”之类）——那是不该外放的内务。
// 这类回合的提示词有现成标记（实测原文）：“你的手机收到了 #ch_xxx 的新群聊消息”、
// “不是用户单独发给你的请求”；单聊转发则带“非用户本人”。
const RELAY_MARKERS = [
  "非用户本人", "[来自 Agent", "[来自Agent", "来自 Agent「",
  "新群聊消息", "不是用户单独发给你的请求", "频道聊天记录",
];
const CHANNEL_PATH_RE = /(?:^|[\\/])phone[\\/]sessions[\\/]ch[-_]/i;   // 频道（群聊）会话

function isSystemTurn(invocation, prompt) {
  const path = String(invocation?.session?.sessionPath || "").trim();
  const id = String(invocation?.session?.sessionId || "").trim();
  if (!path) return true;                                        // 无会话文件 = 系统活动回合
  if (SYSTEM_PATH_RE.test(path)) return true;                    // 桌面活动 / 心跳 / 巡检 / 定时任务会话
  if (CHANNEL_PATH_RE.test(path)) return true;                   // 频道群聊会话
  if (SYSTEM_ID_RE.test(id)) return true;
  // 开场拿得到本轮提示词；过程/收尾拿不到，就用开场时记下的那句
  const t = String(prompt || "").trim() || String(userPrompts.get(sessionKey(invocation)) || "");
  if (RELAY_MARKERS.some((m) => t.includes(m))) return true;     // 非用户本人的转发 / 群聊消息
  return PATROL_MARKERS.some((m) => t.includes(m));
}

// 全局文本去重（不分会话、不分调用路径）：同一句话 10 分钟内只允许播一次。// 为什么要全局：工具路径与 exec_command 路径拿到的会话键可能不同，分会话去重会放行
// “同一个内容从另一条路再播一遍”——那正是“同一句念两遍”的根。
const spokenTextTimes = new Map();
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function isDuplicateText(norm) {
  if (!norm) return false;
  const t = spokenTextTimes.get(norm);
  return !!t && Date.now() - t < DEDUPE_WINDOW_MS;
}

function markSpokenText(norm) {
  if (norm) spokenTextTimes.set(norm, Date.now());
}

// ---------------------------------------------------------------- 唯一的声音出口

async function speakOnce(sdk, config, key, text, tag) {
  while (audioBusy) await new Promise((r) => setTimeout(r, 300));
  audioBusy = true;
  try {
    const result = await toolSpeak.execute({ text }, buildToolContext(sdk, config));
    // 只有“真的出声了”才算刚说过话；失败不算（否则失败会误伤后面的收尾）
    if (key && String(result).includes("播报完成")) lastSpokeAt.set(key, Date.now());
    await sdk.logger.info(`voiceloop [${tag}]: ${String(result).slice(0, 120)} | text=${text.slice(0, 50)}`);
    return result;
  } finally {
    audioBusy = false;
  }
}

// ---------------------------------------------------------------- 设置快照（给 CLI 读）

async function writeRuntimeConfig(sdk) {
  try {
    const env = (typeof process !== "undefined" && process.env) ? process.env : {};
    if (env.VOICELOOP_NO_RUNTIME_CONFIG === "1") return; // 自测时别动真实配置
    const config = (await sdk.config.getAll()) || {};
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const snap = {
      strategy: String(config.strategy ?? "edge-local"),
      ttsSource: String(config.ttsSource ?? "custom"),
      apiBaseUrl: String(config.apiBaseUrl ?? "http://127.0.0.1:8137/v1"),
      apiModel: String(config.apiModel ?? ""),
      apiKey: String(config.apiKey ?? ""),
      voice: String(config.voice ?? "zh-CN-XiaoxiaoNeural"),
      rate: String(config.rate ?? "+15"),
      density: String(config.density ?? "standard"),
      style: String(config.style ?? "playful"),
      enabled: config.enabled !== false,
    };
    fs.writeFileSync(path.join(dir, "runtime-tts.json"), JSON.stringify(snap, null, 2), "utf8");
  } catch { /* 快照失败不影响主流程 */ }
}

// ---------------------------------------------------------------- 模型调用（开场/收尾润色）

const sessionIdCache = new Map();

async function resolveSessionId(sdk, sessionPath) {
  const p = String(sessionPath || "").trim();
  if (!p || !sdk.sessions || typeof sdk.sessions.list !== "function") return "";
  if (sessionIdCache.has(p)) return sessionIdCache.get(p);
  let id = "";
  try {
    const r = await withTimeout(
      sdk.sessions.list({ scope: "all" }), GREETING_TIMEOUT_CONTEXT_MS, "sessions-list",
    );
    const arr = Array.isArray(r) ? r : (r?.sessions || r?.items || []);
    const list = Array.isArray(arr) ? arr : [];
    const base = p.split(/[\\/]/).pop();
    const hit = list.find((s) => {
      if (!s) return false;
      const cand = [s.path, s.sessionPath, s.legacySessionPath].filter(Boolean);
      return cand.some((c) => c === p || String(c).split(/[\\/]/).pop() === base);
    });
    id = String(hit?.sessionId || hit?.id || "").trim();
  } catch { /* 交给调用方回退 */ }
  if (id) sessionIdCache.set(p, id);
  return id;
}

async function resolveSessionModel(sdk, sessionPath, sessionIdHint) {
  if (!sdk.sessions || typeof sdk.sessions.context !== "function") return null;
  const p = String(sessionPath || "").trim();
  const hint = String(sessionIdHint || "").trim();
  const candidates = [];
  if (p) candidates.push({ legacySessionPath: p, scope: "all" });
  const id = await resolveSessionId(sdk, p);
  if (id) candidates.push({ sessionId: id, scope: "all" });
  if (hint) candidates.push({ sessionId: hint, scope: "all" });
  for (const ref of candidates) {
    try {
      const ctx = await withTimeout(
        sdk.sessions.context(ref), GREETING_TIMEOUT_CONTEXT_MS, "session-context",
      );
      const m = ctx && ctx.model;
      if (!m || typeof m !== "object") continue;
      const provider = String(m.provider || m.providerId || "").trim();
      const model = String(m.modelId || m.id || m.model || "").trim();
      if (provider && model) return { provider, model };
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

async function collectStreamText(sdk, request) {
  let text = "";
  const iterator = sdk.models.streamEvents(request);
  try {
    for await (const event of iterator) {
      if (!event) continue;
      if (event.type === "text-delta") text += event.delta || "";
      else if (event.type === "error") throw new Error(event.message || event.code || "model error");
      else if (event.type === "done") break;
    }
  } catch (error) {
    try { await sdk.models.cancel?.(request.requestId); } catch { /* best-effort */ }
    throw error;
  }
  return text;
}

async function modelSay(sdk, systemPrompt, userContent, sessionPath, sessionIdHint, maxTokens) {
  const rid = () => `voiceloop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (sdk.models && typeof sdk.models.utility === "function" && Date.now() >= utilityDownUntil) {
    try {
      const r = await withTimeout(
        sdk.models.utility({
          requestId: rid(), scope: "app", systemPrompt,
          messages: [{ role: "user", content: userContent }],
          temperature: 0.5, maxTokens,
        }),
        GREETING_TIMEOUT_UTILITY_MS, "utility",
      );
      const t = String(r?.text || "").trim();
      if (t) return t;
    } catch {
      utilityDownUntil = Date.now() + UTILITY_COOLDOWN_MS;
    }
  }
  try {
    const ref = await resolveSessionModel(sdk, sessionPath, sessionIdHint);
    if (ref) {
      const raw = await withTimeout(
        collectStreamText(sdk, {
          requestId: rid(), provider: ref.provider, model: ref.model, systemPrompt,
          messages: [{ role: "user", content: userContent }],
          temperature: 0.5, maxTokens,
        }),
        GREETING_TIMEOUT_MAIN_MS, "main-model",
      );
      const t = String(raw || "").trim();
      if (t) return t;
    }
  } catch { /* 没拿到就算了 */ }
  return "";
}

function cleanLine(raw, max = 48) {
  const cleaned = stripInternalBlocks(String(raw || ""))
    .replace(/<\/?[a-z][a-z0-9_-]{0,20}[^>]*>/gi, " ")   // 模型万一吐标签，也不让它出声
    .replace(/^["'“‘\s]+|["'”’\s]+$/g, "")
    .replace(/^[-•*\d.、\s]+/, "")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function buildGreetingSystemPrompt(config) {
  const styleHint = GREETING_STYLE_HINT[config.style] || GREETING_STYLE_HINT.playful;
  return [
    "你在给语音助手写一句开场白，这句话会被 TTS 直接念出来。",
    "要求：只用一句，不超过 24 个汉字；贴着用户这句话要办的具体事说，不要说“有什么可以帮你”这类空话；",
    `${styleHint}；口语自然，别用书面腔；不要 emoji、引号、括号、markdown、换行；不要复述用户原话；`,
    "绝不能出现密码、密钥、证件号、银行卡号等敏感信息。只输出这句话本身。",
  ].join("");
}

// 取第一句、裁短（开场用）
function firstSentence(text, max) {
  const cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[#>*\-\s]+/g, "")
    .trim();
  if (!cleaned) return "";
  const m = cleaned.match(/^[^。！？!?\n]{2,}?[。！？!?]/);
  const head = (m ? m[0] : cleaned).trim();
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

function extractAssistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return stripInternalBlocks(content);
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    const t = c && c.type;
    if (t === "toolCall" || t === "tool_call" || t === "toolResult" || t === "tool_result") return "";
  }
  const parts = [];
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return stripInternalBlocks(parts.join("\n"));
}

// 口播长短跟着「播报风格」走：风格既管语气，也管一次念多长（收尾用）。
const STYLE_CAPS = { playful: 140, plain: 80, gentle: 220, crisp: 100 };

function closingCap(config) {
  return STYLE_CAPS[String(config?.style || "playful").trim()] || STYLE_CAPS.playful;
}

async function prepareClosing(sdk, sessionPath, sessionIdHint, text, config) {
  const clean = stripInternalBlocks(text);        // 再剥一遍（宁少念，不念内部块）
  if (!clean) return "";                          // 全被剥光 → 一个字都不念
  const cap = closingCap(config);
  if (clean.length <= cap) return clean;
  const systemPrompt =
    `把下面这段助手回复改写成一段适合念出来的口播稿：只留最关键的信息（结论、数字、改动点、下一步），` +
    `严格控制在 ${cap} 字以内；不要 markdown、表格、代码块、emoji；不要开场白、不要多余解释；只输出口播稿本身。`;
  const out = await modelSay(
    sdk, systemPrompt, `原文：\n${clean.slice(0, 6000)}`, sessionPath, sessionIdHint, 400,
  );
  const line = cleanLine(out, cap + 20);
  if (line) return line;
  // 压缩不出来（模型不可用）：宁可少念，也不自己造句子——只截取**剥完**的原文开头；剥完没东西就不念
  await sdk.logger?.info?.("voiceloop [closing] condense failed; speaking the opening of the raw text");
  const head = cleanLine(clean.slice(0, Math.min(cap, 180)), cap + 20);
  return head ? `${head}……` : "";
}

// ---------------------------------------------------------------- app

export default defineApp(async (sdk) => {
  await sdk.logger.info("voiceloop v6 loaded");

  // ── 工具：助手的过程旁白入口，同时也是唯一的声音出口 ──
  await sdk.tools.register({
    name: toolSpeak.name,
    description: toolSpeak.description,
    parameters: toolSpeak.parameters,
    execute: async (invocation) => {
      const raw = invocation && typeof invocation === "object" ? invocation : {};
      const { context: _context, ...input } = raw;
      const config = (await sdk.config.getAll()) || {};
      await writeRuntimeConfig(sdk);

      const key = sessionKey(null, raw);
      const text = String(input?.text ?? "").trim();
      if (!text) return await toolSpeak.execute(input, buildToolContext(sdk, config));

      const density = String(config.density ?? "standard").trim() || "standard";
      const steps = toolSteps.get(key) || 0;
      const first = !spokeInTurn.has(key);
      if (first) {
        // 本回合第一句无条件放行（它就是开场/起手计划），只做去重登记
        const norm0 = normalizeForDedupe(text);
        if (isDuplicateText(norm0)) {
          await sdk.logger.info(`voiceloop [gate:tool] blocked: 同文本刚播过 | text=${text.slice(0, 30)}`);
          return "（这句刚才已经播过，跳过，不要重试。）";
        }
        markSpokenText(norm0);
      } else {
        // 之后才按档位 + 去重（gateSpeak 自己会登记，不要再查一遍）
        const gate = gateSpeak(key, density, text, steps);
        if (gate.block) {
          await sdk.logger.info(`voiceloop [gate:tool] blocked: ${gate.reason} | text=${text.slice(0, 30)}`);
          return `（${gate.reason}，这句先不播，继续原流程，不要重试。）`;
        }
      }
      toolSteps.set(key, 0);
      spokeInTurn.add(key);

      return await speakOnce(sdk, config, key, text, "process");
    },
  });

  await writeRuntimeConfig(sdk);

  if (typeof sdk.hooks?.onDecision !== "function") {
    await sdk.logger.info("voiceloop: hooks unavailable, auto narration disabled");
    return;
  }

  // ── 计步 + 标记“在等用户回答” ──
  await sdk.hooks.onDecision("tools/post-execute", (invocation) => {
    const key = sessionKey(invocation);
    if (!key) return undefined;
    const name = String(invocation?.toolName || "").trim();
    if (!name || name.startsWith("voiceloop")) return undefined;
    if (name === "answer_choice" || name === "ask_user" || name === "ask-user") {
      awaitingUserTurn.add(key); // 回合以提问/等选择结束，不是结论 → 不播收尾
      return undefined;
    }
    toolSteps.set(key, (toolSteps.get(key) || 0) + 1);
    return undefined;
  });

  // 巡检/系统回合是否静默：由设置页「巡检静默」控制（默认开；关掉则连巡检也播）
  const systemQuiet = async (invocation, prompt) => {
    if (!isSystemTurn(invocation, prompt)) return false;
    const config = (await sdk.config.getAll()) || {};
    return config.inspectionSilent !== false;
  };

  // ── 闸门 + 过程旁白：都在 pre-execute 里做 ──
  await sdk.hooks.onDecision("tools/pre-execute", async (invocation) => {
    try {
      const name = String(invocation?.toolName || "");
      if (!name || name.startsWith("voiceloop")) return undefined;
      if (await systemQuiet(invocation, "")) return undefined;      // 巡检/系统回合：过程也不播
      const input = invocation?.input || {};
      const key = sessionKey(invocation);
      const config = (await sdk.config.getAll()) || {};
      if (config.enabled === false) return undefined;

      // ① 如果模型自己在跑 speak.py：过闸门（档位 + 去重），不让它绕过
      const cmd = String(input.cmd || input.command || "");
      if (name === "exec_command" && /speak\.py/i.test(cmd)) {
        const text = spokenTextFromCommand(cmd);
        const norm = normalizeForDedupe(text);
        if (isDuplicateText(norm)) {
          await sdk.logger.info(`voiceloop [gate:cli] blocked: 同文本刚播过 | text=${text.slice(0, 30)}`);
          return { block: true, reason: "voiceloop：这句刚才已经播过，继续原流程，不要重试。" };
        }
        const steps0 = toolSteps.get(key) || 0;
        const first0 = !spokeInTurn.has(key);
        const density0 = String(config.density ?? "standard").trim() || "standard";
        if (!first0) {
          const gate = gateSpeak(key, density0, text, steps0);
          if (gate.block) {
            await sdk.logger.info(`voiceloop [gate:cli] blocked: ${gate.reason} | text=${text.slice(0, 30)}`);
            return { block: true, reason: `voiceloop：${gate.reason}，继续原流程，不要重试。` };
          }
        }
        markSpokenText(norm);
        toolSteps.set(key, 0);
        spokeInTurn.add(key);
        await sdk.logger.info(`voiceloop [gate:cli] allowed${first0 ? " (本回合第一句)" : ""} | text=${text.slice(0, 30)}`);
        return undefined;
      }

      // ② 里程碑旁白：应用主动说，句子由模型写（带温度，不固定句式）
      const density = densityKey(config.density);
      const need = DENSITY_STEPS[density] ?? 2;
      if (need === Infinity) return undefined;
      const steps = toolSteps.get(key) || 0;
      if (steps < need) return undefined;
      const finished = prevTools.get(key);                  // 上一个工具 = 刚跑完的那个
      prevTools.set(key, { name, input });
      if (audioBusy) return undefined;                      // 上一句还在响，不排队
      const gap = DENSITY_GAP_MS[density] ?? 12000;         // 档位越密，允许的间隔越短
      if (Date.now() - (lastSpokeAt.get(key) || 0) < gap) return undefined;
      // 先占位再异步生成，避免同一段里重复触发
      toolSteps.set(key, 0);
      spokeInTurn.add(key);
      const style = String(config.style || "playful");      const nextTarget = _target(name, input);
      const payload = {
        task: userPrompts.get(key) || "",
        justDid: finished ? donePhrase(finished.name, finished.input) : "",
        nextDoing: nextTarget ? `${_act(name)[0]}：${nextTarget}` : _act(name)[0],
      };
      const run = async () => {
        const line = await narratorLine(
          sdk, key, invocation?.session?.sessionPath, invocation?.session?.sessionId, config, payload,
        ).catch(() => "");
        if (!line) return;
        const normLine = normalizeForDedupe(line);
        if (!normLine || isDuplicateText(normLine)) return;
        markSpokenText(normLine);
        await speakOnce(sdk, config, key, line, "progress");
      };
      run().catch(async (e) => {
        try { await sdk.logger.info(`voiceloop [narrate] failed: ${e?.message || e}`); } catch { /* */ }
      });
      return undefined;
    } catch { return undefined; }
  });

  // 开场改在下面 messages/post-assistant 里做（播助手写的第一句），这里不再另生成。

  // ── 应用主动介入 · 开场：新会话第一轮，应用自己说一句（模型现写，带温度）──
  await sdk.hooks.onDecision("agent/before-start", async (invocation) => {
    const key = sessionKey(invocation);
    const prompt = String(invocation?.prompt ?? "").trim();
    if (await systemQuiet(invocation, prompt)) return undefined;   // 巡检/系统回合：全程静默
    if (key && prompt) userPrompts.set(key, prompt.slice(0, 160));
    const run = async () => {
      const config = (await sdk.config.getAll()) || {};
      if (config.enabled === false) return;
      if (!key || !prompt) return;
      if (greetedSessions.has(key)) return;               // 开场只在新会话第一轮
      greetedSessions.add(key);
      spokeInTurn.add(key);                               // 本回合已经说过话 → 后面的是“里程碑”不是“开场”
      toolSteps.set(key, 0);
      const line = await narratorLine(
        sdk, key, invocation?.session?.sessionPath, invocation?.session?.sessionId, config,
        { task: prompt, justDid: "", nextDoing: "先看一遗情况" },
      ).catch(() => "");
      if (!line) return;
      const n = normalizeForDedupe(line);
      if (!n || isDuplicateText(n)) return;
      markSpokenText(n);
      await speakOnce(sdk, config, key, line, "opening");
    };
    run().catch(async (e) => {
      try { await sdk.logger.info(`voiceloop [opening] failed: ${e?.message || e}`); } catch { /* */ }
    });
    return undefined;
  });

  // ── 收尾第一步：记下本轮最后一条纯文本消息 ──（开场不在这里做，开场由助手自己播）
  await sdk.hooks.onDecision("messages/post-assistant", async (invocation) => {
    if (await systemQuiet(invocation, "")) return undefined;        // 巡检/系统回合：不记也不播
    const key = sessionKey(invocation);
    const text = extractAssistantText(invocation?.message);
    if (key && text) pendingClosing.set(key, text);
    return undefined;
  });

  // ── 收尾第二步：回合真正结束才念，且两条去重 ──
  if (typeof sdk.hooks.on === "function") {
    await sdk.hooks.on("agent/settled", (invocation) => {
      const run = async () => {
        const key = sessionKey(invocation);
        if (await systemQuiet(invocation, "")) return;            // 巡检/系统回合：不播收尾
        spokeInTurn.delete(key);
        prevTools.delete(key);
        const config = (await sdk.config.getAll()) || {};
        if (config.enabled === false) return;
        const text = key ? pendingClosing.get(key) : "";
        if (key) pendingClosing.delete(key);
        if (!text) {
          await sdk.logger.info("voiceloop [closing] skipped: nothing to say");
          return;
        }
        if (key && awaitingUserTurn.has(key)) {
          awaitingUserTurn.delete(key);
          await sdk.logger.info("voiceloop [closing] skipped: turn is waiting for user");
          return;
        }
        // 去重 1：助手刚说过话（宽限期内）→ 不补
        if (key && Date.now() - (lastSpokeAt.get(key) || 0) < CLOSING_GRACE_MS) {
          await sdk.logger.info("voiceloop [closing] skipped: spoke recently");
          return;
        }
        // 去重 2：同一文本 10 分钟内 → 不重播
        const norm = normalizeForDedupe(text);
        if (isDuplicateText(norm)) {
          await sdk.logger.info("voiceloop [closing] skipped: same as before");
          return;
        }
        const spoken = await prepareClosing(
          sdk, invocation?.session?.sessionPath, invocation?.session?.sessionId, text, config,
        );
        if (!spoken) return;
        markSpokenText(norm);
        await speakOnce(sdk, config, key, spoken, "closing");
      };
      run().catch(async (e) => {
        try { await sdk.logger.info(`voiceloop [closing] failed: ${e?.message || e}`); } catch { /* */ }
      });
    });
  }

  await sdk.logger.info("voiceloop: opening + closing armed；过程由工具闸门控档位与去重");
});
