// Voiceloop 上线验收（离线模拟，不发声）
//   python 命令故意写成不存在的可执行文件 → 每次播报瞬间失败，
//   于是可以快速、精确地数“哪些句子被放行了”。
// 跑法：node _test_launch.mjs
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";
import app from "./index.js";

const logs = [];
const decisions = {};
const listeners = {};
const played = [];

// 可变配置：测试过程中按需要改（应用每次调用都重新读）
const CFG = {
  enabled: true,
  strategy: "local",
  ttsSource: "custom",
  apiBaseUrl: "http://127.0.0.1:9/v1",
  apiModel: "",
  apiKey: "",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+15",
  density: "standard",
  style: "playful",
  inspectionSilent: true,
  pythonCommand: "definitely-not-a-python",   // ← 让链路瞬间失败，测试才跑得快
};

let MODEL_UP = true;   // 模拟“模型可用 / 不可用”

// 媒体引擎（豆包）相关状态：方法闭包读它，测试中改它
const MEDIA = { captured: null, discover: true };

const mockSdk = {
  dataDir: "./tmp-test-data",
  bus: {
    request: async (verb, payload) => {
      // 应用通过总线问“有没有默认语音模型 / 有哪些语音模型”（复现本机真实状态：未配默认）
      if (verb === "provider:resolve-media-model") return { error: "no default configured" };
      // 真机上媒体供应商目录走的是 media-providers（models-by-type 对语音合成永远为空）
      if (verb === "provider:media-providers") return { providers: { "volcengine-tts": { providerId: "volcengine-tts", models: [{ id: "seed-tts-2.0-standard" }], hasCredentials: true, unavailableReason: null } } };
      if (verb === "provider:models-by-type") return { models: [] };
      if (verb === "media:generate-speech") { MEDIA.captured = payload; return { tasks: [{ taskId: "t1" }] }; }
      if (/resource/i.test(verb)) return { resources: [{ resource: { kind: "local-file", path: "C:\\tmp\\nope.mp3" } }] };
      if (/task/i.test(verb)) return { status: "completed", completedAt: Date.now() };
      return {};
    },
  },
  storage: { global: {}, agent: () => ({}) },
  logger: {
    info: async (m) => {
      logs.push(String(m));
      const tag = /\[(opening|progress|closing)\]/.exec(String(m));
      const t = /text=([^|]*)$/.exec(String(m));
      if (tag && t && /播报完成|播报失败/.test(String(m))) played.push({ tag: tag[1], text: t[1].trim() });
    },
    error: async (m) => { logs.push("ERR " + String(m)); },
  },
  config: { getAll: async () => ({ ...CFG }) },
  media: {
    generateSpeech: async (input) => { MEDIA.captured = input; return { tasks: [{ taskId: "t1" }] }; },
    getTask: async () => ({ status: "completed", completedAt: Date.now() }),
    getTaskResources: async () => ({ resources: [{ resource: { kind: "local-file", path: "C:\\tmp\\nope.mp3" } }] }),
  },
  providers: {},
  sessions: {
    list: async () => ({ sessions: [] }),
    context: async () => { if (!MODEL_UP) throw new Error("model unavailable"); return { model: null }; },
  },
  models: {
    streamEvents: async function* () {},
    cancel: async () => {},
    utility: async () => {
      if (!MODEL_UP) throw new Error("utility unavailable");
      return { text: `说一句人话（${(globalThis.__n = (globalThis.__n || 0) + 1)}）` };
    },
  },
  tools: { register: async (t) => { mockSdk._tool = t; return { ready: Promise.resolve() }; } },
  hooks: {
    onDecision: async (e, f) => { decisions[e] = f; return { ready: Promise.resolve() }; },
    on: async (e, f) => { listeners[e] = f; return { ready: Promise.resolve() }; },
  },
};

