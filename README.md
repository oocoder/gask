# gask

Ask **Google AI Mode** from the command line. `gask` drives a private headless
Chrome, types your question into AI Mode (`google.com/search?udm=50`), waits for
the reply, and prints the answer with the **real source URLs**. There's a JSON
mode so other tools and LLM agents can use it for research.

```console
$ gask ask "What is the capital of Peru?"
The capital of Peru is Lima.

$ gask follow "And what is its approximate population?"
Lima's population is approximately 10.1 million for the city proper, and roughly
11.5 to 12 million across the broader metropolitan area (which includes the
neighboring port city of Callao).

Sources:
[1] Lima - Wikipedia (Wikipedia)
    https://en.wikipedia.org/wiki/Lima
[2] Lima Population 2026 (World Population Review)
    https://worldpopulationreview.com/cities/peru/lima
```

## Requirements

- macOS with Google Chrome installed (other OS: set `GASK_CHROME` to the Chrome binary)
- Node.js 18+

## Install

```sh
git clone https://github.com/oocoder/gask.git
cd gask
npm install                              # installs playwright-core only; uses your Chrome
ln -s "$PWD/gask" ~/.local/bin/gask      # optional: put it on your PATH
gask selftest                            # should print PASS twice
```

There's no Google login and nothing to configure.

## Usage

| Command | What it does |
|---|---|
| `gask ask "question"` | Start a new conversation and print the answer + sources |
| `gask follow "question"` | Ask a follow-up in the same conversation |
| `gask read` | Re-print the last answer (no network) |
| `gask new` | Discard the current conversation |
| `gask diag` | Show Chrome, conversation and rate-limit status |
| `gask selftest` | Ask + follow-up round trip |
| `gask show` | Open the same profile in a visible window (for a captcha or consent page) |
| `gask stop` | Stop the background Chrome |

Options: `--json`, `--timeout <seconds>` (default 90), `--no-resolve` (keep
Google redirect links), `--stop` (shut Chrome down right after answering),
`-v` (progress on stderr). Pass `-` as the question, or
pipe it in, to read from stdin.

### JSON output

```sh
gask ask --json "your question"
```

```json
{
  "ok": true,
  "complete": true,
  "question": "...",
  "answer": "...",
  "sources": [{ "title": "...", "site": "...", "snippet": "...", "url": "https://..." }],
  "turn": 1,
  "conversationUrl": "https://www.google.com/search?...",
  "elapsedMs": 7761,
  "askedAt": "2026-11-20T16:42:53.067Z"
}
```

Errors print `{ "ok": false, "code": N, "error": "..." }`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Answer returned |
| 1 | Usage or other error |
| 2 | Timed out (a partial answer may be printed) |
| 3 | Blocked by a captcha or consent page: run `gask show`, solve it, then `gask stop` |
| 4 | AI Mode unavailable, or the page layout changed |
| 5 | Chrome not found or didn't start |

### Configuration

| Env var | Default |
|---|---|
| `GASK_CHROME` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `GASK_HOME` | `~/.gask` (browser profile, last answer, state) |
| `GASK_PORT` | `9335` (Chrome remote-debugging port) |
| `GASK_MIN_GAP_SECONDS` | `8` (minimum time between questions) |
| `GASK_IDLE_MINUTES` | `1` (background Chrome stops after this much idle time) |

## How it works

- Chrome runs headless with its own profile, separate from your normal browser.
  Any call starts it if needed. It stops by itself after 1 idle minute
  (it uses about 1 GB of RAM while running), and a cold start adds only a second or two.
  Follow-ups need Chrome still up, so ask them within the idle window or raise
  `GASK_IDLE_MINUTES`.
- AI agents: see the lifecycle and recovery rules in [OUTLINE.md](OUTLINE.md#1-for-agents-lifecycle-and-recovery).
- Headless Chrome identifies itself as `HeadlessChrome`, and Google refuses AI
  Mode for that. gask presents a normal Chrome user agent instead.
- It knows an answer is finished when the page announces "AI Mode response is ready".
- Source links are Google redirects. gask follows each one to report the destination URL.
- It runs one question at a time, with a minimum gap between questions.

Maintainer notes (DOM markers, gotchas) are in [OUTLINE.md](OUTLINE.md).

## Caveats

- **Unofficial.** There's no public AI Mode API, and automated querying is
  against Google's Terms of Service. Use it lightly, for personal research.
  Heavy use can trigger captchas or temporary blocks on your IP, which can also
  affect normal Google searching for everyone on your network. You're responsible
  for how you use it. See the notice in [LICENSE](LICENSE).
- **Answers are model output.** Check the cited sources before relying on them.
- **Privacy.** Every question is sent to Google. Don't include secrets or personal data.
- **Fragile by nature.** If Google changes the AI Mode page, extraction may break
  (exit 4 or empty answers).

## License

[MIT](LICENSE), plus an additional notice: gask is unofficial and not affiliated
with Google, Google may block IPs that send automated queries, and you use it at
your own risk.
