# PokerSplit: implementation plan

An installable web app (PWA) for Android and iPhone that tracks home poker buy-ins, settles up in the fewest payments, and keeps a record of paid and unpaid debts.

## Game rules the app must follow

- One fixed buy-in amount per night, set at the start. A buy-in can be full or half.
- Players who start the game take their first buy-in (full) from the bank.
- Any later buy-in comes from the bank or from another seated player.
- A player-to-player buy-in is minus one for the giver and plus one for the taker. The bank total does not change.
- The giver's count has no floor. Zero is "nil"; below zero is locked-in profit.
- A new player can join mid-game and take their first buy-in from the bank or from another player.
- A player can leave mid-game with their chips; their result is fixed at that point. They can come back later with a new buy-in.
- No cash changes hands during the game. Everything is settled between players at the end.
- One person keeps score on one phone. Nothing is synced.
- Payments not made on the night become debts, kept across games in Unpaid and Paid sections.

## Tech choices

- Plain HTML, CSS and JS. No framework, no build step, no dependencies.
- All data in `localStorage` on the phone. No server.
- Service worker for offline use; web manifest for "Add to Home Screen".
- Money is handled as whole numbers. Buy-in counts are stored in halves (2 = one full buy-in) so there are no fractions.

## Status of this folder

| File | State |
|---|---|
| `logic.js` | Done, tested |
| `tests/logic.test.js` | Done, passing (`node tests/logic.test.js`) |
| `store.js` | Done |
| `index.html` | Done |
| `styles.css` | Done (class names listed in step 4) |
| `manifest.webmanifest` | Done |
| `sw.js` | Done |
| `app.js` | Done |
| `icons/icon-180.png`, `icon-192.png`, `icon-512.png` | Done |
| Browser verification (step 6) | Done at 375 × 812 on a local server, light and dark. Not yet tried on a real phone; the share sheet, file export/import dialogs and the install prompt can only be checked there. |
| Hosting (step 7) | **Not done** |

To run it locally: `python -m http.server 8123` in this folder, then open `http://localhost:8123`.

## Step 1: data model and pure logic (`logic.js`)

Game object:

```js
{
  stage: 'setup' | 'play' | 'settle',
  buyIn: 500,              // string while typing in setup, number once started
  date: '2026-10-04',      // set when the game starts
  nextId: 1,
  players: [{ id, name }],
  events: [],              // the log below
  finalChips: {},          // { playerId: raw input string }
  ticks: {},               // payments ticked as already paid
  override: false          // settle despite a chip mismatch
}
```

Events, in order:

- `{ type: 'join', player, again? }` — `again: true` when a player who left comes back.
- `{ type: 'bank', to, halves, withJoin?, start? }`
- `{ type: 'transfer', from, to, halves, withJoin? }`
- `{ type: 'leave', player, chips }`

`withJoin` marks the buy-in that belongs to the join just before it, so Undo removes both. `start` marks the starting players' first buy-ins, which Undo does not touch.

Functions:

- `deriveState(game)` → `{ players: { id: { halves, seated, cashedOut } }, bankHalves, cashedOutTotal }` by replaying the log.
- `computeNets(game, state, finalChips)` → `[{ id, amount }]` where `amount = cashedOut + finalChips − halves × buyIn / 2`.
- `settle(nets)` → `[{ from, to, amount }]`, the fewest payments.
- `formatHalves(n)` → `"1"`, `"1½"`, `"−½"`.

Fewest-payments algorithm: the minimum is `n − g`, where `g` is the largest number of groups the non-zero players can be split into with each group summing to zero.

1. Drop players with a zero result.
2. Bitmask DP over subsets: `best[mask] = max over i in mask of best[mask without i] + (sum[mask] == 0 ? 1 : 0)`, remembering which `i` was dropped.
3. Walk back from the full set. Each time the remaining set sums to zero, the players dropped since the last such point form one group.
4. Inside each group, sort debtors and creditors largest first and pair them off with two pointers (`k − 1` payments for a group of `k`).
5. If more than 16 players have a non-zero result, or the results do not sum to zero (chip mismatch overridden), skip the DP and pair everyone as one group.

## Step 2: storage (`store.js`)

- Keys: `pt.game`, `pt.debts`, `pt.names`, plus `pt.flag.*` for dismissed hints.
- Every read and write wrapped in try/catch; the app must work with storage unavailable.
- Debt record: `{ id, from, to, amount, gameDate, status: 'unpaid' | 'paid', paidDate }`. `from` and `to` are player **names**, so one person's debts line up across nights.
- `exportData(debts, names)` and `parseBackup(text)`; the backup carries `app: 'poker-tracker'` and is validated record by record on import.

## Step 3: shell (`index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`)