await app.apply(mockSdk);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 先等飞的就地落地再清空（播报是 fire-and-forget，不清干净会串到下一段）
const reset = async () => { await sleep(400); played.length = 0; };
const count = (tag) => played.filter((p) => p.tag === tag).length;
const results = [];
const check = (n, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  | " + extra : ""}`); };

const S = { sessionPath: "C:\\sessions\\launch.jsonl", sessionId: "sess_launch" };
const step = (name = "web_search", input = { query: "关键词" }) =>
  decisions["tools/pre-execute"]({ session: S, toolName: name, input }).then(() =>
    decisions["tools/post-execute"]({ session: S, toolName: name }));
const turnStart = async (prompt) => decisions["agent/before-start"]({ session: S, prompt });
const turnEnd = async (text) => {
  await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text }] } });
  await listeners["agent/settled"]({ session: S });
  await sleep(300);
};

// ① 三段全自动：助手一句话都不说，应用也要把开场/过程/收尾补齐
await reset();
await turnStart("帮我把成都三天的行程排一下");
await sleep(300);
check("① 开场：应用主动出声", count("opening") === 1, `opening=${count("opening")}`);
for (let i = 0; i < 6; i++) { await step(); await sleep(120); }
await turnEnd("结论：三天按市井、展览、近郊排，具体表在上面。");
check("① 过程：有里程碑旁白", count("progress") >= 1, `progress=${count("progress")}`);
check("① 收尾：应用念结论", count("closing") === 1, `closing=${count("closing")}`);

// ② 四档密度：节奏必须递进
const densityCounts = {};
for (const d of ["tight", "standard", "sparse", "quiet"]) {
  CFG.density = d;
  const S2 = { sessionPath: `C:\\sessions\\${d}.jsonl`, sessionId: `sess_${d}` };
  await reset();
  await decisions["agent/before-start"]({ session: S2, prompt: "做一件有点长的事" });
  await sleep(300);
  for (let i = 0; i < 10; i++) {
    await decisions["tools/pre-execute"]({ session: S2, toolName: "web_search", input: { query: `第${i}组关键词` } });
    await decisions["tools/post-execute"]({ session: S2, toolName: "web_search" });
    await sleep(60);
  }
  densityCounts[d] = count("progress");
}
CFG.density = "standard";
check("② 密度递进：紧凑 ≥ 标准 ≥ 稀疏 > 安静=0",
  densityCounts.tight >= densityCounts.standard && densityCounts.standard >= densityCounts.sparse && densityCounts.sparse > 0 && densityCounts.quiet === 0,
  JSON.stringify(densityCounts));
check("② 稀疏档确实比标准更少话（更宽的一档）", densityCounts.sparse < densityCounts.standard, `sparse=${densityCounts.sparse} standard=${densityCounts.standard}`);

// ②b 旧档位名兼容：以前那档叫 loose（名实相反），存量设置不能因此失效
CFG.density = "loose";
{
  const S2b = { sessionPath: "C:\\sessions\\legacy.jsonl", sessionId: "sess_legacy" };
  await reset();
  await decisions["agent/before-start"]({ session: S2b, prompt: "存量设置兼容" });
  await sleep(300);
  for (let i = 0; i < 4; i++) {
    await decisions["tools/pre-execute"]({ session: S2b, toolName: "web_search", input: { query: `旧档第${i}组` } });
    await decisions["tools/post-execute"]({ session: S2b, toolName: "web_search" });
    await sleep(60);
  }
  check("②b 旧档位名 loose 按紧凑处理（存量设置不失效）", count("progress") >= 3, `progress=${count("progress")}`);
}
CFG.density = "standard";

// ③ 去重：同一句第二次不播（工具路径 + 命令行路径）
await reset();
CFG.density = "tight";
await decisions["agent/before-start"]({ session: S, prompt: "再来一轮" });
await sleep(300);
await step();
const r1 = await mockSdk._tool.execute({ text: "同一句话只该播一次", context: { sessionPath: S.sessionPath } });
await step();
const r2 = await mockSdk._tool.execute({ text: "同一句话只该播一次", context: { sessionPath: S.sessionPath } });
check("③ 去重（工具路径）", String(r1).includes("播报失败"), String(r1).slice(0, 30));
check("③ 去重（工具路径·第二次被拦）", String(r2).includes("已经播过"), String(r2).slice(0, 30));
const r3 = await decisions["tools/pre-execute"]({
  session: S, toolName: "exec_command",
  input: { cmd: `py "x\\speak.py" "同一句话只该播一次"` },
});
check("③ 去重（跨路径：命令行也被拦）", r3 && r3.block === true, JSON.stringify(r3).slice(0, 60));

