/* IPTV Player – TV-App (webOS 4.x, Chromium 53: bewusst reines ES5). */
(function () {
  'use strict';

  var SERVICE_URI = 'luna://org.iptvplayer.app.service/';
  var DEFAULT_PORT = 8766;
  var LIST_LIMIT = 5000;

  var K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, BACKSPACE: 8, ESC: 27,
    PLAY: 415, PAUSE: 19, STOP: 413, REW: 412, FF: 417,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, CH_UP: 427, CH_DOWN: 428, INFO: 457
  };

  var state = {
    screen: 'loading',
    base: 'http://127.0.0.1:' + DEFAULT_PORT,
    info: null,
    lib: null,
    settings: { proxy: 'auto', autoplayLast: false, showLogos: true, bufferMb: 0 },
    stack: [],             // Ansichten (Startseite, Gruppen, Senderliste)
    messageAction: null,
    messageBack: null,
    returnScreen: 'browse'
  };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ Hilfen

  function store(key, value) {
    try {
      if (value === undefined) { var v = window.localStorage.getItem(key); return v === null ? null : v; }
      if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    } catch (e) { /* localStorage nicht verfuegbar */ }
    return null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(sec) {
    var d = sec === undefined ? new Date() : new Date(sec * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function nowSec() { return Math.floor(new Date().getTime() / 1000); }

  var SCREENS = ['Loading', 'Message', 'Browse', 'Search', 'Player'];
  function showScreen(name) {
    for (var i = 0; i < SCREENS.length; i++) $('screen' + SCREENS[i]).hidden = (SCREENS[i].toLowerCase() !== name);
    state.screen = name;
  }

  function exitApp() {
    try {
      if (window.PalmSystem && window.PalmSystem.platformBack) { window.PalmSystem.platformBack(); return; }
    } catch (e) { /* weiter */ }
    window.close();
  }

  // Alle Aufrufe gehen an den lokalen Dienst. POST als text/plain: spart die CORS-Vorabanfrage.
  function xhr(method, path, body, cb, timeoutMs) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(err, data) { if (done) return; done = true; cb(err, data); }
    x.open(method, state.base + path, true);
    x.timeout = timeoutMs || 20000;
    if (body !== null) x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    x.onload = function () {
      var d = null;
      try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
      if (x.status >= 200 && x.status < 300 && d) finish(null, d);
      else finish(new Error((d && d.error) || ('HTTP ' + x.status)), d);
    };
    x.onerror = function () { finish(new Error('Dienst nicht erreichbar')); };
    x.ontimeout = function () { finish(new Error('Zeitüberschreitung')); };
    x.send(body === null ? null : JSON.stringify(body));
  }

  function getJson(path, cb, timeoutMs) { xhr('GET', path, null, cb, timeoutMs); }
  function postJson(path, body, cb, timeoutMs) { xhr('POST', path, body || {}, cb, timeoutMs); }

  function lunaCall(method, params, cb) {
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (msg) {
        var res;
        try { res = JSON.parse(msg); } catch (e) { res = { returnValue: false, errorText: 'Ungültige Antwort' }; }
        cb(res);
      };
      bridge.call(SERVICE_URI + method, JSON.stringify(params || {}));
    } catch (e) {
      cb({ returnValue: false, errorText: 'Luna-Dienstaufruf nicht möglich (' + (e && e.message) + ')' });
    }
  }

  function enc(s) { return encodeURIComponent(s); }

  // ------------------------------------------------------------------ Virtuelle Liste
  // Feste Zeilenhoehe, nur "rows" Zeilen existieren im DOM. Bei Tausenden Sendern bleibt das flott.

  function span(cls) {
    var e = document.createElement('span');
    e.className = cls;
    return e;
  }

  function VList(ul, rows, onActivate, max) {
    this.ul = ul;
    this.rows = rows;      // sichtbare Zeilen
    this.max = rows;       // vorhandene Zeilen im DOM
    this.items = [];
    this.focus = 0;
    this.top = 0;
    this.lis = [];
    this.onActivate = onActivate;
    if (max) this.max = max;
    for (var i = 0; i < this.max; i++) {
      var li = this.makeRow(i);
      ul.appendChild(li);
      this.lis.push(li);
    }
  }

  VList.prototype.makeRow = function (slot) {
    var self = this;
    var li = document.createElement('li');
    li._ico = span('ico');
    li._num = span('num');
    li._bar = span('pbar');
    li._fill = span('pfill');
    li._bar.appendChild(li._fill);
    li._logo = document.createElement('img');
    li._logo.className = 'logo';
    li._logo.onerror = function () { this.style.visibility = 'hidden'; };
    li._logo.onload = function () { this.style.visibility = 'visible'; };
    li._space = span('logoSpace');
    var txt = document.createElement('div');
    txt.className = 'txt';
    li._name = span('name');
    li._sub = span('sub');
    txt.appendChild(li._name);
    txt.appendChild(li._sub);
    li._txt = txt;
    li._meta = span('meta');
    li._star = span('star');
    li.appendChild(li._ico);
    li.appendChild(li._num);
    li.appendChild(li._bar);
    li.appendChild(li._logo);
    li.appendChild(li._space);
    li.appendChild(txt);
    li.appendChild(li._meta);
    li.appendChild(li._star);
    li._slot = slot;
    li.onclick = function () {
      var idx = self.top + li._slot;
      if (idx < self.items.length) { self.setFocus(idx); if (self.onActivate) self.onActivate(); }
    };
    return li;
  };

  function progressPct(now) {
    if (!now) return 0;
    var t = nowSec();
    return Math.max(0, Math.min(100, Math.round((t - now.s) / Math.max(1, now.e - now.s) * 100)));
  }

  VList.prototype.fill = function (li, item, focused) {
    var isCh = item.kind === 'channel';
    var logos = state.settings.showLogos;
    li.className = focused ? 'focus' : '';
    if (isCh) {
      li._ico.style.display = 'none';
      li._num.style.display = 'block';
      li._num.textContent = item.n;
      li._bar.style.display = 'block';
      li._fill.style.width = progressPct(item.now) + '%';
      var wantLogo = logos && item.logo;
      li._logo.style.display = wantLogo ? 'block' : 'none';
      li._space.style.display = (logos && !item.logo) ? 'block' : 'none';
      if (wantLogo && li._logoSrc !== item.logo) {
        li._logoSrc = item.logo;
        li._logo.style.visibility = 'hidden';
        li._logo.src = item.logo;
      }
    } else {
      li._ico.style.display = 'block';
      li._ico.className = 'ico ' + item.kind;
      li._num.style.display = 'none';
      li._bar.style.display = 'none';
      li._logo.style.display = 'none';
      li._space.style.display = 'none';
    }
    li._name.textContent = item.name;
    li._sub.textContent = item.sub || '';
    li._sub.style.display = item.sub ? 'block' : 'none';
    li._meta.textContent = item.meta || '';
    li._star.textContent = item.fav ? '★' : '';
    li._star.style.display = isCh ? 'block' : 'none';
  };

  VList.prototype.render = function () {
    for (var r = 0; r < this.max; r++) {
      var idx = this.top + r;
      var li = this.lis[r];
      if (r < this.rows && idx < this.items.length) {
        li.style.display = 'flex';
        this.fill(li, this.items[idx], idx === this.focus);
      } else {
        li.style.display = 'none';
      }
    }
  };

  VList.prototype.setItems = function (items, focus) {
    this.items = items;
    focus = Math.max(0, Math.min(items.length - 1, focus || 0));
    this.focus = items.length ? focus : 0;
    // Fokus moeglichst mittig anzeigen
    this.top = Math.max(0, Math.min(this.focus - Math.floor(this.rows / 2), items.length - this.rows));
    if (this.top < 0) this.top = 0;
    this.render();
    if (this.onChange) this.onChange();
  };

  VList.prototype.setFocus = function (i) {
    if (!this.items.length) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    this.focus = i;
    if (i < this.top) this.top = i;
    else if (i >= this.top + this.rows) this.top = i - this.rows + 1;
    this.render();
    if (this.onChange) this.onChange();
  };

  VList.prototype.move = function (d) { this.setFocus(this.focus + d); };
  VList.prototype.current = function () { return this.items[this.focus]; };

  var COMPACT_ROWS = 19;
  var browseList = new VList($('list'), 10, function () { activate(); }, COMPACT_ROWS);
  var chanList = new VList($('chanList'), COMPACT_ROWS, function () { overlayPick(); }, COMPACT_ROWS);

  // ------------------------------------------------------------------ Infofenster rechts (Logo, Zeiten, Beschreibung)

  function sideRefs(root) {
    function q(c) { return root.querySelector('.' + c); }
    return { root: root, logo: q('sideLogo'), start: q('sideStart'), end: q('sideEnd'), left: q('sideLeft'),
      chan: q('sideChan'), title: q('sideTitle'), desc: q('sideDesc'), next: q('sideNext') };
  }

  // S = { R: Elemente, timer, id, cache, active: function }
  function makeSide(root, active) {
    var S = { R: sideRefs(root), timer: 0, id: '', cache: {}, active: active };
    S.R.logo.onload = function () { this.style.visibility = 'visible'; };
    S.R.logo.onerror = function () { this.style.visibility = 'hidden'; };
    return S;
  }

  function fillSideDetail(S, item, ep) {
    var R = S.R;
    var now = ep && ep.now;
    var up = (ep && ep.upcoming) || [];
    var t = nowSec();
    R.title.textContent = now ? now.t : (item.next ? 'Keine laufende Sendung' : 'Keine Programminformation');
    R.start.textContent = now ? fmtClock(now.s) : '';
    R.end.textContent = now ? fmtClock(now.e) : '';
    R.left.textContent = now ? 'noch ' + Math.max(0, Math.round((now.e - t) / 60)) + ' Min.' : '';
    R.desc.textContent = (now && now.d) ? now.d : ((!now && up[0] && up[0].d) ? up[0].d : '');
    var box = R.next;
    while (box.firstChild) box.removeChild(box.firstChild);
    var rest = [];
    for (var i = 0; i < up.length; i++) if (!now || up[i].s !== now.s) rest.push(up[i]);
    for (var j = 0; j < rest.length && j < 3; j++) {
      var row = document.createElement('div');
      var tm = document.createElement('span');
      tm.textContent = fmtClock(rest[j].s) + '–' + fmtClock(rest[j].e);
      row.appendChild(tm);
      row.appendChild(document.createTextNode(rest[j].t));
      box.appendChild(row);
    }
  }

  // Infofenster zum markierten Sender: sofort mit den Listendaten, kurz danach mit Beschreibung vom Dienst
  function showSideFor(S, item) {
    if (!item || item.kind !== 'channel') return;
    var R = S.R;
    var logoWanted = state.settings.showLogos && item.logo;
    R.logo.style.visibility = 'hidden';
    if (logoWanted) {
      if (R.logo.getAttribute('src') !== item.logo) R.logo.src = item.logo;
      else R.logo.style.visibility = 'visible';
    }
    R.chan.textContent = item.n + '  ' + item.name + (item.group ? '  ·  ' + item.group : '');
    var cached = S.cache[item.id];
    var fresh = cached && (new Date().getTime() - cached.at < 60000);
    fillSideDetail(S, item, fresh ? cached.epg : { now: item.now, upcoming: item.next ? [item.next] : [] });
    S.id = item.id;
    clearTimeout(S.timer);
    if (fresh) return;
    S.timer = setTimeout(function () {
      var id = item.id;
      getJson('/api/epg?id=' + enc(id), function (err, data) {
        if (err || !data || !data.epg) return;
        S.cache[id] = { at: new Date().getTime(), epg: data.epg };
        if (S.id === id && S.active()) fillSideDetail(S, item, data.epg);
      }, 8000);
    }, 160);
  }

  var side = makeSide($('side'), function () { return state.screen === 'browse'; });
  var sideO = makeSide($('chanSide'), function () { return P.overlay; });

  function updateSide() {
    var v = curView();
    var on = !!(v && v.type === 'channels' && state.screen === 'browse');
    $('side').hidden = !on;
    $('list').className = 'vlist' + (on ? ' cols' : '');
    if (!on) return;
    showSideFor(side, browseList.current());
  }
  browseList.onChange = updateSide;
  chanList.onChange = function () { if (P.overlay) showSideFor(sideO, chanList.current()); };

  // ------------------------------------------------------------------ Start

  function setLoading(text) { $('loadingText').textContent = text; showScreen('loading'); }

  function showMessage(title, text, hint, action, backAction) {
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    $('msgHint').textContent = hint || '';
    state.messageAction = action || boot;
    state.messageBack = backAction || exitApp;
    showScreen('message');
  }

  function tryInfo(cb) {
    getJson('/api/info', function (err, info) {
      if (err) return cb(false);
      state.info = info;
      cb(true);
    }, 2500);
  }

  function pollInfo(n, lunaRes) {
    tryInfo(function (ok) {
      if (ok) return goHome(true);
      if (n >= 25) {
        var detail = (lunaRes && lunaRes.errorText) ? lunaRes.errorText : 'keine Antwort vom Dienst';
        return showMessage('Dienst nicht erreichbar',
          'Der IPTV-Dienst auf dem Fernseher läuft nicht.',
          'Details: ' + detail);
      }
      setTimeout(function () { pollInfo(n + 1, lunaRes); }, 800);
    });
  }

  function boot() {
    setLoading('Starte Dienst …');
    tryInfo(function (ok) {
      if (ok) return goHome(true);
      lunaCall('start', {}, function (res) {
        if (res && res.port) state.base = 'http://127.0.0.1:' + res.port;
        pollInfo(0, res);
      });
    });
  }

  function configUrl() {
    var info = state.info || {};
    var ip = (info.ips && info.ips[0]) || 'IP-DES-FERNSEHERS';
    return 'http://' + ip + ':' + (info.port || DEFAULT_PORT) + '/';
  }

  // ------------------------------------------------------------------ Ansichten

  function curView() { return state.stack[state.stack.length - 1]; }

  function footFor(v) {
    if (v.type === 'channels') return 'OK Abspielen  ·  Rot Favorit  ·  Blau Suche  ·  Gelb Neu laden  ·  Zurück';
    if (v.type === 'home') return 'OK Öffnen  ·  Grün Zuletzt gesehener Sender  ·  Blau Suche  ·  Gelb Neu laden   —   Einrichtung: ' + configUrl();
    return 'OK Öffnen  ·  Blau Suche  ·  Zurück';
  }

  function showView(v) {
    $('title').textContent = v.title;
    $('crumb').textContent = v.crumb || '';
    $('foot').textContent = footFor(v);
    $('empty').textContent = v.emptyText || '';
    $('empty').hidden = v.items.length > 0;
    showScreen('browse');
    side.cache = {};
    var compact = v.type === 'channels';
    browseList.rows = compact ? COMPACT_ROWS : 10;
    $('list').className = 'vlist' + (compact ? ' cols' : '');
    $('screenBrowse').className = 'screen' + (compact ? ' vu' : '');
    browseList.setItems(v.items, v.focus || 0);
    updateSide();
    tickClock();
  }

  function saveFocus() {
    var v = curView();
    if (v) v.focus = browseList.focus;
  }

  function applyLib(lib) {
    state.lib = lib;
    if (lib.settings) state.settings = lib.settings;
  }

  function goHome(allowAutoplay) {
    setLoading('Lade Sender …');
    getJson('/api/library', function (err, lib) {
      if (err) return showMessage('Fehler', err.message, '', function () { goHome(allowAutoplay); });
      applyLib(lib);
      if (!lib.playlists.length) {
        return showMessage('Noch keine Playlist eingerichtet',
          'Öffne auf einem PC oder Handy im selben Netzwerk:',
          configUrl() + '   –   dort eine M3U-Playlist hinzufügen, danach hier OK drücken.',
          function () { goHome(allowAutoplay); });
      }
      var items = [
        { kind: 'special', key: 'fav', name: 'Favoriten', meta: String(lib.favCount) },
        { kind: 'special', key: 'recent', name: 'Zuletzt gesehen', meta: String(lib.recentCount) }
      ];
      function finish(extra) {
        state.stack = [{
          type: 'home', title: 'IPTV Player',
          crumb: lib.playlists.length === 1 ? lib.playlists[0].name : lib.playlists.length + ' Playlisten',
          items: items.concat(extra), focus: (lib.favCount > 0 ? 0 : 2)
        }];
        showView(curView());
        if (allowAutoplay && lib.settings && lib.settings.autoplayLast && lib.last) autoplayLast(lib);
      }
      if (lib.playlists.length === 1) {
        var p = lib.playlists[0];
        getJson('/api/groups?playlist=' + enc(p.id), function (e2, g) {
          var extra = [{ kind: 'special', key: 'all', name: 'Alle Sender', meta: String(p.count), sub: p.error || '', ctx: { playlist: p.id } }];
          var groups = (g && g.groups) || [];
          for (var i = 0; i < groups.length; i++) {
            extra.push({ kind: 'group', name: groups[i].name, meta: String(groups[i].count), ctx: { playlist: p.id, group: groups[i].name } });
          }
          finish(extra);
        });
      } else {
        finish(lib.playlists.map(function (p) {
          return { kind: 'playlist', name: p.name, meta: p.count + ' Sender', sub: p.error || '', playlist: p };
        }));
      }
    }, 120000);
  }

  function openGroups(p) {
    saveFocus();
    setLoading('Lade Gruppen …');
    getJson('/api/groups?playlist=' + enc(p.id), function (err, g) {
      if (err) return showMessage('Fehler', err.message, p.name, function () { openGroups(p); }, backToView);
      var items = [{ kind: 'special', key: 'all', name: 'Alle Sender', meta: String(p.count), ctx: { playlist: p.id } }];
      var groups = g.groups || [];
      for (var i = 0; i < groups.length; i++) {
        items.push({ kind: 'group', name: groups[i].name, meta: String(groups[i].count), ctx: { playlist: p.id, group: groups[i].name } });
      }
      state.stack.push({ type: 'groups', title: p.name, crumb: groups.length + ' Gruppen', items: items, focus: 0 });
      showView(curView());
    });
  }

  function backToView() { showView(curView()); }

  function ctxQuery(ctx) {
    var q = 'limit=' + LIST_LIMIT;
    if (ctx.playlist) q += '&playlist=' + enc(ctx.playlist);
    if (ctx.group) q += '&group=' + enc(ctx.group);
    if (ctx.q) q += '&q=' + enc(ctx.q);
    if (ctx.fav) q += '&fav=1';
    if (ctx.recent) q += '&recent=1';
    return q;
  }

  function channelItem(c) {
    var sub = '', meta = '';
    if (c.now) { sub = c.now.t; meta = fmtClock(c.now.s) + '–' + fmtClock(c.now.e); }
    else if (c.next) { sub = 'Danach: ' + c.next.t; meta = fmtClock(c.next.s); }
    return {
      kind: 'channel', id: c.id, n: c.n, name: c.name, group: c.group,
      logo: (c.logo && c.logo.charAt(0) === '/') ? state.base + c.logo : c.logo,     // Logo ueber den TV-Dienst (mit Anmeldung)
      fav: c.fav,
      now: c.now || null, next: c.next || null, sub: sub, meta: meta
    };
  }

  function loadChannels(ctx, cb) {
    getJson('/api/channels?' + ctxQuery(ctx), function (err, data) {
      if (err) return cb(err);
      cb(null, (data.channels || []).map(channelItem), data.total || 0, data.epg || null);
    }, 60000);
  }

  // Neue Sendungsdaten in vorhandene Listeneintraege uebernehmen (gleiche Objekte, damit auch die Liste im Player aktuell ist)
  function mergeEpg(target, fresh) {
    var map = {};
    var i;
    for (i = 0; i < fresh.length; i++) map[fresh[i].id] = fresh[i];
    for (i = 0; i < target.length; i++) {
      var f = map[target[i].id];
      if (!f) continue;
      target[i].now = f.now; target[i].next = f.next; target[i].sub = f.sub; target[i].meta = f.meta;
    }
  }

  var epgWait = 0;
  // Liste im Hintergrund neu laden; solange der Dienst noch den Programmfuehrer laedt, alle 4 s erneut
  function softRefresh(v, list, redraw) {
    if (!v || v.type !== 'channels' || !list || list.length > 1000) return;
    loadChannels(v.ctx || {}, function (err, items, total, epgInfo) {
      if (err) return;
      mergeEpg(list, items);
      side.cache = {}; sideO.cache = {};
      redraw();
      if (epgInfo && epgInfo.loading && epgWait < 30) {
        epgWait++;
        setTimeout(function () { softRefresh(v, list, redraw); }, 4000);
      } else {
        epgWait = 0;
      }
    });
  }

  function redrawLists() {
    if (state.screen === 'browse') { browseList.render(); updateSide(); }
    if (P.overlay) { chanList.render(); showSideFor(sideO, chanList.current()); }
  }

  function openChannels(ctx, title) {
    saveFocus();
    setLoading('Lade Sender …');
    loadChannels(ctx, function (err, items, total, epgInfo) {
      if (err) return showMessage('Sender konnten nicht geladen werden', err.message, title, function () { openChannels(ctx, title); }, backToView);
      var crumb = total + ' Sender' + (total > items.length ? ' (die ersten ' + items.length + ' werden angezeigt)' : '');
      var empty = ctx.fav ? 'Noch keine Favoriten. Mit der roten Taste in der Senderliste hinzufügen.'
        : (ctx.recent ? 'Noch kein Sender angesehen.' : (ctx.q ? 'Nichts gefunden für „' + ctx.q + '“.' : 'Keine Sender in dieser Gruppe.'));
      state.stack.push({ type: 'channels', ctx: ctx, title: title, crumb: crumb, items: items, focus: 0, emptyText: empty });
      showView(curView());
      if (epgInfo && epgInfo.loading) { epgWait = 0; softRefresh(curView(), items, redrawLists); }
    });
  }

  // Senderliste nach Rueckkehr aus dem Player auffrischen (Sendungen aendern sich), Fokus auf dem letzten Sender
  function refreshChannelView(focus) {
    var v = curView();
    if (!v) return;
    v.focus = focus;
    showView(v);
    if (v.type !== 'channels') return;
    loadChannels(v.ctx, function (err, items, total, epgInfo) {
      if (err || curView() !== v || state.screen !== 'browse') return;
      v.items = items;
      v.crumb = total + ' Sender';
      v.focus = browseList.focus;
      showView(v);
      if (epgInfo && epgInfo.loading) { epgWait = 0; softRefresh(v, items, redrawLists); }
    });
  }

  function activate() {
    var v = curView();
    var item = browseList.current();
    if (!v || !item) return;
    if (item.kind === 'special' && item.key === 'fav') return openChannels({ fav: true }, 'Favoriten');
    if (item.kind === 'special' && item.key === 'recent') return openChannels({ recent: true }, 'Zuletzt gesehen');
    if (item.kind === 'special' && item.key === 'all') return openChannels(item.ctx, 'Alle Sender');
    if (item.kind === 'playlist') return openGroups(item.playlist);
    if (item.kind === 'group') return openChannels(item.ctx, item.name);
    if (item.kind === 'channel') {
      saveFocus();
      startPlayer(v.items, browseList.focus, v.ctx || {});
    }
  }

  function goBack() {
    if (state.stack.length <= 1) return exitApp();
    state.stack.pop();
    showView(curView());
  }

  function toggleFavorite(item, after) {
    var on = !item.fav;
    postJson('/api/favorite', { id: item.id, on: on }, function (err) {
      if (err) return toast('Favorit konnte nicht gespeichert werden');
      item.fav = on;
      toast(on ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
      if (after) after();
    });
  }

  // ------------------------------------------------------------------ Suche

  function openSearch() {
    state.returnScreen = state.screen === 'player' ? 'player' : 'browse';
    $('q').value = '';
    showScreen('search');
    try { $('q').focus(); } catch (e) { /* ignorieren */ }
  }

  function closeSearch() {
    $('q').blur();
    showScreen('browse');
  }

  function submitSearch() {
    var text = $('q').value.replace(/^\s+|\s+$/g, '');
    $('q').blur();
    if (!text) return closeSearch();
    var v = curView();
    var ctx = { q: text };
    if (v && v.ctx && v.ctx.playlist) ctx.playlist = v.ctx.playlist;
    showScreen('browse');
    openChannels(ctx, 'Suche: ' + text);
  }

  // ------------------------------------------------------------------ Uhr

  function tickClock() {
    var t = fmtClock();
    $('clock').textContent = t;
    $('osdClock').textContent = t;
  }
  setInterval(tickClock, 15000);

  // Senderliste: Balken alle Minute neu zeichnen, kleine Listen alle 5 Minuten neu laden (neue Sendungen)
  var listTicks = 0;
  setInterval(function () {
    if (P.overlay) chanList.render();
    var v = curView();
    if (state.screen !== 'browse' || !v || v.type !== 'channels') return;
    listTicks++;
    if (listTicks % 5 === 0 && v.items.length <= 1000) {
      softRefresh(v, v.items, redrawLists);
    } else {
      browseList.render();
    }
  }, 60000);

  // ------------------------------------------------------------------ Player

  var video = $('video');
  var P = {
    list: [], index: 0, tuned: -1, prev: -1, ctx: {},
    cur: null, ch: null,
    token: 0, attempts: [], ai: 0, swap: false, stalls: 0, serial: 0,
    zapTimer: 0, watchdog: 0, stallTimer: 0, osdTimer: 0, toastTimer: 0, numBuf: '', numTimer: 0, osdProgTimer: 0,
    overlay: false, detail: false, playing: false
  };

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(P.toastTimer);
    P.toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }

  function showOsd(sticky) {
    $('osd').hidden = false;
    tickClock();
    clearTimeout(P.osdTimer);
    if (!sticky && !P.detail) {
      P.osdTimer = setTimeout(function () { $('osd').hidden = true; }, 5000);
    }
  }

  function renderOsd() {
    if (!P.cur) return;
    var it = P.cur.item;
    var ep = P.cur.epg || {};
    $('osdNum').textContent = it.n;
    $('osdName').textContent = it.name;
    $('osdGroup').textContent = it.group + (it.fav ? '   ★ Favorit' : '');
    var now = ep.now, next = ep.next;
    var t = nowSec();
    if (now) {
      var left = Math.max(0, Math.round((now.e - t) / 60));
      $('osdNow').textContent = fmtClock(now.s) + '–' + fmtClock(now.e) + '   ' + now.t + '   (noch ' + left + ' Min.)';
      var pct = Math.max(0, Math.min(100, (t - now.s) / Math.max(1, now.e - now.s) * 100));
      $('osdFill').style.width = pct + '%';
    } else {
      $('osdNow').textContent = 'Keine Programminformation';
      $('osdFill').style.width = '0';
    }
    $('osdNext').textContent = next ? 'Danach  ' + fmtClock(next.s) + '   ' + next.t : '';
    var desc = '';
    if (P.detail) {
      if (now && now.d) desc = now.d;
      else if (next && next.d) desc = next.d;
      if (ep.upcoming && ep.upcoming.length > 1) {
        var more = [];
        for (var i = 1; i < ep.upcoming.length && i < 4; i++) more.push(fmtClock(ep.upcoming[i].s) + ' ' + ep.upcoming[i].t);
        desc += (desc ? '   ·   ' : '') + more.join('   ·   ');
      }
      if (!desc) desc = 'Keine weiteren Programminformationen.';
    }
    $('osdDesc').textContent = desc;
    $('osdDesc').hidden = !desc;
  }

  function showNoSignal(text) {
    $('noSignal').hidden = !text;
    if (text) {
      $('noSignalText').textContent = text;
      $('buffering').hidden = true;
      $('osd').hidden = false;
      clearTimeout(P.osdTimer);
    }
  }

  function extOf(u) {
    var p = String(u).split('?')[0].split('#')[0];
    var last = p.substring(p.lastIndexOf('/') + 1);
    var m = /\.([A-Za-z0-9]{1,5})$/.exec(last);
    return m ? m[1].toLowerCase() : '';
  }

  function typesFor(src) {
    var e = extOf(src);
    if (e === 'm3u8' || e === 'm3u') return ['application/x-mpegURL', null];
    if (e === 'ts') return ['video/mp2t', null];
    if (e === 'mp4' || e === 'm4v') return [null];
    return [null, 'application/x-mpegURL', 'video/mp2t'];
  }

  function buildAttempts(ch) {
    var mode = state.settings.proxy || 'auto';
    var direct = ch.url;
    var viaProxy = state.base + ch.proxyUrl;
    var order = [];
    if (mode === 'never') order = [['direct', direct]];
    else if (mode === 'always') order = [['proxy', viaProxy]];
    else if (ch.needsProxy || state.settings.bufferMb > 0) order = [['proxy', viaProxy], ['direct', direct]];   // Puffer gibt es nur im TV-Dienst
    else order = [['direct', direct], ['proxy', viaProxy]];
    if (P.swap && order.length === 2) order.reverse();
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var types = typesFor(order[i][1]);
      for (var j = 0; j < types.length; j++) out.push({ via: order[i][0], src: order[i][1], type: types[j] });
    }
    return out;
  }

  function clearTimers() {
    clearTimeout(P.watchdog);
    clearTimeout(P.stallTimer);
  }

  function stopMedia() {
    clearTimers();
    P.serial = 0;
    P.playing = false;
    try { video.pause(); } catch (e) { /* ignorieren */ }
    while (video.firstChild) video.removeChild(video.firstChild);
    video.removeAttribute('src');
    try { video.load(); } catch (e2) { /* ignorieren */ }
  }

  function setSource(att) {
    while (video.firstChild) video.removeChild(video.firstChild);
    video.removeAttribute('src');
    var token = P.token;
    if (att.type) {
      var s = document.createElement('source');
      s.onerror = function () { attemptFailed(token, 'Quelle abgelehnt'); };
      s.type = att.type;
      s.src = att.src;
      video.appendChild(s);
    } else {
      video.src = att.src;
    }
    try { video.load(); } catch (e) { /* ignorieren */ }
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* Fehler meldet das error-Event */ });
  }

  function startAttempt(token) {
    if (token !== P.token) return;
    clearTimers();
    var att = P.attempts[P.ai];
    if (!att) return showNoSignal('Der Sender liefert kein abspielbares Signal.');
    P.serial = (P.serial || 0) + 1;
    $('buffering').hidden = false;
    P.watchdog = setTimeout(function () { attemptFailed(token, 'Zeitüberschreitung'); }, 18000);
    setSource(att);
  }

  function attemptFailed(token) {
    if (token !== P.token || !P.serial) return;
    clearTimers();
    P.ai++;
    P.stalls = 0;
    if (P.ai < P.attempts.length) return startAttempt(token);
    stopMedia();
    var mode = state.settings.proxy || 'auto';
    showNoSignal('Der Sender liefert kein abspielbares Signal.' + (mode === 'auto' ? ' (direkt und über den TV-Dienst versucht)' : ''));
  }

  function onStall() {
    var token = P.token;
    if (!P.serial) return;
    // Mitten in der Wiedergabe haengengeblieben: gleiche Quelle noch zweimal neu starten, danach naechste Variante
    if (P.stalls < 2) { P.stalls++; return startAttempt(token); }
    attemptFailed(token);
  }

  video.onplaying = function () {
    if (!P.serial) return;
    clearTimers();
    P.playing = true;
    P.stalls = 0;
    $('buffering').hidden = true;
    $('noSignal').hidden = true;
    showOsd(false);
  };
  video.onwaiting = function () {
    if (!P.serial) return;
    $('buffering').hidden = false;
    clearTimeout(P.stallTimer);
    P.stallTimer = setTimeout(onStall, 25000);
  };
  video.oncanplay = function () { if (P.serial) { clearTimeout(P.stallTimer); } };
  video.onerror = function () { if (P.serial) attemptFailed(P.token); };
  video.onended = function () { if (P.serial) onStall(); };

  function tune(index) {
    clearTimeout(P.zapTimer);
    var item = P.list[index];
    if (!item) return;
    if (P.tuned >= 0 && P.tuned !== index) P.prev = P.tuned;
    P.tuned = index;
    P.index = index;
    var token = ++P.token;
    P.cur = { item: item, epg: { now: item.now, next: item.next, upcoming: [] } };
    P.swap = false;
    P.detail = false;
    P.stalls = 0;
    stopMedia();
    $('noSignal').hidden = true;
    $('buffering').hidden = false;
    renderOsd();
    showOsd(false);
    postJson('/api/play', { id: item.id, ctx: P.ctx }, function (err, data) {
      if (token !== P.token) return;
      if (err) return showNoSignal('Sender konnte nicht geladen werden: ' + err.message);
      P.ch = data.channel;
      P.cur.epg = data.channel.epg || P.cur.epg;
      item.fav = data.channel.fav;
      renderOsd();
      P.attempts = buildAttempts(P.ch);
      P.ai = 0;
      startAttempt(token);
    });
  }

  function startPlayer(list, index, ctx) {
    P.list = list;
    P.ctx = ctx || {};
    P.tuned = -1;
    P.prev = -1;
    P.overlay = false;
    $('chanPanel').hidden = true;
    $('numInput').hidden = true;
    $('toast').hidden = true;
    showScreen('player');
    tune(index);
    clearInterval(P.osdProgTimer);
    P.osdProgTimer = setInterval(function () { if (state.screen === 'player' && !$('osd').hidden) renderOsd(); }, 20000);
  }

  function leavePlayer() {
    clearInterval(P.osdProgTimer);
    clearTimeout(P.zapTimer);
    clearTimeout(P.numTimer);
    P.token++;
    stopMedia();
    P.overlay = false;
    $('chanPanel').hidden = true;
    showScreen('browse');
    refreshChannelView(Math.max(0, P.index));
  }

  // Autostart: zuletzt gesehenen Sender abspielen (Einstellung in der Weboberflaeche)
  function autoplayLast(lib) {
    var ctx = lib.lastCtx || {};
    loadChannels(ctx, function (err, items) {
      if (err || !items.length) return;
      var idx = -1;
      for (var i = 0; i < items.length; i++) if (items[i].id === lib.last.id) { idx = i; break; }
      if (idx < 0) { items = [{ kind: 'channel', id: lib.last.id, n: 1, name: lib.last.name, group: '', logo: '', fav: false, now: null, next: null }]; idx = 0; }
      if (state.screen === 'browse' && state.stack.length === 1) startPlayer(items, idx, ctx);
    });
  }

  function playLast() {
    var lib = state.lib;
    if (!lib || !lib.last) return toast('Noch kein Sender angesehen');
    autoplayLast(lib);
  }

  // Umschalten: Anzeige sofort, eigentliches Tunen erst nach kurzer Pause (schnelles Durchschalten)
  function zap(delta) {
    if (!P.list.length) return;
    var i = (P.index + delta + P.list.length) % P.list.length;
    previewChannel(i);
  }

  function previewChannel(i) {
    P.index = i;
    P.cur = { item: P.list[i], epg: { now: P.list[i].now, next: P.list[i].next, upcoming: [] } };
    P.detail = false;
    renderOsd();
    showOsd(false);
    clearTimeout(P.zapTimer);
    P.zapTimer = setTimeout(function () { tune(i); }, 450);
  }

  function setOverlay(on) {
    P.overlay = on;
    $('chanPanel').hidden = !on;
    if (on) {
      sideO.cache = {};
      chanList.setItems(P.list, P.index);
      var cv = curView();
      if (cv && cv.type === 'channels') { epgWait = 0; softRefresh(cv, P.list, redrawLists); }
      clearTimeout(P.osdTimer);
      $('osd').hidden = true;
    }
  }

  function overlayPick() {
    var idx = chanList.focus;
    setOverlay(false);
    if (idx === P.tuned) return showOsd(false);
    previewChannel(idx);
    clearTimeout(P.zapTimer);
    tune(idx);
  }

  function digit(d) {
    P.numBuf += d;
    var box = $('numInput');
    box.hidden = false;
    box.textContent = P.numBuf;
    clearTimeout(P.numTimer);
    if (P.numBuf.length >= 4) return commitNumber();
    P.numTimer = setTimeout(commitNumber, 1600);
  }

  function commitNumber() {
    clearTimeout(P.numTimer);
    var n = parseInt(P.numBuf, 10);
    P.numBuf = '';
    $('numInput').hidden = true;
    if (!n) return;
    for (var i = 0; i < P.list.length; i++) {
      if (P.list[i].n === n) { previewChannel(i); clearTimeout(P.zapTimer); return tune(i); }
    }
    toast('Kanal ' + n + ' nicht vorhanden');
  }

  function playerKey(code) {
    // Zifferntasten (oben und Ziffernblock)
    if ((code >= 48 && code <= 57) || (code >= 96 && code <= 105)) {
      digit(String(code >= 96 ? code - 96 : code - 48));
      return true;
    }
    if (P.overlay) {
      switch (code) {
        case K.UP: chanList.move(-1); break;
        case K.DOWN: chanList.move(1); break;
        case K.CH_UP: case K.LEFT: chanList.move(-chanList.rows); break;
        case K.CH_DOWN: case K.RIGHT: chanList.move(chanList.rows); break;
        case K.ENTER: overlayPick(); break;
        case K.RED:
          var it = chanList.current();
          if (it) toggleFavorite(it, function () { chanList.render(); });
          break;
        case K.BACK: case K.BACKSPACE: case K.ESC: setOverlay(false); break;
        default: return false;
      }
      return true;
    }
    switch (code) {
      case K.UP: case K.CH_UP: zap(1); break;
      case K.DOWN: case K.CH_DOWN: zap(-1); break;
      case K.ENTER: setOverlay(true); break;
      case K.INFO: case K.BLUE:
        P.detail = !P.detail;
        renderOsd();
        showOsd(P.detail);
        break;
      case K.RED:
        if (P.cur) toggleFavorite(P.cur.item, function () { renderOsd(); showOsd(false); });
        break;
      case K.GREEN:
        if (P.prev >= 0 && P.prev < P.list.length) { var p2 = P.prev; previewChannel(p2); clearTimeout(P.zapTimer); tune(p2); }
        else toast('Kein vorheriger Sender');
        break;
      case K.YELLOW:
        // Neu verbinden, dabei die andere Zugriffsart (direkt / TV-Dienst) zuerst versuchen
        if (P.ch) {
          P.swap = !P.swap;
          P.attempts = buildAttempts(P.ch);
          P.ai = 0;
          P.stalls = 0;
          toast('Verbinde neu …');
          $('noSignal').hidden = true;
          startAttempt(P.token);
        }
        break;
      case K.LEFT: case K.RIGHT: showOsd(false); break;
      case K.PLAY: try { video.play(); } catch (e) { /* ignorieren */ } break;
      case K.PAUSE: break;
      case K.STOP: case K.BACK: case K.BACKSPACE: case K.ESC:
        if (P.detail) { P.detail = false; renderOsd(); showOsd(false); }
        else leavePlayer();
        break;
      default:
        return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ Tasten

  function browseKey(code) {
    var v = curView();
    switch (code) {
      case K.UP: browseList.move(-1); break;
      case K.DOWN: browseList.move(1); break;
      case K.LEFT: case K.CH_UP: browseList.move(-browseList.rows); break;
      case K.RIGHT: case K.CH_DOWN: browseList.move(browseList.rows); break;
      case K.ENTER: activate(); break;
      case K.BACK: case K.BACKSPACE: case K.ESC: goBack(); break;
      case K.BLUE: openSearch(); break;
      case K.RED:
        var item = browseList.current();
        if (item && item.kind === 'channel') toggleFavorite(item, function () { browseList.render(); });
        break;
      case K.GREEN:
        if (v && v.type === 'home') playLast();
        break;
      case K.YELLOW:
        if (v && v.type === 'home') {
          setLoading('Aktualisiere Playlisten …');
          postJson('/api/library/refresh', {}, function () { goHome(false); }, 180000);
        } else if (v && v.type === 'channels') {
          refreshChannelView(browseList.focus);
        }
        break;
      default: return false;
    }
    return true;
  }

  function onKey(ev) {
    var code = ev.keyCode;
    var handled = true;

    if (state.screen === 'player') {
      handled = playerKey(code);
    } else if (state.screen === 'browse') {
      handled = browseKey(code);
    } else if (state.screen === 'search') {
      if (code === K.ENTER) submitSearch();
      else if (code === K.BACK || code === K.ESC) closeSearch();
      else handled = false;       // Tasten gehoeren dem Eingabefeld
    } else if (state.screen === 'message') {
      switch (code) {
        case K.ENTER: if (state.messageAction) state.messageAction(); break;
        case K.BACK: case K.BACKSPACE: case K.ESC:
          (state.messageBack || exitApp)();
          break;
        default: handled = false;
      }
    } else {
      // Ladebildschirm: Zurueck beendet die App
      if (code === K.BACK || code === K.BACKSPACE || code === K.ESC) exitApp(); else handled = false;
    }

    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  $('list').addEventListener('wheel', function (ev) {
    if (state.screen !== 'browse') return;
    browseList.move(ev.deltaY > 0 ? 3 : -3);
    ev.preventDefault();
  });
  $('chanList').addEventListener('wheel', function (ev) {
    chanList.move(ev.deltaY > 0 ? 3 : -3);
    ev.preventDefault();
  });
  $('screenPlayer').addEventListener('click', function (ev) {
    if (ev.target === video || ev.target === $('screenPlayer')) { if (!P.overlay) showOsd(false); }
  });

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', function () {
    if (state.screen !== 'player') return;
    if (document.hidden) {
      // Live-Strom im Hintergrund nicht weiterlaufen lassen
      P.token++;
      stopMedia();
    } else {
      tune(P.tuned >= 0 ? P.tuned : P.index);
    }
  });

  boot();
})();
