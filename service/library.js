'use strict';
// Sender-Bibliothek: laedt Playlisten (URL oder hochgeladene Datei), haelt sie im Speicher,
// cacht geparste Listen auf der Platte und beantwortet Abfragen (Gruppen, Sender, Suche).
var fs = require('fs');
var config = require('./config');
var fetcher = require('./fetcher');
var m3u = require('./m3u');
var epg = require('./epg');
var proxy = require('./proxy');
var enigma2 = require('./enigma2');

var lists = {};        // playlistId -> { channels, groups, epgUrl, fetchedAt, error, loading, waiters }
var byId = {};         // channelId -> { ch, pl }

function now() { return new Date().getTime(); }

function indexList(plId, channels) {
  var id;
  for (id in byId) if (byId.hasOwnProperty(id) && byId[id].pl === plId) delete byId[id];
  for (var i = 0; i < channels.length; i++) byId[channels[i].id] = { ch: channels[i], pl: plId };
}

function readCache(pl) {
  try {
    var c = JSON.parse(fs.readFileSync(config.cacheFile(pl.id), 'utf8'));
    if (c && Array.isArray(c.channels)) return c;
  } catch (e) { /* kein Cache */ }
  return null;
}

function writeCache(pl, entry) {
  try {
    fs.writeFileSync(config.cacheFile(pl.id) + '.tmp',
      JSON.stringify({ fetchedAt: entry.fetchedAt, epgUrl: entry.epgUrl, channels: entry.channels }),
      { mode: parseInt('600', 8) });
    fs.renameSync(config.cacheFile(pl.id) + '.tmp', config.cacheFile(pl.id));
  } catch (e) { /* Cache ist nur eine Beschleunigung */ }
}

function groupsOf(channels) {
  var idx = {};
  var out = [];
  for (var i = 0; i < channels.length; i++) {
    var g = channels[i].group;
    if (idx[g] === undefined) { idx[g] = out.length; out.push({ name: g, count: 0 }); }
    out[idx[g]].count++;
  }
  return out;
}

function setEntry(pl, parsed, fetchedAt, error) {
  enigma2.annotate(parsed.channels, pl.type === 'enigma2' ? pl.url : pl.owifUrl, pl.owifOff, function (u) { return proxy.makeUrl(u, {}); });    // Picons und Service-Referenz fuer Enigma2-Receiver
  var entry = {
    channels: parsed.channels, groups: parsed.groups || groupsOf(parsed.channels),
    epgUrl: parsed.epgUrl || '', fetchedAt: fetchedAt, error: error || '', loading: false, waiters: []
  };
  lists[pl.id] = entry;
  indexList(pl.id, entry.channels);
  return entry;
}

function maxAgeMs() { return config.data.settings.refreshHours * 3600 * 1000; }

// Quelle holen und parsen (M3U-Adresse oder Enigma2-Box). cb(err, parsed)
function fetchParsed(pl, cb) {
  if (pl.type === 'enigma2') return enigma2.fetchServices(pl, pl.id, cb);
  fetcher.fetchBuffer(pl.url, { ua: pl.ua, insecure: pl.insecureTls, timeout: 30000 }, function (err, buf) {
    if (err) return cb(err);
    cb(null, m3u.parse(buf.toString('utf8'), pl.id));
  });
}

// Playlist sicherstellen. force = neu von der Quelle holen. cb(err, entry)
function ensure(pl, force, cb) {
  var cur = lists[pl.id];
  if (cur && cur.loading) { cur.waiters.push(cb); return; }
  if (cur && !force && now() - cur.fetchedAt < maxAgeMs()) return cb(null, cur);
  if (cur && !force && cur.retryAt && now() < cur.retryAt) return cb(null, cur);   // nach Fehler nicht bei jeder Anfrage neu versuchen

  var placeholder = cur || { channels: [], groups: [], epgUrl: '', fetchedAt: 0, error: '' };
  placeholder.loading = true;
  placeholder.waiters = [cb];
  lists[pl.id] = placeholder;

  function done(err, entry) {
    var waiters = placeholder.waiters;
    placeholder.waiters = [];
    placeholder.loading = false;
    for (var i = 0; i < waiters.length; i++) waiters[i](err, entry);
  }

  if (pl.type === 'file') {
    try {
      var parsed = m3u.parse(config.readContent(pl.id), pl.id);
      var e1 = setEntry(pl, parsed, now(), parsed.channels.length ? '' : 'Die Datei enthaelt keine Sender.');
      return done(null, e1);
    } catch (e) {
      lists[pl.id] = placeholder;
      placeholder.error = 'Datei nicht lesbar: ' + e.message;
      placeholder.retryAt = now() + 60000;
      return done(null, placeholder);
    }
  }

  // URL: erst frischen Cache probieren (nur beim ersten Laden, nicht bei erzwungener Aktualisierung)
  var cache = readCache(pl);
  if (cache && !force && now() - cache.fetchedAt < maxAgeMs()) {
    var e2 = setEntry(pl, { channels: cache.channels, epgUrl: cache.epgUrl }, cache.fetchedAt, '');
    return done(null, e2);
  }

  fetchParsed(pl, function (err, p2) {
    if (err) {
      // Quelle nicht erreichbar: alter Stand (Speicher oder Platte) bleibt nutzbar
      if (!placeholder.channels.length && cache) {
        var e3 = setEntry(pl, { channels: cache.channels, epgUrl: cache.epgUrl }, cache.fetchedAt, 'Aktualisierung fehlgeschlagen: ' + err.message);
        e3.retryAt = now() + 60000;
        return done(null, e3);
      }
      placeholder.error = err.message;
      placeholder.retryAt = now() + 60000;
      return done(null, placeholder);
    }
    if (!p2.channels.length) {
      placeholder.error = pl.type === 'enigma2' ? 'Die Box hat keine Sender geliefert.' : 'Die Playlist enthaelt keine Sender (kein gueltiges M3U?).';
      placeholder.retryAt = now() + 60000;
      return done(null, placeholder);
    }
    var e4 = setEntry(pl, p2, now(), '');
    writeCache(pl, e4);
    done(null, e4);
  });
}

