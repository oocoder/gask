#!/usr/bin/env node
// gask: ask Google AI Mode (google.com/search?udm=50) a question through a
// private headless Chrome and print the answer plus resolved source URLs.
// Usage: README.md. Internals and gotchas: OUTLINE.md.

import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.GASK_HOME || path.join(os.homedir(), '.gask');
const PORT = Number(process.env.GASK_PORT || 9335);
const CHROME = process.env.GASK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIN_GAP_MS = Number(process.env.GASK_MIN_GAP_SECONDS || 8) * 1000;
const IDLE_MS = Number(process.env.GASK_IDLE_MINUTES || 30) * 60_000;
const AI_URL = 'https://www.google.com/search?udm=50&hl=en';
const BOX = 'textarea[aria-label="Ask anything"]';
const CDP = `http://127.0.0.1:${PORT}`;

const PROFILE = path.join(HOME, 'profile');
const STATE = path.join(HOME, 'state.json');
const LAST = path.join(HOME, 'last.json');
const LOCK = path.join(HOME, 'lock');

const EXIT = { OK: 0, ERR: 1, TIMEOUT: 2, BLOCKED: 3, UNAVAILABLE: 4, CHROME: 5 };

class GaskError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// ---------- small utils ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let VERBOSE = false;
const log = (...a) => { if (VERBOSE) console.error('gask:', ...a); };
const readJSON = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const state = () => readJSON(STATE);
const patchState = p => writeJSON(STATE, { ...state(), ...p });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function cdpUp() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------- lock (one query at a time) ----------
async function withLock(fn) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = Date.now() - fs.statSync(LOCK).mtimeMs;
      if (age > 240_000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new GaskError(EXIT.ERR, 'another gask call is still running (lock held); try again');
      log('waiting for another gask call to finish');
      await sleep(1000);
    }
  }
  const release = () => fs.rmSync(LOCK, { recursive: true, force: true });
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });
  try { return await fn(); } finally { release(); }
}

// ---------- chrome lifecycle ----------
function userAgent() {
  // Headless Chrome advertises "HeadlessChrome", which Google refuses for AI
  // Mode ("not currently available on your device"). Present as normal Chrome.
  let major = '157';
  try { major = execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).match(/(\d+)\./)[1]; } catch {}
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function startChrome({ headed = false } = {}) {
  if (await cdpUp()) return;
  if (!fs.existsSync(CHROME)) throw new GaskError(EXIT.CHROME, `Chrome not found at ${CHROME} (set GASK_CHROME)`);
  const args = [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--lang=en-US',
    '--window-size=1280,900', `--user-agent=${userAgent()}`,
  ];
  if (!headed) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  patchState({ pid: child.pid, headed, startedAt: Date.now() });
  for (let i = 0; i < 40; i++) { await sleep(250); if (await cdpUp()) break; }
  if (!(await cdpUp())) throw new GaskError(EXIT.CHROME, `Chrome did not open its debug port ${PORT}`);
  log(`started ${headed ? 'headed' : 'headless'} Chrome pid ${child.pid}`);
  if (!headed) startReaper();
}

function startReaper() {
  // Detached watcher: stops the headless Chrome after GASK_IDLE_MINUTES without a query.
  const r = spawn(process.execPath, [new URL(import.meta.url).pathname, '_reaper'], { detached: true, stdio: 'ignore' });
  r.unref();
}

async function reaper() {
  for (;;) {
    await sleep(60_000);
    const s = state();
    if (!s.pid || !alive(s.pid)) return;
    if (s.headed) return; // a human is using it; leave it alone
    const last = Math.max(s.lastQueryAt || 0, s.startedAt || 0);
    if (Date.now() - last > IDLE_MS && !fs.existsSync(LOCK)) { stopChrome(); return; }
  }
}

function stopChrome() {
  const s = state();
  let stopped = false;
  if (s.pid && alive(s.pid)) { try { process.kill(s.pid); stopped = true; } catch {} }
  patchState({ pid: null, headed: false });
  return stopped;
}

async function connect() {
  await startChrome();
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  return { browser, ctx };
}

function findTab(ctx) {
  const pages = ctx.pages();
  return pages.find(p => p.url().includes('udm=50')) || null;
}

async function getTab(ctx) {
  return findTab(ctx) || ctx.pages().find(p => p.url() === 'about:blank') || await ctx.newPage();
}

