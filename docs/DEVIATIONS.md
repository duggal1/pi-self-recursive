# DEVIATIONS — Orchestra (from architecture.md)

## S0 verified (2026-11-07, see docs/RECON.md)

| # | Architecture.md assumption | Reality in fork | Deviation |
|---|---|---|---|
| D1 | RPC steer/follow-up queueing | Exists natively (`prompt/streamingBehavior`, `steer`, `follow_up`, `abort`) | Use RPC push at safe points (Agent queues drain between tool calls). Pull fallback (extension polls inbox on `before_agent_start`/`context`) kept only if a delivery is missed; reconciler redelivers. |
| D2 | Extensions can block tool calls | `tool_call` → `{block:true,reason}`; `Agent.beforeToolCall` block | Guard = `tool_call` handler asking supervisor over HTTP. No core edit. |
| D3 | Agent-end hook for goal loops | `agent_end`/`agent_before_settle`/`agent_settled`/`turn_end` + `finishTurn` | Goal loop external to agent (supervisor runs checks, re-prompts). Hooks not required; supervisor observes events via RPC. |
| D4 | MCP must be wrapped as extension tool if not native | MCP is native (built-in extension + `pi-mcp` client) | `shotd` is a plain MCP stdio server, added to `mcp.json`. Optional `direct` exposure; no wrapper extension needed. |
| D5 | Unix socket for agent→supervisor IPC | Pi extensions can `fetch()` localhost | Use `http://127.0.0.1:<port>` (stored in DB, injected via `ORCHESTRA_SUPERVISOR_URL`). RPC JSONL still carries agent events/control. |
| D6 | Session resume from file | JSONL tree, `--session`/`switch_session` | Store `session_file` + `sessionId` per agent; restart reopens same file. |
| D7 | Per-role provider/model | `createAgentSession({model})` + RPC `set_model` | Worker model and `proxy-me` model configured separately in supervisor config; no new provider code. |
| D8 | SQLite WAL + JSONL | Node v26 `node:sqlite` available; sessions are already JSONL | Supervisor uses `node:sqlite` (`PRAGMA journal_mode=WAL, synchronous=NORMAL`) + Pi session JSONL. No Redis/Kafka/better-sqlite3 dep. |
| D9 | shotd WebP via CDP | `Page.captureScreenshot` emits jpeg/png | Capture PNG → `sharp` → WebP (quality/lossless). Model view via CDP `clip.scale` or `sharp` resize. |
| D10 | Image long-edge 2576/1568 | Per-model `inputLimits.images.resize` | Default `maxLongEdge=1568`; per-model override map. Never return oversized image. |

## S1–S10 notes
- Filled as stages complete. See `docs/ORCHESTRATION.md` for how to run.

## v2 (2026-11-07)

| # | Change | Detail |
|---|---|---|
| D11 | HTTP auth | Per-agent Bearer token (migration v2). 127.0.0.1 only. Missing/wrong/cross-agent → 401. Tests in product.test.ts. |
| D12 | CDP session routing | `sessionId` top-level (flatten), not in params. Fixes real Chrome capture. |
| D13 | Faux at load | Faux provider registered in extension factory, not session_start, so `--model` resolves. |
| D14 | Async goal checks | `runChecksAsync` for screenshot_diff/dom_assert; sync `runChecks` kept. Lazy shotd import (off by default). |
| D15 | Supervisor product | /supervisor extension, planner prompts (versioned), watchdog gates, comms detectors, dynamic thinking rubric, report/watch, cells-based layout. Off by default. |

## Part C (desktop control, 2026-11-07)

| # | Change | Detail |
|---|---|---|
| D16 | Pinned upstream | agent-desktop is external (vercel-labs, Apache-2.0), pinned at exact **1.0.2**. Doctor compares the exact version string and exits non-zero on mismatch. Upstream HEAD observed at 1.2.0 (envelope 2.6) was used for research only. |
| D17 | Envelope contract | Every command prints one JSON envelope `{version:"2.6", ok, command, data?|error?{code, message, suggestion?, recovery?, platform_detail?, details?, disposition:{delivery, retry}}}`; exit 0/1/2. Success `data` varies per command (snapshot carries `app, snapshot_id, ref_count, complete, tree`; screenshot carries base64 `data` or `path`+dims). |
| D18 | Capability gate | `desktop` is OFF by default. Task declares via env: `ORCHESTRA_DESKTOP_CAPABILITIES` must include `desktop`, `ORCHESTRA_DESKTOP_ALLOWED_APPS` lists apps, `AGENT_DESKTOP_BIN` overrides the binary. Tool fails closed with an error when missing; `tool_call` blocks `bash` containing `agent-desktop` without the capability. Retry only when `disposition.retry === "safe"` (max once, read-only commands only). |
| D19 | App leases (client-side) | Resource `app:<name>`, non-blocking file lease (O_EXCL, 30s TTL, expiry reclaim). No supervisor `/app-lease` endpoint exists and this part may not edit supervisor/core, so leases coordinate across processes via `.orchestra/desktop-leases` (0600), not the SQLite `leases` table. Carry-over: add supervisor `/app-lease` and switch. |
| D20 | Events (metadata only, deferred) | Desktop event metadata is command/app/ok/error/ref-count only; snapshot trees and screenshots are payloads written to 0600 run-scoped artifacts referenced by sha256 with TTL cleanup. The supervisor has no `/event` endpoint, so durable `events` rows are deferred; tool results carry the same metadata subset verbatim. Carry-over: add `/event` (metadata-only) when the supervisor part lands. |
| D21 | shotd resizer reuse | Desktop screenshots reuse shotd's `resizeForModel` (dynamic import `@earendil-works/pi-shotd/image`, added as a pinned dep). No resize math is duplicated; shotd stays the web-pages tool. Falls back to the original buffer when shotd is unavailable. |
| D22 | Bench honesty | `doctor --bench` prints latency, refs, named refs, and completeness per app; `complete=false` or unnamed refs print `POOR TREE` in plain words and fail the run. No real-machine results yet (smoke gated by `ORCHESTRA_DESKTOP_REAL_SMOKE=1`; permission not granted here). |
