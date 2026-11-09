# dsh-todo

[English](README.md) | [简体中文](README.zh-CN.md)

Long-running DSH sessions drift: the model writes a todo list, works for fifty steps, and stops checking it. This plugin keeps that list in view. It reuses the existing `todo_write` tool, nudges the model only when the list has gone stale for a while, and restores the current open list into DSH runtime context after compaction. It adds no new tool, no new turn, and no extra storage.

## Requirements

- Node.js ≥24.9
- A DSH profile that already provides `todo_write`, tools, session-projection and system-prompt services

Verified against DSH 0.2.1-rc.2 (bundled with Desktop), 0.2.2-rc.1 (installed CLI), and the adjacent `deepseek-harness` source.

## Installation

1. Install dependencies in the checkout:

   ```sh
   cd <path-to-dsh-todo>
   npm ci
   ```

2. Register the plugin as a link in your profile:

   ```sh
   dsh plugin --profile <profile> add link:<path-to-dsh-todo>
   ```

Replace `<profile>` with the profile you actually use. The plugin is loaded through `dsh.bundle.patch`; running `pnpm add` inside the profile directory alone does not enable the bundle. If the older `@bewaremypower/dsh-todo-reminder` is still enabled, remove it first — otherwise you get duplicate reminders and colliding entry IDs.

`desktop` is managed exclusively by Electron. Install there through Desktop → Plugins → Add plugin, using the same `link:<path-to-dsh-todo>` address; the CLI rejects `dsh plugin --profile desktop`.

Inside `dsh-TUI`, install into the profile its DSH backend actually selects. The plugin ships no TUI panel: the list renders wherever todos already render, and reminders arrive as model-visible notices. Other backends such as Claude/Codex never run these DSH hooks. The TUI has not been tested against this project.

## Behavior

- The list tracks only successfully committed `todo/write` calls. Failed or rejected tool calls do not reset the counters.
- Each non-empty committed assistant response that isn't pure reasoning counts as one step. Parallel or nested tool calls inside a single response add no extra steps. Failed model attempts, tool results, and compaction replacement copies do not count.
- A reminder fires after at least 10 steps since the last successful write **and** at least 10 since the last reminder; later reminders repeat at intervals of at least 10 steps. Both thresholds are configurable.
- Lists that were never created, were cleared, or are fully completed get no reminders. A real user message grants a fresh grace period. `turn/start` clears list state, matching the DSH todo tool.
- The reminder is queued before the next permitted model request and recorded by the agent loop as a `user/message`. Rejected steps, cancelled requests, and steps without permitted `todo_write` use get nothing.
- The open list is contributed to DSH through `systemPrompt.context()`. DSH re-records it when the list changes or when compaction drops the snapshot, and deduplicates unchanged content. At most 20 open items are shown, each description capped at 240 UTF-16 code units, and any remainder is summarized as a count.
- The reminder leaves an accurate list untouched. The plugin never starts a turn, never blocks completion, and never completes, deletes or cancels tasks on its own.

## Configuration

Override the bundle entry in the profile's Cordis patch:

```yaml
- id: todo-reminder
  config:
    staleAfterSteps: 10
    repeatEverySteps: 10
    restoreContext: true
```

| Key | Default | Effect |
| --- | --- | --- |
| `staleAfterSteps` | `10` | Steps since the last successful write before the list counts as stale. |
| `repeatEverySteps` | `10` | Steps between reminders once the list is stale. |
| `restoreContext` | `true` | Contribute the open list via `systemPrompt.context()`. Set `false` to keep reminders but drop the snapshot. |

Both intervals must be positive safe integers, and the first reminder must satisfy both. With `staleAfterSteps: 5` and `repeatEverySteps: 10`, for example, the first reminder still waits at least 10 steps.

## State and scope

`src/projection.js` registers a host-only projection. Its pure functions replay committed events into the list plus the two counters; DSH owns checkpoints, restore and event-driven updates. The projection is a derived cache — `todo/write` stays the single source of the list. No extra files, no calls to the deprecated synchronous history-scanning API.

On DSH 0.2.2, `index.js` checks availability against the tool set resolved for each assembly. 0.2.1 has no step-time admission, so it falls back to the visibility of that version's tools registry. The projection likewise supports 0.2.1's registration disposer and key-based reads alongside 0.2.2's async reader handle. The pre-step waterfall preserves downstream rejections, messages and request-series marks. Ordinary reminders and "keep going until the goal is done" execution control are separate concerns; this plugin implements only the former.

The design follows the dual-counter reminder in CC's restore source and Grok's post-compaction task snapshot. Persistent-execution machinery — end-of-turn TodoGate, OpenCode Goal — is out of scope.

## Development and verification

```sh
npm run check
DSH_SOURCE=/absolute/path/to/deepseek-harness npm run test:integration
DSH_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' npm run test:integration
npm pack --dry-run
```

`check` runs syntax checks plus the standalone behavior tests. Integration tests need a DSH source checkout with dependencies installed (tsx included) and look for an adjacent `../deepseek-harness` by default. The launcher resolves workspace packages to the source only inside the child process; a missing zod link in the checkout falls back to this project's installed dependency, without touching harness files or `node_modules`.

`DSH_RUNTIME` mode runs directly against the runtime libraries in the install directory — no tsx, no source. Source mode and both installed versions run the same suite.

The suite drives a real agent loop, session, projection registry, todo tool and tool executor, mocking only the model and the read tool. It covers parallel-call counting, reminders actually reaching requests and logs, failed writes, unload/reload mid-run, and recovery after snapshot replacement. Passing source revision: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Passing installs: Desktop 0.2.1-rc.2, CLI 0.2.2-rc.1. No API key required — these tests prove the plumbing, not that a real model will obey the reminder.
