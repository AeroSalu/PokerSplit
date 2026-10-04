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

// settle
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

// deriveState: the example from the plan, buy-in 500.
const P = (id) => ({ id, name: id });
const start = (id) => [{ type: 'join', player: id }, { type: 'bank', to: id, halves: 2 }];
const game = {
  buyIn: 500,
  players: [P('A'), P('B'), P('C')],
  events: [
    ...start('A'), ...start('B'), ...start('C'),
    { type: 'transfer', from: 'A', to: 'B', halves: 2 },
    { type: 'bank', to: 'C', halves: 2 }
  ]
};
let st = Logic.deriveState(game);
assert.deepStrictEqual(['A', 'B', 'C'].map((id) => st.players[id].halves), [0, 4, 4]);
assert.strictEqual(st.bankHalves, 8);

game.events.push({ type: 'transfer', from: 'A', to: 'B', halves: 2 });
st = Logic.deriveState(game);
assert.strictEqual(st.players.A.halves, -2, 'giver can go below nil');
game.events.pop();

st = Logic.deriveState(game);
let n = Logic.computeNets(game, st, { A: 1200, B: 300, C: 500 });
assert.deepStrictEqual(n.map((x) => x.amount), [1200, -700, -500]);
pay = Logic.settle(n);
assert.deepStrictEqual(pay, [
  { from: 'B', to: 'A', amount: 700 },
  { from: 'C', to: 'A', amount: 500 }
]);

// Joining, leaving, rejoining and half buy-ins.
const g2 = {
  buyIn: 500,
  players: [P('A'), P('B'), P('C'), P('D')],
  events: [
    ...start('A'), ...start('B'), ...start('C'),
    { type: 'join', player: 'D' }, { type: 'bank', to: 'D', halves: 2 },
    { type: 'transfer', from: 'A', to: 'B', halves: 2 },
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

g2.events.push({ type: 'join', player: 'A' }, { type: 'bank', to: 'A', halves: 2 });
st = Logic.deriveState(g2);
assert.strictEqual(st.players.A.seated, true);
assert.strictEqual(st.players.A.halves, 2);
assert.strictEqual(st.players.A.cashedOut, 1200);
assert.strictEqual(st.bankHalves, 10);

g2.events.push({ type: 'bank', to: 'B', halves: 1 }, { type: 'transfer', from: 'C', to: 'D', halves: 1 });
st = Logic.deriveState(g2);
assert.strictEqual(st.players.B.halves, 5);
assert.strictEqual(st.players.C.halves, 1);
assert.strictEqual(st.players.D.halves, 3);
assert.strictEqual(st.bankHalves, 11);

// formatHalves
assert.strictEqual(Logic.formatHalves(0), '0');
assert.strictEqual(Logic.formatHalves(1), '½');
assert.strictEqual(Logic.formatHalves(2), '1');
assert.strictEqual(Logic.formatHalves(3), '1½');
assert.strictEqual(Logic.formatHalves(-1), '−½');
assert.strictEqual(Logic.formatHalves(-2), '−1');

console.log('All logic tests passed');
