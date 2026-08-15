"use strict";
/*
 * Regression suite for index.html. Each case here maps to a bug that has
 * actually broken this app before (see CLAUDE.md "Cases that have broken
 * before"). Run with:  npm test   (or  node test/tests.js ,  DEBUG=1 for logs)
 */

const { loadApp, makeArtifactStorage, test, assert, eq, throws, run } = require("./harness");

/* ============================================================ storage ==== */

test("storage: healthy artifact host round-trips a save", async () => {
  const app = loadApp({ artifact: true });
  await app.discoverStorage();
  eq(app.storageUsable, true, "storage should be usable");
  eq(app.activeKey, "strength:main", "first candidate key should win");
  eq(app.activeMode.id, "string,shared", "first write mode should win");

  app.store = app.normalize({});
  app.store.protein.push({ id: app.newId(), date: "2026-08-10", grams: 150 });
  const ok = await app.saveStore();
  assert(ok !== false, "save should succeed");
  eq(app.memoryOnly, false, "should not fall back to memory");
});

test("storage: host that rejects a value shape/key outright is probed around", async () => {
  // Accept only object-shaped values written under a key beginning "strengthTracker".
  // That forces discoverStorage past every mode of the first key candidate.
  const storage = makeArtifactStorage({
    accept(key, value) {
      const okShape = value && typeof value === "object" && typeof value.data === "string";
      const okKey = String(key).startsWith("strengthTracker");
      if (!okShape || !okKey) throw new Error("rejected: " + key);
    }
  });
  const app = loadApp({ artifact: true, storage });
  await app.discoverStorage();
  eq(app.storageUsable, true, "should find a working key/shape");
  eq(app.activeKey, "strengthTracker", "should skip to the accepted key");
  eq(app.activeMode.id, "object,shared", "should skip to the accepted shape");

  app.store = app.normalize({});
  app.store.protein.push({ id: app.newId(), date: "2026-08-10", grams: 120 });
  const ok = await app.saveStore();
  assert(ok !== false, "save should succeed on the discovered mode");
  eq(app.memoryOnly, false, "should be saving normally");
});

test("storage: rate-limited host is respected — paced writes all land", async () => {
  // The host rejects a real write that lands within 1400ms of the previous one.
  // MIN_WRITE_GAP is 1600ms, so correctly paced writes must slip under the bar.
  const calls = [];
  const storage = makeArtifactStorage({ rateLimitMs: 1400, calls });
  const app = loadApp({ artifact: true, storage });
  await app.discoverStorage();
  app.store = app.normalize({});

  app.store.protein.push({ id: app.newId(), date: "2026-08-10", grams: 100 });
  await app.saveStore();
  app.store.protein.push({ id: app.newId(), date: "2026-08-10", grams: 120 });
  await app.saveStore();

  eq(app.memoryOnly, false, "paced writes should not trip the limiter");
  const real = calls.filter((c) => !String(c.key).endsWith("_probe")).map((c) => c.t);
  assert(real.length >= 2, "expected at least two real writes, got " + real.length);
  for (let i = 1; i < real.length; i++) {
    assert(real[i] - real[i - 1] >= 1400, "writes spaced " + (real[i] - real[i - 1]) + "ms — too close");
  }
});

test("storage: identical payload is skipped, not rewritten", async () => {
  const app = loadApp({ artifact: true });
  await app.discoverStorage();
  app.store = app.normalize({});
  app.store.protein.push({ id: app.newId(), date: "2026-08-10", grams: 100 });
  await app.saveStore();
  const writes = app.saveStats.writes;
  await app.saveStore(); // nothing changed
  eq(app.saveStats.writes, writes, "unchanged payload must not add a write");
  assert(app.saveStats.skipped >= 1, "the no-op save should be counted as skipped");
});

test("storage: absent entirely -> falls back to memory without losing data", async () => {
  const app = loadApp({ artifact: false, localBlocked: true });
  eq(app.haveStorage(), false, "no backend should be available");
  await app.loadStore();
  eq(app.memoryOnly, true, "should flip to memory-only");
  eq(app.store.restDays.length, 1, "the seeded start-day row should still be in memory");
});

/* ============================================================ parsing ==== */

