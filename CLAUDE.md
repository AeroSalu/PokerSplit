# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Poker Tracker: an offline-first PWA for home poker nights. One scorekeeper on one phone tracks buy-ins, settles up in the fewest payments, keeps unpaid/paid debts, game history and a leaderboard across games, and can optionally publish a read-only live view. `PLAN.md` is the full spec (game rules, data model, UI behaviour, manual verification script) — read it before changing behaviour.

Plain HTML/CSS/JS: no framework, no build step, no dependencies. All data lives in `localStorage`; the only network use is the optional live view (Firebase Realtime Database over REST), which is off while `config.js` has an empty `firebaseUrl`.

## Commands

- Run logic tests: `node tests/logic.test.js` (single script of `assert` calls; there is no test runner, so "one test" means editing/running this file)
- Serve locally: `python -m http.server 8123` in the repo root, then open `http://localhost:8123` (also configured in `.claude/launch.json`). Must be served over http(s) for the service worker to register.

## Architecture

Scripts load in order as globals from `index.html`: `config.js` → `logic.js` → `store.js` → `live.js` → `app.js`.

- **`logic.js`** — pure functions, no DOM or storage. UMD-style: exports via `module.exports` in Node (for tests), `self.Logic` in the browser. Keep it that way so it stays testable.
  - The game is an **event log** (`join`, `bank`, `transfer`, `leave`); `deriveState` replays it to get each player's `put` (money in for, no floor), seated status, cashed-out chips, and bank total. Never store derived state on the game object. Every event has a stable `eid`.
  - `validateLog` replays a log and returns the first inconsistency or null; any edit to an earlier entry must pass it (`applyEvents` in `app.js`).
  - `dealStacks` works out a starting stack worth exactly one buy-in per player, as even across colours as the set allows (the chip splitter on the setup screen); `splitChips` is its fallback, an equal share of the whole set, used when no buy-in is entered or no exact stack exists; `combineDebts` nets unpaid debts through `settle`; `leaderboard` aggregates history; `migrateGame` converts games saved in the old `halves` format.
  - `settle` finds the minimum number of payments via a bitmask DP over zero-sum subgroups (exact up to 16 non-zero players; falls back to one greedy group above that or when totals don't sum to zero).
- **`store.js`** — `self.Store`; every `localStorage` read/write is wrapped in try/catch so the app works without storage. Keys: `pt.game`, `pt.debts`, `pt.names`, `pt.history`, `pt.chips`, `pt.flag.*`. Debts reference players by **name** (not id) so they line up across games. `parseBackup` validates imported JSON record by record (`app: 'poker-tracker'` marker); backups are version 2 (adds history and chip values) and version 1 files still import.
- **`app.js`** — one IIFE holding all UI state (`game`, `debts`, `names`, `history`, `chipDefs`, `tab`, `ctx` for the open bottom sheet). Tabs: Game, Debts, History. Opening with `?view=<id>` renders the read-only live viewer instead. `render()` rebuilds `#view` from template strings; all user-supplied text must go through `esc()`. Interaction is dispatched through three delegated listeners: `click` on `[data-action]` → `actions` map, `submit` → `forms` map, and `input`. Call `save()` after every state change.
  - Game stages: `setup` → `play` → `settle`. In settle, inputs are rendered once and only the output container is updated per keystroke (`updateSettleOut`) so focus isn't lost — preserve this pattern for any live-updating form.
  - Any log entry can be deleted (and a leave's chips edited) through `applyEvents`, which refuses changes that fail `validateLog`. A buy-in flagged `withJoin` is removed together with the `join` before it. "Undo last" is the same delete on the last entry and is disabled for `start` events.
- **`live.js`** — `self.Live`; `publish` PUTs a debounced snapshot (one JSON string) to `/live/<id>` and retries when offline; `watch` listens with `EventSource`. `save()` in `app.js` publishes whenever `game.live` is set. The database rules are in `firebase-rules.json`.

## Conventions

- Money is whole numbers. Buy-ins are stored as money (`amount` on `bank`/`transfer` events), so custom amounts work; `putLabel` in `app.js` shows them as buy-in counts when they are a whole number of halves. The buy-in amount must be even.
- Phone-first CSS: light/dark via `prefers-color-scheme`, safe-area padding, ≥44px tap targets, 16px inputs (prevents iOS zoom). Reuse existing classes listed in `PLAN.md` step 4 rather than adding new ones.
- **After any change to shipped files, bump `CACHE` in `sw.js`** (currently `poker-tracker-v5`) so installed phones pick up the update. If you add a new file, add it to `FILES` in `sw.js` too.

## Status

Everything is built and browser-verified at 375×812. The live view was verified only against a local stand-in for Firebase; it has not been run against a real Firebase database and `firebaseUrl` is empty. Hosting (GitHub Pages / Netlify / Cloudflare Pages, HTTPS required for install) is not done yet, and real-device checks (share sheet, file import/export, install prompt) are outstanding.