- `index.html`: top bar, `<main id="view">`, bottom tab bar (Game, Debts with an unpaid badge), a bottom-sheet container (`#sheet` / `#sheet-body`), a toast, a hidden file input for import. Meta tags: `viewport-fit=cover`, `theme-color`, `apple-mobile-web-app-capable`, `apple-touch-icon`.
- `styles.css`: phone-first, light and dark via `prefers-color-scheme`, safe-area padding, tap targets of 44 px or more, inputs at 16 px so iOS does not zoom.
- `manifest.webmanifest`: `display: standalone`, portrait, 192 and 512 icons, the 512 also declared maskable.
- `sw.js`: precache the app files; serve from cache and refresh in the background.

## Step 4: the app (`app.js`)

One IIFE. State: `game`, `debts`, `names`, `tab`, `ctx` (what the open sheet is for). `render()` rebuilds `#view` from state with template strings; every user-supplied name goes through an HTML-escape helper. One delegated `click` listener on `[data-action]`, one `submit` listener, one `input` listener. Save after every change.

CSS classes already defined: `card`, `field`, `input`, `area`, `row`, `spread`, `btn` (`primary`, `ghost`, `danger`, `block`, `small`), `chips`, `chip`, `list`, `who`, `name`, `sub`, `acts`, `stats`, `stat`, `log`, `note` (`warn`, `ok`, `info`), `check`, `chips-in`, `seg`, `sources`, `sheet-title`, `muted`, `small-text`, `pos`, `neg`, `num`.

### Game tab, setup stage

- Buy-in amount input (`inputmode="numeric"`); update `game.buyIn` on input without re-rendering.
- Name input with Add, remembered names as tappable chips, list of added players with Remove.
- Start game: buy-in must be a positive even whole number, at least two players, no duplicate names (case-insensitive). On start, set the date, push `join` plus a full `bank` buy-in (`withJoin`, `start`) for each player, go to play.
- Install hint: on Android show an Install button when `beforeinstallprompt` fires; on iPhone (not already standalone) show "Share, then Add to Home Screen", dismissible.

### Game tab, play stage

- Two stats: bank total (buy-ins and money) and money on the table (`bankHalves × buyIn / 2 − cashedOutTotal`).
- One row per seated player: name, count ("1½ buy-ins", "Nil", "−1 · profit locked 500"), buttons Buy-in and Leave.
- Add player button.
- "Left" list: name, chips they left with, fixed result, Rejoin button.
- Log, newest first, in plain words: "D joined with a buy-in from the bank", "B took a half buy-in from A", "A left with 1,200", "A rejoined with a buy-in from C". Undo button for the last entry.
- End game and settle; Discard game (confirmed).

Sheets:

- **Buy-in / Add player / Rejoin** share one sheet: a Full/Half toggle (Full preselected, toggled without re-rendering so a typed name is kept), then source buttons: Bank, and each other seated player with their current count. Add player also has the name input and remembered-name chips, and rejects a name already in the game.
- **Leave**: chips input; must be a whole number from 0 up to the money on the table.
- **Confirm**: generic title, text, Cancel and a confirm button.

Undo: pop the last event; if it has `withJoin`, pop the `join` too, and if that player now has no events, remove them from `players`. Disabled when the last event has `start`.

### Game tab, settle stage

