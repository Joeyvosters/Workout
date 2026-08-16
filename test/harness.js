"use strict";
/*
 * Test harness for index.html.
 *
 * There is no build step and no framework, so tests work the way CLAUDE.md
 * describes: pull the inline <script> out of index.html, run it inside a Node
 * `vm` with stubbed window/document/localStorage/fetch, expose the internals,
 * then drive them and assert on `store`.
 *
 * loadApp(opts) returns a fresh, isolated instance of the app's guts. Because
 * BACKEND is captured once at load time from the environment, every scenario
 * that needs a different storage backend loads its own instance.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INDEX = path.join(__dirname, "..", "index.html");
const DEBUG = !!process.env.DEBUG;

/* ---------- extracting the app ---------- */
/* Mirror the deploy workflow: take the last non-empty inline <script>. Then cut
 * the auto-run init section so tests drive the app deterministically instead of
 * racing the boot-time loadStore/render/coach calls. Everything the tests need
 * (storage, parsing, the send flow) is defined above that marker. */
const INIT_MARKER = "/* ========== init ========== */";
const EPILOGUE = `
;Object.defineProperties(__out, {
  store:            { get(){ return store; }, set(v){ store = v; } },
  state:            { get(){ return state; } },
  memoryOnly:       { get(){ return memoryOnly; } },
  START:            { get(){ return START; } },
  activeKey:        { get(){ return activeKey; } },
  activeMode:       { get(){ return activeMode; } },
  storageUsable:    { get(){ return storageUsable; } },
  storageReport:    { get(){ return storageReport; } },
  lastParseRepaired:{ get(){ return lastParseRepaired; } },
  saveStats:        { get(){ return saveStats; } },
  lastSaveError:    { get(){ return lastSaveError; } },
  settings:         { get(){ return settings; }, set(v){ settings = v; } }
});
Object.assign(__out, {
  IN_ARTIFACT: IN_ARTIFACT,
  blank: blank, normalize: normalize, newId: newId,
  todayISO: todayISO, dayNum: dayNum, addDays: addDays, diffDays: diffDays,
  programDay: programDay, planLength: planLength, planEnd: planEnd, sickCount: sickCount,
  facts: facts, exercises: exercises, bestFor: bestFor,
  haveStorage: haveStorage, discoverStorage: discoverStorage,
  loadStore: loadStore, saveStore: saveStore, flush: flush, writeWithRetry: writeWithRetry,
  extractJSON: extractJSON, parseWithRetry: parseWithRetry, callClaude: callClaude,
  coachEnabled: coachEnabled,
  send: send, loadCoach: loadCoach, weeklyNote: weeklyNote,
  mergeBackup: mergeBackup, syncPlan: syncPlan, render: render,
  addBlankRow: addBlankRow, discardNewRow: discardNewRow,
  ingestParsed: ingestParsed, importParsed: importParsed, bulkImportPrompt: bulkImportPrompt
});
`;

function appSource() {
  const html = fs.readFileSync(INDEX, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((b) => b.trim());
  if (!blocks.length) throw new Error("no inline <script> found in index.html");
  let js = blocks[blocks.length - 1];
  const cut = js.indexOf(INIT_MARKER);
  if (cut === -1) throw new Error("init marker not found — did index.html change shape?");
  return js.slice(0, cut) + EPILOGUE;
}

/* ---------- DOM / environment stubs ---------- */
function makeElement() {
  const el = {
    _html: "", value: "", textContent: "", disabled: false,
    dataset: {}, style: {}, files: [], href: "", download: "",
    addEventListener() {}, removeEventListener() {},
    appendChild() { return el; }, removeChild() {}, remove() {},
    click() {}, focus() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; },
    getContext() { return {}; }
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v); }
  });
  return el;
}

/* Fixed calendar day for `new Date()` so program-day math is deterministic,
 * while Date.now() stays real time so the write pacing logic behaves normally. */
function makeFixedDate(today) {
  const RealDate = Date;
  return class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(today + "T12:00:00");
      else super(...args);
    }
  };
}

/* In-memory localStorage. `blocked:true` throws on access, standing in for a
 * browser that forbids localStorage entirely. */
function makeLocalStorage(blocked) {
  if (blocked) {
    const boom = () => { throw new Error("localStorage is blocked"); };
    return { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
  }
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m
  };
}

/*
 * A stand-in for the artifact host's window.storage.
 *   set(key, value[, shared]) / get(key[, shared])
 * Options:
 *   accept(key, value)  -> throw inside to reject a key/shape (probe loop).
 *   rateLimitMs         -> reject a real (non-probe) write within N ms of the last.
 *   calls               -> array; every set() is recorded {t, key, value}.
 */
function makeArtifactStorage(opts) {
  opts = opts || {};
  const map = new Map();
  const calls = opts.calls || [];
  let lastRealWrite = 0;
  return {
    calls,
    _map: map,
    async set(key, value) {
      const t = Date.now();
      calls.push({ t, key, value });
      if (opts.accept) opts.accept(key, value); // may throw to reject
      const isProbe = String(key).endsWith("_probe");
      if (!isProbe && opts.rateLimitMs) {
        if (lastRealWrite && t - lastRealWrite < opts.rateLimitMs) {
          throw new Error("rate limited (" + (t - lastRealWrite) + "ms)");
        }
        lastRealWrite = t;
      }
      map.set(key, value);
      return { key, value };
    },
    async get(key) {
      if (!map.has(key)) throw new Error("not found: " + key);
      return { key, value: map.get(key) };
    }
  };
}

/* ---------- loading an app instance ---------- */
function loadApp(opts) {
  opts = opts || {};
  const today = opts.today || "2026-08-10";
  const localStorage = opts.localStorage || makeLocalStorage(opts.localBlocked);
  const window = {
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
    prompt() { return null; }, alert() {}, confirm() { return true; },
    location: { href: "" }
  };
  if (opts.artifact) window.storage = opts.storage || makeArtifactStorage();

  const elById = {};
  const document = {
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
    getElementById: (id) => elById[id] || (elById[id] = makeElement()),
    createElement: () => makeElement(),
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  };

  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const context = {
    window, document, localStorage,
    navigator: { clipboard: { async writeText() {} } },
    getComputedStyle: () => ({ getPropertyValue: () => "#000000" }),
    fetch: opts.fetch || (async () => { throw new Error("unexpected fetch"); }),
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Date: makeFixedDate(today),
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, Promise,
    confirm: () => true, alert() {}, prompt: () => null,
    hdr: makeElement(), view: makeElement(), nav: makeElement(),
    console: DEBUG ? console : quiet,
    __out: {}
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(appSource(), context, { filename: "index.html:inline" });
  return context.__out;
}

/* ---------- tiny test runner ---------- */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ": " : "") + "expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  }
}
async function throws(fn, msg) {
  try { await fn(); } catch (e) { return; }
  throw new Error(msg || "expected an error but none was thrown");
}
async function run() {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok   " + t.name);
      pass++;
    } catch (e) {
      console.log("  FAIL " + t.name);
      console.log("         " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n         ") : e));
      fail++;
    }
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
}

module.exports = {
  loadApp, makeArtifactStorage, makeLocalStorage,
  test, assert, eq, throws, run
};
