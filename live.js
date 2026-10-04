// Optional live view over the Firebase Realtime Database REST interface.
// The scoring phone writes a snapshot to /live/<id>; viewers listen to
// /live/<id>/state. The snapshot is one JSON string, so every update arrives
// whole. Scoring never waits on any of this.
(function (root) {
  'use strict';

  const RETRY_MS = 15000;
  const DEBOUNCE_MS = 600;
  const base = String((root.POKER_CONFIG && root.POKER_CONFIG.firebaseUrl) || '').replace(/\/+$/, '');

  let pending = null; // latest unsent snapshot
  let sending = false;
  let timer = 0;

  function url(id, tail) {
    return base + '/live/' + encodeURIComponent(id) + (tail || '') + '.json';
  }

  function randomHex() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  // Every write carries a fresh nonce `n` and `sig` = owner key + nonce. The
  // database rules require the nonce to change and the sig to match the stored
  // key, so a write that touches only part of the node (which would inherit
  // the stored key) is refused. Only `state` is readable.
  function signed(key, state) {
    const n = randomHex();
    return { owner: key, n: n, sig: key + n, state: state };
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(flush, ms);
  }

  function flush() {
    if (!pending || sending) return;
    clearTimeout(timer);
    const job = pending;
    let failed = false;
    pending = null;
    sending = true;
    fetch(url(job.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed(job.key, JSON.stringify(job.state)))
    })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); })
      .catch(function () {
        // Keep it for the next attempt unless something newer is already queued.
        failed = true;
        if (!pending) pending = job;
      })
      .then(function () {
        sending = false;
        if (pending) schedule(failed ? RETRY_MS : 0);
      });
  }

  function publish(id, key, state) {
    if (!base) return;
    pending = { id: id, key: key, state: state };
    schedule(DEBOUNCE_MS);
  }

  // onState(state | null) for each snapshot; onStatus('live' | 'offline').
  // Returns a function that stops listening.
  function watch(id, onState, onStatus) {
    const es = new EventSource(url(id, '/state'));
    es.addEventListener('put', function (e) {
      let state = null;
      try {
        const data = JSON.parse(e.data).data;
        state = data ? JSON.parse(data) : null;
      } catch (err) {
        state = null;
      }
      onState(state);
    });
    es.onopen = function () { onStatus('live'); };
    es.onerror = function () { onStatus('offline'); };
    return function () { es.close(); };
  }

  if (base) root.addEventListener('online', flush);

  root.Live = {
    enabled: !!base,
    newId: randomHex,
    isId: function (id) { return /^[a-f0-9]{32}$/.test(id || ''); },
    publish: publish,
    watch: watch
  };
})(self);
