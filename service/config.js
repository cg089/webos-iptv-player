'use strict';
// Lokale Konfiguration (config.json) und Zustand (state.json: Favoriten, zuletzt gesehen).
// Alles ES5, kein mkdir -p, keine neueren Node-APIs (laeuft auf Node 0.12 im webOS 4).
var fs = require('fs');
var path = require('path');
var os = require('os');
var url = require('url');
var crypto = require('crypto');
var enigma2 = require('./enigma2');

var DEFAULT_PORT = 8766;
var MAX_RECENTS = 30;

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function isWritableDir(dir) {
  try {
    mkdirp(dir);
    var probe = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

// Erstes beschreibbares Verzeichnis: Umgebungsvariable, dann "data" neben dem Dienst (bleibt auf dem TV
// ueber Neustarts erhalten; im webOS-Jail ist nur der eigene Dienstordner beschreibbar), dann
// /media/developer, zuletzt das Temp-Verzeichnis.
function pickDataDir() {
  var candidates = [];
  if (process.env.IPTV_DATA) candidates.push(process.env.IPTV_DATA);
  candidates.push(path.join(__dirname, 'data'));
  candidates.push('/media/developer/iptvplayer');
  candidates.push(path.join(os.tmpdir(), 'iptvplayer'));
  for (var i = 0; i < candidates.length; i++) {
    if (isWritableDir(candidates[i])) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

var dataDir = pickDataDir();
var file = path.join(dataDir, 'config.json');
var stateFile = path.join(dataDir, 'state.json');

function defaultSettings() {
  return { refreshHours: 12, epgUrl: '', proxy: 'auto', autoplayLast: false, showLogos: true, bufferMb: 0 };
}

var data = { version: 1, port: DEFAULT_PORT, admin: null, secret: '', settings: defaultSettings(), playlists: [] };
var state = { favorites: [], recents: [], last: null, lastCtx: null };

function writeJson(target, obj) {
  mkdirp(dataDir);
  var tmp = target + '.tmp';
  // Zugangsdaten (Playlist-Adressen mit Benutzer/Passwort) stehen im Klartext: nur fuer den Besitzer lesbar
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: parseInt('600', 8) });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, parseInt('600', 8)); } catch (e) { /* nicht kritisch */ }
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/^\s+|\s+$/g, '').substring(0, max || 255);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------- Einstellungen

function sanitizeSettings(input, base) {
  var s = {};
  var k;
  for (k in base) if (base.hasOwnProperty(k)) s[k] = base[k];
  if (!input || typeof input !== 'object') return s;
  if (input.refreshHours !== undefined) {
    var h = parseInt(input.refreshHours, 10);
    if (!(h >= 1 && h <= 168)) throw new Error('Die Aktualisierung muss zwischen 1 und 168 Stunden liegen.');
    s.refreshHours = h;
  }
  if (input.epgUrl !== undefined) {
    s.epgUrl = str(input.epgUrl, 4000);
    var list = splitUrls(s.epgUrl);
    for (var i = 0; i < list.length; i++) {
      if (!/^https?:\/\/[^\s]+$/i.test(list[i])) throw new Error('Ungueltige EPG-Adresse: ' + list[i]);
    }
  }
  if (input.proxy !== undefined) {
    if (input.proxy !== 'auto' && input.proxy !== 'always' && input.proxy !== 'never') throw new Error('Ungueltiger Proxy-Modus.');
    s.proxy = input.proxy;
  }
  if (input.bufferMb !== undefined) {
    var mb = parseInt(input.bufferMb, 10);
    if (!(mb >= 0 && mb <= 64)) throw new Error('Der Puffer muss zwischen 0 und 64 MB liegen.');
    s.bufferMb = mb;
  }
  if (input.autoplayLast !== undefined) s.autoplayLast = input.autoplayLast === true;
  if (input.showLogos !== undefined) s.showLogos = input.showLogos === true;
  return s;
}

