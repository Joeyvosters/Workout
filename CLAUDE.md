# Working on this repo

Context for Claude Code (or anyone) picking this up.

## Shape

One file: `index.html`. Inline CSS, inline JS, no build, no bundler, no framework.
Chart.js from CDN is the only external dependency. Keep it that way unless there's a
strong reason — the single-file property is what lets it run as a Claude artifact
*and* on Pages from the same source.

Vanilla JS with a `render()` that rebuilds `#view` from a `state` object, plus one
delegated `click` handler dispatching on `data-action`. There's no virtual DOM and no
reactivity; if you change `state` or `store`, call `render()`.

## Data model

`store` is one object persisted as a single JSON blob:

| Collection | Fields |
|---|---|
| `sets` | date, exercise, weight (lb, null = bodyweight), reps, sets, notes, phase |
| `restDays` | date, type (planned/sick/travel/other), notes |
| `protein` | date, grams, notes |
| `scale` | date, weight, bodyFatPct, muscleMass, other, notes |
| `goals` | exercise, baseline, target, targetDate, notes |
| `trainerNotes` | date, note |
| `pendingRaw` | id, date, text, status — raw input that failed to parse |
| `meta` | start, created, surfaced, lastTrendAttempt |

Every row gets an `id` from `newId()`. `FIELDS` drives the row editor; adding a field
there gives you an editable input for free.

## Invariants — these were bugs once, don't regress them

**Never discard typed input.** Raw text is written to `pendingRaw` *before* the parse
call and only removed on success. A failed parse leaves it on screen with a retry
button. Don't "clean this up" into a fire-and-forget parse.

**Sick days pause the clock.** `programDay()` subtracts sick days before the given
date; `planLength()` is 30 + sick count. Anything user-facing showing a day number
must use `programDay()`, never raw calendar difference. Rest days do *not* extend.

**Storage is paced and probed.** `saveStore()` marks dirty and shares one debounced
flush; `MIN_WRITE_GAP` (1.6s) is a floor between writes because the artifact host
rate-limits, and retry backoff starts *above* that window. `discoverStorage()` probes
key names against value shapes because one host rejected a specific combination
outright. Don't replace this with a bare `set()` call — that failure mode cost real
data.

**Model replies are not trusted JSON.** `extractJSON()` does a brace-balanced scan
ignoring string contents, strips trailing commas, and on a truncated reply trims back
to the last complete row rather than losing everything. `parseWithRetry()` retries
once with a stricter instruction.

**Tone.** The coaching prompts are deliberate: never guilt about missed or lighter
days, explicitly pro-rest-day, 2–4 sentences, no bullets or markdown (it's read on a
phone and answered by voice). If you edit prompts, preserve that.

## Environment detection

`IN_ARTIFACT` decides storage backend and whether the API needs a key. When testing,
check both paths — it's easy to fix one and break the other.

## Testing

No test framework — just Node's built-in `vm`, no dependencies to install. Run
`npm test` (or `node test/tests.js`; `DEBUG=1` surfaces the app's console output).

`test/harness.js` loads the inline `<script>` out of `index.html` into a `vm` with
stubbed `window`, `document`, `localStorage` and `fetch`, exposes the internals, and
lets a test drive them and assert on `store`. It cuts the auto-run init section so
tests aren't racing boot, and because `BACKEND` is captured once at load, each
storage scenario calls `loadApp()` for a fresh instance with its own stubs.
`test/tests.js` is the suite. If you touch persistence or parsing, add the new
failure mode here.

Cases the suite already covers (each was a real bug once):

- rate-limited storage host, several saves in quick succession
- host that rejects a value shape or key name outright
- storage entirely absent
- model reply with trailing prose, code fences, or truncated mid-object
- unparseable reply — raw text must survive
- sick day logged same-day as sets (plan length must update before phase is set)

## Ideas not yet built

- Per-exercise volume (weight x reps x sets) trend, not just weight and reps
- Deload week suggestion when a lift stalls three sessions running
- Service worker so it opens offline
