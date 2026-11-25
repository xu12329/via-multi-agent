# Architecture & Module Map

This document summarizes the internal modules, role boundaries, Concord messaging lifecycle, and security controls of `via-multi-agent`.

## Module Map

| Path | Responsibility |
|---|---|
| `local/claude-bridge.mjs` | Bridges Claude Code MCP stdio connections per project workspace to the shared controller daemon. |
| `local/server.mjs` | Core controller daemon: MCP tool handlers (`start`, `steer`, `followup`, `stop`, `board`, `history`, `list`, `coordinator_inbox`, `reminders`, etc.), task lifecycle, wake scheduling, and supervisor integration. |
| `local/backend.mjs` | Spawns and speaks JSON-RPC with `codex app-server` and `agy acp`; disables Codex native multi-agent delegation so child workers always go through Via. |
| `local/concord.mjs` | Enrolls every coordinator, supervisor, depth-1 worker, and depth-2 leaf into scoped Concord sandboxes (`/usr/bin/sandbox-exec`), enriches `inspect_work` peer discovery with `role`/`depth`/`parentId`, passes `parent_task_id` on `start_work`, and enforces leaf isolation. |
| `local/delegation.mjs` | Implements `spawn_worker` and `child_status` for active depth-1 non-supervisor workers (max 6 children per parent, idempotent by `requestId`). |
| `local/sol-supervisor.mjs` | Durable SQLite state machine (`sol-supervisor.sqlite`) tracking worker turn/heartbeat/stall/error events and deduplicating supervisor wakes. |
| `local/history.mjs` | Append-only SQLite WAL event store (`history.sqlite`) with session groups, delivery/read/reply evidence, and `mail_summaries` storage. |
| `local/mail-summaries.mjs` & `local/mail-summary-provider.mjs` | Bounded-concurrency (`concurrency: 3`) retry queue calling an optional OpenAI-compatible endpoint (`VIA_SUMMARY_*`). |
| `hooks/register.ts`, `hooks/panel.ts`, `hooks/desk.ts` | Registers `/via-panel` and `/via-desk` commands inside Claude Code and injects `_viaClaudeSession` on tool calls. |
| `desk/open.mjs`, `desk/service.mjs`, `desk/preview-http.mjs`, `desk/index.html` | Single-instance local web dashboard with bearer hash-fragment auth (`#desk=<key>`), live board polling, SQLite replay, and relationship graph. |

## Role & Capability Matrix

| Role | `depth` | Concord ID Pattern | Can Spawn Leaves? | Can Message | Special Tools |
|---|---|---|---|---|---|
| `coordinator` | `0` | `coordinator-<N>` | Top-level `start` | Any peer (via `start`/`steer`/`followup`) | Full controller MCP surface |
| `supervisor` | `1` | `supervisor-<N>` | No | Group peers & `coordinator-*` | `group_status`, `group_history`, `group_list`, `steer_worker`, `followup_worker`, `stop_worker` |
| `worker` | `1` | `codex-<N>` / `agy-<N>` | Yes (`spawn_worker`, max 6) | Group peers & `coordinator-*` | `spawn_worker`, `child_status`, `report_stage` |
| `leaf` | `2` | `codex-<N>` / `agy-<N>` | No | Direct `parentId` **only** | `report_stage` |

## Delivery & Reporting Lifecycle

1. Sending via `update_work(operation: "prompt")` records `message_sent` (`queued`) and wakes the target worker via `steer` (if running) or `prompt` (if idle / `waiting_inbox`).
2. `inspect_work(agent_id)` records real consumption (`message_read`), updates board state, and links worker replies (`message_reply`, `providerPhase: 'replied'`).
3. Messages addressed to `coordinator-*` mark `forCoordinator: true` and surface as `unreadCoordinatorCount` in `/via-panel`, `/via-desk`, `list`, and `coordinator_inbox` without interrupting Claude Code unless `reminders({ action: 'open' })` was explicitly called.