test("parse: JSON with trailing prose is extracted cleanly", () => {
  const app = loadApp({ artifact: true });
  const out = app.extractJSON('{"sets":[{"exercise":"bench","weight":40,"reps":10,"sets":3}]} Great work today!');
  eq(out.sets[0].exercise, "bench");
  eq(app.lastParseRepaired, false, "a complete object should not be flagged as repaired");
});

test("parse: JSON wrapped in code fences is extracted", () => {
  const app = loadApp({ artifact: true });
  const out = app.extractJSON("```json\n{\"protein\":[{\"grams\":150}]}\n```");
  eq(out.protein[0].grams, 150);
});

test("parse: trailing commas are tolerated", () => {
  const app = loadApp({ artifact: true });
  const out = app.extractJSON('{"sets":[{"reps":10,},],}');
  eq(out.sets.length, 1);
  eq(out.sets[0].reps, 10);
});

test("parse: a truncated reply keeps the rows that made it", () => {
  const app = loadApp({ artifact: true });
  const out = app.extractJSON('{"sets":[{"exercise":"bench","weight":40,"reps":10,"sets":3},{"exercise":"row","weight":30');
  eq(app.lastParseRepaired, true, "truncation should set the repaired flag");
  eq(out.sets.length, 1, "only the complete row should survive");
  eq(out.sets[0].exercise, "bench");
});

test("parse: a reply with no JSON object throws", async () => {
  const app = loadApp({ artifact: true });
  await throws(() => app.extractJSON("I couldn't understand that one."), "expected a throw on non-JSON");
});

/* ====================================================== the send flow ==== */

test("send: an unparseable reply never discards the typed text", async () => {
  const app = loadApp({
    artifact: true,
    fetch: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "no idea what you mean" }] }) })
  });
  await app.loadStore();
  app.state.draft = "asdf qwer zxcv";
  await app.send();

  const kept = app.store.pendingRaw.find((p) => p.text === "asdf qwer zxcv");
  assert(kept, "raw text must be preserved in pendingRaw");
  eq(kept.status, "failed", "the failed parse should be marked failed, not dropped");
  eq(app.state.draft, "asdf qwer zxcv", "the draft should not be cleared on failure");
});

test("send: sick day logged with sets extends the plan before goal dates are set", async () => {
  // A sick day and a set arrive in the same breath, plus a goal with no date.
  // The plan must already be 31 days when the goal's target date is computed,
  // otherwise the goal points a day short.
  const reply = JSON.stringify({
    sets: [{ date: "2026-08-10", exercise: "press", weight: 40, reps: 8, sets: 3 }],
    restDays: [{ date: "2026-08-10", type: "sick", notes: "flu" }],
    goals: [{ exercise: "press", baseline: "40x8", target: "45x8" }]
  });
  const app = loadApp({
    today: "2026-08-10",
    artifact: true,
    fetch: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: reply }] }) })
  });
  await app.loadStore();
  app.store = app.normalize({}); // clean slate: no seeded sick day
  eq(app.planLength(), 30, "baseline plan is 30 days");

  app.state.draft = "did press 40 for 8 three sets but came down with the flu, goal 45x8";
  await app.send();

  eq(app.sickCount(), 1, "the sick day should be counted");
  eq(app.planLength(), 31, "the plan should extend by the sick day");
  eq(app.planEnd(), "2026-09-02", "finish line should move out one day");

  const goal = app.store.goals.find((g) => g.exercise === "press");
  assert(goal, "the goal row should have been created");
  eq(goal.targetDate, "2026-09-02", "goal date must use the extended (31-day) finish line");

  const set = app.store.sets.find((s) => s.exercise === "press");
  assert(set, "the set row should have been created");
  assert(set.phase, "the set row should have a phase assigned");
});

/* =================================================== program-day math ==== */

test("clock: sick days pause the program day, rest days do not", () => {
  const app = loadApp({ today: "2026-08-10" });
  app.store = app.normalize({
    meta: { start: "2026-08-03" },
    restDays: [
      { id: "a", date: "2026-08-05", type: "sick", notes: "" },
      { id: "b", date: "2026-08-06", type: "planned", notes: "" }
    ]
  });
  eq(app.sickCount(), 1, "one sick day");
  eq(app.planLength(), 31, "sick day extends the plan; rest day does not");
  eq(app.planEnd(), "2026-09-02", "finish line moves out one day");
  eq(app.programDay("2026-08-10"), 7, "the sick day before this date pauses the count");
});

run();
