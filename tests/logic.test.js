// Run with: node tests/logic.test.js
const assert = require('assert');
const Logic = require('../logic.js');

function nets(amounts) {
  return amounts.map((amount, i) => ({ id: 'p' + i, amount }));
}

function checkBalanced(input, payments) {
  const bal = {};
  input.forEach((x) => { bal[x.id] = x.amount; });
  payments.forEach((p) => {
    assert(p.amount > 0);
    bal[p.from] += p.amount;
    bal[p.to] -= p.amount;
  });
  Object.values(bal).forEach((v) => assert.strictEqual(v, 0));
}

// ---------- settle ----------
let input = nets([500, -500, 300, -300]);
let pay = Logic.settle(input);
assert.strictEqual(pay.length, 2, 'two separate pairs');
checkBalanced(input, pay);

input = nets([700, -200, -500]);
pay = Logic.settle(input);
assert.strictEqual(pay.length, 2);
checkBalanced(input, pay);

assert.deepStrictEqual(Logic.settle(nets([0, 0, 0])), []);

// Greedy largest-first would need 5 payments here; the exact search finds 4.
input = nets([400, 300, 300, -500, -200, -300]);
pay = Logic.settle(input);
assert.strictEqual(pay.length, 4);
checkBalanced(input, pay);

// Three independent zero-sum groups among 7 players -> 4 payments.
input = nets([100, -100, 250, -250, 900, -400, -500]);
pay = Logic.settle(input);
assert.strictEqual(pay.length, 4);
checkBalanced(input, pay);

// Larger than the exact limit still balances.
input = nets(Array.from({ length: 20 }, (_, i) => (i % 2 ? -(i * 10) : (i + 1) * 10)));
pay = Logic.settle(input);
assert(pay.length <= 19);
checkBalanced(input, pay);

// ---------- deriveState: the first example, buy-in 500 ----------
const P = (id) => ({ id, name: id });
const start = (id) => [{ type: 'join', player: id }, { type: 'bank', to: id, amount: 500 }];
const game = {
  buyIn: 500,
  players: [P('A'), P('B'), P('C')],
  events: [
    ...start('A'), ...start('B'), ...start('C'),
    { type: 'transfer', from: 'A', to: 'B', amount: 500 },
    { type: 'bank', to: 'C', amount: 500 }
  ]
};
let st = Logic.deriveState(game);
assert.deepStrictEqual(['A', 'B', 'C'].map((id) => st.players[id].put), [0, 1000, 1000]);
assert.strictEqual(st.bankTotal, 2000);

game.events.push({ type: 'transfer', from: 'A', to: 'B', amount: 500 });
st = Logic.deriveState(game);
assert.strictEqual(st.players.A.put, -500, 'giver can go below nil');
game.events.pop();

st = Logic.deriveState(game);
let n = Logic.computeNets(game, st, { A: 1200, B: 300, C: 500 });
assert.deepStrictEqual(n.map((x) => x.amount), [1200, -700, -500]);
pay = Logic.settle(n);
assert.deepStrictEqual(pay, [
  { from: 'B', to: 'A', amount: 700 },
  { from: 'C', to: 'A', amount: 500 }
]);

// ---------- joining, leaving, rejoining, half and custom amounts ----------
const g2 = {
  buyIn: 500,
  players: [P('A'), P('B'), P('C'), P('D')],
  events: [
    ...start('A'), ...start('B'), ...start('C'), ...start('D'),
    { type: 'transfer', from: 'A', to: 'B', amount: 500 },
    { type: 'leave', player: 'A', chips: 1200 }
  ]
};
st = Logic.deriveState(g2);
assert.strictEqual(st.players.A.seated, false);
assert.strictEqual(st.cashedOutTotal, 1200);
n = Logic.computeNets(g2, st, { B: 0, C: 300, D: 500 });
assert.deepStrictEqual(n.map((x) => x.amount), [1200, -1000, -200, 0]);
pay = Logic.settle(n);
assert.strictEqual(pay.length, 2);
assert(!pay.some((p) => p.from === 'D' || p.to === 'D'));
assert.strictEqual(Logic.validateLog(g2), null);

g2.events.push({ type: 'join', player: 'A' }, { type: 'bank', to: 'A', amount: 500 });
st = Logic.deriveState(g2);
assert.strictEqual(st.players.A.seated, true);
assert.strictEqual(st.players.A.put, 500);
assert.strictEqual(st.players.A.cashedOut, 1200);
assert.strictEqual(st.bankTotal, 2500);

g2.events.push(
  { type: 'bank', to: 'B', amount: 250 },
  { type: 'transfer', from: 'C', to: 'D', amount: 250 },
  { type: 'bank', to: 'D', amount: 300 }
);
st = Logic.deriveState(g2);
assert.strictEqual(st.players.B.put, 1250);
assert.strictEqual(st.players.C.put, 250);
assert.strictEqual(st.players.D.put, 1050);
assert.strictEqual(st.bankTotal, 3050);
assert.strictEqual(Logic.validateLog(g2), null);

