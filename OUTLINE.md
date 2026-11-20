# gask

A CLI that asks **Google AI Mode** (`google.com/search?udm=50`) a question
through a private **headless Chrome** and prints the answer plus the real source
URLs. It's built so any model or script can call it.

Its answers are **leads, not facts**. Open the cited source before relying on
anything that matters (dates, fees, legal rules).

Use gask when you want a fast, sourced synthesis of the open web. To read
one specific page, use a fetcher or extractor instead.

Requirements: macOS with Google Chrome installed (set `GASK_CHROME` for another
path or OS), Node 18+.

---

## 0. Setup and usage

Install, commands, JSON shape, exit codes and env vars: see [README.md](README.md).
This file holds the agent operating rules (§1) and maintainer notes (§2, §3).

---

## 1. For agents: lifecycle and recovery

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
| 4 | AI Mode unavailable / input box missing | `gask stop`, retry once. If it repeats, Google changed detection or layout: report it (maintainer fix, see §3). |
| 5 | Chrome missing / didn't start | `gask stop`, retry once. Then check `gask diag` and `GASK_CHROME`. |
| any odd hang or garbage output | `gask stop`, then `gask selftest` (2 PASS = healthy) |

`gask diag` shows the Chrome state, the idle watcher, the last question time and
the lock state. Run it before reporting a problem.

**Ground rules:** at most a handful of questions per task; never put secrets,
personal or client data in a question (it goes to Google); answers are leads,
not facts.

---

## 2. How it works

- **Chrome**: launches the installed Google Chrome with `--headless=new` on
  debug port **9335**, profile `~/.gask/profile`. It's separate from any Chrome you
  use.
  It stays running between calls (each answer takes about 3 to 20s). A
  detached watcher (`gask _reaper`, pid stored in `~/.gask/state.json`) stops it
  after `GASK_IDLE_MINUTES` (default **1**) without a query. It checks every
  max(5s, idle/4), capped at 30s. Each run calls `ensureReaper()`, so a dead
  watcher gets replaced and a newer watcher supersedes an older one.
- **Memory**: about 1 GB RSS across about 11 processes, even with the trimming flags
  (`--disable-extensions`, `--disable-sync`, `--renderer-process-limit=2`,
  `--disable-features=Translate,...`). Those flags saved only about 10%. The short idle
  timeout is the real control.
- **User agent**: headless Chrome reports `HeadlessChrome`, and Google
  replies "AI Mode is not currently available on your device". gask passes a
  normal Chrome UA (major version read from `chrome --version`). Verified 2026-11-20.
- **Done detection**: the page's `aria-live` region goes from "AI Mode is thinking
  about your query" to "AI Mode response is ready". gask waits for that plus 2
  stable ticks, and falls back to about 7s of no text change.
- **Extraction**: anchors on stable English text, not obfuscated class names:
  the `h3` "AI Mode reply for ...", the visible `textarea[aria-label="Ask anything"]`,
  "AI can make mistakes". `--lang=en-US` and `hl=en` keep those strings in English.
  Citation chips and source cards are hidden while reading the text.
  Source cards are `a[data-link-behavior=cobrowse]`.
  Inline links that carry real words are kept.
- **Sources**: links are opaque `google.com/goto?url=...`. gask resolves each one
  with a no-redirect GET and reads `Location`.
- **Safety rails**: one query at a time (`~/.gask/lock`) and at least **8s between
  queries**. Captcha/consent detection returns exit 3 instead of hanging.

Env overrides: `GASK_HOME`, `GASK_PORT`, `GASK_CHROME`,
`GASK_MIN_GAP_SECONDS`, `GASK_IDLE_MINUTES`.

---

## 3. Gotchas

- **Plain HTTP doesn't work.** `curl` of the AI Mode URL returns an
  "enable JavaScript" shell with no answer. A real browser engine is required.
- **No public API.** Automated querying is against Google's terms. Keep usage to
  a handful of questions at a time. Heavy use risks captchas or a temporary block
  on your IP, which affects normal Google searching too.
- **Fresh profiles get checked.** The first run on a new profile was redirected
  through Google's abuse check and auto-exempted (`google_abuse=...EXEMPTION` in
  the URL). Keep `~/.gask/profile`; don't delete it casually.
- **Hidden textareas.** Every reply block has its own hidden textarea. Only the
  *visible* "Ask anything" box marks the conversation boundary.
- **Card text isn't newline-separated.** Site, title and snippet are split by the
  card's `aria-label` (title), not by lines.
- **Layout changes** will surface as exit 4 or empty answers. Re-probe the DOM
  with a visible window (`gask show`) and update the markers in `extractLast`.
- **Privacy**: every question goes to Google. Never put secrets, SSNs, client
  data or anything private in a question.
- **Answers are model output**: they can be wrong or stale, even when they cite a
  source. Check the source itself before acting on dates, fees or rules.