// Alle Playlisten laden. cb(entries) - Fehler stehen in den Eintraegen.
function ensureAll(force, cb) {
  var pls = config.data.playlists;
  if (!pls.length) return cb();
  var left = pls.length;
  pls.forEach(function (pl) {
    ensure(pl, force, function () { if (--left === 0) cb(); });
  });
}

function forget(plId) {
  delete lists[plId];
  indexList(plId, []);
}

function hiddenSet(pl) {
  var set = {};
  var h = pl.hiddenGroups || [];
  for (var i = 0; i < h.length; i++) set[h[i]] = true;
  return set;
}

function visibleChannels(pl) {
  var e = lists[pl.id];
  if (!e) return [];
  if (!(pl.hiddenGroups && pl.hiddenGroups.length)) return e.channels;
  var hid = hiddenSet(pl);
  return e.channels.filter(function (c) { return !hid[c.group]; });
}

function visibleGroups(pl) {
  var e = lists[pl.id];
  if (!e) return [];
  var hid = hiddenSet(pl);
  return e.groups.filter(function (g) { return !hid[g.name]; });
}

// ---------------------------------------------------------------- Ausgabe

function publicChannel(ch, plId, n) {
  var ep = epg.nowNext(ch);
  var fav = config.state.favorites.indexOf(ch.id) >= 0;
  var o = { id: ch.id, n: n, name: ch.name, group: ch.group, logo: ch.logo, pl: plId, fav: fav };
  if (ep.now) o.now = { t: ep.now.t, s: ep.now.s, e: ep.now.e };
  if (ep.next) o.next = { t: ep.next.t, s: ep.next.s };
  return o;
}

function info(id) {
  var r = byId[id];
  if (!r) return null;
  var pl = config.findPlaylist(r.pl);
  if (!pl) return null;
  return { ch: r.ch, pl: pl };
}

// Wiedergabe-Angaben fuer einen Sender (mit Stream-Adresse - nur fuer die TV-App/Einrichtungsseite)
function playInfo(id) {
  var r = info(id);
  if (!r) return null;
  var ch = r.ch, pl = r.pl;
  var ua = ch.ua || pl.ua || '';
  var referrer = ch.referrer || '';
  var needsProxy = !!(ch.ua || ch.referrer || pl.insecureTls || pl.proxyStreams);
  return {
    id: ch.id, name: ch.name, group: ch.group, logo: ch.logo, playlist: pl.id,
    fav: config.state.favorites.indexOf(ch.id) >= 0,
    url: ch.url,
    proxyUrl: proxy.makeUrl(ch.url, { ua: ua, referrer: referrer, insecure: pl.insecureTls, buffer: config.data.settings.bufferMb }),
    needsProxy: needsProxy
  };
}

