// 巡检静默 + 内部区块不外泄 自测
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";
import app from "./index.js";

const logs = [];
const decisions = {};
const listeners = {};

const mockSdk = {
  dataDir: "./tmp-test-data",
  bus: { request: async () => ({}) },
  storage: { global: {}, agent: () => ({}) },
  logger: {
    info: async (m) => { logs.push(String(m)); },
    error: async (m) => { logs.push("ERR " + String(m)); },
  },
  config: {
    getAll: async () => ({
      enabled: true, strategy: "local", ttsSource: "custom",
      apiBaseUrl: "http://127.0.0.1:9/v1", apiModel: "", apiKey: "",
      voice: "zh-CN-XiaoxiaoNeural", rate: "+15",
      density: "tight", style: "playful", inspectionSilent: true, pythonCommand: "py",
    }),
  },
  media: {}, providers: {},
  sessions: { list: async () => ({ sessions: [] }), context: async () => ({ model: null }) },
  models: {
    streamEvents: async function* () {},
    cancel: async () => {},
    utility: async () => ({ text: "这句不该出现在巡检里。" }),
  },
  tools: { register: async (t) => { mockSdk._tool = t; return { ready: Promise.resolve() }; } },
  hooks: {
    onDecision: async (e, f) => { decisions[e] = f; return { ready: Promise.resolve() }; },
    on: async (e, f) => { listeners[e] = f; return { ready: Promise.resolve() }; },
  },
};

await app.apply(mockSdk);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spoken = () => logs.filter((l) => /\[(opening|kickoff|progress|closing)\]/.test(l) && /播报完成|播报失败/.test(l));
const results = [];
const check = (n, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  | " + extra : ""}`); };

// ① 系统/巡检回合：没有会话文件路径 → 全程静默
await decisions["agent/before-start"]({ session: { sessionId: "hb_20261009", sessionPath: null }, prompt: "工作台巡检：看看有什么要处理的" });
await sleep(800);
check("巡检回合：开场不播", spoken().length === 0, JSON.stringify(spoken()));

await decisions["messages/post-assistant"]({ session: { sessionId: "hb_20261009", sessionPath: null }, message: { role: "assistant", content: [{ type: "text", text: "一切正常。" }] } });
await listeners["agent/settled"]({ session: { sessionId: "hb_20261009", sessionPath: null } });
await sleep(1200);
check("巡检回合：收尾不播", spoken().length === 0, JSON.stringify(spoken()));

await decisions["tools/pre-execute"]({ session: { sessionId: "hb_20261009", sessionPath: null }, toolName: "web_search", input: { query: "巡检用的搜索" } });
await sleep(600);
check("巡检回合：过程不播", spoken().length === 0, JSON.stringify(spoken()));

// ② 正常会话，但助手消息是 <pulse> 独白 → 收尾不能念它
const S = { sessionPath: "C:\\sessions\\x.jsonl", sessionId: "sess_x" };
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "<pulse>\nVibe: 我在自言自语。\nEcho:\n  - 一些内心活动\n</pulse>\n" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(4500);
const pulseSpoken = spoken().filter((l) => l.includes("Vibe") || l.includes("<pulse>"));
check("独白（<pulse>）不外泄", pulseSpoken.length === 0, JSON.stringify(pulseSpoken));

// ③ 正常会话：独白 + 结论 → 只念结论
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "<pulse>Vibe: 有点兴奋。</pulse>\n结论：三条线里中画幅最抗跌，具体型号在上面那张表。" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(4500);
const last = spoken().slice(-1)[0] || "";
check("正常会话：收尾念的是正文", last.includes("结论") && !last.includes("Vibe"), last.slice(0, 90));

const failed = results.filter((r) => !r).length;
console.log("\n---- 全部日志 ----");
logs.forEach((l) => console.log("  " + l.slice(0, 120)));
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
