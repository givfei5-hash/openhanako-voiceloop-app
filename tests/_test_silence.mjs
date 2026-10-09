// 巡检静默 + 内部区块不外泄 自测
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";
import app from "../voiceloop/index.js";

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

// ④ 内部块 <mood>：真机曾经把 "<mood>" 直接念出来（2026-10-09）
await sleep(11500);
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "<mood>\n我现在有点困，但还想把这件事做完。\n</mood>" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(3000);
const moodOnly = spoken().filter((l) => l.includes("mood") || l.includes("困"));
check("内部块（<mood>）独白不外泄", moodOnly.length === 0, JSON.stringify(moodOnly));

// ⑤ <mood> 包着的独白 + 正文 → 只念正文
await sleep(11500);
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "<mood>困</mood>结论：三件事都过了，第五条待确认。" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(3000);
const moodMix = spoken().slice(-1)[0] || "";
check("<mood> + 正文：只念正文", moodMix.includes("结论") && !moodMix.includes("mood") && !moodMix.includes("困"), moodMix.slice(0, 90));

// ⑥ 没见过的内部块名（兜底规则）也不能外泄
await sleep(11500);
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "<whisper>心里话</whisper>正文：三条线都验过了。" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(3000);
const unknownBlock = spoken().slice(-1)[0] || "";
check("未知内部块（兜底）不外泄", unknownBlock.includes("三条线") && !unknownBlock.includes("心里话"), unknownBlock.slice(0, 90));

// ⑦ 真机补修：心跳跑在 activity 会话里（有会话文件、提示词可能不带“巡检”）
const HB = {
  sessionPath: "C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\2026-10-09T11-20-00-034Z_01a12064-3321.jsonl",
  sessionId: "01a12064-3321-7c8c-a22d-febf008a7f92",
};
const before = spoken().length;
await decisions["agent/before-start"]({ session: HB, prompt: "看看这轮有什么要处理的" });
await sleep(600);
await decisions["tools/pre-execute"]({ session: HB, toolName: "exec_command", input: { cmd: "ping" } });
await decisions["tools/post-execute"]({ session: HB, toolName: "exec_command" });
await decisions["messages/post-assistant"]({ session: HB, message: { role: "assistant", content: [{ type: "text", text: "巡检完毕。本轮：150 全绿，F 套 31 小时无重启。" }] } });
await listeners["agent/settled"]({ session: HB });
await sleep(1500);
check("心跳/桌面活动会话（activity 路径）：三段全静默", spoken().length === before, `新增 ${spoken().length - before} 条`);

// ⑧ 定时任务类会话（heartbeat 字样）同样静默
const HB2 = { sessionPath: "C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\heartbeat-20261009.jsonl", sessionId: "hb_999" };
const before2 = spoken().length;
await decisions["agent/before-start"]({ session: HB2, prompt: "定时任务：备份" });
await decisions["messages/post-assistant"]({ session: HB2, message: { role: "assistant", content: [{ type: "text", text: "备份完成。" }] } });
await listeners["agent/settled"]({ session: HB2 });
await sleep(1200);
check("定时任务会话：三段全静默", spoken().length === before2, `新增 ${spoken().length - before2} 条`);

// ⑨ 对照：普通用户会话（sessions 路径）仍要说
const before3 = spoken().length;
await decisions["messages/post-assistant"]({ session: S, message: { role: "assistant", content: [{ type: "text", text: "正文：三条线都验过了，第四条待确认。" }] } });
await listeners["agent/settled"]({ session: S });
await sleep(3500);
check("普通会话不受影响（仍要出声）", spoken().length > before3, `新增 ${spoken().length - before3} 条`);

const failed = results.filter((r) => !r).length;
console.log("\n---- 全部日志 ----");
logs.forEach((l) => console.log("  " + l.slice(0, 120)));
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
