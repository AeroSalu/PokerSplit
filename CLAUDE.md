# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Poker Tracker: an offline-first PWA for home poker nights. One scorekeeper on one phone tracks buy-ins, settles up in the fewest payments, and keeps a record of unpaid/paid debts across games. `PLAN.md` is the full spec (game rules, data model, UI behaviour, manual verification script) — read it before changing behaviour.

Plain HTML/CSS/JS: no framework, no build step, no dependencies, no server. All data lives in `localStorage`.

## Commands

- Run logic tests: `node tests/logic.test.js` (single script of `assert` calls; there is no test runner, so "one test" means editing/running this file)
- Serve locally: `python -m http.server 8123` in the repo root, then open `http://localhost:8123` (also configured in `.claude/launch.json`). Must be served over http(s) for the service worker to register.

## Architecture

Scripts load in order as globals from `index.html`: `logic.js` → `store.js` → `app.js`.

- **`logic.js`** — pure functions, no DOM or storage. UMD-style: exports via `module.exports` in Node (for tests), `self.Logic` in the browser. Keep it that way so it stays testable.
  - The game is an **event log** (`join`, `bank`, `transfer`, `leave`); `deriveState` replays it to get each player's count, seated status, cashed-out chips, and bank total. Never store derived state on the game object.
  - `settle` finds the minimum number of payments via a bitmask DP over zero-sum subgroups (exact up to 16 non-zero players; falls back to one greedy group above that or when totals don't sum to zero).
- **`store.js`** — `self.Store`; every `localStorage` read/write is wrapped in try/catch so the app works without storage. Keys: `pt.game`, `pt.debts`, `pt.names`, `pt.flag.*`. Debts reference players by **name** (not id) so they line up across games. `parseBackup` validates imported JSON record by record (`app: 'poker-tracker'` marker).
- **`app.js`** — one IIFE holding all UI state (`game`, `debts`, `names`, `tab`, `ctx` for the open bottom sheet). `render()` rebuilds `#view` from template strings; all user-supplied text must go through `esc()`. Interaction is dispatched through three delegated listeners: `click` on `[data-action]` → `actions` map, `submit` → `forms` map, and `input`. Call `save()` after every state change.
  - Game stages: `setup` → `play` → `settle`. In settle, inputs are rendered once and only the output container is updated per keystroke (`updateSettleOut`) so focus isn't lost — preserve this pattern for any live-updating form.
  - Undo pops the last event; events flagged `withJoin` also pop the preceding `join`; events flagged `start` (starting buy-ins) can't be undone.

## Conventions

- Money is whole numbers. Buy-in counts are stored in **halves** (2 = one full buy-in); format with `Logic.formatHalves`. The buy-in amount must be even.
- Phone-first CSS: light/dark via `prefers-color-scheme`, safe-area padding, ≥44px tap targets, 16px inputs (prevents iOS zoom). Reuse existing classes listed in `PLAN.md` step 4 rather than adding new ones.
- **After any change to shipped files, bump `CACHE` in `sw.js`** (e.g. `poker-tracker-v2`) so installed phones pick up the update. If you add a new file, add it to `FILES` in `sw.js` too.

## Status

Everything is built and browser-verified at 375×812; hosting (GitHub Pages / Netlify / Cloudflare Pages, HTTPS required for install) is not done yet, and real-device checks (share sheet, file import/export, install prompt) are outstanding.
