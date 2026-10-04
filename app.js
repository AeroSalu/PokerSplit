// Screens, sheets and event handling. Game rules live in logic.js,
// persistence in store.js and the optional live view in live.js.
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };
  const view = $('#view');
  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');
  const toastEl = $('#toast');
  const importInput = $('#import-file');

  let game = Store.loadGame() || newGame('');
  let debts = Store.loadDebts();
  let names = Store.loadNames();
  let history = Store.loadHistory();
  let chipDefs = Store.loadChips();
  let tab = 'game';
  let histView = 'games';
  let editNames = false;
  let ctx = null; // what the open sheet is for
  let installEvent = null;
  let toastTimer = 0;

  // Read-only live view of someone else's game (?view=<id>).
  const viewId = new URLSearchParams(location.search).get('view');
  let viewState = null;
  let viewLoaded = false;
  let viewStatus = 'connecting';

  function newGame(buyIn) {
    return {
      stage: 'setup',
      buyIn: buyIn,
      date: null,
      nextId: 1,
      nextEid: 1,
      players: [],
      events: [],
      finalChips: {},
      ticks: {},
      override: false,
      live: null
    };
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) {
    return Math.abs(n).toLocaleString();
  }

  function signed(n) {
    return (n > 0 ? '+' : n < 0 ? '−' : '') + money(n);
  }

  function tone(n) {
    return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  }

  function parseAmount(s) {
    const t = String(s == null ? '' : s).replace(/[,\s]/g, '');
    return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
  }

  function todayISO() {
    const d = new Date();
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    const opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  function playerName(id) {
    const p = game.players.find(function (x) { return x.id === id; });
    return p ? p.name : '?';
  }

  // "1½ buy-ins" when the money is a whole number of half buy-ins, otherwise
  // the money itself.
  function putLabel(put, buyIn) {
    if (put === 0) return 'Nil';
    const h = (put * 2) / buyIn;
    if (Number.isInteger(h)) return Logic.formatHalves(h) + (Math.abs(h) <= 2 ? ' buy-in' : ' buy-ins');
    return (put < 0 ? '−' : '') + money(put) + ' in';
  }

  function amountWord(amount) {
    if (amount === game.buyIn) return 'a buy-in';
    if (amount * 2 === game.buyIn) return 'a half buy-in';
    return money(amount);
  }

  function cleanName(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  }

  function nameError(name) {
    if (!name) return 'Enter a name';
    const taken = game.players.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); });
    return taken ? name + ' is already in this game' : '';
  }

  function addPlayer(name) {
    const id = 'p' + game.nextId++;
    game.players.push({ id: id, name: name });
    return id;
  }

  function pushEvent(e) {
    e.eid = 'e' + game.nextEid++;
    game.events.push(e);
  }

  function rememberNames(list) {
    list.forEach(function (name) {
      const known = names.some(function (n) { return n.toLowerCase() === name.toLowerCase(); });
      if (!known) names.push(name);
    });
    names.sort(function (a, b) { return a.localeCompare(b); });
    Store.saveNames(names);
  }

  function unusedNames() {
    const inGame = game.players.map(function (p) { return p.name.toLowerCase(); });
    return names.filter(function (n) { return inGame.indexOf(n.toLowerCase()) < 0; });
  }

  function save() {
    Store.saveGame(game);
    if (game.live) Live.publish(game.live.id, game.live.key, liveState());
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3500);
  }

  function describe(e) {
    if (e.type === 'leave') return playerName(e.player) + ' left with ' + money(e.chips);
    if (e.type !== 'bank' && e.type !== 'transfer') return '';
    const src = e.type === 'bank' ? 'the bank' : playerName(e.from);
    const verb = e.withJoin === 'join' ? ' joined with ' : e.withJoin === 'rejoin' ? ' rejoined with ' : ' took ';
    return playerName(e.to) + verb + amountWord(e.amount) + ' from ' + src;
  }

  // Oldest first. A join is folded into the buy-in that came with it.
  function logLines() {
    return game.events
      .filter(function (e) { return e.type !== 'join'; })
      .map(function (e) { return { eid: e.eid, text: describe(e) }; });
  }

  function chipPicks(action, picks) {
    if (!picks.length) return '';
    return '<div class="chips">' + picks.map(function (n) {
      return '<button type="button" class="chip" data-action="' + action + '" data-name="' + esc(n) + '">' + esc(n) + '</button>';
    }).join('') + '</div>';
  }

  // ---------- sheets ----------

  function openSheet(html) {
    sheetBody.innerHTML = html;
    sheet.hidden = false;
    const first = sheetBody.querySelector('[data-focus]');
    if (first) first.focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    sheetBody.innerHTML = '';
    ctx = null;
  }

  function confirmSheet(title, text, label, run, danger) {
    ctx = { kind: 'confirm', run: run };
    openSheet(
      '<p class="sheet-title">' + esc(title) + '</p>' +
      '<p class="muted">' + esc(text) + '</p>' +
      '<button type="button" class="btn block ' + (danger ? 'danger' : 'primary') + '" data-action="confirm-yes">' + esc(label) + '</button>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
    );
  }

  // Shared by Buy-in, Add player and Rejoin: pick a size, then a source.
  function sourceSheet() {
    const st = Logic.deriveState(game);
    const others = game.players.filter(function (p) {
      return st.players[p.id].seated && p.id !== ctx.player;
    });

    let head;
    if (ctx.kind === 'add') {
      head =
        '<p class="sheet-title">Add player</p>' +
        '<input id="join-name" class="input" placeholder="Player name" autocomplete="off" maxlength="24" data-focus>' +
        chipPicks('join-pick', unusedNames());
    } else {
      head = '<p class="sheet-title">' + (ctx.kind === 'rejoin' ? 'Rejoin: ' : 'Buy-in: ') + esc(playerName(ctx.player)) + '</p>';
    }

    openSheet(
      head +
      '<div class="seg">' +
        '<button type="button" data-action="size" data-size="full" aria-pressed="true">Full · ' + money(game.buyIn) + '</button>' +
        '<button type="button" data-action="size" data-size="half" aria-pressed="false">Half · ' + money(game.buyIn / 2) + '</button>' +
        '<button type="button" data-action="size" data-size="custom" aria-pressed="false">Custom</button>' +
      '</div>' +
      '<input id="custom-amount" class="input num" inputmode="numeric" autocomplete="off" placeholder="Amount" hidden>' +
      '<h2>Take it from</h2>' +
      '<div class="sources">' +
        '<button type="button" class="btn" data-action="source" data-src="bank">Bank<span>adds to the bank total</span></button>' +
        others.map(function (p) {
          return '<button type="button" class="btn" data-action="source" data-src="' + p.id + '">' + esc(p.name) +
            '<span>has ' + esc(putLabel(st.players[p.id].put, game.buyIn).toLowerCase()) + '</span></button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
    );
  }

  function takeBuyIn(src) {
    let amount = ctx.size === 'half' ? game.buyIn / 2 : game.buyIn;
    if (ctx.size === 'custom') {
      amount = parseAmount($('#custom-amount').value);
      if (!(amount > 0)) { toast('Enter the amount'); return; }
    }

    let id = ctx.player;
    let flag = '';
    if (ctx.kind === 'add') {
      const name = cleanName($('#join-name').value);
      const err = nameError(name);
      if (err) { toast(err); return; }
      id = addPlayer(name);
      flag = 'join';
    } else if (ctx.kind === 'rejoin') {
      flag = 'rejoin';
    }
    if (flag) pushEvent({ type: 'join', player: id });

    const e = src === 'bank'
      ? { type: 'bank', to: id, amount: amount }
      : { type: 'transfer', from: src, to: id, amount: amount };
    if (flag) e.withJoin = flag;
    pushEvent(e);

    save();
    closeSheet();
    render();
  }

  function leaveSheet(id, value) {
    const st = Logic.deriveState(game);
    const onTable = st.bankTotal - st.cashedOutTotal;
    ctx = { kind: 'leave', player: id, max: onTable };
    openSheet(
      '<p class="sheet-title">' + esc(playerName(id)) + ' is leaving</p>' +
      '<form data-form="leave" class="stack">' +
        '<label class="field" for="leave-chips">Chips they are leaving with</label>' +
        '<div class="row">' +
          '<input id="leave-chips" class="input num" inputmode="numeric" autocomplete="off" placeholder="0" data-focus value="' + esc(value == null ? '' : value) + '">' +
          (chipDefs.length ? '<button type="button" class="btn" data-action="count" data-for="leave">Count</button>' : '') +
        '</div>' +
        '<p class="muted small-text">' + money(onTable) + ' is on the table.</p>' +
        '<button type="submit" class="btn primary block">Confirm</button>' +
        '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>' +
      '</form>'
    );
  }

  // target: { type: 'leave' | 'settle', player }
  function countSheet(target) {
    ctx = { kind: 'count', target: target };
    openSheet(
      '<p class="sheet-title">Count chips: ' + esc(playerName(target.player)) + '</p>' +
      chipDefs.map(function (c, i) {
        return '<label class="spread"><span>' + esc(c.name) + ' <span class="muted num">× ' + money(c.value) + '</span></span>' +
          '<input class="input chips-in num" inputmode="numeric" autocomplete="off" placeholder="0" data-count="' + i + '"' + (i ? '' : ' data-focus') + '></label>';
      }).join('') +
      '<div class="spread"><span class="field">Total</span><b id="count-total" class="num">0</b></div>' +
      '<button type="button" class="btn primary block" data-action="count-use">Use total</button>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
    );
  }

  function countTotal() {
    let total = 0;
    sheetBody.querySelectorAll('[data-count]').forEach(function (el) {
      const n = parseAmount(el.value);
      if (!isNaN(n)) total += n * chipDefs[Number(el.dataset.count)].value;
    });
    return total;
  }

  // Chip splitter: how many of each colour every player gets from the set.
  function splitSheet() {
    ctx = { kind: 'split' };
    openSheet(
      '<p class="sheet-title">Split chips between players</p>' +
      '<label class="spread"><span class="field">Players</span>' +
        '<input id="split-players" class="input chips-in num" inputmode="numeric" autocomplete="off" placeholder="0" data-split="players" data-focus value="' +
        (game.players.length >= 2 ? game.players.length : '') + '"></label>' +
      '<h2>Chips in the set</h2>' +
      chipDefs.map(function (c, i) {
        return '<label class="spread"><span>' + esc(c.name) + ' <span class="muted num">× ' + money(c.value) + '</span></span>' +
          '<input class="input chips-in num" inputmode="numeric" autocomplete="off" placeholder="0" data-split="' + i + '" value="' + (c.count || '') + '"></label>';
      }).join('') +
      '<div id="split-out" class="stack"></div>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Close</button>'
    );
    updateSplitOut();
  }

  // Only this part is redrawn while typing, so the inputs keep focus.
  function updateSplitOut() {
    const out = $('#split-out');
    if (!out) return;
    const players = parseAmount($('#split-players').value);
    const total = chipDefs.reduce(function (t, c) { return t + (c.count || 0); }, 0);
    if (!(players > 0) || !total) {
      out.innerHTML = '<div class="note info">Enter the number of players and how many chips of each colour you have.</div>';
      return;
    }

    // With a buy-in entered, every stack is worth exactly one buy-in. Without
    // one, or when the chips cannot make it, show an equal share of the set.
    const buyIn = parseAmount(game.buyIn);
    const deal = buyIn > 0 ? Logic.dealStacks(chipDefs, players, buyIn) : null;
    const s = deal || Logic.splitChips(chipDefs, players);
    const chipCount = s.each.reduce(function (t, c) { return t + c.n; }, 0);
    let note;
    if (deal) {
      note = '<div class="note ok"><span>' + chipCount + ' chips worth <b class="num">' + money(s.stack) +
        '</b>, exactly one buy-in.</span></div>';
    } else if (buyIn > 0) {
      note = '<div class="note warn"><span>These chips cannot make a stack worth exactly ' + money(buyIn) + ' for ' + players +
        ' players. This is an equal share of the whole set instead, worth <b class="num">' + money(s.stack) + '</b> each.</span></div>';
    } else {
      note = '<div class="note info"><span>An equal share of the whole set, worth <b class="num">' + money(s.stack) +
        '</b> each. Enter the buy-in amount first to get stacks worth exactly one buy-in.</span></div>';
    }
    const rows = function (list) {
      return '<ul class="list">' + list.map(function (c) {
        return '<li><span>' + esc(c.name) + ' <span class="muted num">× ' + money(c.value) + '</span></span>' +
          '<span class="num">' + c.n + (c.n === 1 ? ' chip' : ' chips') + '</span></li>';
      }).join('') + '</ul>';
    };

    out.innerHTML =
      '<h2>Each player gets</h2>' +
      (s.each.length
        ? rows(s.each) + note
        : '<p class="muted small-text">There are not enough chips to give every player one of any colour.</p>') +
      (s.left.length
        ? '<h2>Left in the set</h2>' + rows(s.left) +
          '<p class="muted small-text">Worth ' + money(s.leftValue) + '. Keep it aside for later buy-ins.</p>'
        : '<p class="muted small-text">Nothing is left in the set.</p>');
  }

  // ---------- editing the log ----------

  // Applies a changed event list if the log still makes sense; players left
  // with no entries are dropped.
  function applyEvents(events) {
    const used = {};
    events.forEach(function (e) {
      [e.player, e.to, e.from].forEach(function (id) { if (id) used[id] = true; });
    });
    const players = game.players.filter(function (p) { return used[p.id]; });
    const problem = Logic.validateLog({ players: players, events: events });
    if (problem) { toast('Not changed: ' + problem); return false; }

    game.events = events;
    game.players = players;
    Object.keys(game.finalChips).forEach(function (id) { if (!used[id]) delete game.finalChips[id]; });
    save();
    closeSheet();
    render();
    return true;
  }

  function deleteEvent(eid) {
    const i = game.events.findIndex(function (e) { return e.eid === eid; });
    if (i < 0) return;
    const next = game.events.slice();
    // A first buy-in goes together with the join just before it.
    if (game.events[i].withJoin) next.splice(i - 1, 2);
    else next.splice(i, 1);
    applyEvents(next);
  }

  // ---------- game tab ----------

  function installNote() {
    if (installEvent) {
      return '<div class="note info"><span>Install this app on your phone for quick, offline use.</span>' +
        '<button type="button" class="btn small primary" data-action="install">Install app</button></div>';
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (ios && !standalone && !Store.getFlag('ios-hint')) {
      return '<div class="note info"><span>To install: tap Share, then “Add to Home Screen”.</span>' +
        '<button type="button" class="btn small" data-action="hide-hint">Got it</button></div>';
    }
    return '';
  }

  // Remembered names as tap-to-add suggestions, or, while editing, as
  // tap-to-remove chips so misspelt or duplicate names can be cleared out.
  function savedNames() {
    if (!names.length) return '';
    if (editNames) {
      return '<p class="muted small-text">Tap a name to remove it from the saved names. Debts and history are not changed.</p>' +
        '<div class="chips">' + names.map(function (n) {
          return '<button type="button" class="chip remove" data-action="name-forget" data-name="' + esc(n) + '" aria-label="Remove ' + esc(n) + '">' +
            esc(n) + ' ✕</button>';
        }).join('') + '</div>' +
        '<button type="button" class="btn small" data-action="names-edit">Done</button>';
    }
    return chipPicks('setup-pick', unusedNames()) +
      '<button type="button" class="btn small ghost" data-action="names-edit">Edit saved names</button>';
  }

  function renderSetup() {
    return installNote() +
      '<section class="card">' +
        '<label class="field" for="buyin">Buy-in amount</label>' +
        '<input id="buyin" class="input num" inputmode="numeric" autocomplete="off" placeholder="e.g. 500" value="' + esc(game.buyIn) + '">' +
      '</section>' +
      '<section class="card">' +
        '<h2>Players</h2>' +
        '<form class="row" data-form="setup-add">' +
          '<input id="new-name" class="input" placeholder="Player name" autocomplete="off" maxlength="24">' +
          '<button type="submit" class="btn">Add</button>' +
        '</form>' +
        savedNames() +
        (game.players.length
          ? '<ul class="list">' + game.players.map(function (p) {
              return '<li><span class="name">' + esc(p.name) + '</span>' +
                '<button type="button" class="btn small ghost" data-action="setup-remove" data-id="' + p.id + '">Remove</button></li>';
            }).join('') + '</ul>'
          : '<p class="muted small-text">Add at least two players. Each starts with one buy-in from the bank.</p>') +
      '</section>' +
      '<button type="button" class="btn primary block" data-action="start">Start game</button>' +
      '<section class="card">' +
        '<h2>Chip values · optional</h2>' +
        '<p class="muted small-text">Add each chip colour and its value to count stacks by colour instead of adding them up yourself.</p>' +
        (chipDefs.length
          ? '<ul class="list">' + chipDefs.map(function (c, i) {
              return '<li><div class="who"><span class="name">' + esc(c.name) + '</span><span class="sub num">' + money(c.value) + '</span></div>' +
                '<button type="button" class="btn small ghost" data-action="chip-remove" data-i="' + i + '">Remove</button></li>';
            }).join('') + '</ul>'
          : '') +
        '<form class="row" data-form="chip-add">' +
          '<input id="chip-name" class="input" placeholder="Colour" autocomplete="off" maxlength="16" aria-label="Chip colour">' +
          '<input id="chip-value" class="input num" inputmode="numeric" placeholder="Value" autocomplete="off" aria-label="Chip value">' +
          '<button type="submit" class="btn">Add</button>' +
        '</form>' +
        (chipDefs.length ? '<button type="button" class="btn block" data-action="split">Split chips between players</button>' : '') +
      '</section>';
  }

  function renderPlay() {
    const st = Logic.deriveState(game);
    const seated = game.players.filter(function (p) { return st.players[p.id].seated; });
    const left = game.players.filter(function (p) { return !st.players[p.id].seated; });
    const lines = logLines().reverse();
    const last = game.events[game.events.length - 1];
    const bankLabel = putLabel(st.bankTotal, game.buyIn);

    return '<div class="stats">' +
        '<div class="stat"><b>' + money(st.bankTotal) + '</b><span>Bank total' +
          (/buy-in/.test(bankLabel) ? ' · ' + esc(bankLabel) : '') + '</span></div>' +
        '<div class="stat"><b>' + money(st.bankTotal - st.cashedOutTotal) + '</b><span>On the table</span></div>' +
      '</div>' +
      '<section class="card">' +
        '<div class="spread"><h2>At the table</h2>' +
          '<button type="button" class="btn small" data-action="add-player">Add player</button></div>' +
        (seated.length
          ? '<ul class="list">' + seated.map(function (p) {
              const put = st.players[p.id].put;
              const sub = put < 0
                ? '<span class="sub pos">' + esc(putLabel(put, game.buyIn)) + ' · profit locked ' + money(put) + '</span>'
                : '<span class="sub">' + esc(putLabel(put, game.buyIn)) + '</span>';
              return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' + sub + '</div>' +
                '<div class="acts">' +
                  '<button type="button" class="btn small primary" data-action="buyin" data-id="' + p.id + '">Buy-in</button>' +
                  '<button type="button" class="btn small ghost" data-action="leave" data-id="' + p.id + '">Leave</button>' +
                '</div></li>';
            }).join('') + '</ul>'
          : '<p class="muted small-text">Nobody is at the table.</p>') +
      '</section>' +
      (left.length
        ? '<section class="card"><h2>Left</h2><ul class="list">' + left.map(function (p) {
            const s = st.players[p.id];
            const net = s.cashedOut - s.put;
            return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' +
              '<span class="sub">left with ' + money(s.cashedOut) + ' · <span class="num ' + tone(net) + '">' + signed(net) + '</span></span></div>' +
              '<button type="button" class="btn small ghost" data-action="rejoin" data-id="' + p.id + '">Rejoin</button></li>';
          }).join('') + '</ul></section>'
        : '') +
      '<section class="card">' +
        '<div class="spread"><h2>Log</h2>' +
          '<button type="button" class="btn small ghost" data-action="undo"' + (!last || last.start ? ' disabled' : '') + '>Undo last</button></div>' +
        '<ul class="log">' + lines.map(function (l) {
          return '<li><span>' + esc(l.text) + '</span>' +
            '<button type="button" class="more" data-action="log-menu" data-eid="' + l.eid + '" aria-label="Change this entry">⋯</button></li>';
        }).join('') + '</ul>' +
      '</section>' +
      (Live.enabled
        ? '<button type="button" class="btn block" data-action="live">' + (game.live ? 'Live link · on' : 'Live link') + '</button>'
        : '') +
      '<button type="button" class="btn primary block" data-action="to-settle">End game and settle</button>' +
      '<button type="button" class="btn ghost danger block" data-action="discard">Discard game</button>';
  }

  function settleData() {
    const st = Logic.deriveState(game);
    const chips = {};
    let complete = true;
    let entered = st.cashedOutTotal;

    game.players.forEach(function (p) {
      if (!st.players[p.id].seated) return;
      const v = parseAmount(game.finalChips[p.id]);
      if (isNaN(v)) complete = false;
      else { chips[p.id] = v; entered += v; }
    });

    const diff = entered - st.bankTotal;
    const usable = complete && (diff === 0 || game.override);
    const nets = Logic.computeNets(game, st, chips);
    return {
      complete: complete,
      entered: entered,
      expected: st.bankTotal,
      diff: diff,
      usable: usable,
      nets: nets,
      payments: usable ? Logic.settle(nets) : []
    };
  }

  function renderSettle() {
    const st = Logic.deriveState(game);
    return '<section class="card">' +
        '<h2>Final chips</h2>' +
        '<ul class="list">' + game.players.map(function (p) {
          const s = st.players[p.id];
          if (!s.seated) {
            return '<li><div class="who"><span class="name">' + esc(p.name) + '</span><span class="sub">left earlier</span></div>' +
              '<span class="num">' + money(s.cashedOut) + '</span></li>';
          }
          const v = game.finalChips[p.id];
          return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' +
            '<span class="sub">' + esc(putLabel(s.put, game.buyIn)) + '</span></div>' +
            '<div class="acts">' +
              (chipDefs.length ? '<button type="button" class="btn small ghost" data-action="count" data-for="settle" data-id="' + p.id + '">Count</button>' : '') +
              '<input class="input chips-in num" inputmode="numeric" autocomplete="off" placeholder="chips" data-chips="' + p.id + '"' +
              ' aria-label="Final chips for ' + esc(p.name) + '" value="' + esc(v == null ? '' : v) + '">' +
            '</div></li>';
        }).join('') + '</ul>' +
      '</section>' +
      '<div id="settle-out" class="stack"></div>' +
      '<button type="button" class="btn ghost block" data-action="to-play">Back to game</button>';
  }

  // Only this part is redrawn while typing, so the chip inputs keep focus.
  function updateSettleOut() {
    const out = $('#settle-out');
    if (!out) return;
    const d = settleData();
    let html;

    if (!d.complete) {
      html = '<div class="note info">Enter the final chips for everyone still at the table. Use 0 for anyone who is out.</div>';
    } else if (d.diff === 0) {
      html = '<div class="note ok">Chips add up to the bank total: ' + money(d.expected) + '.</div>';
    } else {
      html = '<div class="note warn"><span>Chips are ' + (d.diff > 0 ? 'over' : 'short') + ' by <b>' + money(d.diff) +
        '</b>. Entered ' + money(d.entered) + ', bank total ' + money(d.expected) + '. Recount, or settle anyway.</span>' +
        '<label class="check"><input type="checkbox" data-action="override"' + (game.override ? ' checked' : '') + '>Settle anyway</label></div>';
    }

    if (d.complete) {
      const sorted = d.nets.slice().sort(function (a, b) { return b.amount - a.amount; });
      html += '<section class="card"><h2>Results</h2><ul class="list">' + sorted.map(function (x) {
        return '<li><span class="name">' + esc(playerName(x.id)) + '</span>' +
          '<span class="num ' + tone(x.amount) + '">' + signed(x.amount) + '</span></li>';
      }).join('') + '</ul></section>';
    }

    if (d.usable) {
      html += '<section class="card"><h2>Payments</h2>' + (d.payments.length
        ? '<ul class="list">' + d.payments.map(function (p) {
            const key = p.from + '>' + p.to;
            return '<li><div class="who"><span class="name">' + esc(playerName(p.from)) + ' pays ' + esc(playerName(p.to)) + '</span>' +
              '<span class="sub num">' + money(p.amount) + '</span></div>' +
              '<label class="check small-text"><input type="checkbox" data-action="tick" data-key="' + key + '"' +
              (game.ticks[key] ? ' checked' : '') + '>Paid now</label></li>';
          }).join('') + '</ul>'
        : '<p class="muted small-text">Nobody owes anything.</p>') +
        (d.diff !== 0 ? '<p class="muted small-text">' + money(d.diff) + ' is not covered because the chips did not add up.</p>' : '') +
        '</section>';
    }

    html += '<button type="button" class="btn block" data-action="share-result"' + (d.usable ? '' : ' disabled') + '>Share result</button>' +
      '<button type="button" class="btn primary block" data-action="finish"' + (d.usable ? '' : ' disabled') + '>Finish game</button>';
    out.innerHTML = html;
  }

  // Plain-text summary of a finished game record (also used for history).
  function recordText(rec) {
    const lines = ['Poker · ' + fmtDate(rec.date), 'Buy-in ' + money(rec.buyIn), '', 'Results'];
    rec.players.slice().sort(function (a, b) { return b.net - a.net; }).forEach(function (p) {
      lines.push(p.name + '  ' + signed(p.net));
    });
    lines.push('', 'Payments');
    if (!rec.payments.length) lines.push('Nobody owes anything.');
    rec.payments.forEach(function (p) {
      lines.push(p.from + ' pays ' + p.to + ' ' + money(p.amount));
    });
    return lines.join('\n');
  }

  function buildRecord(d) {
    const st = Logic.deriveState(game);
    return {
      id: Store.newId(),
      date: game.date || todayISO(),
      buyIn: game.buyIn,
      bankTotal: st.bankTotal,
      players: d.nets.map(function (x) {
        const put = st.players[x.id].put;
        return { name: playerName(x.id), put: put, out: x.amount + put, net: x.amount };
      }),
      payments: d.payments.map(function (p) {
        return { from: playerName(p.from), to: playerName(p.to), amount: p.amount };
      }),
      log: logLines().map(function (l) { return l.text; })
    };
  }

  function finishGame() {
    const d = settleData();
    if (!d.usable) return;
    const today = todayISO();
    const rec = buildRecord(d);

    d.payments.forEach(function (p) {
      const paid = !!game.ticks[p.from + '>' + p.to];
      debts.unshift({
        id: Store.newId(),
        from: playerName(p.from),
        to: playerName(p.to),
        amount: p.amount,
        gameDate: rec.date,
        status: paid ? 'paid' : 'unpaid',
        paidDate: paid ? today : null,
        combined: false
      });
    });
    Store.saveDebts(debts);
    history.unshift(rec);
    Store.saveHistory(history);
    rememberNames(game.players.map(function (p) { return p.name; }));
    if (game.live) Live.publish(game.live.id, game.live.key, liveState('finished'));

    game = newGame(String(game.buyIn));
    save();
    tab = 'debts';
    closeSheet();
    render();
    toast('Game saved');
  }

  // ---------- debts tab ----------

  function unpaidDebts() {
    return debts.filter(function (d) { return d.status === 'unpaid'; });
  }

  function debtRow(d) {
    const when = (d.combined ? 'combined ' : '') + fmtDate(d.gameDate);
    if (d.status === 'unpaid') {
      return '<li><div class="who"><span class="name">' + esc(d.from) + ' owes ' + esc(d.to) + '</span>' +
        '<span class="sub"><span class="num">' + money(d.amount) + '</span> · ' + esc(when) + '</span></div>' +
        '<button type="button" class="btn small primary" data-action="pay" data-id="' + esc(d.id) + '">Mark paid</button></li>';
    }
    return '<li><div class="who"><span class="name">' + esc(d.from) + ' paid ' + esc(d.to) + '</span>' +
      '<span class="sub"><span class="num">' + money(d.amount) + '</span> · paid ' + esc(fmtDate(d.paidDate)) + '</span></div>' +
      '<div class="acts">' +
        '<button type="button" class="btn small ghost" data-action="unmark" data-id="' + esc(d.id) + '">Undo</button>' +
        '<button type="button" class="btn small ghost danger" data-action="delete-debt" data-id="' + esc(d.id) + '">Delete</button>' +
      '</div></li>';
  }

  function renderDebts() {
    const unpaid = unpaidDebts();
    const paid = debts.filter(function (d) { return d.status === 'paid'; });
    const simpler = Logic.combineDebts(unpaid).length < unpaid.length;

    const totals = {};
    unpaid.forEach(function (d) {
      totals[d.from] = totals[d.from] || { owes: 0, owed: 0 };
      totals[d.to] = totals[d.to] || { owes: 0, owed: 0 };
      totals[d.from].owes += d.amount;
      totals[d.to].owed += d.amount;
    });
    const people = Object.keys(totals).sort(function (a, b) {
      return (totals[a].owed - totals[a].owes) - (totals[b].owed - totals[b].owes);
    });

    return (people.length
        ? '<section class="card"><h2>Outstanding by person</h2><ul class="list">' + people.map(function (n) {
            const t = totals[n];
            const parts = [];
            if (t.owes) parts.push('<span class="neg">owes <span class="num">' + money(t.owes) + '</span></span>');
            if (t.owed) parts.push('<span class="pos">is owed <span class="num">' + money(t.owed) + '</span></span>');
            return '<li><div class="who"><span class="name">' + esc(n) + '</span><span class="sub">' + parts.join(' · ') + '</span></div>' +
              (t.owes ? '<button type="button" class="btn small ghost" data-action="remind" data-name="' + esc(n) + '">Remind</button>' : '') +
              '</li>';
          }).join('') + '</ul></section>'
        : '') +
      '<section class="card">' +
        '<div class="spread"><h2>Unpaid</h2><div class="acts">' +
          (simpler ? '<button type="button" class="btn small" data-action="simplify">Simplify</button>' : '') +
          (unpaid.length ? '<button type="button" class="btn small ghost" data-action="share-unpaid">Share</button>' : '') +
        '</div></div>' +
        (unpaid.length
          ? '<ul class="list">' + unpaid.map(debtRow).join('') + '</ul>'
          : '<p class="muted small-text">No unpaid debts.</p>') +
      '</section>' +
      '<section class="card"><h2>Paid</h2>' +
        (paid.length
          ? '<ul class="list">' + paid.map(debtRow).join('') + '</ul>'
          : '<p class="muted small-text">Nothing paid yet.</p>') +
      '</section>' +
      '<section class="card"><h2>Backup</h2>' +
        '<p class="muted small-text">Debts, history and chip values are stored only on this phone. Export a backup to keep a copy or move to another phone.</p>' +
        '<div class="row">' +
          '<button type="button" class="btn grow" data-action="export">Export</button>' +
          '<button type="button" class="btn grow" data-action="import">Import</button>' +
        '</div>' +
      '</section>';
  }

  function findDebt(id) {
    return debts.find(function (d) { return d.id === id; });
  }

  function payFull(d) {
    d.status = 'paid';
    d.paidDate = todayISO();
    Store.saveDebts(debts);
    closeSheet();
    render();
  }

  // ---------- history tab ----------

  function renderHistory() {
    const seg = '<div class="seg">' +
      '<button type="button" data-action="hist-view" data-view="games" aria-pressed="' + (histView === 'games') + '">Games</button>' +
      '<button type="button" data-action="hist-view" data-view="board" aria-pressed="' + (histView === 'board') + '">Leaderboard</button>' +
      '</div>';

    if (!history.length) {
      return seg + '<section class="card"><p class="muted small-text">Finished games appear here.</p></section>';
    }

    if (histView === 'board') {
      return seg + '<section class="card"><h2>All games</h2><ul class="list">' + Logic.leaderboard(history).map(function (r, i) {
        return '<li><div class="who"><span class="name">' + (i + 1) + '. ' + esc(r.name) + '</span>' +
          '<span class="sub">' + r.games + (r.games === 1 ? ' game' : ' games') +
          ' · best <span class="num">' + signed(r.best) + '</span> · worst <span class="num">' + signed(r.worst) + '</span></span></div>' +
          '<span class="num ' + tone(r.total) + '">' + signed(r.total) + '</span></li>';
      }).join('') + '</ul></section>';
    }

    return seg + '<section class="card"><h2>Games</h2><ul class="list">' + history.map(function (g) {
      const top = g.players.slice().sort(function (a, b) { return b.net - a.net; })[0];
      return '<li><div class="who"><span class="name">' + esc(fmtDate(g.date)) + '</span>' +
        '<span class="sub">' + g.players.length + ' players' +
        (top && top.net > 0 ? ' · ' + esc(top.name) + ' <span class="num">' + signed(top.net) + '</span>' : '') + '</span></div>' +
        '<button type="button" class="btn small ghost" data-action="hist-open" data-id="' + esc(g.id) + '">View</button></li>';
    }).join('') + '</ul></section>';
  }

  function historySheet(g) {
    ctx = { kind: 'history', id: g.id };
    openSheet(
      '<p class="sheet-title">' + esc(fmtDate(g.date)) + ' · buy-in ' + money(g.buyIn) + '</p>' +
      '<h2>Results</h2><ul class="list">' + g.players.slice().sort(function (a, b) { return b.net - a.net; }).map(function (p) {
        return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' +
          '<span class="sub num">in ' + money(p.put) + ' · out ' + money(p.out) + '</span></div>' +
          '<span class="num ' + tone(p.net) + '">' + signed(p.net) + '</span></li>';
      }).join('') + '</ul>' +
      '<h2>Payments</h2>' + (g.payments.length
        ? '<ul class="list">' + g.payments.map(function (p) {
            return '<li><span>' + esc(p.from) + ' pays ' + esc(p.to) + '</span><span class="num">' + money(p.amount) + '</span></li>';
          }).join('') + '</ul>'
        : '<p class="muted small-text">Nobody owed anything.</p>') +
      '<h2>Log</h2><ul class="log">' + g.log.map(function (t) { return '<li><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' +
      '<button type="button" class="btn block" data-action="hist-share">Share</button>' +
      '<button type="button" class="btn ghost danger block" data-action="hist-delete">Delete this game</button>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Close</button>'
    );
  }

  // ---------- live view ----------

  function liveState(stage) {
    stage = stage || game.stage;
    const st = Logic.deriveState(game);
    const d = stage === 'play' ? null : settleData();
    const done = !!(d && d.usable);
    return {
      v: 1,
      stage: stage,
      date: game.date,
      buyIn: game.buyIn,
      bankTotal: st.bankTotal,
      onTable: st.bankTotal - st.cashedOutTotal,
      players: game.players.map(function (p) {
        const s = st.players[p.id];
        return { name: p.name, put: s.put, seated: s.seated, cashedOut: s.cashedOut };
      }),
      log: logLines().reverse().slice(0, 30).map(function (l) { return l.text; }),
      results: done
        ? d.nets.map(function (x) { return { name: playerName(x.id), net: x.amount }; })
            .sort(function (a, b) { return b.net - a.net; })
        : null,
      payments: done
        ? d.payments.map(function (p) { return { from: playerName(p.from), to: playerName(p.to), amount: p.amount }; })
        : null,
      updated: Date.now()
    };
  }

  function liveLink() {
    return location.origin + location.pathname + '?view=' + game.live.id;
  }

  function liveSheet() {
    ctx = { kind: 'live' };
    if (!game.live) {
      openSheet(
        '<p class="sheet-title">Live link</p>' +
        '<p class="muted">Creates a link the other players can open to watch this game update on their own phones. They cannot change anything.</p>' +
        '<p class="muted small-text">Anyone who has the link can see the names and amounts in this game. Updates need an internet connection; scoring carries on without one and catches up later.</p>' +
        '<button type="button" class="btn primary block" data-action="live-start">Create link</button>' +
        '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
      );
      return;
    }
    openSheet(
      '<p class="sheet-title">Live link is on</p>' +
      '<textarea class="input link-box" readonly rows="3">' + esc(liveLink()) + '</textarea>' +
      '<button type="button" class="btn primary block" data-action="live-share">Share link</button>' +
      '<button type="button" class="btn ghost danger block" data-action="live-stop">Stop sharing</button>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Close</button>'
    );
  }

  function renderViewer() {
    if (!Live.enabled || !Live.isId(viewId)) {
      return '<div class="note warn">This live link is not valid.</div>';
    }
    if (!viewState) {
      if (viewLoaded) return '<div class="note info">Nothing has been shared on this link yet.</div>';
      return '<div class="note info">' + (viewStatus === 'offline' ? 'Cannot reach the live game. Check your connection.' : 'Connecting…') + '</div>';
    }
    const s = viewState;
    if (s.stage === 'ended') return '<div class="note info">The scorer has stopped sharing this game.</div>';

    const players = s.players || [];
    const seated = players.filter(function (p) { return p.seated; });
    const left = players.filter(function (p) { return !p.seated; });
    const time = new Date(s.updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (viewStatus === 'offline'
        ? '<div class="note warn">Connection lost. Showing the last update, from ' + esc(time) + '.</div>'
        : '<div class="note ok">' + (s.stage === 'finished' ? 'Game finished' : 'Live') + ' · updated ' + esc(time) + '</div>') +
      '<div class="stats">' +
        '<div class="stat"><b>' + money(s.bankTotal) + '</b><span>Bank total</span></div>' +
        '<div class="stat"><b>' + money(s.onTable) + '</b><span>On the table</span></div>' +
      '</div>' +
      (s.results
        ? '<section class="card"><h2>Results</h2><ul class="list">' + s.results.map(function (r) {
            return '<li><span class="name">' + esc(r.name) + '</span><span class="num ' + tone(r.net) + '">' + signed(r.net) + '</span></li>';
          }).join('') + '</ul></section>' +
          '<section class="card"><h2>Payments</h2>' + ((s.payments || []).length
            ? '<ul class="list">' + s.payments.map(function (p) {
                return '<li><span>' + esc(p.from) + ' pays ' + esc(p.to) + '</span><span class="num">' + money(p.amount) + '</span></li>';
              }).join('') + '</ul>'
            : '<p class="muted small-text">Nobody owes anything.</p>') + '</section>'
        : '') +
      '<section class="card"><h2>At the table</h2>' + (seated.length
        ? '<ul class="list">' + seated.map(function (p) {
            return '<li><span class="name">' + esc(p.name) + '</span>' +
              '<span class="' + (p.put < 0 ? 'pos' : 'muted') + '">' + esc(putLabel(p.put, s.buyIn)) + '</span></li>';
          }).join('') + '</ul>'
        : '<p class="muted small-text">Nobody is at the table.</p>') + '</section>' +
      (left.length
        ? '<section class="card"><h2>Left</h2><ul class="list">' + left.map(function (p) {
            const net = p.cashedOut - p.put;
            return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' +
              '<span class="sub">left with ' + money(p.cashedOut) + '</span></div>' +
              '<span class="num ' + tone(net) + '">' + signed(net) + '</span></li>';
          }).join('') + '</ul></section>'
        : '') +
      '<section class="card"><h2>Log</h2><ul class="log">' + (s.log || []).map(function (t) {
        return '<li><span>' + esc(t) + '</span></li>';
      }).join('') + '</ul></section>';
  }

  // ---------- sharing and backup ----------

  function shareText(title, text) {
    const fallback = function () {
      const copy = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject();
      copy.then(function () { toast('Copied to clipboard'); }, function () {
        openSheet('<p class="sheet-title">' + esc(title) + '</p>' +
          '<textarea class="input area" readonly>' + esc(text) + '</textarea>' +
          '<button type="button" class="btn block" data-action="close-sheet">Close</button>');
      });
    };
    if (!navigator.share) { fallback(); return; }
    navigator.share({ title: title, text: text }).catch(function (e) {
      if (!e || e.name !== 'AbortError') fallback();
    });
  }

  function exportBackup() {
    const data = JSON.stringify(Store.exportData(debts, names, history, chipDefs), null, 2);
    const name = 'poker-backup-' + todayISO() + '.json';
    let file = null;
    try { file = new File([data], name, { type: 'application/json' }); } catch (e) { file = null; }

    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function () {});
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importBackup(text) {
    const data = Store.parseBackup(text);
    if (!data) { toast('That file is not a Poker Tracker backup'); return; }
    confirmSheet(
      'Import backup',
      'This replaces the debts, history and chip values on this phone (' + debts.length + ' debts, ' + history.length +
        ' games) with the backup (' + data.debts.length + ' debts, ' + data.history.length + ' games).',
      'Replace',
      function () {
        debts = data.debts;
        history = data.history;
        chipDefs = data.chips;
        names = [];
        Store.saveDebts(debts);
        Store.saveHistory(history);
        Store.saveChips(chipDefs);
        rememberNames(data.names);
        closeSheet();
        render();
        toast('Backup imported');
      },
      true
    );
  }

  // ---------- render ----------

  function render() {
    if (viewId) {
      $('#topbar-note').textContent = 'Live view';
      view.innerHTML = renderViewer();
      return;
    }

    document.querySelectorAll('.tab').forEach(function (b) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const unpaid = unpaidDebts().length;
    const badge = $('#debt-badge');
    badge.hidden = !unpaid;
    badge.textContent = unpaid;
    $('#topbar-note').textContent = tab === 'game' && game.stage !== 'setup' ? 'Buy-in ' + money(game.buyIn) : '';

    if (tab === 'debts') view.innerHTML = renderDebts();
    else if (tab === 'history') view.innerHTML = renderHistory();
    else if (game.stage === 'setup') view.innerHTML = renderSetup();
    else if (game.stage === 'play') view.innerHTML = renderPlay();
    else { view.innerHTML = renderSettle(); updateSettleOut(); }
  }

  // ---------- actions ----------

  const actions = {
    'tab': function (el) { tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    'close-sheet': closeSheet,
    'confirm-yes': function () { if (ctx && ctx.run) ctx.run(); },

    'install': function () {
      if (!installEvent) return;
      installEvent.prompt();
      installEvent = null;
      render();
    },
    'hide-hint': function () { Store.setFlag('ios-hint'); render(); },

    'setup-pick': function (el) {
      const err = nameError(el.dataset.name);
      if (err) { toast(err); return; }
      addPlayer(el.dataset.name);
      save();
      render();
    },
    'setup-remove': function (el) {
      game.players = game.players.filter(function (p) { return p.id !== el.dataset.id; });
      save();
      render();
    },
    'names-edit': function () { editNames = !editNames; render(); },
    'name-forget': function (el) {
      names = names.filter(function (n) { return n !== el.dataset.name; });
      Store.saveNames(names);
      if (!names.length) editNames = false;
      render();
    },
    'split': splitSheet,
    'chip-remove': function (el) {
      chipDefs.splice(Number(el.dataset.i), 1);
      Store.saveChips(chipDefs);
      render();
    },
    'start': function () {
      const amount = parseAmount(game.buyIn);
      if (!(amount > 0)) { toast('Enter the buy-in amount'); return; }
      if (amount % 2) { toast('Use an even amount so half buy-ins work'); return; }
      if (game.players.length < 2) { toast('Add at least two players'); return; }
      game.buyIn = amount;
      game.date = todayISO();
      game.stage = 'play';
      game.players.forEach(function (p) {
        pushEvent({ type: 'join', player: p.id });
        pushEvent({ type: 'bank', to: p.id, amount: amount, withJoin: 'join', start: true });
      });
      rememberNames(game.players.map(function (p) { return p.name; }));
      save();
      render();
    },

    'buyin': function (el) { ctx = { kind: 'buyin', player: el.dataset.id, size: 'full' }; sourceSheet(); },
    'rejoin': function (el) { ctx = { kind: 'rejoin', player: el.dataset.id, size: 'full' }; sourceSheet(); },
    'add-player': function () { ctx = { kind: 'add', player: null, size: 'full' }; sourceSheet(); },
    'join-pick': function (el) { $('#join-name').value = el.dataset.name; },
    'size': function (el) {
      ctx.size = el.dataset.size;
      sheetBody.querySelectorAll('.seg button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === el));
      });
      const custom = $('#custom-amount');
      custom.hidden = ctx.size !== 'custom';
      if (!custom.hidden) custom.focus();
    },
    'source': function (el) { takeBuyIn(el.dataset.src); },

    'leave': function (el) { leaveSheet(el.dataset.id); },
    'count': function (el) {
      countSheet(el.dataset.for === 'leave'
        ? { type: 'leave', player: ctx.player }
        : { type: 'settle', player: el.dataset.id });
    },
    'count-use': function () {
      const total = countTotal();
      const target = ctx.target;
      if (target.type === 'leave') { leaveSheet(target.player, total); return; }
      game.finalChips[target.player] = String(total);
      game.ticks = {};
      game.override = false;
      save();
      closeSheet();
      render();
    },

    'undo': function () {
      const last = game.events[game.events.length - 1];
      if (!last || last.start) return;
      deleteEvent(last.eid);
    },
    'log-menu': function (el) {
      const e = game.events.find(function (x) { return x.eid === el.dataset.eid; });
      if (!e) return;
      ctx = { kind: 'log', eid: e.eid };
      openSheet(
        '<p class="sheet-title">' + esc(describe(e)) + '</p>' +
        (e.type === 'leave'
          ? '<form data-form="leave-edit" class="stack">' +
              '<label class="field" for="edit-chips">Chips they left with</label>' +
              '<div class="row"><input id="edit-chips" class="input num" inputmode="numeric" autocomplete="off" value="' + e.chips + '">' +
              '<button type="submit" class="btn">Save</button></div></form>'
          : '') +
        '<button type="button" class="btn ghost danger block" data-action="log-delete">Delete this entry</button>' +
        '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
      );
    },
    'log-delete': function () { deleteEvent(ctx.eid); },

    'to-settle': function () { game.stage = 'settle'; save(); render(); window.scrollTo(0, 0); },
    'to-play': function () { game.stage = 'play'; save(); render(); },
    'discard': function () {
      confirmSheet('Discard game', 'This game and its log are removed. Debts and history from earlier games are kept.', 'Discard', function () {
        if (game.live) Live.publish(game.live.id, game.live.key, { v: 1, stage: 'ended', updated: Date.now() });
        game = newGame(String(game.buyIn));
        save();
        closeSheet();
        render();
      }, true);
    },

    'override': function (el) { game.override = el.checked; save(); updateSettleOut(); },
    'tick': function (el) {
      if (el.checked) game.ticks[el.dataset.key] = true;
      else delete game.ticks[el.dataset.key];
      save();
    },
    'share-result': function () {
      const d = settleData();
      if (d.usable) shareText('Poker result', recordText(buildRecord(d)));
    },
    'finish': function () {
      const d = settleData();
      if (!d.usable) return;
      const paid = d.payments.filter(function (p) { return game.ticks[p.from + '>' + p.to]; }).length;
      const open = d.payments.length - paid;
      confirmSheet(
        'Finish game',
        (d.payments.length ? open + ' unpaid and ' + paid + ' paid will be saved under Debts. ' : '') +
          'The game goes into History and the table is cleared.',
        'Finish game',
        finishGame
      );
    },

    'live': liveSheet,
    'live-start': function () {
      game.live = { id: Live.newId(), key: Live.newId() };
      save();
      render();
      liveSheet();
    },
    'live-share': function () { shareText('Poker live link', liveLink()); },
    'live-stop': function () {
      Live.publish(game.live.id, game.live.key, { v: 1, stage: 'ended', updated: Date.now() });
      game.live = null;
      save();
      closeSheet();
      render();
    },

    'pay': function (el) {
      const d = findDebt(el.dataset.id);
      if (!d) return;
      ctx = { kind: 'pay', id: d.id };
      openSheet(
        '<p class="sheet-title">' + esc(d.from) + ' owes ' + esc(d.to) + ' ' + money(d.amount) + '</p>' +
        '<button type="button" class="btn primary block" data-action="pay-full">Paid in full</button>' +
        '<form data-form="pay-part" class="stack">' +
          '<label class="field" for="part-amount">Or record a part payment</label>' +
          '<div class="row"><input id="part-amount" class="input num" inputmode="numeric" autocomplete="off" placeholder="Amount paid">' +
          '<button type="submit" class="btn">Record</button></div>' +
        '</form>' +
        '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
      );
    },
    'pay-full': function () {
      const d = findDebt(ctx.id);
      if (d) payFull(d);
    },
    'unmark': function (el) {
      const d = findDebt(el.dataset.id);
      if (!d) return;
      d.status = 'unpaid';
      d.paidDate = null;
      Store.saveDebts(debts);
      render();
    },
    'delete-debt': function (el) {
      const d = findDebt(el.dataset.id);
      if (!d) return;
      confirmSheet('Delete record', d.from + ' paid ' + d.to + ' ' + money(d.amount) + '. This record is removed for good.', 'Delete', function () {
        debts = debts.filter(function (x) { return x.id !== d.id; });
        Store.saveDebts(debts);
        closeSheet();
        render();
      }, true);
    },
    'simplify': function () {
      const unpaid = unpaidDebts();
      const combined = Logic.combineDebts(unpaid);
      ctx = {
        kind: 'confirm',
        run: function () {
          const today = todayISO();
          const fresh = combined.map(function (p) {
            return {
              id: Store.newId(), from: p.from, to: p.to, amount: p.amount,
              gameDate: today, status: 'unpaid', paidDate: null, combined: true
            };
          });
          debts = fresh.concat(debts.filter(function (d) { return d.status === 'paid'; }));
          Store.saveDebts(debts);
          closeSheet();
          render();
        }
      };
      openSheet(
        '<p class="sheet-title">Simplify unpaid debts</p>' +
        '<p class="muted">' + unpaid.length + ' unpaid debts become ' + combined.length +
          (combined.length === 1 ? ' payment' : ' payments') + '. Everyone ends up paying or receiving the same total.</p>' +
        (combined.length
          ? '<ul class="list">' + combined.map(function (p) {
              return '<li><span>' + esc(p.from) + ' owes ' + esc(p.to) + '</span><span class="num">' + money(p.amount) + '</span></li>';
            }).join('') + '</ul>'
          : '<p class="small-text">The debts cancel out completely.</p>') +
        '<p class="muted small-text">The separate debts are replaced. Each night’s own payments stay in History.</p>' +
        '<button type="button" class="btn primary block" data-action="confirm-yes">Replace with these</button>' +
        '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
      );
    },
    'remind': function (el) {
      const name = el.dataset.name;
      const owed = unpaidDebts().filter(function (d) { return d.from === name; });
      const total = owed.reduce(function (t, d) { return t + d.amount; }, 0);
      const lines = [name + ', you owe ' + money(total) + ' from poker:'];
      owed.forEach(function (d) {
        lines.push(money(d.amount) + ' to ' + d.to + ' (' + fmtDate(d.gameDate) + ')');
      });
      shareText('Poker reminder', lines.join('\n'));
    },
    'share-unpaid': function () {
      const lines = ['Poker debts still unpaid'];
      unpaidDebts().forEach(function (d) {
        lines.push(d.from + ' owes ' + d.to + ' ' + money(d.amount) + ' (' + fmtDate(d.gameDate) + ')');
      });
      shareText('Unpaid poker debts', lines.join('\n'));
    },
    'export': exportBackup,
    'import': function () { importInput.click(); },

    'hist-view': function (el) { histView = el.dataset.view; render(); },
    'hist-open': function (el) {
      const g = history.find(function (x) { return x.id === el.dataset.id; });
      if (g) historySheet(g);
    },
    'hist-share': function () {
      const g = history.find(function (x) { return x.id === ctx.id; });
      if (g) shareText('Poker result', recordText(g));
    },
    'hist-delete': function () {
      const id = ctx.id;
      confirmSheet('Delete game', 'This game is removed from History and the leaderboard. Debts are not changed.', 'Delete', function () {
        history = history.filter(function (x) { return x.id !== id; });
        Store.saveHistory(history);
        closeSheet();
        render();
      }, true);
    }
  };

  const forms = {
    'setup-add': function () {
      const name = cleanName($('#new-name').value);
      const err = nameError(name);
      if (err) { toast(err); return; }
      addPlayer(name);
      save();
      render();
      $('#new-name').focus();
    },
    'chip-add': function () {
      const name = cleanName($('#chip-name').value).slice(0, 16);
      const value = parseAmount($('#chip-value').value);
      if (!name) { toast('Enter the chip colour'); return; }
      if (!(value > 0)) { toast('Enter the chip value'); return; }
      chipDefs.push({ name: name, value: value, count: 0 });
      chipDefs.sort(function (a, b) { return a.value - b.value; });
      Store.saveChips(chipDefs);
      render();
      $('#chip-name').focus();
    },
    'leave': function () {
      const chips = parseAmount($('#leave-chips').value);
      if (isNaN(chips)) { toast('Enter their chips as a whole number'); return; }
      if (chips > ctx.max) { toast('Only ' + money(ctx.max) + ' is on the table'); return; }
      pushEvent({ type: 'leave', player: ctx.player, chips: chips });
      save();
      closeSheet();
      render();
    },
    'leave-edit': function () {
      const chips = parseAmount($('#edit-chips').value);
      if (isNaN(chips)) { toast('Enter their chips as a whole number'); return; }
      const eid = ctx.eid;
      applyEvents(game.events.map(function (e) {
        return e.eid === eid ? Object.assign({}, e, { chips: chips }) : e;
      }));
    },
    'pay-part': function () {
      const d = findDebt(ctx.id);
      if (!d) return;
      const part = parseAmount($('#part-amount').value);
      if (!(part > 0)) { toast('Enter the amount paid'); return; }
      if (part > d.amount) { toast('That is more than the ' + money(d.amount) + ' owed'); return; }
      if (part === d.amount) { payFull(d); return; }
      d.amount -= part;
      debts.splice(debts.indexOf(d) + 1, 0, {
        id: Store.newId(), from: d.from, to: d.to, amount: part,
        gameDate: d.gameDate, status: 'paid', paidDate: todayISO(), combined: d.combined
      });
      Store.saveDebts(debts);
      closeSheet();
      render();
    }
  };

  document.addEventListener('click', function (e) {
    if (e.target === sheet) { closeSheet(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const run = actions[el.dataset.action];
    if (run) run(el);
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    const run = forms[e.target.dataset.form];
    if (run) run(e.target);
  });

  document.addEventListener('input', function (e) {
    const el = e.target;
    if (el.id === 'buyin') {
      game.buyIn = el.value;
      save();
    } else if (el.dataset && el.dataset.chips) {
      game.finalChips[el.dataset.chips] = el.value;
      game.ticks = {};
      game.override = false;
      save();
      updateSettleOut();
    } else if (el.dataset && el.dataset.count) {
      $('#count-total').textContent = money(countTotal());
    } else if (el.dataset && el.dataset.split) {
      if (el.dataset.split !== 'players') {
        const n = parseAmount(el.value);
        chipDefs[Number(el.dataset.split)].count = isNaN(n) ? 0 : n;
        Store.saveChips(chipDefs);
      }
      updateSplitOut();
    }
  });

  importInput.addEventListener('change', function () {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { importBackup(String(reader.result)); };
    reader.onerror = function () { toast('Could not read that file'); };
    reader.readAsText(file);
  });

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvent = e;
    const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (!viewId && tab === 'game' && game.stage === 'setup' && !typing) render();
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  if (viewId) {
    document.body.classList.add('viewer');
    if (Live.enabled && Live.isId(viewId)) {
      Live.watch(viewId, function (state) {
        viewState = state;
        viewLoaded = true;
        render();
      }, function (status) {
        viewStatus = status;
        render();
      });
    }
  }

  render();
})();
