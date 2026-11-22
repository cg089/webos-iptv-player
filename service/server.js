'use strict';
// HTTP-Server: Konfig-Weboberflaeche, JSON-API fuer die TV-App und Stream-Proxy.
// Laeuft entweder im webOS-Service (service.js) oder allein: node server.js
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var url = require('url');

var config = require('./config');
var library = require('./library');
var epg = require('./epg');
var proxy = require('./proxy');

var VERSION = '1.3.0';
var WEB_DIR = path.join(__dirname, 'web');
var MAX_JSON = 64 * 1024;
var MAX_UPLOAD = 40 * 1024 * 1024;

var STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

var server = null;
var listeningPort = 0;
var epgTimer = null;

proxy.setSecret(config.data.secret);

// ------------------------------------------------------------------ Hilfsfunktionen

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { ok: false, error: message });
}

function isLoopback(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Mutierende Aufrufe nur vom eigenen Ursprung: schuetzt vor fremden Webseiten (CSRF).
// Die TV-App (file://, Ursprung "null") darf nur ueber Loopback schreiben.
function sameOrigin(req) {
  var origin = req.headers.origin;
  if (!origin) return true;
  if (isLoopback(req) && (origin === 'null' || /^file:/i.test(origin))) return true;
  return origin.replace(/^[a-z]+:\/\//i, '') === req.headers.host;
}

// Lesen: eigene Oberflaeche oder TV-App. Fremde Webseiten sollen Playlisten (mit Zugangsdaten) nicht lesen koennen.
function readAllowed(req) {
  return sameOrigin(req) || isLoopback(req);
}

function checkAuth(req, res) {
  if (!config.hasAdminPassword() || isLoopback(req)) return true;
  var h = req.headers.authorization || '';
  if (/^basic /i.test(h)) {
    var dec = new Buffer(h.substring(6), 'base64').toString('utf8');
    var pw = dec.substring(dec.indexOf(':') + 1);
    if (config.checkAdminPassword(pw)) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="IPTV Player", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Anmeldung erforderlich');
  return false;
}

function readJson(req, limit, cb) {
  var parts = [];
  var size = 0;
  var failed = false;
  req.on('data', function (d) {
    size += d.length;
    if (size > limit && !failed) { failed = true; cb(new Error('Anfrage zu gross')); req.destroy(); return; }
    if (!failed) parts.push(d);
  });
  req.on('end', function () {
    if (failed) return;
    try {
      cb(null, JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
    } catch (e) {
      cb(new Error('Ungueltiges JSON'));
    }
  });
}

function localIps() {
  var out = [];
  var ifs = os.networkInterfaces();
  var name;
  for (name in ifs) {
    if (!ifs.hasOwnProperty(name)) continue;
    for (var i = 0; i < ifs[name].length; i++) {
      var a = ifs[name][i];
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function publicSettings() {
  var s = config.data.settings;
  return { refreshHours: s.refreshHours, epgUrl: s.epgUrl, proxy: s.proxy, autoplayLast: s.autoplayLast, showLogos: s.showLogos, bufferMb: s.bufferMb };
}

function epgPublic() {
  var st = epg.status();
  return { urls: st.urls, loadedAt: st.loadedAt, loading: st.loading, channels: st.channels, programmes: st.programmes, error: st.error };
}

function epgBlock(ch) {
  var ep = epg.nowNext(ch);
  return {
    now: ep.now, next: ep.next,
    upcoming: epg.upcoming(ch, 8)
  };
}

function countKnown(ids) {
  var n = 0;
  for (var i = 0; i < ids.length; i++) if (library.info(ids[i])) n++;
  return n;
}

// EPG neu laden (nicht blockierend). Kommt eine Anfrage waehrend eines laufenden Ladens, wird danach noch einmal geladen,
// damit z. B. eine neu angelegte Playlist nicht uebergangen wird.
var epgBusy = false;
var epgRerun = false;
function refreshEpg(cb) {
  if (epgBusy) { epgRerun = true; return cb && cb(null); }
  epgBusy = true;
  library.ensureAll(false, function () {
    epg.load(library.epgUrls(), library.allChannels(), { insecure: library.epgInsecure() }, function (err) {
      if (err) console.error('EPG: ' + err.message);
      epgBusy = false;
      if (epgRerun) { epgRerun = false; refreshEpg(); }
      if (cb) cb(err);
    });
  });
}

function startEpgTimer() {
  if (epgTimer) return;
  epgTimer = setInterval(function () {
    var st = epg.status();
    var maxAge = config.data.settings.refreshHours * 3600 * 1000;
    if (st.loading) return;
    if (new Date().getTime() - st.loadedAt >= maxAge) refreshEpg();
  }, 30 * 60 * 1000);
}

// ------------------------------------------------------------------ Handler

function handleInfo(req, res) {
  sendJson(res, 200, {
    ok: true,
    name: 'IPTV Player',
    version: VERSION,
    node: process.version,
    platform: process.platform + '/' + process.arch,
    ips: localIps(),
    port: listeningPort,
    configFile: config.file,
    playlistCount: config.data.playlists.length,
    hasAdminPassword: config.hasAdminPassword(),
    settings: publicSettings(),
    epg: epgPublic()
  });
}

function handleLibrary(req, res) {
  if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  library.ensureAll(false, function () {
    var pls = config.data.playlists.map(library.summary);
    var last = config.state.last ? library.playInfo(config.state.last) : null;
    sendJson(res, 200, {
      ok: true,
      playlists: pls,
      favCount: countKnown(config.state.favorites),
      recentCount: countKnown(config.state.recents),
      last: last ? { id: last.id, name: last.name } : null,
      lastCtx: config.state.lastCtx,
      settings: publicSettings(),
      epg: epgPublic()
    });
  });
}

function handleLibraryRefresh(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  library.ensureAll(true, function () {
    sendJson(res, 200, { ok: true, playlists: config.data.playlists.map(library.summary) });
    refreshEpg();
  });
}

function handleGroups(req, res, query) {
  if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  library.ensureAll(false, function () {
    sendJson(res, 200, { ok: true, groups: library.groupList(query.playlist || '') });
  });
}

function handleChannels(req, res, query) {
  if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  library.ensureAll(false, function () {
    var r = library.query({
      playlist: query.playlist || '', group: query.group || '', q: query.q || '',
      fav: query.fav === '1', recent: query.recent === '1',
      offset: query.offset, limit: query.limit
    });
    sendJson(res, 200, { ok: true, total: r.total, channels: r.channels, epg: { loading: !!(epg.status().loading || epgBusy), loadedAt: epg.status().loadedAt } });
  });
}

function handlePlay(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, MAX_JSON, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    library.ensureAll(false, function () {
      var id = String(body.id || '');
      var p = library.playInfo(id);
      if (!p) return sendError(res, 404, 'Sender nicht gefunden (die Playlist wurde evtl. aktualisiert).');
      if (body.record !== false) config.pushRecent(id, body.ctx);
      p.epg = epgBlock(library.info(id).ch);
      sendJson(res, 200, { ok: true, channel: p });
    });
  });
}

function handleEpg(req, res, query) {
  if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  var r = library.info(String(query.id || ''));
  if (!r) return sendError(res, 404, 'Sender nicht gefunden');
  sendJson(res, 200, { ok: true, epg: epgBlock(r.ch) });
}

function handleFavorite(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, MAX_JSON, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    var id = String(body.id || '');
    if (!library.info(id)) return sendError(res, 404, 'Sender nicht gefunden');
    config.setFavorite(id, body.on === true);
    sendJson(res, 200, { ok: true, fav: body.on === true });
  });
}

function playlistRow(p) {
  var row = config.publicPlaylist(p);
  var s = library.summary(p);
  row.count = s.unique;
  row.groups = s.groups;
  row.fetchedAt = s.fetchedAt;
  row.error = s.error;
  return row;
}

function handlePlaylists(req, res, parts) {
  // parts: ['api','playlists', id, action]
  var id = parts[2];
  var action = parts[3];

  if (req.method === 'GET' && !id) {
    if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
    return library.ensureAll(false, function () {
      sendJson(res, 200, { ok: true, playlists: config.data.playlists.map(playlistRow) });
    });
  }
  if (req.method === 'GET' && id && action === 'groups') {
    if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
    var pl = config.findPlaylist(id);
    if (!pl) return sendError(res, 404, 'Playlist nicht gefunden');
    return library.ensure(pl, false, function () {
      var e = library.entry(pl.id);
      var hid = {};
      (pl.hiddenGroups || []).forEach(function (n) { hid[n] = true; });
      sendJson(res, 200, {
        ok: true,
        groups: (e ? e.groups : []).map(function (g) { return { name: g.name, count: g.count, hidden: !!hid[g.name] }; })
      });
    });
  }

  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');

  if (req.method === 'DELETE' && id) {
    var removed = config.deletePlaylist(id);
    library.forget(id);
    if (removed) refreshEpg();
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }

  if (req.method === 'POST' && id && action === 'refresh') {
    var plr = config.findPlaylist(id);
    if (!plr) return sendError(res, 404, 'Playlist nicht gefunden');
    return library.ensure(plr, true, function () {
      sendJson(res, 200, { ok: true, playlist: playlistRow(plr) });
      refreshEpg();
    });
  }

  if (req.method === 'POST' && id && action === 'hidden') {
    return readJson(req, MAX_UPLOAD, function (err, body) {
      if (err) return sendError(res, 400, err.message);
      if (!Array.isArray(body.hidden)) return sendError(res, 400, 'Liste fehlt');
      var ok = config.setHiddenGroups(id, body.hidden);
      sendJson(res, ok ? 200 : 404, { ok: ok });
      if (ok) refreshEpg();
    });
  }

  if (req.method === 'POST' && !id) {
    return readJson(req, MAX_UPLOAD, function (err, body) {
      if (err) return sendError(res, 400, err.message);
      var existing = body.id ? config.findPlaylist(body.id) : null;
      var p;
      try {
        // Vorab pruefen (wirft bei ungueltigen Angaben), bevor etwas gespeichert wird
        p = config.normalizePlaylist(body, existing);
      } catch (e) { return sendError(res, 400, e.message); }
      if (p.type === 'file' && typeof body.content === 'string' && body.content.length > 0 &&
          !/#EXTM3U|#EXTINF/i.test(body.content.substring(0, 200000))) {
        return sendError(res, 400, 'Die Datei sieht nicht wie eine M3U-Playlist aus (#EXTM3U fehlt).');
      }
      var saved;
      try { saved = config.savePlaylist(body); } catch (e2) { return sendError(res, 400, e2.message); }
      library.forget(saved.id);
      library.ensure(saved, true, function () {
        sendJson(res, 200, { ok: true, playlist: playlistRow(saved) });
        refreshEpg();
      });
    });
  }
  sendError(res, 405, 'Methode nicht erlaubt');
}

// Quelle testen, ohne zu speichern
function handleTest(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, MAX_UPLOAD, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    var existing = body.id ? config.findPlaylist(body.id) : null;
    var pl;
    try { pl = config.normalizePlaylist(body, existing); } catch (e) { return sendError(res, 400, e.message); }
    library.testSource(pl, body.content, function (terr, parsed) {
      if (terr) return sendJson(res, 200, { ok: false, error: terr.message });
      if (!parsed.channels.length) return sendJson(res, 200, { ok: false, error: pl.type === 'enigma2' ? 'Die Box ist erreichbar, hat aber keine Sender geliefert.' : 'Die Quelle ist erreichbar, enthaelt aber keine Sender (kein gueltiges M3U?).' });
      var sample = [];
      for (var i = 0; i < parsed.channels.length && sample.length < 5; i++) sample.push(parsed.channels[i].name);
      sendJson(res, 200, {
        ok: true,
        message: 'Erfolgreich: ' + parsed.channels.length + ' Sender in ' + parsed.groups.length + ' Gruppen gefunden.',
        count: parsed.channels.length, groups: parsed.groups.length, sample: sample,
        epgUrl: parsed.epgUrl
      });
    });
  });
}

function handleSettings(req, res) {
  if (req.method === 'GET') {
    if (!readAllowed(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
    return sendJson(res, 200, { ok: true, settings: publicSettings(), epg: epgPublic() });
  }
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, MAX_JSON, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    try { config.saveSettings(body); } catch (e) { return sendError(res, 400, e.message); }
    sendJson(res, 200, { ok: true, settings: publicSettings() });
    if (body.epgUrl !== undefined) refreshEpg();
  });
}

function handleEpgRefresh(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  if (epg.status().loading || epgBusy) return sendJson(res, 200, { ok: true, epg: epgPublic() });
  var st = epgPublic();
  refreshEpg();
  st.loading = true;
  sendJson(res, 200, { ok: true, epg: st });
}

function handleAdmin(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, MAX_JSON, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    config.setAdminPassword(body.password || '');
    sendJson(res, 200, { ok: true, hasAdminPassword: config.hasAdminPassword() });
  });
}

