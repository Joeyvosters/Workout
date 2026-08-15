# 30-Day Strength Tracker

A single-file strength training log that acts as a coach. Dictate what you did in
plain language, and it parses that into structured rows, tracks progress against
goals, and writes a weekly trend note.

Built for: adjustable bench, dumbbells to 55 lb in 5 lb increments, pull-up bar,
treadmill, light resistance bands.

## Running it

`index.html` is the whole app — no build step, no dependencies to install. Open it
locally, or serve it:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploying to GitHub Pages

1. Push to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. The workflow in `.github/workflows/deploy-pages.yml` deploys on every push to
   `main`, and can be re-run by hand from the Actions tab (`workflow_dispatch`).

## The API key

Coaching, dictation parsing and weekly notes call the Anthropic API. Everything
else — logging by hand, charts, goals, the calendar, export/import — works without
one.

Open the **Data** tab, paste your key from
[console.anthropic.com](https://console.anthropic.com/settings/keys), and hit Save.
Use **Test** to confirm it works.

The key is stored in your browser's `localStorage` and sent only to
`api.anthropic.com`, using the `anthropic-dangerous-direct-browser-access` header
that Anthropic provides for exactly this bring-your-own-key pattern. It is never
committed to the repo and never reaches GitHub. Anyone else visiting your Pages URL
sees an app with no key and is prompted for their own.

If a model name stops being current, change it in the same Data tab panel.

## Dual environment

The same file runs both on a static host and pasted into a Claude artifact. It
detects which at load:

| | Static host (Pages, local) | Claude artifact |
|---|---|---|
| Storage | `localStorage` | injected `window.storage` |
| API | your key + browser-access header | proxied, no key needed |

## How the program works

- 30 program days. Day 1 defaults to 2026-08-03; **Reset** on the Data tab starts a
  fresh 30 days from today.
- Days 1–7 are a baseline week for finding working weights. Day 8 onward is the
  daily log.
- **Rest days** are planned recovery and count inside the 30.
- **Sick days** pause the clock — each one extends the plan by a day and pushes the
  finish date out, so illness never costs you program days.

## Backups

The Data tab exports JSON and CSV. Restore by file or by pasting JSON back in.
Worth doing periodically: clearing browser data wipes `localStorage`.

## Tests

`npm test` (equivalently `node test/tests.js`) runs the regression suite. It has no
dependencies — `test/harness.js` loads the app's inline script into Node's built-in
`vm` with stubbed browser globals and drives it directly. The cases cover the storage
pacing/probing/fallback paths, the tolerant JSON extraction, raw input surviving a
failed parse, and the sick-day clock math.

## Working on it

See [CLAUDE.md](CLAUDE.md) for architecture notes and the invariants to preserve
when editing.