function splitUrls(text) {
  var parts = String(text || '').split(/[\s,]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
  return out;
}

function saveSettings(input) {
  data.settings = sanitizeSettings(input, data.settings);
  save();
  return data.settings;
}

// ---------------------------------------------------------------- Laden/Speichern

function load() {
  try {
    var parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      data.port = parsed.port || DEFAULT_PORT;
      data.admin = parsed.admin || null;
      data.secret = typeof parsed.secret === 'string' ? parsed.secret : '';
      data.playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
      try { data.settings = sanitizeSettings(parsed.settings, defaultSettings()); } catch (e1) { data.settings = defaultSettings(); }
    }
  } catch (e) {
    // Datei fehlt oder ist kaputt: mit leerer Konfiguration starten
  }
  try {
    var st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (st && typeof st === 'object') {
      state.favorites = Array.isArray(st.favorites) ? st.favorites : [];
      state.recents = Array.isArray(st.recents) ? st.recents : [];
      state.last = st.last || null;
      state.lastCtx = st.lastCtx || null;
    }
  } catch (e2) { /* noch kein Zustand */ }
  if (!data.secret) {
    // Schluessel fuer die signierten Proxy-Adressen
    data.secret = crypto.randomBytes(24).toString('hex');
    try { save(); } catch (e3) { /* wird beim naechsten Speichern erneut versucht */ }
  }
}

function save() {
  writeJson(file, data);
}

var stateTimer = null;
var stateDirty = false;

function saveState() {
  if (!stateDirty) return;
  stateDirty = false;
  try { writeJson(stateFile, state); } catch (e) { stateDirty = true; }
}

function saveStateSoon() {
  stateDirty = true;
  if (stateTimer) return;
  stateTimer = setTimeout(function () { stateTimer = null; saveState(); }, 2000);
}

// ---------------------------------------------------------------- Playlists

function contentFile(id) { return path.join(dataDir, 'pl-' + id + '.m3u'); }
function cacheFile(id) { return path.join(dataDir, 'pl-' + id + '.cache.json'); }

function hasContent(id) {
  try { return fs.statSync(contentFile(id)).isFile(); } catch (e) { return false; }
}

function readContent(id) {
  return fs.readFileSync(contentFile(id), 'utf8');
}

function removeFile(f) {
  try { fs.unlinkSync(f); } catch (e) { /* war nicht da */ }
}

function normalizePlaylist(input, existing) {
  var p = {
    id: existing ? existing.id : newId(),
    name: str(input.name, 80),
    type: input.type === 'file' ? 'file' : (input.type === 'enigma2' ? 'enigma2' : 'url'),
    url: str(input.url, 4000),
    ua: str(input.ua, 300),
    insecureTls: input.insecureTls === true,
    proxyStreams: input.proxyStreams === true,
    owifUrl: str(input.owifUrl, 300),
    owifOff: input.owifOff === true,
    e2Port: Math.max(1, Math.min(65535, parseInt(input.e2Port, 10) || 8001)),
    e2Auth: input.e2Auth === true,
    hiddenGroups: existing && Array.isArray(existing.hiddenGroups) ? existing.hiddenGroups : []
  };
  if (p.owifUrl && !/^https?:\/\/[^\s]+$/i.test(p.owifUrl)) throw new Error('Ungueltige OpenWebif-Adresse (http://Box oder http://Box:Port).');
  if (p.type === 'enigma2') {
    p.url = enigma2.normalizeBase(p.url);     // wirft bei ungueltiger Adresse
    p.owifUrl = '';
    if (!p.name) {
      var h2 = '';
      try { h2 = url.parse(p.url).hostname || ''; } catch (e) { h2 = ''; }
      p.name = h2 || ('Receiver ' + (data.playlists.length + 1));
    }
  } else if (p.type === 'url') {
    if (!/^https?:\/\/[^\s]+$/i.test(p.url)) throw new Error('Bitte eine gueltige Adresse angeben (http:// oder https://).');
    if (!p.name) {
      var host = '';
      try { host = url.parse(p.url).hostname || ''; } catch (e) { host = ''; }
      p.name = host || ('Playlist ' + (data.playlists.length + 1));
    }
  } else {
    p.url = '';
    var hasNew = typeof input.content === 'string' && input.content.length > 0;
    if (!hasNew && !(existing && hasContent(existing.id))) throw new Error('Bitte eine Playlist-Datei auswaehlen.');
    if (!p.name) p.name = 'Playlist ' + (data.playlists.length + 1);
  }
  return p;
}