function handleStatic(req, res, pathname) {
  var entry = STATIC[pathname];
  if (!entry) return sendError(res, 404, 'Nicht gefunden');
  fs.readFile(path.join(WEB_DIR, entry[0]), function (err, data) {
    if (err) return sendError(res, 404, 'Nicht gefunden');
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function route(req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname || '/';
  var parts = pathname.split('/');            // ['', 'api', 'playlists', 'id', 'action']

  // Lesende Endpunkte duerfen von der TV-App (anderer Ursprung) aufgerufen werden
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!checkAuth(req, res)) return;

  try {
    if (parts[1] === 'p') return proxy.handle(req, res, parts);
    if (pathname === '/api/info' || pathname === '/api/ping') return handleInfo(req, res);
    if (pathname === '/api/library') return handleLibrary(req, res);
    if (pathname === '/api/library/refresh') return handleLibraryRefresh(req, res);
    if (pathname === '/api/groups') return handleGroups(req, res, u.query);
    if (pathname === '/api/channels') return handleChannels(req, res, u.query);
    if (pathname === '/api/play') return handlePlay(req, res);
    if (pathname === '/api/epg') return handleEpg(req, res, u.query);
    if (pathname === '/api/epg/refresh') return handleEpgRefresh(req, res);
    if (pathname === '/api/favorite') return handleFavorite(req, res);
    if (parts[1] === 'api' && parts[2] === 'playlists') {
      return handlePlaylists(req, res, [parts[1], parts[2], parts[3] && decodeURIComponent(parts[3]), parts[4]]);
    }
    if (pathname === '/api/test') return handleTest(req, res);
    if (pathname === '/api/settings') return handleSettings(req, res);
    if (pathname === '/api/admin') return handleAdmin(req, res);
    return handleStatic(req, res, pathname);
  } catch (e) {
    console.error('Fehler bei', req.url, e && e.stack || e);
    if (!res.headersSent) sendError(res, 500, 'Interner Fehler');
    else res.destroy();
  }
}

// ------------------------------------------------------------------ Start/Stop

function start(cb) {
  cb = cb || function () {};
  if (server) return cb(null, listeningPort);
  var s = http.createServer(route);
  s.timeout = 0;
  s.on('error', function (err) {
    if (server === s) server = null;
    cb(err);
  });
  s.listen(config.data.port, '0.0.0.0', function () {
    server = s;
    listeningPort = s.address().port;
    cb(null, listeningPort);
    // Playlisten und Programmfuehrer im Hintergrund vorladen
    refreshEpg();
    startEpgTimer();
  });
}

function stop(cb) {
  if (epgTimer) { clearInterval(epgTimer); epgTimer = null; }
  config.saveState();
  if (!server) return cb && cb();
  var s = server;
  server = null;
  s.close(function () { if (cb) cb(); });
}

module.exports = {
  start: start,
  stop: stop,
  isRunning: function () { return !!server; },
  getPort: function () { return listeningPort; },
  version: VERSION
};

if (require.main === module) {
  start(function (err, port) {
    if (err) {
      console.error('Start fehlgeschlagen: ' + err.message);
      process.exit(1);
    }
    // Als Kindprozess des webOS-Service: beenden, sobald der Elternprozess weg ist (stdin wird geschlossen)
    if (process.env.IPTV_CHILD === '1') {
      process.stdin.resume();
      process.stdin.on('end', function () { stop(function () { process.exit(0); }); });
      process.stdin.on('close', function () { process.exit(0); });
    }
    console.log('IPTV Player laeuft auf Port ' + port + ' (Node ' + process.version + ', gc ' + (typeof global.gc === 'function' ? 'an' : 'aus') + ')');
    console.log('Konfiguration: ' + config.file);
    var ips = localIps();
    for (var i = 0; i < ips.length; i++) console.log('  http://' + ips[i] + ':' + port + '/');
  });
  process.on('SIGTERM', function () { stop(function () { process.exit(0); }); });
  process.on('SIGINT', function () { stop(function () { process.exit(0); }); });
}
