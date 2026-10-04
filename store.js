// Everything is kept on this phone in localStorage. Reads and writes are
// guarded because storage can be unavailable (private mode, blocked site data).
(function (root) {
  'use strict';

  const KEYS = { game: 'pt.game', debts: 'pt.debts', names: 'pt.names' };

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

  function cleanDebt(d) {
    if (!d || typeof d.from !== 'string' || typeof d.to !== 'string') return null;
    if (typeof d.amount !== 'number' || !(d.amount > 0)) return null;
    const paid = d.status === 'paid';
    return {
      id: typeof d.id === 'string' ? d.id : newId(),
      from: d.from,
      to: d.to,
      amount: d.amount,
      gameDate: typeof d.gameDate === 'string' ? d.gameDate : '',
      status: paid ? 'paid' : 'unpaid',
      paidDate: paid && typeof d.paidDate === 'string' ? d.paidDate : null
    };
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Returns { debts, names } or null if the file is not a backup of this app.
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!data || data.app !== 'poker-tracker' || !Array.isArray(data.debts)) return null;
    const debts = data.debts.map(cleanDebt).filter(Boolean);
    const names = Array.isArray(data.names)
      ? data.names.filter(function (n) { return typeof n === 'string' && n.trim(); })
      : [];
    return { debts: debts, names: names };
  }

  root.Store = {
    newId: newId,
    loadGame: function () { return read(KEYS.game, null); },
    saveGame: function (game) { write(KEYS.game, game); },
    loadDebts: function () { return read(KEYS.debts, []).map(cleanDebt).filter(Boolean); },
    saveDebts: function (debts) { write(KEYS.debts, debts); },
    loadNames: function () { return read(KEYS.names, []); },
    saveNames: function (names) { write(KEYS.names, names); },
    getFlag: function (name) { return read('pt.flag.' + name, false); },
    setFlag: function (name) { write('pt.flag.' + name, true); },
    exportData: function (debts, names) {
      return { app: 'poker-tracker', version: 1, exported: new Date().toISOString(), debts: debts, names: names };
    },
    parseBackup: parseBackup
  };
})(self);
