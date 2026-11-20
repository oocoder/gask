# gask internals (maintainer notes)

Moved verbatim from OUTLINE.md §2 and §3 (2026-11-20).

## How it works

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

## Gotchas

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
