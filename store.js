// Everything is kept on this phone in localStorage. Reads and writes are
// guarded because storage can be unavailable (private mode, blocked site data).
(function (root) {
  'use strict';

  const KEYS = { game: 'pt.game', debts: 'pt.debts', names: 'pt.names', history: 'pt.history', chips: 'pt.chips', photos: 'pt.photos' };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Nothing to do: the app keeps working from memory for this session.
    }
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function isStr(v) { return typeof v === 'string'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function list(v) { return Array.isArray(v) ? v : []; }

  function cleanDebt(d) {
    if (!d || !isStr(d.from) || !isStr(d.to) || !isNum(d.amount) || !(d.amount > 0)) return null;
    const paid = d.status === 'paid';
    return {
      id: isStr(d.id) ? d.id : newId(),
      from: d.from,
      to: d.to,
      amount: d.amount,
      gameDate: isStr(d.gameDate) ? d.gameDate : '',
      status: paid ? 'paid' : 'unpaid',
      paidDate: paid && isStr(d.paidDate) ? d.paidDate : null,
      combined: d.combined === true
    };
  }

  function cleanRecord(g) {
    if (!g || !isStr(g.date) || !Array.isArray(g.players)) return null;
    return {
      id: isStr(g.id) ? g.id : newId(),
      date: g.date,
      buyIn: isNum(g.buyIn) ? g.buyIn : 0,
      bankTotal: isNum(g.bankTotal) ? g.bankTotal : 0,
      players: g.players
        .filter(function (p) { return p && isStr(p.name) && isNum(p.net); })
        .map(function (p) {
          return { name: p.name, put: isNum(p.put) ? p.put : 0, out: isNum(p.out) ? p.out : 0, net: p.net };
        }),
      payments: list(g.payments)
        .filter(function (p) { return p && isStr(p.from) && isStr(p.to) && isNum(p.amount); })
        .map(function (p) { return { from: p.from, to: p.to, amount: p.amount }; }),
      log: list(g.log).filter(isStr)
    };
  }

  function cleanChip(c) {
    if (!c || !isStr(c.name) || !c.name.trim() || !isNum(c.value) || !(c.value > 0)) return null;
    return { name: c.name, value: c.value, count: isNum(c.count) && c.count > 0 ? Math.floor(c.count) : 0 };
  }

  // Photos are small image data URLs keyed by lower-cased player name.
  function cleanPhotos(map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    Object.keys(map).forEach(function (key) {
      const v = map[key];
      if (isStr(v) && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length < 60000) out[key.toLowerCase()] = v;
    });
    return out;
  }

  // Returns { debts, names, history, chips, photos } or null if the file is
  // not a backup of this app. Older versions lack the later fields.
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!data || data.app !== 'poker-tracker' || !Array.isArray(data.debts)) return null;
    return {
      debts: data.debts.map(cleanDebt).filter(Boolean),
      names: list(data.names).filter(function (n) { return isStr(n) && n.trim(); }),
      history: list(data.history).map(cleanRecord).filter(Boolean),
      chips: list(data.chips).map(cleanChip).filter(Boolean),
      photos: cleanPhotos(data.photos)
    };
  }

  root.Store = {
    newId: newId,
    loadGame: function () { return Logic.migrateGame(read(KEYS.game, null)); },
    saveGame: function (game) { write(KEYS.game, game); },
    loadDebts: function () { return list(read(KEYS.debts, [])).map(cleanDebt).filter(Boolean); },
    saveDebts: function (debts) { write(KEYS.debts, debts); },
    loadNames: function () { return list(read(KEYS.names, [])); },
    saveNames: function (names) { write(KEYS.names, names); },
    loadHistory: function () { return list(read(KEYS.history, [])).map(cleanRecord).filter(Boolean); },
    saveHistory: function (history) { write(KEYS.history, history); },
    loadChips: function () { return list(read(KEYS.chips, [])).map(cleanChip).filter(Boolean); },
    saveChips: function (chips) { write(KEYS.chips, chips); },
    loadPhotos: function () { return cleanPhotos(read(KEYS.photos, {})); },
    savePhotos: function (photos) { write(KEYS.photos, photos); },
    getFlag: function (name) { return read('pt.flag.' + name, false); },
    setFlag: function (name) { write('pt.flag.' + name, true); },
    exportData: function (debts, names, history, chips, photos) {
      return {
        app: 'poker-tracker',
        version: 3,
        exported: new Date().toISOString(),
        debts: debts,
        names: names,
        history: history,
        chips: chips,
        photos: photos || {}
      };
    },
    parseBackup: parseBackup
  };
})(self);
