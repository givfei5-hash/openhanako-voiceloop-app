# Voiceloop — give your Hana agent a mouth (Hana v2 App)

**Opening** greets you and says what this round is about; **progress** reports milestones and what is coming next, at a cadence you choose; **closing** reads the final result aloud. All three stages are driven by the **app** (not by the agent's memory), and every line is **written by a model on the spot** — no canned templates.

**Version 2.2.1** (Hana v2 App, `manifestVersion: 2`) · License **AGPL-3.0**

Chinese docs (primary): [README.md](README.md)

---

## This is V2, not the original skill

| | **V1 · skill** ([openhanako-voiceloop-skill](https://github.com/givfei5-hash/openhanako-voiceloop-skill)) | **V2 · app** (this repo) |
|---|---|---|
| Shape | a skill + `speak.py` dual-engine bridge | a **Hana v2 App** (`manifestVersion: 2`) |
| Who decides when to speak | **the agent** — reads persona files, judges whether to speak | **the app** — hooks into `agent/before-start` / `tools/post-execute` / `agent/settled` |
| What gets said | a line the agent picks from context | the app hands *task / just finished / next / already said* to a model and writes one spoken line |
| Settings | conversational commands ("keep it quiet") | a settings page: 4 densities, 4 styles, 4 strategies, voice, rate, silent-on-patrol |
| Engines | edge-tts → local llama.cpp clone | edge-tts / Hana's built-in media engine (Doubao TTS) / any OpenAI-compatible TTS API |
| Voices | bring your own reference clip | six cloud voices ship with **pre-synthesized 24 kHz reference clips** |
| Install | skill + Python + a 2.5 GB local engine | install the app, approve permissions; the local clone is optional |

**Why an app**: V1 left *when to speak* to the agent's discipline — a busy agent goes silent for a whole round, or fills the air with template lines. V2 moves the rhythm into the app (a hard gate counting tool steps) and leaves the wording to the model: **the app owns when / how long / no repeats; the model owns how the sentence sounds human.**

V1 still lives at <https://github.com/givfei5-hash/openhanako-voiceloop-skill>.

---

## Why this only became possible after Hana 1.0

**This is not "the V1 script wrapped in an app".** It is a dedicated landing of the **v2 App system introduced by Hana 1.0** (`manifestVersion: 2`) — each mechanism added in 1.0 is used to its full extent, which is what makes a shape V1 could never reach. Requirement: **Hana ≥ `1.0.4-beta`** (declared as `minAppVersion` in the manifest).

| What Hana 1.0 added | Where this app uses it | Why V1 could not |
|---|---|---|
| **Hook decision authority** (`app/hooks.*`: `agent/before-start`, `tools-pre-execute`, `tools-post-execute`, `messages-post-assistant`, `hooks.observe`) | The *entire rhythm* of the three stages: opening itself on the first turn, tool-step counting for progress, intercepting the final answer for closing | A skill could only be invoked when the agent remembered to — a busy agent went silent for a whole round |
| **Settings contribution** (`contributes.settings`, schema-driven) | Four densities, four styles, four strategies, voice, rate, silent-on-patrol — click and it applies | Only conversational commands, and the agent had to remember them |
| **Media bus + provider catalog** (`provider:media-providers`, `resolve-media-model`, `media:generate-speech`) | Doubao TTS with **zero config**; credentials managed by Hana, the app stores no TTS secrets | No access to the host media stack — bring your own engine and keys |
| **App-scoped media generation** (`{ scope: "app", input: {…} }`) | Hook-driven narration has no call token of a tool call to sit inside, so this new path is the only way to synthesize under the app's own authority and read the audio back | The path did not exist; non-tool contexts could not speak |
| **Capability ledger** (auditable, revocable per item) | 12 capabilities listed at install time, revocable at any time; whichever media link is missing is reported by name | No such mechanism; the capability boundary was invisible |
| **Tools exposed to the model** (`app/tools.expose-to-model`) | `voiceloop_speak` becomes a callable tool for the agent — and it still passes the app's cadence gate and dedupe gate (the agent cannot bypass discipline) | The agent called a script directly; whether it respected the cadence was up to its own discipline |
| **Host model capability** (`app/models.infer`) | Opening / progress / closing lines are written by the session model on the spot — no third-party copy service | Only hardcoded templates, which sound mechanical |

In one line: **V1 gave the agent a mouth and trusted its discipline; V2 uses what Hana 1.0 actually shipped** — hooks own the rhythm, the settings page owns control, the media bus owns the voice, the capability ledger owns trust. The old V1 problems (rounds going silent, mechanical templates, a 2.5 GB local engine before the first word) are only really solved here.

---

## Closing the loop: voice in, voice out

This is the expanded version of the "Closing the loop: voice in, voice out" section from V1. **Speaking is only half the loop** — the app is the *mouth*; you still need an *ear* and a *push-to-talk key* for a real conversation.

A setup that works well in the wild (Windows):

1. **The ear — WeChat IME (微信输入法) voice typing.** Its speech-to-text drops your words straight into the text field of whatever app you are in. Nothing new to install, decent Chinese.
2. **The talk key — a mouse macro (Logitech G HUB / Logi Options+).** Map a spare **side button** to the WeChat IME voice-input hotkey: **hold = recording, release = text lands in the field.** No keyboard involved.

That closes the loop:

```
hold the mouse side button, say the task, release → text goes into the chat → Hana works
                                                                              ↓
        hands never leave the mouse  ←  the app speaks  ←  opening / progress / closing
```

**Voice in → text → agent → voice out.** Press once to hand over the job, hear it narrate progress while working, and get the conclusion read back — that is what "the agent really is a voice assistant" looks like day to day.

Three notes:

- **The app does not touch your microphone.** It only handles the speaking half. Any input method slots into the same loop: system dictation, a hardware PTT key, Bridge voice from your phone, or plain typing.
- **This is a personal-configuration note, not a dependency.** WeChat IME and a Logitech mouse are not required.
- **V2 makes the loop reliable**: in V1, "should I speak now?" was the agent's own judgement and broke easily under load; in V2 the three stages are the app's hooks, so input → work → output never loses a segment.

---

## Features

**Three stages, app-driven, model-written**

- **Opening** — first turn of a new session: reads what you asked for, writes a greeting + plan (≤24 Chinese chars)
- **Progress** — between tool steps: reports *what just finished* and *what is next*, never "I am currently…"
- **Closing** — end of the turn: condenses the final answer into a spoken script, length set by style

**Four narration densities** (a hard gate on tool-step count, not the agent's counting)

| Tier | Cadence |
|---|---|
| tight | one line per tool step (most talkative) |
| standard | one line every 2 tool steps (default) |
| sparse | one line every 4 tool steps |
| quiet | process narration off — only opening + closing |

Plus a no-overlap rule (a line is never queued while another is still playing) and a 10-minute no-repeat window per sentence.

**Four styles** (tone and closing length): playful (≈140 chars) / plain (≈80) / gentle (≈220) / crisp (≈100).

**Four synthesis strategies**: cloud Edge TTS only / cloud-first with a fallback source (default) / fallback source only / Hana media engine only. The fallback source is either **Hana's built-in media engine (Doubao TTS, zero config)** or **your own OpenAI-compatible TTS API** (base URL + model + key). The app never talks to a local model process directly — expose it as an API and point the app at it.

**Discipline**

- **Patrol / heartbeat turns are completely silent** (a hard rule, not a reminder)
- **Inner monologue never leaks**: `<pulse>` / `<think>` blocks are stripped before speaking
- **Sensitive content is never spoken** (credentials, IDs, keys stay on screen)
- **Master switch**: off means zero audio and no synthesis process at all

---

## Install

Send the repo link to your Hana agent and say:

> Install this repo as an app and turn narration on.

It will clone the repo, install the directory as a v2 app, and walk you through the 12 permissions.

Manual: clone locally, then install that directory from Hana's app manager (`manifest.json`, `manifestVersion: 2`).

---

## License

**AGPL-3.0** — see [LICENSE](LICENSE).

Read it, change it, use it yourself: go ahead. But if you turn it into a service (SaaS, hosting, or a closed-source component of a commercial product), AGPL requires you to open-source your modifications too. Free riding is not a business model.

- Personal / study / self-modified use: no permission needed
- Closed-source commercial use or integration: a **commercial license** is required — open an issue or email the author
- Redistributing a modified version: keep the copyright notice and stay on AGPL-3.0

Copyright (c) 2026 givfei5-hash