// Auswahl nach Kontext. q = { playlist, group, q, fav, recent, offset, limit }
// Rueckgabe: { total, channels: [oeffentliche Sender] } - n ist die laufende Nummer in der Auswahl.
function query(q) {
  var pool = [];
  var i, pl, list;
  var pls = config.data.playlists;

  if (q.fav || q.recent) {
    var ids = q.fav ? config.state.favorites : config.state.recents;
    for (i = 0; i < ids.length; i++) {
      var r = byId[ids[i]];
      if (r) pool.push({ ch: r.ch, pl: r.pl });
    }
  } else {
    for (i = 0; i < pls.length; i++) {
      pl = pls[i];
      if (q.playlist && q.playlist !== pl.id) continue;
      list = visibleChannels(pl);
      var seenSref = {};
      for (var j = 0; j < list.length; j++) {
        if (q.group && list[j].group !== q.group) continue;
        if (!q.group && pl.type === 'enigma2') {          // Bouquets ueberschneiden sich: in "Alle Sender" jeden Sender nur einmal
          if (seenSref[list[j].id]) continue;
          seenSref[list[j].id] = true;
        }
        pool.push({ ch: list[j], pl: pl.id });
      }
    }
  }

  if (q.q) {
    var needle = String(q.q).toLowerCase();
    pool = pool.filter(function (x) {
      return x.ch.name.toLowerCase().indexOf(needle) >= 0 || x.ch.group.toLowerCase().indexOf(needle) >= 0;
    });
  }

  var offset = Math.max(0, parseInt(q.offset, 10) || 0);
  var limit = Math.min(10000, Math.max(1, parseInt(q.limit, 10) || 3000));
  var slice = pool.slice(offset, offset + limit);
  var out = [];
  for (i = 0; i < slice.length; i++) out.push(publicChannel(slice[i].ch, slice[i].pl, offset + i + 1));
  return { total: pool.length, channels: out };
}

function groupList(plId) {
  var pls = config.data.playlists;
  var merged = {};
  var out = [];
  for (var i = 0; i < pls.length; i++) {
    if (plId && plId !== pls[i].id) continue;
    var gs = visibleGroups(pls[i]);
    for (var j = 0; j < gs.length; j++) {
      if (merged[gs[j].name] === undefined) { merged[gs[j].name] = out.length; out.push({ name: gs[j].name, count: 0 }); }
      out[merged[gs[j].name]].count += gs[j].count;
    }
  }
  return out;
}

function uniqueCount(pl) {
  var list = visibleChannels(pl);
  if (pl.type !== 'enigma2') return list.length;
  var seen = {}, n = 0;
  for (var i = 0; i < list.length; i++) if (!seen[list[i].id]) { seen[list[i].id] = true; n++; }
  return n;
}

function uniqueTotal(pl, channels) {
  if (pl.type !== 'enigma2') return channels.length;
  var seen = {}, n = 0;
  for (var i = 0; i < channels.length; i++) if (!seen[channels[i].id]) { seen[channels[i].id] = true; n++; }
  return n;
}

function summary(pl) {
  var e = lists[pl.id];
  return {
    id: pl.id, name: pl.name,
    count: e ? uniqueCount(pl) : 0,
    total: e ? e.channels.length : 0,
    unique: e ? uniqueTotal(pl, e.channels) : 0,
    groups: e ? e.groups.length : 0,
    fetchedAt: e ? e.fetchedAt : 0,
    loading: !!(e && e.loading),
    error: e ? e.error : ''
  };
}

// Alle Sender aller Playlisten (fuer den EPG-Abgleich)
function allChannels() {
  var out = [];
  var pls = config.data.playlists;
  for (var i = 0; i < pls.length; i++) {
    if (lists[pls[i].id]) out = out.concat(visibleChannels(pls[i]));     // ausgeblendete Gruppen brauchen keinen Programmfuehrer
  }
  return out;
}

// EPG-Quellen: Einstellung, sonst die url-tvg-Angaben aus den Playlisten
function epgUrls() {
  var fromSettings = config.splitUrls(config.data.settings.epgUrl);
  if (fromSettings.length) return fromSettings;
  var out = [];
  var pls = config.data.playlists;
  for (var i = 0; i < pls.length; i++) {
    var e = lists[pls[i].id];
    if (!e || !e.epgUrl) continue;
    var parts = config.splitUrls(e.epgUrl);
    for (var j = 0; j < parts.length; j++) {
      if (/^https?:\/\//i.test(parts[j]) && out.indexOf(parts[j]) < 0) out.push(parts[j]);
    }
  }
  return out;
}

// Wirkt nur, wenn die Playlist-Option "Zertifikate nicht pruefen" bei irgendeiner Playlist an ist
function epgInsecure() {
  var pls = config.data.playlists;
  for (var i = 0; i < pls.length; i++) if (pls[i].insecureTls) return true;
  return false;
}

// Aufruf fuer "Verbindung testen": Quelle holen und parsen, ohne zu speichern. cb(err, parsed)
function testSource(pl, content, cb) {
  if (pl.type === 'file') {
    if (typeof content !== 'string' || !content) {
      if (pl.id && config.hasContent(pl.id)) content = config.readContent(pl.id);
      else return cb(new Error('Bitte eine Playlist-Datei auswaehlen.'));
    }
    return cb(null, m3u.parse(content, 'test'));
  }
  fetchParsed(pl, function (err, parsed) { cb(err, parsed); });
}

module.exports = {
  ensure: ensure,
  ensureAll: ensureAll,
  forget: forget,
  query: query,
  groupList: groupList,
  playInfo: playInfo,
  info: info,
  summary: summary,
  allChannels: allChannels,
  epgUrls: epgUrls,
  epgInsecure: epgInsecure,
  testSource: testSource,
  entry: function (id) { return lists[id]; },
  publicChannel: publicChannel
};
