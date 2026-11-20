# gask for agents: lifecycle and recovery

Moved verbatim from OUTLINE.md §1 (2026-11-20). Install, commands, JSON shape, exit codes and env vars: [README.md](../README.md).

**You don't need to start anything.** Every `gask ask` / `gask follow` starts the
headless Chrome if it's down. The commands are idempotent: running `gask stop`
when nothing is running is fine, and any call after a stop starts Chrome again.

**It shuts itself off.** Chrome uses about 1 GB of RAM while up. A detached idle
watcher stops it after **1 minute** with no question (`GASK_IDLE_MINUTES`).
Every call checks the watcher and replaces it if it died. A cold start
adds only about 1 to 2s (measured: a cold `ask` took 5s total).

| Situation | Do this |
|---|---|
| One question, done | `gask ask --stop "..."`: Chrome stops right after the answer |
| Several related questions | `gask ask`, then `gask follow` within 1 min of each answer, then `gask stop` when finished |
| Long research session (thinking or reading between questions) | `GASK_IDLE_MINUTES=10 gask ask ...` (set it on every call), then `gask stop` at the end |
| `follow` says "no open conversation" | Chrome idled out and the conversation is gone. `gask ask` again and restate the context in the question. |
| Finished with gask | `gask stop` (always safe) |

**Recovery by exit code** (`--json` also returns `code`):

| Exit | Meaning | Agent action |
|---|---|---|
| 0 | ok | Use the answer and verify key claims against `sources[].url` |
| 1 | error / usage / lock held | Read the message. "Lock held" means another gask call is running; wait and retry once. |
| 2 | timeout (partial answer may be printed) | `gask stop`, then retry **once** with `--timeout 150`. If it fails again, report it and fall back to other research tools. |
| 3 | **captcha / unusual traffic / consent** | **Stop querying. Don't retry in a loop**: retries make the block longer. Run `gask stop`, then tell the human: "gask hit a Google captcha: run `gask show`, solve it in the window, then `gask stop`." Use other research tools meanwhile. |
| 4 | AI Mode unavailable / input box missing | `gask stop`, retry once. If it repeats, Google changed detection or layout: report it (maintainer fix, see [INTERNALS.md](INTERNALS.md#gotchas)). |
| 5 | Chrome missing / didn't start | `gask stop`, retry once. Then check `gask diag` and `GASK_CHROME`. |
| any odd hang or garbage output | `gask stop`, then `gask selftest` (2 PASS = healthy) |

`gask diag` shows the Chrome state, the idle watcher, the last question time and
the lock state. Run it before reporting a problem.

**Ground rules:** at most a handful of questions per task; never put secrets,
personal or client data in a question (it goes to Google); answers are leads,
not facts.
