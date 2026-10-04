// Screens, sheets and event handling. Game rules live in logic.js and
// persistence in store.js.
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
  let tab = 'game';
  let ctx = null; // what the open sheet is for
  let installEvent = null;
  let toastTimer = 0;

  function newGame(buyIn) {
    return {
      stage: 'setup',
      buyIn: buyIn,
      date: null,
      nextId: 1,
      players: [],
      events: [],
      finalChips: {},
      ticks: {},
      override: false
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

  function countLabel(halves) {
    if (halves === 0) return 'Nil';
    return Logic.formatHalves(halves) + (Math.abs(halves) <= 2 ? ' buy-in' : ' buy-ins');
  }

  function sizeWord(halves) {
    return halves === 1 ? 'a half buy-in' : 'a buy-in';
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
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  function describe(e) {
    if (e.type === 'leave') return playerName(e.player) + ' left with ' + money(e.chips);
    if (e.type !== 'bank' && e.type !== 'transfer') return '';
    const src = e.type === 'bank' ? 'the bank' : playerName(e.from);
    const verb = e.withJoin === 'join' ? ' joined with ' : e.withJoin === 'rejoin' ? ' rejoined with ' : ' took ';
    return playerName(e.to) + verb + sizeWord(e.halves) + ' from ' + src;
  }

  // ---------- sheets ----------

  function openSheet(html) {
    sheetBody.innerHTML = html;
    sheet.hidden = false;
    const first = sheetBody.querySelector('input, textarea');
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
      const picks = unusedNames();
      head =
        '<p class="sheet-title">Add player</p>' +
        '<input id="join-name" class="input" placeholder="Player name" autocomplete="off" maxlength="24">' +
        (picks.length
          ? '<div class="chips">' + picks.map(function (n) {
              return '<button type="button" class="chip" data-action="join-pick" data-name="' + esc(n) + '">' + esc(n) + '</button>';
            }).join('') + '</div>'
          : '');
    } else {
      head = '<p class="sheet-title">' + (ctx.kind === 'rejoin' ? 'Rejoin: ' : 'Buy-in: ') + esc(playerName(ctx.player)) + '</p>';
    }

    openSheet(
      head +
      '<div class="seg">' +
        '<button type="button" data-action="size" data-halves="2" aria-pressed="true">Full · ' + money(game.buyIn) + '</button>' +
        '<button type="button" data-action="size" data-halves="1" aria-pressed="false">Half · ' + money(game.buyIn / 2) + '</button>' +
      '</div>' +
      '<h2>Take it from</h2>' +
      '<div class="sources">' +
        '<button type="button" class="btn" data-action="source" data-src="bank">Bank<span>adds to the bank total</span></button>' +
        others.map(function (p) {
          return '<button type="button" class="btn" data-action="source" data-src="' + p.id + '">' + esc(p.name) +
            '<span>has ' + esc(countLabel(st.players[p.id].halves).toLowerCase()) + '</span></button>';
        }).join('') +
      '</div>' +
      '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>'
    );
  }

  function takeBuyIn(src) {
    let id = ctx.player;
    let flag = '';

    if (ctx.kind === 'add') {
      const name = cleanName($('#join-name').value);
      const err = nameError(name);
      if (err) { toast(err); return; }
      id = addPlayer(name);
      rememberNames([name]);
      flag = 'join';
    } else if (ctx.kind === 'rejoin') {
      flag = 'rejoin';
    }
    if (flag) game.events.push({ type: 'join', player: id });

    const e = src === 'bank'
      ? { type: 'bank', to: id, halves: ctx.halves }
      : { type: 'transfer', from: src, to: id, halves: ctx.halves };
    if (flag) e.withJoin = flag;
    game.events.push(e);

    save();
    closeSheet();
    render();
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

  function renderSetup() {
    const picks = unusedNames();
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
        (picks.length
          ? '<div class="chips">' + picks.map(function (n) {
              return '<button type="button" class="chip" data-action="setup-pick" data-name="' + esc(n) + '">' + esc(n) + '</button>';
            }).join('') + '</div>'
          : '') +
        (game.players.length
          ? '<ul class="list">' + game.players.map(function (p) {
              return '<li><span class="name">' + esc(p.name) + '</span>' +
                '<button type="button" class="btn small ghost" data-action="setup-remove" data-id="' + p.id + '">Remove</button></li>';
            }).join('') + '</ul>'
          : '<p class="muted small-text">Add at least two players. Each starts with one buy-in from the bank.</p>') +
      '</section>' +
      '<button type="button" class="btn primary block" data-action="start">Start game</button>';
  }

  function renderPlay() {
    const st = Logic.deriveState(game);
    const seated = game.players.filter(function (p) { return st.players[p.id].seated; });
    const left = game.players.filter(function (p) { return !st.players[p.id].seated; });
    const bankMoney = (st.bankHalves * game.buyIn) / 2;
    const lines = game.events.map(describe).filter(Boolean).reverse();
    const last = game.events[game.events.length - 1];

    return '<div class="stats">' +
        '<div class="stat"><b>' + money(bankMoney) + '</b><span>Bank total · ' + esc(countLabel(st.bankHalves).toLowerCase()) + '</span></div>' +
        '<div class="stat"><b>' + money(bankMoney - st.cashedOutTotal) + '</b><span>On the table</span></div>' +
      '</div>' +
      '<section class="card">' +
        '<div class="spread"><h2>At the table</h2>' +
          '<button type="button" class="btn small" data-action="add-player">Add player</button></div>' +
        (seated.length
          ? '<ul class="list">' + seated.map(function (p) {
              const h = st.players[p.id].halves;
              const sub = h < 0
                ? '<span class="sub pos">' + esc(countLabel(h)) + ' · profit locked ' + money((h * game.buyIn) / 2) + '</span>'
                : '<span class="sub">' + esc(countLabel(h)) + '</span>';
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
            const net = s.cashedOut - (s.halves * game.buyIn) / 2;
            return '<li><div class="who"><span class="name">' + esc(p.name) + '</span>' +
              '<span class="sub">left with ' + money(s.cashedOut) + ' · <span class="num ' + tone(net) + '">' + signed(net) + '</span></span></div>' +
              '<button type="button" class="btn small ghost" data-action="rejoin" data-id="' + p.id + '">Rejoin</button></li>';
          }).join('') + '</ul></section>'
        : '') +
      '<section class="card">' +
        '<div class="spread"><h2>Log</h2>' +
          '<button type="button" class="btn small ghost" data-action="undo"' + (!last || last.start ? ' disabled' : '') + '>Undo last</button></div>' +
        '<ul class="log">' + lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
      '</section>' +
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

    const expected = (st.bankHalves * game.buyIn) / 2;
    const diff = entered - expected;
    const usable = complete && (diff === 0 || game.override);
    const nets = Logic.computeNets(game, st, chips);
    return {
      complete: complete,
      entered: entered,
      expected: expected,
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
            '<span class="sub">' + esc(countLabel(s.halves)) + '</span></div>' +
            '<input class="input chips-in num" inputmode="numeric" autocomplete="off" placeholder="chips" data-chips="' + p.id + '"' +
            ' aria-label="Final chips for ' + esc(p.name) + '" value="' + esc(v == null ? '' : v) + '"></li>';
        }).join('') + '</ul>' +
      '</section>' +
      '<div id="settle-out" style="display:grid;gap:14px"></div>' +
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

  function resultText(d) {
    const lines = ['Poker · ' + fmtDate(game.date), 'Buy-in ' + money(game.buyIn), '', 'Results'];
    d.nets.slice().sort(function (a, b) { return b.amount - a.amount; }).forEach(function (x) {
      lines.push(playerName(x.id) + '  ' + signed(x.amount));
    });
    lines.push('', 'Payments');
    if (!d.payments.length) lines.push('Nobody owes anything.');
    d.payments.forEach(function (p) {
      lines.push(playerName(p.from) + ' pays ' + playerName(p.to) + ' ' + money(p.amount));
    });
    return lines.join('\n');
  }

  function finishGame() {
    const d = settleData();
    if (!d.usable) return;
    const today = todayISO();
    d.payments.forEach(function (p) {
      const paid = !!game.ticks[p.from + '>' + p.to];
      debts.unshift({
        id: Store.newId(),
        from: playerName(p.from),
        to: playerName(p.to),
        amount: p.amount,
        gameDate: game.date || today,
        status: paid ? 'paid' : 'unpaid',
        paidDate: paid ? today : null
      });
    });
    Store.saveDebts(debts);
    rememberNames(game.players.map(function (p) { return p.name; }));
    game = newGame(String(game.buyIn));
    save();
    tab = 'debts';
    closeSheet();
    render();
    toast('Game saved');
  }

  // ---------- debts tab ----------

  function debtRow(d) {
    if (d.status === 'unpaid') {
      return '<li><div class="who"><span class="name">' + esc(d.from) + ' owes ' + esc(d.to) + '</span>' +
        '<span class="sub"><span class="num">' + money(d.amount) + '</span> · ' + esc(fmtDate(d.gameDate)) + '</span></div>' +
        '<button type="button" class="btn small primary" data-action="mark-paid" data-id="' + esc(d.id) + '">Mark paid</button></li>';
    }
    return '<li><div class="who"><span class="name">' + esc(d.from) + ' paid ' + esc(d.to) + '</span>' +
      '<span class="sub"><span class="num">' + money(d.amount) + '</span> · paid ' + esc(fmtDate(d.paidDate)) + '</span></div>' +
      '<div class="acts">' +
        '<button type="button" class="btn small ghost" data-action="unmark" data-id="' + esc(d.id) + '">Undo</button>' +
        '<button type="button" class="btn small ghost danger" data-action="delete-debt" data-id="' + esc(d.id) + '">Delete</button>' +
      '</div></li>';
  }

  function renderDebts() {
    const unpaid = debts.filter(function (d) { return d.status === 'unpaid'; });
    const paid = debts.filter(function (d) { return d.status === 'paid'; });

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
            return '<li><span class="name">' + esc(n) + '</span><span class="small-text">' + parts.join(' · ') + '</span></li>';
          }).join('') + '</ul></section>'
        : '') +
      '<section class="card">' +
        '<div class="spread"><h2>Unpaid</h2>' +
          (unpaid.length ? '<button type="button" class="btn small ghost" data-action="share-unpaid">Share</button>' : '') + '</div>' +
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
        '<p class="muted small-text">Debts are stored only on this phone. Export a backup to keep a copy or move to another phone.</p>' +
        '<div class="row">' +
          '<button type="button" class="btn" style="flex:1" data-action="export">Export</button>' +
          '<button type="button" class="btn" style="flex:1" data-action="import">Import</button>' +
        '</div>' +
      '</section>';
  }

  function findDebt(id) {
    return debts.find(function (d) { return d.id === id; });
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
    const data = JSON.stringify(Store.exportData(debts, names), null, 2);
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
      'This replaces the ' + debts.length + ' debt records on this phone with ' + data.debts.length + ' from the backup.',
      'Replace',
      function () {
        debts = data.debts;
        names = [];
        Store.saveDebts(debts);
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
    document.querySelectorAll('.tab').forEach(function (b) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const unpaid = debts.filter(function (d) { return d.status === 'unpaid'; }).length;
    const badge = $('#debt-badge');
    badge.hidden = !unpaid;
    badge.textContent = unpaid;
    $('#topbar-note').textContent = tab === 'game' && game.stage !== 'setup' ? 'Buy-in ' + money(game.buyIn) : '';

    if (tab === 'debts') view.innerHTML = renderDebts();
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
    'start': function () {
      const amount = parseAmount(game.buyIn);
      if (!(amount > 0)) { toast('Enter the buy-in amount'); return; }
      if (amount % 2) { toast('Use an even amount so half buy-ins work'); return; }
      if (game.players.length < 2) { toast('Add at least two players'); return; }
      game.buyIn = amount;
      game.date = todayISO();
      game.stage = 'play';
      game.players.forEach(function (p) {
        game.events.push({ type: 'join', player: p.id });
        game.events.push({ type: 'bank', to: p.id, halves: 2, withJoin: 'join', start: true });
      });
      rememberNames(game.players.map(function (p) { return p.name; }));
      save();
      render();
    },

    'buyin': function (el) { ctx = { kind: 'buyin', player: el.dataset.id, halves: 2 }; sourceSheet(); },
    'rejoin': function (el) { ctx = { kind: 'rejoin', player: el.dataset.id, halves: 2 }; sourceSheet(); },
    'add-player': function () { ctx = { kind: 'add', player: null, halves: 2 }; sourceSheet(); },
    'join-pick': function (el) { $('#join-name').value = el.dataset.name; },
    'size': function (el) {
      ctx.halves = Number(el.dataset.halves);
      sheetBody.querySelectorAll('.seg button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === el));
      });
    },
    'source': function (el) { takeBuyIn(el.dataset.src); },

    'leave': function (el) {
      const st = Logic.deriveState(game);
      const onTable = (st.bankHalves * game.buyIn) / 2 - st.cashedOutTotal;
      ctx = { kind: 'leave', player: el.dataset.id, max: onTable };
      openSheet(
        '<p class="sheet-title">' + esc(playerName(el.dataset.id)) + ' is leaving</p>' +
        '<form data-form="leave" style="display:grid;gap:14px">' +
          '<label class="field" for="leave-chips">Chips they are leaving with</label>' +
          '<input id="leave-chips" class="input num" inputmode="numeric" autocomplete="off" placeholder="0">' +
          '<p class="muted small-text">' + money(onTable) + ' is on the table.</p>' +
          '<button type="submit" class="btn primary block">Confirm</button>' +
          '<button type="button" class="btn ghost block" data-action="close-sheet">Cancel</button>' +
        '</form>'
      );
    },

    'undo': function () {
      const last = game.events[game.events.length - 1];
      if (!last || last.start) return;
      game.events.pop();
      if (last.withJoin) {
        game.events.pop(); // the join that came with this buy-in
        if (last.withJoin === 'join') {
          game.players = game.players.filter(function (p) { return p.id !== last.to; });
        }
      }
      save();
      render();
    },

    'to-settle': function () { game.stage = 'settle'; save(); render(); window.scrollTo(0, 0); },
    'to-play': function () { game.stage = 'play'; save(); render(); },
    'discard': function () {
      confirmSheet('Discard game', 'This game and its log are removed. Debts from earlier games are kept.', 'Discard', function () {
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
      if (d.usable) shareText('Poker result', resultText(d));
    },
    'finish': function () {
      const d = settleData();
      if (!d.usable) return;
      const paid = d.payments.filter(function (p) { return game.ticks[p.from + '>' + p.to]; }).length;
      const open = d.payments.length - paid;
      confirmSheet(
        'Finish game',
        (d.payments.length
          ? open + ' unpaid and ' + paid + ' paid payment' + (d.payments.length === 1 ? '' : 's') + ' will be saved under Debts. '
          : '') + 'The table is then cleared for a new game.',
        'Finish game',
        finishGame
      );
    },

    'mark-paid': function (el) {
      const d = findDebt(el.dataset.id);
      if (!d) return;
      d.status = 'paid';
      d.paidDate = todayISO();
      Store.saveDebts(debts);
      render();
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
    'share-unpaid': function () {
      const lines = ['Poker debts still unpaid'];
      debts.filter(function (d) { return d.status === 'unpaid'; }).forEach(function (d) {
        lines.push(d.from + ' owes ' + d.to + ' ' + money(d.amount) + ' (' + fmtDate(d.gameDate) + ')');
      });
      shareText('Unpaid poker debts', lines.join('\n'));
    },
    'export': exportBackup,
    'import': function () { importInput.click(); }
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
    'leave': function () {
      const chips = parseAmount($('#leave-chips').value);
      if (isNaN(chips)) { toast('Enter their chips as a whole number'); return; }
      if (chips > ctx.max) { toast('Only ' + money(ctx.max) + ' is on the table'); return; }
      game.events.push({ type: 'leave', player: ctx.player, chips: chips });
      save();
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
    if (tab === 'game' && game.stage === 'setup' && !typing) render();
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  render();
})();
