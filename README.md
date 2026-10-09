# Voiceloop 语音播报（Hana v2 App）

**让小花开口说话。**

（小花 = 你的 Hana 助手。名字随你起，这里只是我们对她习惯的称呼。）

对话框里它只会写字：你盯着屏幕等结果，它闷头干活、一句不吐。装上 Voiceloop，它变成会说话的那一个——**新会话先打个招呼**、**干活中间报一声进展**、**收尾把结论念给你听**。三段全由**应用通过钩子主动介入**，句子由**会话模型现写**：不是模板句，也不用你追着它问。

配上语音输入，它就是你**自己的贾维斯**：按住一个鼠标侧键把活儿说给它，它一边干一边出声汇报，你手不离鼠标（见下文「闭环输入」）。

**当前版本 2.2.4**（Hana v2 应用，`manifestVersion: 2`）· 许可 **AGPL-3.0**

English docs: [README.en.md](README.en.md)

---

## 这是 V2，不是原来那个技能

| | **V1 · 技能版**（[openhanako-voiceloop-skill](https://github.com/givfei5-hash/openhanako-voiceloop-skill)） | **V2 · 应用版**（本仓库） |
|---|---|---|
| 形态 | 一个 skill + `speak.py` 双引擎语音桥 | 一个 **Hana v2 应用**（`manifestVersion: 2`） |
| 谁决定何时说 | **助手自己**——读人设文件（personas）里的六个节点，自己判断该不该出声 | **应用**——挂在 `agent/before-start` / `tools/post-execute` / `agent/settled` 钩子上，主动介入 |
| 说什么 | 助手从上下文里挑一句话 | 应用把「任务 / 刚完成 / 接下来 / 已说过」交给模型现写一句口播稿 |
| 设置 | 靠对话里的口令（"安静点" / "别提了"） | 设置页：密度四档、风格四档、合成策略四档、音色、语速、巡检静默 |
| 引擎 | edge-tts 云端 → 本地 llama.cpp 克隆（双引擎兜底） | edge-tts 云端 / HanaAgent 内置媒体引擎（豆包 TTS）/ 自配置 OpenAI 兼容 TTS API，四档策略可切 |
| 音色 | 自备参考音 + 本地引擎 | 六个云端音色的**参考音随包预合成**（24 kHz），本地克隆开箱可用 |
| 装机 | 装 skill、配 Python、下 2.5 GB 本地引擎 | 装应用、点权限；本地克隆是可选增强，不装也能用云端出声 |

**为什么改成应用**：V1 把"什么时候说话"交给了助手的自觉——助手一忙就整轮不出声，或者被模板句填满显得机械。V2 把节奏收进应用里（工具步计数的硬闸门），把措辞交给模型现写：**应用管"何时说、说多长、别重复"，模型管"这句人话怎么说"。**

V1 依然可用，仓库留着：<https://github.com/givfei5-hash/openhanako-voiceloop-skill>

---

## 为什么这是 Hana 1.0 之后才做得出来的东西

**这一版不是"把 V1 的脚本包成应用"。** 它是 **Hana 1.0 引入的 v2 应用体系（`manifestVersion: 2`）上的专门落地**——把 1.0 新增的那几套机制逐个用到底，才做出 V1 时代根本做不到的形态。清单要求：**Hana ≥ `1.0.4-beta`**（应用清单里已声明 `minAppVersion`）。

| Hana 1.0 带来的能力 | 在本应用里落到哪儿 | V1 为什么做不到 |
|---|---|---|
| **钩子决策权**（`app/hooks.*`：`agent/before-start` / `tools-pre-execute` / `tools-post-execute` / `messages-post-assistant` / `hooks.observe`） | 三段播报的**全部节奏**：新会话第一轮自己开场、工具步计数驱动过程旁白、截获最终回复做收尾 | 技能只能"被助手想起来调用"，助手一忙就整轮不出声 |
| **设置页贡献**（`contributes.settings`，schema 驱动） | 密度四档、风格四档、策略四档、音色、语速、巡检静默——点一下即生效 | 只能靠对话口令（"安静点"），且要助手记得 |
| **媒体总线 + 供应商目录**（`provider:media-providers` / `resolve-media-model` / `media:generate-speech`） | 豆包 TTS **零配置**可用，密钥由 Hana 统一管，应用不存任何 TTS 凭据 | 拿不到宿主媒体栈，只能自己带引擎、自己管密钥 |
| **应用作用域媒体合成**（`{ scope: "app", input: {...} }`） | 钩子驱动的播报没有"所在工具调用"的 callToken，靠这条新路径才能自持权合成并把音频读回来 | 这条路径不存在，非工具调用场景发不出声 |
| **权限账本**（capability ledger，逐项可审可撤） | 12 项能力列在安装页，用户随时能收回；媒体链缺哪一项就明确报哪一项 | 无此机制，能力边界不可见 |
| **给模型暴露工具**（`app/tools.expose-to-model`） | `voiceloop_speak` 成为助手可调工具，但**仍然过应用的档位闸与去重闸**（助手绕不过纪律） | 助手自调脚本，绕不绕闸全凭自觉 |
| **宿主模型能力**（`app/models.infer`） | 开场/过程/收尾的句子由会话模型**现写**，不引第三方文案服务 | 只能写死模板句，听着机械 |

一句话：**V1 是"给助手一张嘴，靠它自觉"；V2 是"把 Hana 1.0 的新机制用到底"**——钩子拿节奏、设置页拿控制权、媒体总线拿声音、权限账本拿信任。所以 V1 时代的老毛病（整轮哑火、模板机械、装机要先下 2.5 GB 本地引擎）在 V2 里才真正消掉。

---

## 闭环输入：声音进，声音出

这是 V1 文档里那节「Closing the loop: voice in, voice out」的完整版。**语音播报只是闭环的一半**——播报负责"嘴"，你还需要"耳朵"和"对讲键"，两头接上才算真的能跟 agent 说话。

一个在 Windows 上实测好用的配置：

1. **耳朵 · 微信输入法语音输入**：它的语音转文字会把你说的话直接落到**当前光标的输入框**里，不用切应用、不用装新东西，中文识别够用。
2. **对讲键 · 鼠标宏（罗技 G HUB / Logi Options+）**：把一只**侧键**映射成微信输入法的语音输入热键——**按住=录音，松开=文字上屏**。全程不碰键盘。

于是这个环闭合了：

```
按住鼠标侧键说话 → 松开 → 文字进对话 → Hana 干活
                                      ↓
        你手不离鼠标  ← 应用播报 ← 开场 / 过程 / 收尾
```

**声音进 → 文字 → agent → 声音出**。你按一下侧键把活儿说给它，它在干活的过程中一直出声报进展，最后把结论念给你听。

这就是「贾维斯」和「语音助手」的区别：语音助手是你问一句它答一句，它是**在你不看屏幕的时候，依然把进展说清楚**——你该走开就走开，回来它已经念完了。

三条要说清的：

- **应用不读麦克风**，它只负责"出声"那一半。输入侧任何方案都能接进同一个环：系统自带听写、硬件对讲键、手机端 Bridge 语音、甚至纯打字——环是同一个环，看你手边有什么。
- **这只是一条个人配置笔记，不是依赖**。没说必须用微信输入法或罗技鼠标。
- **V2 让这个环更可靠**：V1 时"要不要出声"是助手的自觉，一忙就容易断；V2 把三段播报交给应用的钩子，输入→处理→输出这一圈不会因为助手忘了说话而缺一段。

---

## 功能

**三段播报（应用主动，句子模型现写）**

- **开场**：新会话第一轮，读你这句话要办的事，现写一句问候 + 计划（≤24 汉字）
- **过程**：按档位在工具步之间出声，报"刚完成什么、接下来做什么"，不是"正在做什么"
- **收尾**：本轮结束时把最终回复压成口播稿念出来，长短由风格决定

**四档播报密度**（由应用按工具步数硬控，不靠助手自己数）

| 档位 | 节奏 |
|---|---|
| 紧凑 | 每个工具步一句（话最多） |
| 标准 | 每 2 个工具步一句（默认） |
| 稀疏 | 每 4 个工具步一句（话很少，过程仍有个响动） |
| 安静 | 过程一句不播，只留开场 + 收尾 |

还有"不叠声"规则兜底：上一句还在响就不排下一句；同一句话 10 分钟内不重播。

**四档播报风格**（同时决定语气与收尾长度）：俏皮（≈140 字）/ 平实（≈80 字）/ 温柔（≈220 字）/ 干练（≈100 字）。

**四档合成策略**

| 策略 | 链路 |
|---|---|
| 云端 Edge TTS 优先 | 只走微软 edge-tts，断网静默 |
| 云端优先 + 来源兜底 | edge-tts 失败后按「来源」走下一跳（默认） |
| 只用来源 | 完全不碰云端 |
| HanaAgent 媒体引擎专属 | 只走豆包内部管线，不回退 |

「来源」二选一：**HanaAgent 内置媒体引擎（豆包 TTS，零配置）** 或 **自配置 OpenAI 兼容 TTS API**（本地模型 / 第三方服务，填 Base URL + 模型 + API Key 即可）。应用不直连本地模型进程——把模型部成标准 API，应用连它。

**纪律**

- **巡检 / 心跳回合全程静默**：应用在那种回合根本不出声（硬判据，不是靠提醒）
- **内心独白不外泄**：`<pulse>` / `<think>` 之类的内部块在播报前被剥掉
- **敏感内容一律不播**：凭据、证件号、密钥那类内容只留在屏幕上
- **总开关**：关掉后一个字都不出，连合成进程都不启动

---

## 安装

**把仓库链接发给你的 Hana agent**，说一句：

> 把这个仓库装成应用并开启播报。

它会克隆仓库、把目录作为 v2 应用装上，并带上 12 项权限说明让你确认。

手工装：克隆到本地 → 在 Hana 的应用管理里安装 **`voiceloop/`** 目录（目录名就是清单 `id`，里面有 `manifest.json`，`manifestVersion: 2`）。

首次安装会请求 12 项能力（见下），**其中 4 项是「云端之外的合成链路」和「播报纪律」必需的**，不给就只能用云端。

---

## 权限与它的用途

| 能力 | 用途 |
|---|---|
| `app/hooks.agent-before-start` | 新会话第一轮 → 自动开场 |
| `app/hooks.tools-post-execute` / `app/hooks.tools-pre-execute` | 工具步计数 → 过程旁白按档位出声 |
| `app/hooks.messages-post-assistant` | 记下本轮最终回复 → 收尾朗读 |
| `app/hooks.observe` | 读当前回合上下文（给模型写口播稿用） |
| `app/models.infer` | 调模型现写开场 / 压口播稿 |
| `app/sessions.read` | 读会话上下文 |
| `app/tools.expose-to-model` | 把 `voiceloop_speak` 暴露给助手（用户说"再念一遍"时用） |
| `app/process.spawn` | 起本机 Python 跑 `speak.py`（合成与播放都在 OS 层完成） |
| `app/models.read` | **读供应商 / 模型目录**：宿主没配默认语音模型时，应用靠它自己发现可用的 TTS 供应商（豆包） |
| `app/media.generate` | **调媒体引擎合成语音**（豆包那条链） |
| `app/resources.read` | **把合成出来的音频读回来播放** |

后面三项是「HanaAgent 媒体引擎（豆包）」这条链**缺一不可**的三道门——名字看着跟语音无关，但少一个就会报"没有可用的 TTS 供应商 / 没有权限"，这是我们踩过三遍才钉下来的（细节见 [`docs/architecture.md`](docs/architecture.md)）。

---

## 仓库里有什么

按 Hana v2 应用的**官方布局**组织：应用包目录名必须等于清单 `id`，所以叫 `voiceloop/`；自测套件放仓库根 `tests/`（应用目录里不放测试文件——官方打包器不排除任何文件，会把它们打进安装包）

```
├── voiceloop/                 ← v2 应用包（装的就是这个目录，目录名 = 清单 id）
│   ├── manifest.json          ← 清单：12 项能力 + 设置页 schema
│   ├── index.js               ← 应用主体：钩子、三段编排、档位闸门、去重
│   ├── tools/speak.js         ← 播报工具 + 引擎编排（策略 × 来源）
│   ├── speak.py               ← 原子引擎执行器（edge-tts / 自建 API / 播放）
│   ├── skills/voiceloop/      ← 给助手的纪律（三段由应用播，不要重复调）
│   ├── refs/                  ← 六个云端音色的 24 kHz 参考音（本地克隆用）
│   └── scripts/               ← 本地 TTS 服务 + 参考音生成器
├── tests/                     ← 离线自测套件（CI 也跑）
├── docs/architecture.md       ← 架构、部署、踩坑与实测记录
├── .github/workflows/ci.yml   ← 每次 push 跑静态检查 + 四套离线测试
├── README.md / README.en.md   ← 你在看（V2 说明 + 闭环输入）
└── LICENSE                    ← AGPL-3.0 全文
```

---

## 本地克隆音（可选）

随包 `refs/` 里有六个云端音色（晓晓 / 云希 / 晓伊 / 云健 / 云扬 / 云夏）的**参考音**，每个约 45~55 秒、**24 kHz 单声道**——24 kHz 是引擎原生采样率，16 kHz 会让克隆发闷。它们是云端音色本身，不是任何人的声音。

要跑本地合成（`tts-local` 那种部署：llama.cpp + Qwen3-TTS GGUF + 参考音），把 `scripts/tts_server.py` + 引擎目录 + 本应用 `refs/` 放到同一个目录，启动后应用设置里选「自配置 TTS API」，地址填 `http://127.0.0.1:8137/v1` 即可。参考音要重做：

```bash
py scripts/gen_ref_lively.py zh-CN-XiaoxiaoNeural
py scripts/gen_ref_lively.py zh-CN-YunxiNeural --out /path/to/tts-local/refs --out /path/to/tts-local/ref
```

---

## 自测与真机验证

仓库里的自测脚本都是**离线**的（不发声、不需要网络），在仓库根跑：

```bash
node tests/_test_launch.mjs      # 上线验收：三段自动 / 四档密度 / 去重 / 巡检静默 / 独白不外泄 / 降级
node tests/_test_config.mjs      # 设置项生效核查：用探针 python 抓真实命令行，逐项验
node tests/_test_silence.mjs     # 巡检静默 + 独白过滤
node tests/_test_longtask.mjs tight|standard|sparse|quiet
node tests/_test_verbosity.mjs   # 风格 → 收尾字数
```

最近一次的结果：上线验收 **17/17**、设置项 **17/17**、静默/独白 **5/5**、长任务四档全过；密度实测 `紧凑 9 / 标准 4 / 稀疏 2 / 安静 0`。

**真机验证（豆包链路，2026-10-09）**：`开场 4.9s / 16 字`、`过程 3.4s / 14 字`、`收尾 19.6s / 99 字`，全部由 `Hana 媒体引擎（豆包）` 出声；时长≈合成 + 把这句话播完。

---

## 发布（按 Hana v2 应用规程）

包用宿主自带的官方打包器生成（它会跑与安装同一条静态校验，失败即非零退出）：

```bash
# 1) 静态校验
node ~/.hanako/skills/hana-app-creator/scripts/validate_app.mjs --dir ./voiceloop --json

# 2) 打包：确定性 zip + <kind>-<id>-<version>.entry.json
node ~/.hanako/skills/hana-app-creator/scripts/pack_app.mjs --dir ./voiceloop \
  --publisher "givfei5-hash" --out ./dist

# 3) 校验产物
node ~/.hanako/skills/hana-app-creator/scripts/validate_app.mjs --archive ./dist/<zip> --json
```

发布三步（顺序不能反）：

1. `git push` 成功
2. 打 tag `v2.2.4`
3. 建**正式**（非草稿、非预发布）GitHub Release，把 **ZIP 与 `.entry.json` 同时**作为附件上传

市场侧：Global 官方源读 [hana-marketplace](https://github.com/liliMozi/hana-marketplace) 的索引，仓库通过 **PR 收录**（登记 `kind/id/repository/publisher`），之后新版本靠 Release 自动发现，不用每次再提 PR。

---

## 许可协议

**AGPL-3.0**（严格版权的开源协议，见 [LICENSE](LICENSE)）。

选它的原因很直接：这个项目欢迎你读、改、自用、甚至拿去改出更好的版本——**但如果你把它做成对外提供的服务（包括 SaaS / 托管 / 集成到你的商业产品里当闭源组件），AGPL 要求你同样开源你的修改**。躺赚式白嫖不成立。

- 个人使用、学习、自己改自己用：随便用，不用问
- 想闭源商用 / 集成进闭源产品：需要**商业授权**，开个 issue 或邮件联系作者
- 分发修改版：保留版权声明，并以 AGPL-3.0 继续分发

Copyright (c) 2026 givfei5-hash
