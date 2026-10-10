/*
 * jacob.gg shared kit: things every daily game shows the same way.
 *   <script src="https://biccyanzac-pixel.github.io/jacob.gg/kit/jgg.js" defer></script>
 * (a classic script, before the game's module script; it defines window.JGG)
 *
 *   JGG.level(day)                     -> { weekday: 'Saturday', level: 6, label: 'Hardest', text: 'Saturday · hardest' }
 *   JGG.levelChip(day)                 -> <span class="jgg-level"> element with that text
 *   JGG.rate({ game, day, mount })     -> renders "Rate today's <game>" into mount (an element). Call it when the
 *                                         day's game is finished. Safe to call repeatedly; keeps what was typed.
 *
 * Ratings go to the hub worker (jacob.gg/worker). ?hub=<url> overrides it for local testing, ?hub=off disables.
 * Every call fails soft: if the hub is down, the widget says so and the game carries on.
 */
(function () {
  'use strict';

  var HUB = 'https://jgg-hub.jacob-gg-leaderboard-worker.workers.dev';
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // The house difficulty curve (see PLAYBOOK.md): Monday easiest, rising to Saturday; Sunday is a special.
  var LEVELS = ['Sunday special', 'Easiest', 'Easy', 'Medium', 'Harder', 'Hard', 'Hardest'];
  var NAMES = { 'ridd-le': 'ridd-le', yogle: 'Yogle', predictle: 'Predictle', pointle: 'Pointle', factle: 'Factle', perceptle: 'Perceptle', describle: 'Describle' };

  function hubUrl() {
    try {
      var q = new URLSearchParams(location.search).get('hub');
      if (q === 'off') return null;
      if (q) return q.replace(/\/+$/, '');
    } catch (e) { /* old browser */ }
    return window.JGG_HUB || HUB;
  }

  function raterId() {
    var key = 'jgg:rater', id = null;
    try { id = localStorage.getItem(key); } catch (e) { /* private mode */ }
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join(''));
      try { localStorage.setItem(key, id); } catch (e) { /* the rating still works for this visit */ }
    }
    return id;
  }

  function level(day) {
    var w = new Date(day + 'T00:00:00Z').getUTCDay();
    var label = LEVELS[w];
    return { weekday: WEEKDAYS[w], level: w, label: label, text: w === 0 ? label : WEEKDAYS[w] + ' · ' + label.toLowerCase() };
  }

  function levelChip(day) {
    var l = level(day), s = document.createElement('span');
    s.className = 'jgg-level';
    s.dataset.level = String(l.level);
    s.textContent = l.text;
    return s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function api(path, body) {
    var base = hubUrl();
    if (!base) return Promise.reject(new Error('Ratings are off.'));
    return fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.message) || 'Rating failed (HTTP ' + res.status + ').');
        return data;
      });
    });
  }

  var fmt = function (v) { return v === null ? '–' : (v % 1 ? v.toFixed(1) : String(v)) + ' ★'; };
  var avgText = function (d, isToday) {
    return d && d.votes ? (isToday ? 'Average today: ' : 'Average for this day: ') + d.avg.toFixed(1) + ' ★ from ' + d.votes
      + (d.votes === 1 ? ' rating.' : ' ratings.') : '';
  };

  function rate(opts) {
    var game = opts.game, day = opts.day, mount = opts.mount;
    if (!mount || !game || !day) return;
    var key = game + '|' + day;
    if (mount.dataset.jggRate === key && mount.firstChild) return; // already showing this day's widget
    mount.dataset.jggRate = key;

    var chosen = null, saved = null;
    var isToday = day === new Date().toISOString().slice(0, 10);
    var dayName = new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    var box = el('div', 'jgg-rate');
    var title = el('p', 'jgg-rate-title', isToday ? 'Rate today’s ' + (NAMES[game] || game) : 'Rate ' + (NAMES[game] || game) + ' for ' + dayName);
    var stars = el('span', 'jgg-stars');
    var bg = el('span', 'jgg-stars-bg', '★★★★★');
    var fg = el('span', 'jgg-stars-fg', '★★★★★');
    var value = el('span', 'jgg-stars-value', 'Tap or slide');
    var msg = el('textarea');
    var send = el('button', 'jgg-rate-send', 'Send rating');
    var note = el('p', 'jgg-rate-note');
    var row = el('div', 'jgg-rate-row');
    stars.append(bg, fg);
    row.append(stars, value);
    box.append(title, row, msg, send, note);
    msg.rows = 2;
    msg.maxLength = 500;
    msg.placeholder = 'Anything to tell the maker? (optional)';
    msg.setAttribute('aria-label', 'Optional message');
    send.type = 'button';
    send.disabled = true;
    note.setAttribute('role', 'status');
    stars.tabIndex = 0;
    stars.setAttribute('role', 'slider');
    stars.setAttribute('aria-label', 'Stars, 0 to 5');
    stars.setAttribute('aria-valuemin', '0');
    stars.setAttribute('aria-valuemax', '5');

    function paint(v) {
      fg.style.width = 'calc(' + ((v || 0) / 5) * 100 + '% - ' + ((v || 0) / 5) * 4 + 'px)';
      value.textContent = v === null ? 'Tap or slide' : fmt(v);
      stars.setAttribute('aria-valuenow', String(v || 0));
      stars.setAttribute('aria-valuetext', v === null ? 'not rated' : v + ' stars');
    }
    function choose(v) {
      chosen = Math.max(0, Math.min(5, Math.round(v * 2) / 2));
      paint(chosen);
      send.disabled = false;
    }
    function fromPointer(e) {
      var r = bg.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * 5;
    }

    var dragging = false;
    stars.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { stars.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      choose(fromPointer(e));
      e.preventDefault();
    });
    stars.addEventListener('pointermove', function (e) {
      if (dragging) choose(fromPointer(e));
      else if (e.pointerType === 'mouse') paint(Math.max(0, Math.min(5, Math.round(fromPointer(e) * 2) / 2)));
    });
    stars.addEventListener('pointerup', function () { dragging = false; });
    stars.addEventListener('pointercancel', function () { dragging = false; paint(chosen); });
    stars.addEventListener('pointerleave', function () { if (!dragging) paint(chosen); });
    stars.addEventListener('keydown', function (e) {
      var v = chosen === null ? 0 : chosen;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') choose(v + 0.5);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') choose(v - 0.5);
      else if (e.key === 'Home') choose(0);
      else if (e.key === 'End') choose(5);
      else return;
      e.preventDefault();
    });
    msg.addEventListener('input', function () { if (chosen !== null) send.disabled = false; });

    send.addEventListener('click', function () {
      if (chosen === null) return;
      send.disabled = true;
      note.textContent = 'Sending…';
      api('/api/rate', { game: game, day: day, rater: raterId(), stars: chosen, message: msg.value })
        .then(function (r) {
          saved = r.mine;
          send.textContent = 'Update rating';
          note.textContent = 'Thanks! ' + avgText(r.day, isToday);
        })
        .catch(function (e) {
          send.disabled = false;
          note.textContent = 'Couldn’t send: ' + e.message;
        });
    });

    paint(null);
    mount.replaceChildren(box);

    if (!hubUrl()) { box.hidden = true; return; }
    api('/api/rating?game=' + encodeURIComponent(game) + '&day=' + encodeURIComponent(day) + '&rater=' + encodeURIComponent(raterId()))
      .then(function (r) {
        if (r.mine && chosen === null) {
          saved = r.mine;
          chosen = r.mine.stars;
          paint(chosen);
          if (!msg.value) msg.value = r.mine.message || '';
          send.textContent = 'Update rating';
          send.disabled = true;
          note.textContent = 'You rated this ' + fmt(saved.stars) + '. ' + avgText(r.day, isToday);
        } else if (r.day && r.day.votes) {
          note.textContent = avgText(r.day, isToday);
        }
      })
      .catch(function () { /* the widget still works; sending will report any problem */ });
  }

  window.JGG = { level: level, levelChip: levelChip, rate: rate, hubUrl: hubUrl, LEVELS: LEVELS, WEEKDAYS: WEEKDAYS };
})();
