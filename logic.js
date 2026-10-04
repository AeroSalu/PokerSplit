// Pure game logic: no DOM, no storage. Loaded as a global in the browser and
// as a module in Node so it can be tested on its own.
(function (root) {
  'use strict';

  // Above this many players with a non-zero result, the exact search is skipped.
  const EXACT_LIMIT = 16;

  // Replays the event log. `put` is the money a player is in for; it has no
  // floor, so giving buy-ins away can take it to zero or below.
  function deriveState(game) {
    const players = {};
    game.players.forEach(function (p) {
      players[p.id] = { put: 0, seated: false, cashedOut: 0 };
    });
    let bankTotal = 0;
    let cashedOutTotal = 0;

    game.events.forEach(function (e) {
      if (e.type === 'join') {
        players[e.player].seated = true;
      } else if (e.type === 'bank') {
        players[e.to].put += e.amount;
        bankTotal += e.amount;
      } else if (e.type === 'transfer') {
        players[e.from].put -= e.amount;
        players[e.to].put += e.amount;
      } else if (e.type === 'leave') {
        players[e.player].seated = false;
        players[e.player].cashedOut += e.chips;
        cashedOutTotal += e.chips;
      }
    });

    return { players: players, bankTotal: bankTotal, cashedOutTotal: cashedOutTotal };
  }

  // finalChips: { playerId: amount } for players still seated.
  function computeNets(game, state, finalChips) {
    return game.players.map(function (p) {
      const s = state.players[p.id];
      const chips = s.seated ? (finalChips[p.id] || 0) : 0;
      return { id: p.id, amount: s.cashedOut + chips - s.put };
    });
  }

  // Returns the first reason the log does not make sense, or null. Used before
  // accepting an edit to an earlier entry.
  function validateLog(game) {
    const seated = {};
    const name = {};
    game.players.forEach(function (p) {
      seated[p.id] = false;
      name[p.id] = p.name;
    });
    const known = function (id) { return Object.prototype.hasOwnProperty.call(seated, id); };
    let onTable = 0;

    for (let i = 0; i < game.events.length; i++) {
      const e = game.events[i];
      if (e.type === 'join') {
        if (!known(e.player)) return 'a player in the log no longer exists';
        if (seated[e.player]) return name[e.player] + ' would join while already at the table';
        seated[e.player] = true;
      } else if (e.type === 'bank') {
        if (!known(e.to) || !seated[e.to]) return (name[e.to] || 'a player') + ' would take a buy-in while not at the table';
        onTable += e.amount;
      } else if (e.type === 'transfer') {
        if (!known(e.from) || !seated[e.from]) return (name[e.from] || 'a player') + ' would give a buy-in while not at the table';
        if (!known(e.to) || !seated[e.to]) return (name[e.to] || 'a player') + ' would take a buy-in while not at the table';
      } else if (e.type === 'leave') {
        if (!known(e.player) || !seated[e.player]) return (name[e.player] || 'a player') + ' would leave while not at the table';
        if (e.chips > onTable) return name[e.player] + ' would leave with more than was on the table';
        onTable -= e.chips;
        seated[e.player] = false;
      }
    }
    return null;
  }

  // Splits items into the largest possible number of groups that each sum to
  // zero. Fewest payments overall = items - groups.
  function zeroSumGroups(items) {
    const n = items.length;
    const size = 1 << n;
    const sum = new Float64Array(size);
    const best = new Int8Array(size);
    const drop = new Int8Array(size);

    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sum[mask] = sum[mask ^ low] + items[31 - Math.clz32(low)].amount;
      let top = -1;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          const b = best[mask ^ (1 << i)];
          if (b > top) {
            top = b;
            drop[mask] = i;
          }
        }
      }
      best[mask] = top + (sum[mask] === 0 ? 1 : 0);
    }

    // Walk back from the full set; each time the remainder sums to zero, the
    // players removed since the last such point form one group.
    const groups = [];
    let current = [];
    let mask = size - 1;
    while (mask) {
      const i = drop[mask];
      current.push(items[i]);
      mask ^= 1 << i;
      if (sum[mask] === 0) {
        groups.push(current);
        current = [];
      }
    }
    return groups;
  }

  function pairUp(group, payments) {
    const debtors = group
      .filter(function (x) { return x.amount < 0; })
      .map(function (x) { return { id: x.id, left: -x.amount }; })
      .sort(function (a, b) { return b.left - a.left; });
    const creditors = group
      .filter(function (x) { return x.amount > 0; })
      .map(function (x) { return { id: x.id, left: x.amount }; })
      .sort(function (a, b) { return b.left - a.left; });

    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].left, creditors[c].left);
      payments.push({ from: debtors[d].id, to: creditors[c].id, amount: amount });
      debtors[d].left -= amount;
      creditors[c].left -= amount;
      if (debtors[d].left === 0) d++;
      if (creditors[c].left === 0) c++;
    }
  }

  // nets: [{ id, amount }] with winners positive. Returns [{ from, to, amount }].
  function settle(nets) {
    const items = nets.filter(function (x) { return x.amount !== 0; });
    if (!items.length) return [];
    const total = items.reduce(function (t, x) { return t + x.amount; }, 0);
    const groups = total === 0 && items.length <= EXACT_LIMIT ? zeroSumGroups(items) : [items];
    const payments = [];
    groups.forEach(function (g) { pairUp(g, payments); });
    return payments;
  }

  // Nets a list of debts ({ from, to, amount }, by name) into the fewest
  // payments that leave everyone in the same overall position.
  function combineDebts(debts) {
    const net = {};
    debts.forEach(function (d) {
      net[d.to] = (net[d.to] || 0) + d.amount;
      net[d.from] = (net[d.from] || 0) - d.amount;
    });
    return settle(Object.keys(net).map(function (name) { return { id: name, amount: net[name] }; }));
  }

  // history: finished games, each with players: [{ name, net }].
  function leaderboard(history) {
    const by = {};
    history.forEach(function (g) {
      (g.players || []).forEach(function (p) {
        const r = by[p.name] || (by[p.name] = { name: p.name, games: 0, total: 0, best: -Infinity, worst: Infinity });
        r.games++;
        r.total += p.net;
        r.best = Math.max(r.best, p.net);
        r.worst = Math.min(r.worst, p.net);
      });
    });
    return Object.keys(by)
      .map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
  }

  // Games saved before buy-ins were stored as money used `halves` (2 = one full
  // buy-in) and had no event ids.
  function migrateGame(game) {
    if (!game || !Array.isArray(game.events)) return game;
    let next = game.nextEid || 1;
    game.events.forEach(function (e) {
      if (e.halves != null && e.amount == null) {
        e.amount = (e.halves * Number(game.buyIn)) / 2;
        delete e.halves;
      }
      if (!e.eid) e.eid = 'e' + next++;
    });
    game.nextEid = next;
    return game;
  }

  // Shares a chip set equally: every player gets the same number of each
  // colour, and whatever does not divide evenly is left over.
  // chips: [{ name, value, count }]
  function splitChips(chips, players) {
    const each = [];
    const left = [];
    let stack = 0;
    let leftValue = 0;
    chips.forEach(function (c) {
      const count = c.count || 0;
      const n = players > 0 ? Math.floor(count / players) : 0;
      const rest = count - n * players;
      if (n) each.push({ name: c.name, value: c.value, n: n });
      if (rest) left.push({ name: c.name, value: c.value, n: rest });
      stack += n * c.value;
      leftValue += rest * c.value;
    });
    return { each: each, stack: stack, left: left, leftValue: leftValue };
  }

  // Fewest chips that add up to exactly `target`, using at most `max` of each
  // item. items: [{ value, max }]. Returns a count per item, or null.
  function fewestChips(items, target) {
    const room = items.reduce(function (t, it) { return t + it.max; }, 0);
    if (target * room > 2e7) {
      // Too large to search: take the biggest chips first and accept only an
      // exact result.
      const counts = items.map(function () { return 0; });
      let rest = target;
      items
        .map(function (it, i) { return { i: i, value: it.value, max: it.max }; })
        .sort(function (a, b) { return b.value - a.value; })
        .forEach(function (it) {
          const c = Math.min(it.max, Math.floor(rest / it.value));
          counts[it.i] = c;
          rest -= c * it.value;
        });
      return rest === 0 ? counts : null;
    }

    let best = new Float64Array(target + 1).fill(Infinity);
    best[0] = 0;
    const used = [];
    items.forEach(function (it) {
      const next = best.slice();
      const took = new Int32Array(target + 1);
      for (let s = 0; s <= target; s++) {
        if (best[s] === Infinity) continue;
        for (let c = 1; c <= it.max; c++) {
          const ns = s + c * it.value;
          if (ns > target) break;
          if (best[s] + c < next[ns]) {
            next[ns] = best[s] + c;
            took[ns] = c;
          }
        }
      }
      used.push(took);
      best = next;
    });
    if (best[target] === Infinity) return null;

    const counts = [];
    let s = target;
    for (let i = items.length - 1; i >= 0; i--) {
      counts[i] = used[i][s];
      s -= counts[i] * items[i].value;
    }
    return counts;
  }

  // Works out a starting stack worth exactly one buy-in for every player,
  // spread as evenly across the colours as the chips allow: the same number of
  // each colour first, then the fewest extra chips to reach the buy-in. Big
  // chips are left out when they would stop the stack from being even.
  // chips: [{ name, value, count }]. Returns null if no exact stack exists.
  function dealStacks(chips, players, buyIn) {
    if (!(players > 0) || !(buyIn > 0)) return null;
    const usable = chips
      .map(function (c, i) { return { i: i, value: c.value, max: Math.floor((c.count || 0) / players) }; })
      .filter(function (c) { return c.max > 0 && c.value <= buyIn; })
      .sort(function (a, b) { return a.value - b.value; });

    // Try the smallest `keep` colours with `same` of each, most colours and
    // highest `same` first. The last attempt (same = 0) accepts any exact mix.
    const attempt = function (kept, same) {
      const unit = kept.reduce(function (t, c) { return t + c.value; }, 0);
      const extra = fewestChips(
        kept.map(function (c) { return { value: c.value, max: c.max - same }; }),
        buyIn - same * unit
      );
      if (!extra) return null;
      const counts = chips.map(function () { return 0; });
      kept.forEach(function (c, k) { counts[c.i] = same + extra[k]; });
      return counts;
    };

    let counts = null;
    for (let keep = usable.length; keep > 0 && !counts; keep--) {
      const kept = usable.slice(0, keep);
      const unit = kept.reduce(function (t, c) { return t + c.value; }, 0);
      const cap = kept.reduce(function (t, c) { return Math.min(t, c.max); }, Infinity);
      for (let same = Math.min(cap, Math.floor(buyIn / unit)); same >= 1 && !counts; same--) {
        counts = attempt(kept, same);
      }
    }
    if (!counts && usable.length) counts = attempt(usable, 0);
    if (!counts) return null;

    const each = [];
    const left = [];
    let leftValue = 0;
    chips.forEach(function (c, i) {
      const rest = (c.count || 0) - counts[i] * players;
      if (counts[i]) each.push({ name: c.name, value: c.value, n: counts[i] });
      if (rest) left.push({ name: c.name, value: c.value, n: rest });
      leftValue += rest * c.value;
    });
    return { each: each, stack: buyIn, left: left, leftValue: leftValue };
  }

  // 2 -> "1", 3 -> "1½", -1 -> "−½"
  function formatHalves(halves) {
    const abs = Math.abs(halves);
    const whole = Math.floor(abs / 2);
    const text = (whole || !(abs % 2) ? String(whole) : '') + (abs % 2 ? '½' : '');
    return (halves < 0 ? '−' : '') + text;
  }

  const Logic = {
    deriveState: deriveState,
    computeNets: computeNets,
    validateLog: validateLog,
    settle: settle,
    combineDebts: combineDebts,
    leaderboard: leaderboard,
    migrateGame: migrateGame,
    splitChips: splitChips,
    dealStacks: dealStacks,
    formatHalves: formatHalves
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  else root.Logic = Logic;
})(typeof self !== 'undefined' ? self : this);
