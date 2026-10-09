// Voiceloop 上线验收 · 设置项生效核查
//   办法：把应用源码整份拷到临时目录，并用“把 argv 写进日志”的探针 speak.py 顶替真身，
//   于是能看到**真实代码路径**下应用到底传了什么参数、以及哪些情况下压根没启动进程。
// 跑法：node _test_config.mjs
process.env.VOICELOOP_NO_RUNTIME_CONFIG = "1";
process.on("unhandledRejection", (e) => console.log("[unhandledRejection]", e && (e.stack || e.message || String(e))));
process.on("uncaughtException", (e) => console.log("[uncaughtException]", e && (e.stack || e.message || String(e))));
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "voiceloop");
const TMP = path.join(HERE, "_cfgtest");
const LOG = path.join(TMP, "_argv.log");

// ① 准备一份“带探针 speak.py”的应用副本
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const f of ["index.js", "manifest.json"]) fs.copyFileSync(path.join(APP, f), path.join(TMP, f));
for (const d of ["tools", "sdk"]) fs.cpSync(path.join(APP, d), path.join(TMP, d), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "speak.py"),
  `import sys, json, io\r\n` +
  `with io.open(r"${LOG}", "a", encoding="utf-8") as f:\r\n` +
  `    f.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\\n")\r\n` +
  `sys.exit(2)\r\n`,
);

const decisions = {};
const logs = [];
const CFG = {
  enabled: true,
  strategy: "edge-local",
  ttsSource: "custom",
  apiBaseUrl: "http://127.0.0.1:8137/v1",
  apiModel: "",
  apiKey: "",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+15",
  density: "standard",
  style: "playful",
  inspectionSilent: true,
  pythonCommand: "py",
};

const mockSdk = {
  dataDir: "./tmp-test-data",
  bus: {
    request: async (verb, payload) => {
      if (verb === "provider:resolve-media-model") return { error: "no default configured" };
      if (verb === "provider:media-providers") return { providers: { "volcengine-tts": { providerId: "volcengine-tts", models: [{ id: "seed-tts-2.0-standard" }], hasCredentials: true, unavailableReason: null } } };
      if (verb === "provider:models-by-type") return { models: [] };
      if (verb === "media:generate-speech") { globalThis.__media = payload; return { tasks: [{ taskId: "t1" }] }; }
      if (/resource/i.test(verb)) return { resources: [{ resource: { kind: "local-file", path: "C:\\tmp\\nope.mp3" } }] };
      if (/task/i.test(verb)) return { status: "completed", completedAt: Date.now() };
      (globalThis.__verbs = globalThis.__verbs || []).push(verb);
      return {};
    },
  },
  storage: { global: {}, agent: () => ({}) },
  logger: { info: async (m) => { logs.push(String(m)); }, error: async (m) => { logs.push("ERR " + String(m)); } },
  config: { getAll: async () => ({ ...CFG }) },
  media: {
    getTask: async () => ({ status: "completed", completedAt: Date.now() }),
    getTaskResources: async () => ({ resources: [{ resource: { kind: "local-file", path: "C:\\tmp\\nope.mp3" } }] }),
  },
  providers: {},
  sessions: { list: async () => ({ sessions: [] }), context: async () => ({ model: null }) },
  models: {
    streamEvents: async function* () {},
    cancel: async () => {},
    utility: async () => {
      const t = `探针测试第 ${(globalThis.__n = (globalThis.__n || 0) + 1)} 句口播。`;
      (globalThis.__calls = globalThis.__calls || []).push(t);
      return { text: t };
    },
  },
  tools: { register: async (t) => { mockSdk._tool = t; return { ready: Promise.resolve() }; } },
  hooks: {
    onDecision: async (e, f) => { decisions[e] = f; return { ready: Promise.resolve() }; },
    on: async () => ({ ready: Promise.resolve() }),
  },
};

const app = (await import(new URL(`file:///${path.join(TMP, "index.js").replace(/\\/g, "/")}`).href)).default;
await app.apply(mockSdk);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).join(" ")); } catch { return []; } };