function publicPlaylist(p) {
  return {
    id: p.id, name: p.name, type: p.type, url: p.url, ua: p.ua,
    insecureTls: !!p.insecureTls, proxyStreams: !!p.proxyStreams,
    owifUrl: p.owifUrl || '', owifOff: !!p.owifOff,
    e2Port: p.e2Port || 8001, e2Auth: !!p.e2Auth,
    hiddenCount: (p.hiddenGroups || []).length
  };
}

function findPlaylist(id) {
  for (var i = 0; i < data.playlists.length; i++) {
    if (data.playlists[i].id === id) return data.playlists[i];
  }
  return null;
}

// Speichert (neu oder aendernd). Liefert die Playlist. Wirft Error mit deutscher Meldung.
function savePlaylist(input) {
  var existing = input.id ? findPlaylist(input.id) : null;
  if (input.id && !existing) throw new Error('Playlist nicht gefunden.');
  var p = normalizePlaylist(input, existing);
  if (p.type === 'file' && typeof input.content === 'string' && input.content.length > 0) {
    mkdirp(dataDir);
    fs.writeFileSync(contentFile(p.id), input.content, { mode: parseInt('600', 8) });
  }
  if (existing) data.playlists[data.playlists.indexOf(existing)] = p;
  else data.playlists.push(p);
  removeFile(cacheFile(p.id));
  save();
  return p;
}

function deletePlaylist(id) {
  var p = findPlaylist(id);
  if (!p) return false;
  data.playlists.splice(data.playlists.indexOf(p), 1);
  removeFile(contentFile(id));
  removeFile(cacheFile(id));
  save();
  return true;
}

function setHiddenGroups(id, names) {
  var p = findPlaylist(id);
  if (!p) return false;
  var out = [];
  for (var i = 0; i < names.length && i < 20000; i++) out.push(String(names[i]));
  p.hiddenGroups = out;
  save();
  return true;
}

// ---------------------------------------------------------------- Zugriffsschutz

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function setAdminPassword(password) {
  if (!password) {
    data.admin = null;
  } else {
    var salt = crypto.randomBytes(8).toString('hex');
    data.admin = { salt: salt, hash: hashPassword(String(password), salt) };
  }
  save();
}

function checkAdminPassword(password) {
  if (!data.admin) return true;
  return hashPassword(String(password), data.admin.salt) === data.admin.hash;
}

// ---------------------------------------------------------------- Zustand (Favoriten, zuletzt gesehen)

function setFavorite(id, on) {
  var i = state.favorites.indexOf(id);
  if (on && i < 0) state.favorites.push(id);
  else if (!on && i >= 0) state.favorites.splice(i, 1);
  saveStateSoon();
}

function pushRecent(id, ctx) {
  var i = state.recents.indexOf(id);
  if (i >= 0) state.recents.splice(i, 1);
  state.recents.unshift(id);
  if (state.recents.length > MAX_RECENTS) state.recents.length = MAX_RECENTS;
  state.last = id;
  if (ctx && typeof ctx === 'object') {
    state.lastCtx = {
      playlist: str(ctx.playlist, 40), group: str(ctx.group, 300),
      fav: ctx.fav === true, recent: ctx.recent === true, q: str(ctx.q, 200)
    };
  }
  saveStateSoon();
}

function newerThan(file2, maxAgeMs) {
  try { return (new Date().getTime() - fs.statSync(file2).mtime.getTime()) < maxAgeMs; } catch (e) { return false; }
}

load();

process.on('exit', function () { saveState(); });

module.exports = {
  data: data,
  state: state,
  file: file,
  dataDir: dataDir,
  defaultPort: DEFAULT_PORT,
  load: load,
  save: save,
  saveState: saveState,
  saveSettings: saveSettings,
  splitUrls: splitUrls,
  findPlaylist: findPlaylist,
  savePlaylist: savePlaylist,
  deletePlaylist: deletePlaylist,
  setHiddenGroups: setHiddenGroups,
  publicPlaylist: publicPlaylist,
  normalizePlaylist: normalizePlaylist,
  hasContent: hasContent,
  readContent: readContent,
  cacheFile: cacheFile,
  setFavorite: setFavorite,
  pushRecent: pushRecent,
  setAdminPassword: setAdminPassword,
  checkAdminPassword: checkAdminPassword,
  hasAdminPassword: function () { return !!data.admin; },
  newerThan: newerThan
};