- Chips input for each seated player; players who left shown with their fixed amount.
- Build the inputs once and update only an output container on each keystroke, so focus is not lost.
- Chip check: `cashedOutTotal + sum of final chips` against `bankHalves × buyIn / 2`. Match shows a green note. Mismatch shows "Chips are over/short by X" with a "Settle anyway" checkbox; without it, no payments are shown and Finish is disabled. If any input is empty, ask for all chips first.
- Results: each player's profit or loss, largest first.
- Payments: "B pays A 700", each with a "Paid now" tick.
- Share result: plain text (date, buy-in, results, payments) through `navigator.share`, falling back to the clipboard, falling back to a sheet with a selectable textarea.
- Back to game; Finish game (confirmed): turn each payment into a debt record (paid with today's date if ticked, otherwise unpaid), add all player names to the remembered list, reset to a new game with the same buy-in prefilled, switch to the Debts tab.

### Debts tab

- Summary: for each person with unpaid debts, total owed and total owing across all games.
- Unpaid: "B owes A 700 · 4 Oct", newest first, Mark paid.
- Paid: "C paid A 500 · paid 4 Oct", with Undo (back to unpaid) and Delete (confirmed).
- Share unpaid (same share helper).
- Export backup: JSON file through the share sheet where files can be shared, otherwise a download.
- Import backup: file input, `Store.parseBackup`, confirm before replacing debts and names.

### Startup

Load state, render, set the active tab and badge, register `sw.js` when served over http(s).

## Step 5: icons

Generate `icons/icon-180.png`, `icon-192.png`, `icon-512.png`: solid `#1f7a4d` square, white spade centred within the middle 60% so the maskable crop is safe. A short PowerShell `System.Drawing` or Node script is enough; no need to keep it.

## Step 6: verification

Logic: `node tests/logic.test.js`.

In a browser at 375 × 812, served locally (`python -m http.server 8000` inside the folder), buy-in 500:

1. A, B, C start → counts 1/1/1, bank total 3.
2. B takes from A → 0/2/1, bank still 3. C takes from bank → 0/2/2, bank 4.
3. A gives another to B → A at −1 with profit locked. Undo → 0/2/2.
4. Settle with A 1200, B 300, C 500 → "B pays A 700", "C pays A 500". Change one figure → mismatch warning with the difference.
5. New game: D joins mid-game from the bank; E joins taking from C (bank unchanged); A leaves with chips and drops out of the source list; undo the leave; A leaves again and rejoins; a half buy-in from the bank and a half between players.
6. Finish a game with one payment ticked → one debt under Paid, the rest under Unpaid. Mark paid, undo, delete. Finish a second game → debts accumulate and the summary totals per person.
7. Export, clear site data, import → debts and names return.
8. Refresh mid-game → state restored.
9. Service worker registers; with the server stopped, reload still opens the app. No horizontal scroll; dark mode readable.

## Step 7: getting it onto phones

Installing needs HTTPS on a public address. Options: GitHub Pages (free, permanent link) or Netlify / Cloudflare Pages (free, drag and drop the folder). Then on each phone open the link once: Android taps Install; iPhone uses Share, then Add to Home Screen.

After any later change, bump `CACHE` in `sw.js` so phones pick up the new version.

---

# Version 2: improvements

Built on top of the plan above. Where the two differ, this section is current.

## What changed

| Area | Change |
|---|---|
| Buy-ins | Stored as money (`amount`) instead of `halves`, so a buy-in can be Full, Half or any Custom amount. Old saved games are converted on load (`Logic.migrateGame`). |
| Log | Any entry can be deleted, and a leave's chips edited, through the "⋯" button. A change that would make the log inconsistent is refused with the reason (`Logic.validateLog`). |
| Chip counter | Chip colours and values are set on the setup screen (`pt.chips`). A "Count" button in the Leave sheet and on the settle screen totals a stack by colour. |
| Chip splitter | "Split chips between players" on the setup screen: enter the number of players and how many chips of each colour are in the set. It shows a starting stack worth exactly one buy-in for every player, spread as evenly across the colours as the set allows, and what is left in the set (`Logic.dealStacks`). With no buy-in entered, or when the chips cannot make the buy-in exactly, it shows an equal share of the whole set instead (`Logic.splitChips`). The set's counts are remembered in `pt.chips`. |
| Debts | Part payments; "Simplify" nets all unpaid debts into the fewest payments (`Logic.combineDebts`); "Remind" shares one person's outstanding total. |
| History | Finished games are kept (`pt.history`) in a third tab with a per-game view and a leaderboard (`Logic.leaderboard`). Backups are version 2 and include history and chip values; version 1 files still import. |
| Live view | Optional read-only link for the other players (`live.js`, `config.js`, `firebase-rules.json`). Off until a database URL is set. |
| Look | One dark "casino table" theme: green felt, gold accents, serif title. Player avatars (initials on a colour taken from the name, or a photo added by tapping the circle on the setup or game screen; stored in `pt.photos`, included in version 3 backups, never sent to the live view). Icons on tabs and main buttons, sheet and press animations, a short fall of card suits when a game finishes, a highlighted winner on the settle and history screens and medals on the leaderboard. Motion is off under reduced-motion. |
| Names | Saved names can be removed with "Edit saved names" on the setup screen (this also removes that name's photo). A name is remembered when a game starts or finishes, so an undone mid-game join leaves nothing behind. |

## Status

| Item | State |
|---|---|
| Logic tests (`node tests/logic.test.js`) | Passing |
| Phases 1 to 5 in the browser at 375 × 812 | Verified |
| Live view | On, and verified against the real Firebase database: updates reach a viewer tab within a few seconds, the scorer catches up after losing the connection, "Stop sharing" ends the view, and forged, partial, oversized and out-of-place writes are refused by the published rules. |
| Real phone | Not done: share sheet, file export/import dialogs, install prompt |
| Hosting | Not done |

## Turning on the live view

1. Go to the Firebase console, create a project (free "Spark" plan), and add a **Realtime Database**.
2. In the database's **Rules** tab, replace the contents with `firebase-rules.json` and publish.
3. Copy the database URL (it looks like `https://<project>-default-rtdb.firebaseio.com`) into `firebaseUrl` in `config.js`.
4. Bump `CACHE` in `sw.js` and redeploy.

A "Live link" button then appears on the game screen. The link shows names and amounts to anyone who has it. There is no sign-in, so someone who knew the database address could create junk entries, but could not read or change a real game.
