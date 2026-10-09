// Voiceloop 长任务端到端模拟（不出声：API 指向死端口）
// 验证「应用自己补的过程旁白」是否按档位出现，以及去重/收尾规则。
// 跑法：node _test_longtask.mjs tight|standard|sparse|quiet
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";
import app from "./index.js";

const DENSITY = process.argv[2] || "standard";
const EXPECT = { tight: 8, standard: 4, sparse: 2, quiet: 0 }[DENSITY];

const logs = [];
const decisions = {};
const listeners = {};
const played = [];

const mockSdk = {
  dataDir: "./tmp-test-data",
  bus: { request: async () => ({}) },
  storage: { global: {}, agent: () => ({}) },
  logger: {
    info: async (m) => {
      logs.push(String(m));
      const tag = /\[(opening|kickoff|process|progress|closing)\]/.exec(String(m));
      const t = /text=([^|]*)$/.exec(String(m));
      if (tag && t && /播报完成|播报失败/.test(String(m))) played.push({ tag: tag[1], text: t[1].trim() });
    },
    error: async (m) => { logs.push("ERR " + String(m)); },
  },
  config: {
    getAll: async () => ({
      enabled: true, strategy: "local", ttsSource: "custom",
      apiBaseUrl: "http://127.0.0.1:9/v1", apiModel: "", apiKey: "",
      voice: "zh-CN-XiaoxiaoNeural", rate: "+15",
      density: DENSITY, style: "playful", inspectionSilent: true, pythonCommand: "py",
    }),
  },
  media: {}, providers: {},
  sessions: { list: async () => ({ sessions: [] }), context: async () => ({ model: null }) },
  models: {
    streamEvents: async function* () {},
    cancel: async () => {},
    // 模拟“工具模型”：返回一句带温度的人话（验证应用用的是模型写的，不是自己的模板）
    utility: async (req) => {
      const c = JSON.stringify(req?.messages || []);
      const m = /刚完成：([^"]+)/.exec(c);
      const n = (globalThis.__n = (globalThis.__n || 0) + 1);
      if (m) return { text: `${m[1].slice(0, 12)}，接着往上比一比（${n}）。` };
      return { text: `先探探底，马上给你交个能用的（${n}）。` };
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
await sleep(200);

const SID = "C:\\sessions\\long.jsonl";
const session = { sessionPath: SID, sessionId: "sess_long" };

// 模拟助手：开场由应用说（before-start）；之后一路干活，里程碑也由应用说
await decisions["agent/before-start"]({ session, prompt: "帮我调研 2026 年二手胶片相机行情，给结论" });
await sleep(1500);

for (let i = 1; i <= 8; i++) {
  await decisions["tools/pre-execute"]({
    session, toolName: "web_search", input: { query: `${["二手胶片相机 行情","中画幅 二手 价格","大画幅 成交","便携胶片机 涨价","2026 胶片 回暖"][i % 5]}` },
  });
  await decisions["tools/post-execute"]({ session, toolName: "web_search" });
  await sleep(1200);   // 给播报留出时间（测试里链路会很快失败）
}

// 收尾：最终结论 + 回合结束
await decisions["messages/post-assistant"]({ session, message: { role: "assistant", content: [{ type: "text", text: "结论：三条线里中画幅最抗跌，便携机涨得最猛；具体型号和价位在上面那张表里。" }] } });
await listeners["agent/settled"]({ session });
await sleep(4000);

const progress = played.filter((p) => p.tag === "progress");
const closing = played.filter((p) => p.tag === "closing");
const texts = played.map((p) => p.text);
const dup = texts.filter((t, i) => texts.indexOf(t) !== i);

const results = [];
const check = (n, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  | " + extra : ""}`); };

// 过程句的实际条数受“不叠声”限制（一句要响几秒，期间不会排队），所以看量级不比精确值：
//   紧凑 ≥ 3、标准 ≥ 1、安静 = 0
const okCount = DENSITY === "quiet" ? progress.length === 0
  : DENSITY === "sparse" ? progress.length <= 3
  : DENSITY === "tight" ? progress.length >= 3
  : progress.length >= 1;
check(`档位「${DENSITY}」过程旁白（${DENSITY === "quiet" ? "=0" : "达标"}）`, okCount, `实际 ${progress.length}`);
check("收尾只播一次", closing.length === 1, `实际 ${closing.length}`);
check("没有任何一句被播两遍", dup.length === 0, JSON.stringify(dup));

console.log("\n---- 实际播出的句子 ----");
played.forEach((p, i) => console.log(`  ${i + 1}. [${p.tag}] ${p.text}`));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过（density=${DENSITY}）`);
process.exit(failed ? 1 : 0);