// ---------- validateLog ----------
const bad = (events, players) => Logic.validateLog({ buyIn: 500, players: players || [P('A'), P('B')], events });
assert.match(bad([...start('A'), { type: 'join', player: 'A' }]), /already at the table/);
assert.match(bad([...start('A'), { type: 'bank', to: 'B', amount: 500 }]), /B would take a buy-in while not at the table/);
assert.match(bad([...start('A'), { type: 'transfer', from: 'B', to: 'A', amount: 500 }]), /B would give a buy-in/);
assert.match(bad([...start('B'), { type: 'transfer', from: 'B', to: 'A', amount: 500 }]), /A would take a buy-in/);
assert.match(bad([...start('A'), { type: 'leave', player: 'B', chips: 0 }]), /B would leave while not at the table/);
assert.match(bad([...start('A'), { type: 'leave', player: 'A', chips: 600 }]), /more than was on the table/);
assert.match(bad([...start('A')], [P('B')]), /no longer exists/);
// A leave makes later events by that player invalid.
assert.match(
  bad([...start('A'), ...start('B'), { type: 'leave', player: 'A', chips: 0 }, { type: 'transfer', from: 'A', to: 'B', amount: 500 }]),
  /A would give a buy-in while not at the table/
);

// ---------- migrateGame ----------
const old = {
  buyIn: 500,
  players: [P('A'), P('B')],
  events: [
    { type: 'join', player: 'A' }, { type: 'bank', to: 'A', halves: 2 },
    { type: 'join', player: 'B' }, { type: 'bank', to: 'B', halves: 2 },
    { type: 'transfer', from: 'A', to: 'B', halves: 1 }
  ]
};
Logic.migrateGame(old);
assert.deepStrictEqual(old.events.map((e) => e.amount), [undefined, 500, undefined, 500, 250]);
assert(old.events.every((e) => e.eid && e.halves === undefined));
assert.strictEqual(new Set(old.events.map((e) => e.eid)).size, 5);
assert.strictEqual(old.nextEid, 6);
st = Logic.deriveState(old);
assert.deepStrictEqual([st.players.A.put, st.players.B.put, st.bankTotal], [250, 750, 1000]);
// Running it again changes nothing.
const before = JSON.stringify(old);
Logic.migrateGame(old);
assert.strictEqual(JSON.stringify(old), before);
assert.strictEqual(Logic.migrateGame(null), null);

// ---------- combineDebts ----------
assert.deepStrictEqual(
  Logic.combineDebts([{ from: 'B', to: 'A', amount: 700 }, { from: 'A', to: 'B', amount: 300 }]),
  [{ from: 'B', to: 'A', amount: 400 }]
);
// A chain collapses: C owes B, B owes A the same -> C owes A.
assert.deepStrictEqual(
  Logic.combineDebts([{ from: 'C', to: 'B', amount: 500 }, { from: 'B', to: 'A', amount: 500 }]),
  [{ from: 'C', to: 'A', amount: 500 }]
);
assert.deepStrictEqual(
  Logic.combineDebts([{ from: 'A', to: 'B', amount: 200 }, { from: 'B', to: 'A', amount: 200 }]),
  []
);

// ---------- leaderboard ----------
const board = Logic.leaderboard([
  { players: [{ name: 'A', net: 1200 }, { name: 'B', net: -700 }, { name: 'C', net: -500 }] },
  { players: [{ name: 'A', net: -300 }, { name: 'B', net: 300 }] }
]);
assert.deepStrictEqual(board, [
  { name: 'A', games: 2, total: 900, best: 1200, worst: -300 },
  { name: 'B', games: 2, total: -400, best: 300, worst: -700 },
  { name: 'C', games: 1, total: -500, best: -500, worst: -500 }
]);
assert.deepStrictEqual(Logic.leaderboard([]), []);

