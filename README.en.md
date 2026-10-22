# dsh-session-handoff

[简体中文](./README.md) | English

> One extra button beside DSH's send button: summarize the current session, consolidate its memory, write a handoff document, review it in an editable preview, then continue in a fresh session that already knows what happened.

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933)](./package.json)

Long tasks eventually hit three walls: the context window fills up, you want a different model or
preset, or you have to hand the work over. The expensive part is never "open a new session" — it is
**re-explaining everything that already happened**.

This plugin turns that into one click:

1. Read the current session log (read-only).
2. Extract deterministic facts: user asks, assistant progress, tool calls, failures, touched files, model route.
3. Ask the configured model for a fixed five-part handoff (goal / done / decisions / state / next steps + memory candidates).
4. Write `WorkSummary.md`, `handoff.json` and a de-duplicated memory ledger into the session workspace.
5. Show an editable preview (prompt text, reference-file checkboxes, memory candidates) — or skip it with `preview: false`.
6. Open a fresh session in the same workspace with the confirmed prompt pointing at the handoff document and reference files.

The original session is untouched. Nothing is forked, so the new session starts clean and cheap.
If the model is unavailable, slow, or returns invalid JSON, the plugin degrades to a deterministic
summary and still produces a usable document.

## Install

```bash
dsh plugin --profile desktop add dsh-session-handoff
```

Or from a local checkout while developing:

```bash
dsh plugin --profile desktop add link:/path/to/dsh-session-handoff
```

## What you get

```text
<workspace>/.dsh-handoff/
├── 20261023-031500-session-handoff/
│   ├── WorkSummary.md      # human: five-part handoff + tool appendix
│   └── handoff.json        # machine: schema dsh-session-handoff/v1
└── 交接记忆.md              # cross-session preference/convention ledger (append, de-duplicated)
```

## Configuration

Everything is optional. Add a `config:` block to the bundle patch row:

```yaml
- insert:
    - id: session-handoff
      name: dsh-session-handoff
      config:
        dir: .dsh-handoff
        writeMemory: true
        preview: true          # true = editable preview first; false = open immediately (v0.1)
        autoSend: false        # when preview is off: send immediately instead of prefilling a draft
        provider: ''           # empty = reuse the session's last request route
        model: ''
        maxTokens: 4096
        maxInputChars: 80000
        promptCharBudget: 6000
```

## Safety

- Read-only on the session: no events are appended, no title/compaction state changes.
- Writes stay under the session `cwd`; paths are validated, files are written atomically with mode 0600 and never overwritten.
- Same-origin only: `POST /session-handoff/prepare` requires `x-dsh-handoff: 1` plus a matching `Origin`.
- No new network egress: the summary uses the model route DSH is already configured with.

## Development

```bash
pnpm install
pnpm run bundle
pnpm run typecheck
pnpm run verify             # 31 artifact-contract checks
node scripts/smoke.mjs      # 44 host-side end-to-end checks (fake ctx + strict proxy)
node scripts/smoke-client.mjs # 34 client-bundle checks (real bundle + real React SSR)
node scripts/smoke-parity.mjs # 5 prompt-parity checks (server promptText ≡ client composePrompt)
pnpm run check              # everything above
```

Baseline: DSH `0.2.1-rc.2`, node 24 — `tsc` clean, `verify` 31/31, host `smoke` 44/44, client `smoke:client` 34/34, `parity` 5/5.

## Docs

All design docs are currently in Chinese:

- [01 DSH plugin mechanism](./docs/01-DSH插件机制分析.md)
- [02 Related plugins survey](./docs/02-同类插件调研.md)
- [03 Technical design](./docs/03-技术设计.md)
- [04 Feasibility analysis](./docs/04-可行性分析.md)
- [05 Product design](./docs/05-产品设计.md)
- [06 v0.2 plan & delivery](./docs/06-v0.2实施计划与交付.md)

## License

MIT © 2026 yangsong608