// ④ 巡检静默：没有会话文件的回合全程不出声
await reset();
const HB = { sessionId: "hb_20261009", sessionPath: null };
await decisions["agent/before-start"]({ session: HB, prompt: "工作台巡检：看看有什么要处理的" });
await decisions["tools/pre-execute"]({ session: HB, toolName: "web_search", input: { query: "巡检" } });
await decisions["messages/post-assistant"]({ session: HB, message: { role: "assistant", content: [{ type: "text", text: "一切正常。" }] } });
await listeners["agent/settled"]({ session: HB });
await sleep(400);
check("④ 巡检静默：三段都不播", played.length === 0, JSON.stringify(played));

// ⑤ 内心独白不外泄
await reset();
const S3 = { sessionPath: "C:\\sessions\\pulse.jsonl", sessionId: "sess_pulse" };
await decisions["messages/post-assistant"]({ session: S3, message: { role: "assistant", content: [{ type: "text", text: "<pulse>Vibe: 我在自言自语，不该被念出来。</pulse>\n结论：这次只念这句。" }] } });
await listeners["agent/settled"]({ session: S3 });
await sleep(400);
const spokenTexts = played.map((p) => p.text).join(" | ");
check("⑤ 独白不外泄（只念正文）", !spokenTexts.includes("自言自语") && spokenTexts.includes("结论"), spokenTexts.slice(0, 80));

// ⑥ 模型不可用时的降级：开场/过程静默，但收尾仍然念
await reset();
MODEL_UP = false;
const S4 = { sessionPath: "C:\\sessions\\nomo.jsonl", sessionId: "sess_nomo" };
await decisions["agent/before-start"]({ session: S4, prompt: "模型不可用时试一下" });
await sleep(300);
for (let i = 0; i < 4; i++) { await decisions["tools/pre-execute"]({ session: S4, toolName: "web_search", input: { query: `q${i}` } }); await decisions["tools/post-execute"]({ session: S4, toolName: "web_search" }); await sleep(60); }
await decisions["messages/post-assistant"]({ session: S4, message: { role: "assistant", content: [{ type: "text", text: "结论：模型挂了也把结论念出来。" }] } });
await listeners["agent/settled"]({ session: S4 });
await sleep(400);
MODEL_UP = true;
check("⑥ 降级：模型挂了仍念收尾", count("closing") === 1, `closing=${count("closing")}`);
check("⑥ 降级：开场/过程静默不报错", count("opening") === 0 && count("progress") === 0, `opening=${count("opening")} progress=${count("progress")}`);

// ⑦ 媒体引擎（豆包）路径：没配默认时应用要自己发现供应商
CFG.strategy = "media";
CFG.mediaVoice = "zh_female_qiaopinv_uranus_bigtts";
MEDIA.captured = null;
await reset();
const S5 = { sessionPath: "C:\\sessions\\media.jsonl", sessionId: "sess_media" };
await decisions["tools/pre-execute"]({ session: S5, toolName: "web_search", input: { query: "触发一次" } });
const mediaOut = await mockSdk._tool.execute({ text: "走豆包这条链试试", context: { sessionPath: S5.sessionPath } });
console.log("    [⑦ 工具返回]", String(mediaOut).slice(0, 120));
check("⑦ 媒体引擎：没配默认也能自己发现供应商", MEDIA.captured?.input?.provider === "volcengine-tts" && MEDIA.captured?.input?.model === "seed-tts-2.0-standard", JSON.stringify(MEDIA.captured || null));
check("⑦ 媒体引擎：请求形态合规（scope=app + input 嵌套）", MEDIA.captured?.scope === "app" && !!MEDIA.captured?.input, JSON.stringify(Object.keys(MEDIA.captured || {})));
check("⑦ 媒体引擎：豆包音色已传入", MEDIA.captured?.input?.voice === CFG.mediaVoice, String(MEDIA.captured?.input?.voice));
check("⑦ 媒体引擎：语速换算正确（+15% → 1.15）", MEDIA.captured?.input?.speed === 1.15, String(MEDIA.captured?.input?.speed));
CFG.strategy = "local";

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
console.log("\n密度实测：", JSON.stringify(densityCounts));
process.exit(failed ? 1 : 0);
