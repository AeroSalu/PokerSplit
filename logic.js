// Pure game logic: no DOM, no storage. Loaded as a global in the browser and
// as a module in Node so it can be tested on its own.
(function (root) {
  'use strict';

  // Above this many players with a non-zero result, the exact search is skipped.
  const EXACT_LIMIT = 16;

  // Replays the event log. Buy-ins are counted in halves (2 = one full buy-in).
  function deriveState(game) {
    const players = {};
    game.players.forEach(function (p) {
      players[p.id] = { halves: 0, seated: false, cashedOut: 0 };
    });
    let bankHalves = 0;
    let cashedOutTotal = 0;

    game.events.forEach(function (e) {
      if (e.type === 'join') {
        players[e.player].seated = true;
      } else if (e.type === 'bank') {
        players[e.to].halves += e.halves;
        bankHalves += e.halves;
      } else if (e.type === 'transfer') {
        players[e.from].halves -= e.halves;
        players[e.to].halves += e.halves;
      } else if (e.type === 'leave') {
        players[e.player].seated = false;
        players[e.player].cashedOut += e.chips;
        cashedOutTotal += e.chips;
      }
    });

    return { players: players, bankHalves: bankHalves, cashedOutTotal: cashedOutTotal };
  }

  // finalChips: { playerId: amount } for players still seated.
  function computeNets(game, state, finalChips) {
    return game.players.map(function (p) {
      const s = state.players[p.id];
      const chips = s.seated ? (finalChips[p.id] || 0) : 0;
      return { id: p.id, amount: s.cashedOut + chips - (s.halves * game.buyIn) / 2 };
    });
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
    settle: settle,
    formatHalves: formatHalves
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  else root.Logic = Logic;
})(typeof self !== 'undefined' ? self : this);