// ---------- splitChips ----------
const set = [
  { name: 'White', value: 5, count: 100 },
  { name: 'Red', value: 25, count: 50 },
  { name: 'Green', value: 100, count: 25 },
  { name: 'Black', value: 500, count: 3 }
];
let split = Logic.splitChips(set, 6);
assert.deepStrictEqual(split.each, [
  { name: 'White', value: 5, n: 16 },
  { name: 'Red', value: 25, n: 8 },
  { name: 'Green', value: 100, n: 4 }
]);
assert.strictEqual(split.stack, 680);
assert.deepStrictEqual(split.left, [
  { name: 'White', value: 5, n: 4 },
  { name: 'Red', value: 25, n: 2 },
  { name: 'Green', value: 100, n: 1 },
  { name: 'Black', value: 500, n: 3 }
]);
assert.strictEqual(split.leftValue, 1670);
// Everything handed out plus the leftover equals the whole set.
assert.strictEqual(split.stack * 6 + split.leftValue, 500 + 1250 + 2500 + 1500);
split = Logic.splitChips(set, 5);
assert.deepStrictEqual(split.each.map((c) => c.n), [20, 10, 5]);
assert.deepStrictEqual(split.left, [{ name: 'Black', value: 500, n: 3 }]);
assert.deepStrictEqual(Logic.splitChips(set, 0), {
  each: [],
  stack: 0,
  left: set.map((c) => ({ name: c.name, value: c.value, n: c.count })),
  leftValue: 5750
});
assert.deepStrictEqual(Logic.splitChips([{ name: 'Blue', value: 10 }], 4), { each: [], stack: 0, left: [], leftValue: 0 });

// ---------- dealStacks ----------
const counts = (deal) => deal.each.map((c) => c.n);
const worth = (deal) => deal.each.reduce((t, c) => t + c.n * c.value, 0);
const fifty = [
  { name: 'white', value: 1, count: 50 },
  { name: 'black', value: 2, count: 50 },
  { name: 'blue', value: 5, count: 50 },
  { name: 'green', value: 10, count: 50 }
];
// 3 players, buy-in 150: 8 of each is 144, one white and one blue make up the 6.
let deal = Logic.dealStacks(fifty, 3, 150);
assert.deepStrictEqual(counts(deal), [9, 8, 9, 8]);
assert.strictEqual(worth(deal), 150);
assert.strictEqual(deal.stack, 150);
assert.deepStrictEqual(deal.left.map((c) => c.n), [23, 26, 23, 26]);
assert.strictEqual(deal.leftValue, 50 * 18 - 3 * 150);

deal = Logic.dealStacks(fifty, 3, 100);
assert.deepStrictEqual(counts(deal), [5, 5, 5, 6]);
assert.strictEqual(worth(deal), 100);

// A chip as big as the buy-in is left out rather than being the whole stack.
deal = Logic.dealStacks(fifty.concat([{ name: 'red', value: 100, count: 50 }]), 3, 100);
assert.deepStrictEqual(deal.each.map((c) => c.name), ['white', 'black', 'blue', 'green']);
assert.deepStrictEqual(counts(deal), [5, 5, 5, 6]);

// Limited by the set: 6 players, 16/8/4 available each, black cannot be shared.
deal = Logic.dealStacks(set, 6, 500);
assert.deepStrictEqual(deal.each, [
  { name: 'White', value: 5, n: 5 },
  { name: 'Red', value: 25, n: 3 },
  { name: 'Green', value: 100, n: 4 }
]);
assert.strictEqual(worth(deal), 500);
assert.deepStrictEqual(deal.left.map((c) => c.n), [70, 32, 1, 3]);

// Never more than the set holds.
deal = Logic.dealStacks(fifty, 5, 180);
assert.strictEqual(worth(deal), 180);
assert(deal.each.every((c) => c.n <= 10));
deal = Logic.dealStacks(fifty, 5, 181);
assert.strictEqual(deal, null, 'the set only holds 180 per player');

// No exact stack exists.
assert.strictEqual(Logic.dealStacks([{ name: 'a', value: 5, count: 99 }, { name: 'b', value: 25, count: 99 }], 3, 102), null);
assert.strictEqual(Logic.dealStacks([{ name: 'a', value: 10, count: 2 }], 3, 10), null);
assert.strictEqual(Logic.dealStacks(fifty, 0, 100), null);
assert.strictEqual(Logic.dealStacks(fifty, 3, 0), null);

// A scarce colour limits the even part; the rest is too large to search and
// is made up biggest-first, still landing exactly.
deal = Logic.dealStacks(
  [{ name: 'a', value: 100, count: 3000 }, { name: 'b', value: 500, count: 3000 }, { name: 'c', value: 1000, count: 30 }],
  3, 500000
);
assert.strictEqual(worth(deal), 500000);
assert.deepStrictEqual(counts(deal), [10, 978, 10]);

// Only an uneven mix is possible: still exact.
deal = Logic.dealStacks([{ name: 'a', value: 25, count: 30 }, { name: 'b', value: 100, count: 30 }], 3, 100);
assert.strictEqual(worth(deal), 100);

// ---------- formatHalves ----------
assert.strictEqual(Logic.formatHalves(0), '0');
assert.strictEqual(Logic.formatHalves(1), '½');
assert.strictEqual(Logic.formatHalves(2), '1');
assert.strictEqual(Logic.formatHalves(3), '1½');
assert.strictEqual(Logic.formatHalves(-1), '−½');
assert.strictEqual(Logic.formatHalves(-2), '−1');

console.log('All logic tests passed');
