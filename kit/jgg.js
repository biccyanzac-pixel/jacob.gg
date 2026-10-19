/*
 * jacob.gg shared kit: things every daily game shows the same way.
 *   <script src="https://biccyanzac-pixel.github.io/jacob.gg/kit/jgg.js" defer></script>
 * (a classic script, before the game's module script; it defines window.JGG)
 *
 *   JGG.level(day)                     -> { weekday: 'Saturday', level: 6, label: 'Hardest', text: 'Saturday · hardest' }
 *   JGG.levelChip(day)                 -> <span class="jgg-level"> element with that text
 *   JGG.rate({ game, day, mount })     -> renders "Rate today's <game>" into mount (an element). Call it when the
 *                                         day's game is finished. Safe to call repeatedly; keeps what was typed.
 *   JGG.name() / JGG.setName(name)     -> the player's name, shared by every jacob.gg game (same origin, so one
 *                                         localStorage). Games use it when they have no name of their own yet,
 *                                         and call setName whenever the player sets or changes theirs.
 *   JGG.playingAs({ mount, name, onChange }) -> "Playing as Jo · change" with an inline editor, for games that
 *                                         only ask for a name at the end. onChange(newName) after Save.
 *   JGG.motion.enter(el) / exit(el) / swap(from, to) / reveal(els) / settle(el, to, opts) / scroll(el, opts) / reduced()
 *                                      -> the shared transitions (docs/motion-system.md). enter/exit toggle the
 *                                         hidden attribute; all return promises; reduce motion gets a short fade.
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
  var NAMES = { 'ridd-le': 'ridd-le', yogle: 'Yogle', predictle: 'Predictle', pointle: 'Pointle', factle: 'Factle', perceptle: 'Perceptle', describle: 'Describle', stratle: 'Stratle' };

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

  // Built once: creating a date formatter costs 40-90 ms on a phone, which landed on the results screen.
  var DAY_FMT = null;
  function dayFmt() {
    return DAY_FMT || (DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }));
  }

  function rate(opts) {
    var game = opts.game, day = opts.day, mount = opts.mount;
    if (!mount || !game || !day) return;
    var key = game + '|' + day;
    if (mount.dataset.jggRate === key && mount.firstChild) return; // already showing this day's widget
    mount.dataset.jggRate = key;

    var chosen = null, saved = null;
    var isToday = day === new Date().toISOString().slice(0, 10);
    var dayName = isToday ? '' : dayFmt().format(new Date(day + 'T12:00:00Z'));
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

  var NAME_KEY = 'jgg:name';
  function name() {
    // jgg.name: ridd-le's key from when it was the only jacob.gg game, so its players are already known
    try { return localStorage.getItem(NAME_KEY) || localStorage.getItem('jgg.name') || ''; } catch (e) { return ''; }
  }
  function setName(n) {
    var v = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    try { if (v) localStorage.setItem(NAME_KEY, v); else localStorage.removeItem(NAME_KEY); } catch (e) { /* private mode */ }
    return v;
  }

  function playingAs(opts) {
    var mount = opts.mount;
    if (!mount) return;
    var current = opts.name || '';
    function view() {
      if (!current) { mount.replaceChildren(); mount.hidden = true; return; }
      mount.hidden = false;
      var who = el('b', 'jgg-name', current), change = el('button', 'jgg-change', 'change');
      change.type = 'button';
      change.addEventListener('click', edit);
      mount.replaceChildren('Playing as ', who, ' · ', change);
    }
    function edit() {
      var input = el('input', 'jgg-name-input'), save = el('button', 'jgg-change', 'Save'), cancel = el('button', 'jgg-change', 'cancel');
      input.value = current; input.maxLength = 20; input.autocomplete = 'nickname'; input.setAttribute('aria-label', 'Your name');
      save.type = cancel.type = 'button';
      function commit() {
        var v = input.value.replace(/\s+/g, ' ').trim().slice(0, 20);
        if (!v) { input.focus(); return; }
        current = setName(v);
        if (opts.onChange) opts.onChange(current);
        view();
      }
      save.addEventListener('click', commit);
      cancel.addEventListener('click', view);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') view(); });
      mount.replaceChildren('Playing as ', input, ' ', save, ' · ', cancel);
      input.focus(); input.select();
    }
    view();
  }

  // --- motion: docs/motion-system.md. Same values as the --jgg-* tokens; reduce motion = a short fade ---
  var T = { exit: 160, enter: 220, reveal: 320 };
  var FROM = { enter: 'translateY(6px) scale(.98)', reveal: 'translateY(10px) scale(.96)', exit: 'translateY(-4px) scale(.98)' };
  function reduced() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  // Resolves true when finished, false when a newer transition on el cancelled it. A transition that interrupts
  // another starts from where that one had got to (retargets), not from its first frame.
  function play(el, kind, delay) {
    if (!el || !el.animate) return Promise.resolve(true);
    var calm = reduced(), out = kind === 'exit', a = { opacity: +out }, b = { opacity: +!out };
    if (!calm) { a.transform = out ? 'none' : FROM[kind]; b.transform = out ? FROM.exit : 'none'; }
    if (el._jgg) {
      if (el._jgg.playState === 'running') { var cs = getComputedStyle(el); a = { opacity: cs.opacity }; if (!calm) a.transform = cs.transform; delay = 0; }
      el._jgg.cancel();
    }
    var anim = el._jgg = el.animate([a, b], { duration: calm ? T.exit : T[kind], delay: calm ? 0 : delay || 0,
      easing: calm ? 'ease' : 'cubic-bezier(.23,1,.32,1)', fill: out ? 'forwards' : 'backwards' });
    return anim.finished.then(function () { return true; }, function () { return false; });
  }
  function enter(el, opts) {
    if (!el) return Promise.resolve(true);
    el.hidden = false;
    return play(el, (opts && opts.kind) || 'enter', opts && opts.delay);
  }
  function exit(el) {
    if (!el || el.hidden) return Promise.resolve(true);
    return play(el, 'exit').then(function (done) {
      if (done) { el.hidden = true; el._jgg.cancel(); el._jgg = null; } // drop the held opacity: 0
      return done;
    });
  }
  // Phase change: the old screen goes at once (the system's response snaps) and the new one enters, so the change
  // takes 220 ms and never shows two screens or moves the old one out of its layout.
  function swap(from, to) {
    if (from && from !== to) { if (from._jgg) { from._jgg.cancel(); from._jgg = null; } from.hidden = true; }
    return enter(to);
  }
  // scrollIntoView that respects reduce motion (instant instead of smooth).
  function scroll(el, opts) {
    if (!el) return;
    var o = { block: 'start' };
    for (var k in opts) o[k] = opts[k];
    o.behavior = reduced() ? 'auto' : 'smooth';
    el.scrollIntoView(o);
  }
  function reveal(els, opts) {
    var gap = opts && opts.stagger != null ? opts.stagger : 50;
    return Promise.all(Array.prototype.map.call(els.length != null ? els : [els], function (el, i) {
      return enter(el, { kind: 'reveal', delay: Math.min(i, 6) * gap }); // never hold rows back long
    }));
  }
  // Counts el up to `to` (ease-out cubic). Never await it before showing anything else. Any tap or key jumps
  // straight to the final value. Screen readers get the final value at once from a hidden copy; the ticking
  // number is hidden from them.
  function settle(el, to, opts) {
    opts = opts || {};
    var from = opts.from || 0, ms = opts.duration || 700, start, fmt = opts.format || function (v) { return String(Math.round(v)); };
    var final = fmt(to);
    if (!el) return Promise.resolve();
    if (el._jggSkip) el._jggSkip();
    if (reduced() || from === to) { el.textContent = final; return Promise.resolve(); }
    var hid = el.getAttribute('aria-hidden'), sr = document.createElement('span');
    sr.textContent = final;
    sr.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
    el.setAttribute('aria-hidden', 'true');
    if (el.parentNode) el.parentNode.insertBefore(sr, el.nextSibling);
    return new Promise(function (resolve) {
      function done() {
        cancelAnimationFrame(el._jggN);
        removeEventListener('pointerdown', done, true); removeEventListener('keydown', done, true);
        el._jggSkip = null; el.textContent = final; sr.remove();
        if (hid === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', hid);
        resolve();
      }
      el._jggSkip = done;
      addEventListener('pointerdown', done, true); addEventListener('keydown', done, true);
      el._jggN = requestAnimationFrame(function frame(now) {
        var t = Math.min(1, (now - (start = start || now)) / ms);
        if (t >= 1) return done();
        el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        el._jggN = requestAnimationFrame(frame);
      });
    });
  }

  // iOS Safari shows :active press states only when some touchstart listener exists.
  try { document.addEventListener('touchstart', function () {}, { passive: true }); } catch (e) { /* old browser */ }

  var motion = { reduced: reduced, enter: enter, exit: exit, swap: swap, reveal: reveal, settle: settle, scroll: scroll };

  window.JGG = { level: level, levelChip: levelChip, rate: rate, name: name, setName: setName, playingAs: playingAs, hubUrl: hubUrl, motion: motion, LEVELS: LEVELS, WEEKDAYS: WEEKDAYS };
})();