// ---------- page checks ----------
async function checkBlocked(page) {
  const url = page.url();
  if (/\/sorry\//.test(url)) throw new GaskError(EXIT.BLOCKED, 'Google is showing a captcha ("unusual traffic"). Run `gask show`, solve it in the window, then `gask stop`.');
  if (/consent\.google\./.test(url)) throw new GaskError(EXIT.BLOCKED, 'Google consent page shown. Run `gask show`, accept it, then `gask stop`.');
  const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '');
  if (/unusual traffic/i.test(body)) throw new GaskError(EXIT.BLOCKED, 'Google flagged unusual traffic. Run `gask show`, solve it, then `gask stop`; and slow down.');
  if (/AI Mode is not currently available/i.test(body)) throw new GaskError(EXIT.UNAVAILABLE, 'Google says AI Mode is not available for this browser (headless detection may have changed).');
}

async function openFresh(page) {
  await page.goto(AI_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await checkBlocked(page);
  try { await page.locator(`${BOX}:visible`).first().waitFor({ timeout: 15_000 }); }
  catch { await checkBlocked(page); throw new GaskError(EXIT.UNAVAILABLE, 'AI Mode input box not found (page layout may have changed).'); }
}

// ---------- ask / extract ----------
const pageState = () => {
  const h3 = [...document.querySelectorAll('h3')].filter(e => /^AI Mode reply for/.test(e.innerText));
  const live = [...document.querySelectorAll('[aria-live]')].map(e => e.innerText.trim()).filter(Boolean).join('|');
  return { n: h3.length, live, len: document.body.innerText.length };
};

async function submitAndWait(page, question, timeoutMs) {
  const before = await page.evaluate(pageState);
  const box = page.locator(`${BOX}:visible`).first();
  await box.click();
  await box.fill(question);
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  let sawThinking = false, started = false, lastLen = -1, stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(700);
    if (/\/sorry\//.test(page.url())) await checkBlocked(page);
    const s = await page.evaluate(pageState);
    if (s.n > before.n) started = true;
    if (/thinking/i.test(s.live)) sawThinking = true;
    stable = s.len === lastLen ? stable + 1 : 0;
    lastLen = s.len;
    const ready = /response is ready/i.test(s.live) && !/thinking/i.test(s.live);
    if (started && ((sawThinking && ready && stable >= 2) || stable >= 10)) return { done: true, ms: Date.now() - t0 };
    if (!started && Date.now() - t0 > 20_000) await checkBlocked(page);
  }
  return { done: false, ms: Date.now() - t0 };
}

// Runs in the page. Pulls the newest reply's text (citation chips and the source
// cards hidden so they don't pollute it) and the raw source links.
const extractLast = () => {
  const h3s = [...document.querySelectorAll('h3')].filter(e => /^AI Mode reply for/.test(e.innerText));
  const h = h3s[h3s.length - 1];
  if (!h) return null;
  const prev = h3s[h3s.length - 2];
  // Each reply carries its own hidden textarea, so only the visible main input marks the boundary.
  const mainBox = [...document.querySelectorAll('textarea[aria-label="Ask anything"]')].find(t => t.offsetWidth || t.offsetHeight);
  let c = h;
  while (c.parentElement && c.parentElement !== document.body) {
    const par = c.parentElement;
    if ((prev && par.contains(prev)) || (mainBox && par.contains(mainBox))) break;
    c = par;
  }
  const anchors = [...c.querySelectorAll('a[href*="/goto?"], a[href*="/url?"]')];
  const cards = anchors.filter(a => a.getAttribute('data-link-behavior') === 'cobrowse');
  const chips = anchors.filter(a => a.getAttribute('data-link-behavior') !== 'cobrowse');
  const hidden = [];
  const hide = el => { if (el && !hidden.some(([x]) => x === el)) { hidden.push([el, el.style.display]); el.style.display = 'none'; } };

  const sources = [];
  for (const a of cards) {
    let box = a;
    while (box.parentElement && box.parentElement !== c &&
      box.parentElement.querySelectorAll('a[data-link-behavior="cobrowse"]').length === 1) box = box.parentElement;
    // Card text is "<site> <title> <snippet>", not always newline-separated; split on the title.
    const full = box.innerText.replace(/\s+/g, ' ').trim();
    const title = a.getAttribute('aria-label') || '';
    const at = title ? full.indexOf(title) : -1;
    const site = at > 0 ? full.slice(0, at).trim() : '';
    const snippet = (at >= 0 ? full.slice(at + title.length) : full).trim().slice(0, 300);
    sources.push({ kind: 'card', title, site, snippet, href: a.href });
  }
  for (const a of chips) {
    const label = a.getAttribute('aria-label') || '';
    const own = a.innerText.replace(/\s+/g, ' ').trim();
    sources.push({ kind: 'cite', title: label || own, site: label, snippet: '', href: a.href });
    // In-sentence hyperlinks carry real words: keep them. Only hide citation chips
    // (no visible text of their own, or just the site name).
    if (own && own !== label) continue;
    let w = a;
    while (w.parentElement && w.parentElement !== c && w.parentElement.innerText.length < label.length + 14) w = w.parentElement;
    hide(w);
  }
  if (cards.length) {
    let common = cards[0].parentElement;
    while (common && common !== c && !cards.every(x => common.contains(x))) common = common.parentElement;
    if (common && common !== c) hide(common);
  }
  const text = c.innerText;
  for (const [el, d] of hidden) el.style.display = d;
  return { text, sources, turns: h3s.length, header: h.innerText };
};

function cleanAnswer(raw) {
  let t = raw.text;
  const i = t.indexOf(raw.header);
  if (i >= 0) t = t.slice(i + raw.header.length);
  const cut = t.search(/AI can make mistakes|AI responses may include mistakes/);
  if (cut >= 0) t = t.slice(0, cut);
  const junk = /^(\+\d+|Show all|Show more|AI Mode response is ready|Skip to previous prompt|Skip to next prompt|Share|Copy|Good response|Bad response)$/;
  return t.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => !junk.test(l.trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function resolveSources(page, sources, resolve = true) {
  const resolved = await Promise.all(sources.map(async s => {
    let url = s.href;
    if (resolve && /google\.[a-z.]+\/(goto|url)\?/.test(url)) {
      try {
        const r = await page.request.get(url, { maxRedirects: 0, timeout: 8000 });
        url = r.headers()['location'] || url;
      } catch {}
    }
    return { ...s, url };
  }));
  const seen = new Map();
  for (const s of resolved) {
    const prev = seen.get(s.url);
    if (!prev) seen.set(s.url, s);
    else if (prev.kind === 'cite' && s.kind === 'card') seen.set(s.url, s);
  }
  // cards (title + snippet) first, then extra inline citations
  return [...seen.values()]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'card' ? -1 : 1))
    .map(({ title, site, snippet, url }) => ({ title, site, snippet, url }));
}

async function runQuery(question, { follow = false, timeoutMs = 90_000, resolve = true } = {}) {
  return withLock(async () => {
    const wait = (state().lastQueryAt || 0) + MIN_GAP_MS - Date.now();
    if (wait > 0) { log(`rate limit: waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); }
    const { ctx } = await connect();
    let page;
    if (follow) {
      page = findTab(ctx);
      if (!page || !(await page.evaluate(pageState)).n) throw new GaskError(EXIT.ERR, 'no open conversation to follow up on; use `gask ask` first');
      await checkBlocked(page);
    } else {
      page = await getTab(ctx);
      await openFresh(page);
    }
    patchState({ lastQueryAt: Date.now() });
    const w = await submitAndWait(page, question, timeoutMs);
    patchState({ lastQueryAt: Date.now() });
    const raw = await page.evaluate(extractLast);
    if (!raw) throw new GaskError(EXIT.TIMEOUT, 'no reply appeared');
    const answer = cleanAnswer(raw);
    const sources = await resolveSources(page, raw.sources, resolve);
    const result = {
      ok: w.done && answer.length > 0, complete: w.done, question, answer, sources,
      turn: raw.turns, conversationUrl: page.url(), elapsedMs: w.ms, askedAt: new Date().toISOString(),
    };
    writeJSON(LAST, result);
    if (!w.done) result.error = `timed out after ${Math.round(timeoutMs / 1000)}s; answer may be partial`;
    return result;
  });
}

// ---------- output ----------
function printResult(r, json) {
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  if (r.error) console.error(`gask: ${r.error}`);
  console.log(r.answer || '(empty answer)');
  if (r.sources.length) {
    console.log('\nSources:');
    r.sources.forEach((s, i) => {
      const name = [s.title, s.site && s.site !== s.title ? `(${s.site})` : ''].filter(Boolean).join(' ');
      console.log(`[${i + 1}] ${name}\n    ${s.url}`);
    });
  }
}

// ---------- commands ----------
const USAGE = `gask: ask Google AI Mode from the command line (headless Chrome)

  gask ask "question"     new conversation, print answer + sources
  gask follow "question"  follow-up in the same conversation
  gask read               re-print the last answer (no network)
  gask new                discard the current conversation
  gask diag               show Chrome / tab / rate-limit status
  gask selftest           ask + follow-up round trip; prints PASS/FAIL
  gask show               reopen the same profile in a visible window (captcha/consent)
  gask stop               stop the background Chrome

  options: --json  --timeout <seconds> (default 90)  --no-resolve  -v
  question "-" reads it from stdin

exit codes: 0 ok, 1 error/usage, 2 timeout, 3 blocked (captcha), 4 AI Mode unavailable, 5 Chrome failed`;

function parseArgs(argv) {
  const o = { json: false, timeoutMs: 90_000, resolve: true, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-resolve') o.resolve = false;
    else if (a === '-v' || a === '--verbose') VERBOSE = true;
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.rest.push(a);
  }
  return o;
}

async function readQuestion(rest) {
  let q = rest.join(' ').trim();
  if (q === '-' || (!q && !process.stdin.isTTY)) q = fs.readFileSync(0, 'utf8').trim();
  if (!q) throw new GaskError(EXIT.ERR, 'missing question\n\n' + USAGE);
  return q;
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  const [cmd, ...argv] = process.argv.slice(2);
  const o = parseArgs(argv);
  if (!cmd || o.help || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(USAGE); return EXIT.OK; }

  switch (cmd) {
    case '_reaper': await reaper(); return EXIT.OK;

    case 'ask':
    case 'follow': {
      const q = await readQuestion(o.rest);
      const r = await runQuery(q, { follow: cmd === 'follow', timeoutMs: o.timeoutMs, resolve: o.resolve });
      printResult(r, o.json);
      return r.ok ? EXIT.OK : EXIT.TIMEOUT;
    }

    case 'read': {
      const r = readJSON(LAST, null);
      if (!r) throw new GaskError(EXIT.ERR, 'no previous answer');
      printResult(r, o.json);
      return EXIT.OK;
    }

    case 'new': {
      if (!(await cdpUp())) { console.log('no conversation (Chrome not running)'); return EXIT.OK; }
      const { ctx } = await connect();
      const p = findTab(ctx);
      if (p) await p.goto('about:blank');
      console.log('conversation cleared');
      return EXIT.OK;
    }

    case 'diag': {
      const s = state();
      const v = await cdpUp();
      const out = {
        chrome: v ? 'up' : 'down', port: PORT, pid: s.pid || null, headed: !!s.headed,
        userAgent: v ? v['User-Agent'] : null,
        lastQuery: s.lastQueryAt ? new Date(s.lastQueryAt).toISOString() : null,
        idleStopMinutes: IDLE_MS / 60000, minGapSeconds: MIN_GAP_MS / 1000, home: HOME,
        lockHeld: fs.existsSync(LOCK),
      };
      if (v) {
        const { ctx } = await connect();
        const p = findTab(ctx);
        out.conversation = p ? { url: p.url(), turns: (await p.evaluate(pageState)).n } : null;
      }
      console.log(JSON.stringify(out, null, 2));
      return EXIT.OK;
    }

    case 'selftest': {
      const a = await runQuery('What is the capital of Peru? Answer in one short sentence.', { timeoutMs: o.timeoutMs });
      const b = await runQuery('And what is its approximate population?', { follow: true, timeoutMs: o.timeoutMs });
      const pass1 = a.ok && /lima/i.test(a.answer);
      const pass2 = b.ok && b.turn === 2 && /\d/.test(b.answer);
      console.log(`ask:    ${pass1 ? 'PASS' : 'FAIL'} (${(a.elapsedMs / 1000).toFixed(1)}s) ${a.answer.split('\n')[0].slice(0, 100)}`);
      console.log(`follow: ${pass2 ? 'PASS' : 'FAIL'} (${(b.elapsedMs / 1000).toFixed(1)}s, turn ${b.turn}) ${b.answer.split('\n')[0].slice(0, 100)}`);
      console.log(`sources resolved: ${[...a.sources, ...b.sources].filter(s => !/google\./.test(new URL(s.url).host)).length}`);
      return pass1 && pass2 ? EXIT.OK : EXIT.ERR;
    }

    case 'show': {
      stopChrome();
      await sleep(800);
      await startChrome({ headed: true });
      const { ctx } = await connect();
      const p = await getTab(ctx);
      await p.goto(AI_URL);
      await p.bringToFront();
      console.log('Visible Chrome opened on the gask profile. Solve any captcha/consent, then run `gask stop`.');
      return EXIT.OK;
    }

    case 'stop':
      console.log(stopChrome() ? 'stopped' : 'not running');
      return EXIT.OK;

    default:
      throw new GaskError(EXIT.ERR, `unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().then(code => process.exit(code), e => {
  const code = e instanceof GaskError ? e.code : EXIT.ERR;
  const json = process.argv.includes('--json');
  if (json) console.log(JSON.stringify({ ok: false, code, error: e.message }));
  console.error(`gask: ${e.message}`);
  if (VERBOSE && !(e instanceof GaskError)) console.error(e.stack);
  process.exit(code);
});
