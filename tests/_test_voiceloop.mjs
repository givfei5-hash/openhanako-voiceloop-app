// Voiceloop 应用逻辑自测（不发声：API 指向一个死端口，链路会立刻失败）
// 跑法：node _test_voiceloop.mjs
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";  // 自测不动真实运行时配置
import app from "../voiceloop/index.js";

const logs = [];
const decisions = {};   // event -> fn
const listeners = {};   // event -> fn

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
      enabled: true,
      autoGreeting: true,
      strategy: "local",                                  // 只走 API
      ttsSource: "custom",
      apiBaseUrl: "http://127.0.0.1:9/v1",              // 死端口：立刻失败，不出声
      apiModel: "",
      apiKey: "",
      voice: "zh-CN-XiaoxiaoNeural",
      rate: "+15",
      density: "standard",                              // 标准 = 每 2 个工具步
      style: "playful",
      inspectionSilent: true,
      pythonCommand: "py",
    }),
  },
  media: {},
  providers: {},
  sessions: { list: async () => ({ sessions: [] }), context: async () => ({ model: null }) },
  models: { streamEvents: async function* () {}, cancel: async () => {} },
  tools: {
    register: async (t) => { mockSdk._tool = t; return { ready: Promise.resolve() }; },
  },
  hooks: {
    onDecision: async (evt, fn) => { decisions[evt] = fn; return { ready: Promise.resolve() }; },
    on: async (evt, fn) => { listeners[evt] = fn; return { ready: Promise.resolve() }; },
  },
};

await app.apply(mockSdk);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(200);

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
}

const SID = "C:\\sessions\\t1.jsonl";
const session = { sessionPath: SID, sessionId: "sess_1" };
const msg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

function speaksLogs() { return logs.filter((l) => /\[(opening|closing|process)\]/.test(l) && /播报完成|播报失败/.test(l)); }

// 1) 本回合第一句（开场）应无条件放行
let d = await decisions["tools/pre-execute"]({ session, toolName: "exec_command", input: { cmd: `py "$env:USERPROFILE\\.hanako\\apps\\voiceloop\\speak.py" "来啦，我先把成都的天气和玩乐查一圈，再给你排三天。"` } });
check("开场：本回合第一句无条件放行", d === undefined, JSON.stringify(d));

// 2) 还没走工具步就想说第二句 → 拦
d = await decisions["tools/pre-execute"]({ session, toolName: "exec_command", input: { cmd: `py "...\\speak.py" "我要开始了"` } });
check("档位闸：0 步时说第二句被拦", d && d.block === true, JSON.stringify(d));

// 3) 走 2 个工具步
await decisions["tools/post-execute"]({ session, toolName: "web_search" });
await decisions["tools/post-execute"]({ session, toolName: "web_search" });
d = await decisions["tools/pre-execute"]({ session, toolName: "exec_command", input: { cmd: `py "...\\speak.py" "查完一轮天气"` } });
check("档位闸：够 2 步后放行", d === undefined, JSON.stringify(d));

// 4) 同一句再来 → 拦（去重）
d = await decisions["tools/pre-execute"]({ session, toolName: "exec_command", input: { cmd: `py "...\\speak.py" "查完一轮天气"` } });
check("去重闸：同一句第二次被拦", d && d.block === true, JSON.stringify(d));
// 5) 工具路径也要过闸：再走 2 步后调工具
await decisions["tools/post-execute"]({ session, toolName: "web_search" });
await decisions["tools/post-execute"]({ session, toolName: "web_search" });
const toolOut = await mockSdk._tool.execute({ text: "又推进两步", context: { sessionPath: SID } });
check("工具路径：够步数时真的去播（返回非拦截文案）", typeof toolOut === "string" && !toolOut.includes("先不播"), String(toolOut).slice(0, 60));

// 6) 收尾：最后一条回复 + 回合结束 → 播一次
await decisions["messages/post-assistant"]({ session, message: msg("行程先放这儿：第一天市井，第二天展览，第三天近郊。要重排跟我说。") });
await listeners["agent/settled"]({ session });
await sleep(3500);
check("收尾：回合结束播一次", speaksLogs().filter((l) => l.includes("[closing]")).length === 1, JSON.stringify(speaksLogs().filter((l) => l.includes("[closing]"))));

// 7) 再来一次同样的收尾 → 不重播
await decisions["messages/post-assistant"]({ session, message: msg("行程先放这儿：第一天市井，第二天展览，第三天近郊。要重排跟我说。") });
await listeners["agent/settled"]({ session });
await sleep(3500);
check("去重闸：同样的收尾不重播", speaksLogs().filter((l) => l.includes("[closing]")).length === 1, "closing 次数=" + speaksLogs().filter((l) => l.includes("[closing]")).length);

// 8) 新会话 + 提问轮（answer_choice）→ 不播收尾
const SID2 = "C:\\sessions\\t2.jsonl";
const session2 = { sessionPath: SID2, sessionId: "sess_2" };
await decisions["messages/post-assistant"]({ session: session2, message: msg("先给你三条路子选：A/B/C。") });
await decisions["tools/post-execute"]({ session: session2, toolName: "answer_choice" });
await listeners["agent/settled"]({ session: session2 });
await sleep(14000);
const closing2 = logs.filter((l) => l.includes("[closing]") && l.includes("skipped"));
check("收尾：等用户选择的回合不播收尾", closing2.some((l) => l.includes("waiting for user")), JSON.stringify(closing2));

console.log("\n---- 摘要 ----");
console.log("全部日志：");
logs.forEach((l) => console.log("  " + l.slice(0, 140)));
console.log("播报尝试记录：");
speaksLogs().forEach((l) => console.log("  " + l.slice(0, 120)));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
