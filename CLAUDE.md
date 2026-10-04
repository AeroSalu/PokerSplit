# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PokerSplit: an offline-first PWA for home poker nights. One scorekeeper on one phone tracks buy-ins, settles up in the fewest payments, keeps unpaid/paid debts, game history and a leaderboard across games, and can optionally publish a read-only live view. `PLAN.md` is the full spec (game rules, data model, UI behaviour, manual verification script) — read it before changing behaviour.

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
- **`store.js`** — `self.Store`; every `localStorage` read/write is wrapped in try/catch so the app works without storage. Keys: `pt.game`, `pt.debts`, `pt.names`, `pt.history`, `pt.chips`, `pt.photos`, `pt.flag.*`. Debts reference players by **name** (not id) so they line up across games. `parseBackup` validates imported JSON record by record (`app: 'poker-tracker'` marker); backups are version 3 (history and chip values since 2, player photos since 3) and older files still import. Photos are 96×96 JPEG data URLs keyed by lower-cased player name; they are never sent to the live view.
- **`app.js`** — one IIFE holding all UI state (`game`, `debts`, `names`, `history`, `chipDefs`, `tab`, `ctx` for the open bottom sheet). Tabs: Game, Debts, History. Opening with `?view=<id>` renders the read-only live viewer instead. `render()` rebuilds `#view` from template strings; all user-supplied text must go through `esc()`. Interaction is dispatched through three delegated listeners: `click` on `[data-action]` → `actions` map, `submit` → `forms` map, and `input`. Call `save()` after every state change.
  - Game stages: `setup` → `play` → `settle`. In settle, inputs are rendered once and only the output container is updated per keystroke (`updateSettleOut`) so focus isn't lost — preserve this pattern for any live-updating form.
  - Any log entry can be deleted (and a leave's chips edited) through `applyEvents`, which refuses changes that fail `validateLog`. A buy-in flagged `withJoin` is removed together with the `join` before it. "Undo last" is the same delete on the last entry and is disabled for `start` events.
- **`live.js`** — `self.Live`; `publish` PUTs a debounced snapshot (one JSON string) to `/live/<id>` and retries when offline; `watch` listens with `EventSource`. `save()` in `app.js` publishes whenever `game.live` is set. The database rules are in `firebase-rules.json`.

## Conventions

- Money is whole numbers. Buy-ins are stored as money (`amount` on `bank`/`transfer` events), so custom amounts work; `putLabel` in `app.js` shows them as buy-in counts when they are a whole number of halves. The buy-in amount must be even.
- One visual theme, a dark green card table with gold accents, defined by the tokens on `:root` in `styles.css`; it does not follow the phone's light/dark setting. Player pictures come from `avatar(name)` and button icons from `icon(name)` in `app.js` (inline SVG, always beside a text label or with an `aria-label`). Animations must stay inside the `prefers-reduced-motion` guard.
- Phone-first CSS: safe-area padding, ≥44px tap targets, 16px inputs (prevents iOS zoom). Reuse existing classes listed in `PLAN.md` step 4 rather than adding new ones.
- **After any change to shipped files, bump `CACHE` in `sw.js`** (currently `poker-tracker-v10`) so installed phones pick up the update. If you add a new file, add it to `FILES` in `sw.js` too.

## Status

Everything is built and browser-verified at 375×812. The live view is switched on (`firebaseUrl` in `config.js` points at the project's Firebase Realtime Database) and was verified against that database: the rules in `firebase-rules.json` are published there and were tested with allowed writes and a set of forged, partial, oversized and out-of-place writes. Each write must carry a fresh nonce `n` and `sig` = owner key + nonce (`signed()` in `live.js`); do not drop that, since without it a write to the `state` child alone gets through. Hosting (GitHub Pages / Netlify / Cloudflare Pages, HTTPS required for install) is not done yet, and real-device checks (share sheet, file import/export, install prompt) are outstanding.