const results = [];
const check = (n, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  | " + extra : ""}`); };

let seq = 0;
async function runOnce(prompt = "帮我查一下这周的天气") {
  const S = { sessionPath: `C:\\sessions\\cfg${++seq}.jsonl`, sessionId: `sess_cfg${seq}` };
  fs.rmSync(LOG, { force: true });
  logs.length = 0;
  await decisions["agent/before-start"]({ session: S, prompt });
  await sleep(2600);
  return argv();
}

// ① 音色 / 语速 / API 地址：必须原样出现在命令行里
let cmd = (await runOnce())[0] || "";
check("① 云端音色生效（-v）", cmd.includes("-v zh-CN-XiaoxiaoNeural"), cmd.slice(0, 100));
check("① 语速生效（-r）", cmd.includes("-r +15"));
check("① API 地址生效（--local-base）", cmd.includes("--local-base http://127.0.0.1:8137/v1"));

// ② API 模型 / 密钥：填了才传，且原样传
CFG.apiModel = "my-tts-model";
CFG.apiKey = "sk-FAKE-KEY-ONLY-FOR-TESTS";
cmd = (await runOnce())[0] || "";
check("② API 模型生效（--api-model）", cmd.includes("--api-model my-tts-model"), cmd.slice(0, 100));
check("② API 密钥生效（--api-key）", cmd.includes("--api-key sk-FAKE-KEY-ONLY-FOR-TESTS"));

// ③ 策略：只云端 / 只本地 / 先云端后本地
CFG.strategy = "edge";
cmd = (await runOnce())[0] || "";
check("③ 策略=只用云端（--only-edge）", cmd.includes("--only-edge") && !cmd.includes("--only-api"), cmd.slice(0, 100));
CFG.strategy = "local";
cmd = (await runOnce())[0] || "";
check("③ 策略=只用本地（--only-api）", cmd.includes("--only-api") && !cmd.includes("--only-edge"));
CFG.strategy = "edge-local";
cmd = (await runOnce())[0] || "";
check("③ 策略=云端优先（两个开关都不加）", !cmd.includes("--only-edge") && !cmd.includes("--only-api"));

// ④ 总开关：关掉后一个字都不该出声，进程也不该被拉起
CFG.enabled = false;
check("④ 总开关=关：完全不启动合成进程", (await runOnce()).length === 0);
CFG.enabled = true;

// ⑤ 巡检静默：开关两边都要有效
CFG.inspectionSilent = true;
check("⑤ 巡检静默=开：巡检不出声", (await runOnce("Hana 工作台巡检：检查待办与运行状态")).length === 0);
CFG.inspectionSilent = false;
check("⑤ 巡检静默=关：巡检也出声", (await runOnce("Hana 工作台巡检：检查待办与运行状态")).length >= 1);
CFG.inspectionSilent = true;

// ⑥ 自定义 Python 命令：用别的解释器也得能跑起来
CFG.pythonCommand = "py";
check("⑥ 自定义 Python 命令生效", (await runOnce()).length >= 1);

// ⑦ 来源设置 ttsSource：直接决定非 edge 链走豆包还是自建 API（以前这个开关是死的）
const dump = () => {};
CFG.mediaVoice = "zh_female_qiaopinv_uranus_bigtts";

// ⑦-a 云端优先 + 来源豆包 → 先试云端，失败落豆包
CFG.strategy = "edge-local";
CFG.ttsSource = "hana";
globalThis.__media = null;
let out = await runOnce();
dump("⑦-a");
check("⑦ 云端优先 + 来源豆包：先试云端（--only-edge）", (out[0] || "").includes("--only-edge"), (out[0] || "").slice(0, 80));
check("⑦ 云端优先 + 来源豆包：云端失败后落到豆包", !!globalThis.__media?.input?.provider, String(globalThis.__media?.input?.text));

// ⑦-b 只用本地 + 来源豆包 → 直接走豆包，不起自建 API 进程
CFG.strategy = "local";
globalThis.__media = null;
out = await runOnce();
dump("⑦-b");
check("⑦ 来源=豆包 + 只用本地：不起自建 API 合成进程（只允许 --play 播声）", !out.some((l) => l.includes("--local-base")), JSON.stringify(out).slice(0, 90));
check("⑦ 来源=豆包：真的调了媒体总线（豆包）", globalThis.__media?.input?.provider === "volcengine-tts" && globalThis.__media?.scope === "app", JSON.stringify(globalThis.__media || null).slice(0, 110));

// ⑦-c 来源=自建 API → 回到 speak.py auto（edge → 自建 API）
CFG.ttsSource = "custom";
CFG.strategy = "edge-local";
globalThis.__media = null;
out = await runOnce();
dump("⑦-c");
check("⑦ 来源=自建 API：云端优先时进程不限定引擎（auto）", !(out[0] || "").includes("--only-edge") && !globalThis.__media, (out[0] || "").slice(0, 80));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
