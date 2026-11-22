'use strict';
// Enigma2-Receiver (VU+, Dreambox, ...): Stream-Adressen wie http://box:8001/1:0:19:283D:41B:1:FFFF0182:0:0:0:
// enthalten die Service-Referenz. Daraus ergeben sich Senderlogos (Picons) und - ueber die OpenWebif-
// Schnittstelle der Box - der Programmfuehrer, auch wenn die Playlist selbst weder tvg-id noch EPG-Adresse hat.
var url = require('url');
var crypto = require('crypto');
var fetcher = require('./fetcher');

var SREF_RE = /^\d+(?::[0-9A-Fa-f]+){9}:/;
var KEEP_BEFORE = 3 * 3600;
var KEEP_AFTER = 36 * 3600;
var MAX_EVENTS = 80;
var PARALLEL = 3;

// Aus einer Stream-Adresse Box-Adresse und Service-Referenz bestimmen. Rueckgabe null, wenn es keine ist.
// owifUrl: optionale feste OpenWebif-Adresse (z. B. http://root:pass@192.168.1.5:8080)
function detect(streamUrl, owifUrl) {
  var p;
  try { p = url.parse(streamUrl); } catch (e) { return null; }
  if ((p.protocol !== 'http:' && p.protocol !== 'https:') || !p.hostname) return null;
  var path = (p.pathname || '').replace(/^\//, '');
  try { path = decodeURIComponent(path); } catch (e2) { return null; }
  var m = SREF_RE.exec(path);
  if (!m) return null;
  var sref = m[0];
  // Eingebettete Streams (4097:/5001:/5002: = IPTV-Dienste) haben weder Picon noch EPG
  if (/^(4097|5001|5002):/.test(sref)) return null;
  var base = '';
  if (owifUrl) {
    base = String(owifUrl).replace(/\/+$/, '');
  } else {
    base = p.protocol + '//' + (p.auth ? p.auth + '@' : '') + p.hostname;      // OpenWebif laeuft normalerweise auf Port 80
  }
  return { base: base, sref: sref };
}

function hasAuth(base) { return /^https?:\/\/[^@\/]+@/.test(String(base)); }

// keepAuth=false: Zugangsdaten nicht in Bild-Adressen
function piconUrl(base, sref, keepAuth) {
  var b = keepAuth ? String(base) : String(base).replace(/^(https?:\/\/)[^@\/]*@/, '$1');
  return b + '/picon/' + sref.replace(/:/g, '_').replace(/_+$/, '') + '.png';
}

function key(base, sref) { return base + '|' + sref; }

// Sender mit Enigma2-Angaben versehen und fehlende Logos ergaenzen.
// wrapLogo(url): macht aus einer Adresse mit Zugangsdaten eine Dienst-Adresse (der Dienst schickt die Anmeldung mit)
function annotate(channels, owifUrl, off, wrapLogo) {
  if (off) return;
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var d = detect(ch.url, owifUrl);
    if (!d) continue;
    ch.e2b = d.base;
    ch.e2r = d.sref;
    if (!ch.logo) ch.logo = (hasAuth(d.base) && wrapLogo) ? wrapLogo(piconUrl(d.base, d.sref, true)) : piconUrl(d.base, d.sref, false);
  }
}

// Eindeutige Abrufe fuer alle Sender mit Enigma2-Angaben
function collect(channels) {
  var seen = {};
  var jobs = [];
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    if (!ch.e2b || !ch.e2r) continue;
    var k = key(ch.e2b, ch.e2r);
    if (seen[k]) continue;
    seen[k] = true;
    jobs.push({ key: k, base: ch.e2b, sref: ch.e2r });
  }
  return jobs;
}

function maskAuth(base) { return String(base).replace(/^(https?:\/\/)[^@\/]*@/, '$1'); }

// /api/epgservice liefert { events: [ { begin_timestamp, duration_sec, title, shortdesc, longdesc, ... } ] }
// OpenWebif liefert Texte teils mit HTML-Entities (&quot;, &amp; ...)
function decodeEntities(str) {
  return String(str).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|quot|apos|amp|lt|gt|nbsp);/g, function (m, e) {
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'nbsp') return ' ';
    var code = e.charAt(1) === 'x' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
    return code > 0 && code < 0x10000 ? String.fromCharCode(code) : m;
  });
}

function parseEvents(buf, nowSec) {
  var data = JSON.parse(buf.toString('utf8'));
  var ev = data && data.events;
  if (!Array.isArray(ev)) return [];
  var out = [];
  for (var i = 0; i < ev.length && out.length < MAX_EVENTS; i++) {
    var e = ev[i];
    if (!e || !e.begin_timestamp || !e.title) continue;
    var s = parseInt(e.begin_timestamp, 10);
    var dur = parseInt(e.duration_sec !== undefined ? e.duration_sec : e.duration, 10) || 1800;
    if (!s) continue;
    if (s + dur < nowSec - KEEP_BEFORE || s > nowSec + KEEP_AFTER) continue;
    var d = e.longdesc || e.shortdesc || e.description || '';
    out.push({ s: s, e: s + dur, t: decodeEntities(e.title).substring(0, 160), d: decodeEntities(d).substring(0, 900) });
  }
  out.sort(function (a, b) { return a.s - b.s; });
  return out;
}

// jobs -> cb({ map: {key: [Sendungen]}, channels, programmes, errors: [..] })
function fetchAll(jobs, opts, cb) {
  opts = opts || {};
  var nowSec = Math.floor(new Date().getTime() / 1000);
  var res = { map: {}, channels: 0, programmes: 0, errors: [] };
  var pos = 0, active = 0, finished = false;
  var hostState = {};      // base -> { ok, fail, dead, msg }

  function done() {
    if (finished) return;
    finished = true;
    // Fehlermeldung pro Box, nur wenn von dort gar nichts kam
    for (var b in hostState) {
      if (hostState.hasOwnProperty(b) && hostState[b].fail > 0 && hostState[b].ok === 0) {
        res.errors.push('OpenWebif ' + maskAuth(b) + ': ' + hostState[b].msg);
      }
    }
    cb(res);
  }

  function pump() {
    while (active < PARALLEL && pos < jobs.length) launch(jobs[pos++]);
    if (active === 0 && pos >= jobs.length) done();
  }

  function launch(job) {
    var hs = hostState[job.base] || (hostState[job.base] = { ok: 0, fail: 0, dead: false, msg: '' });
    if (hs.dead) return;     // Box antwortet nicht: restliche Sender dieser Box ueberspringen
    active++;
    fetcher.fetchBuffer(job.base + '/api/epgservice?sRef=' + encodeURIComponent(job.sref),
      { timeout: 8000, maxBytes: 8 * 1024 * 1024, insecure: opts.insecure }, function (err, buf) {
        active--;
        var events = null;
        if (!err) {
          try { events = parseEvents(buf, nowSec); } catch (e) { err = new Error('Antwort ist kein gueltiges JSON (kein OpenWebif?)'); }
        }
        if (err) {
          hs.fail++;
          hs.msg = err.message;
          if (hs.ok === 0 && hs.fail >= 3) hs.dead = true;
        } else {
          hs.ok++;
          if (events.length) {
            res.map[job.key] = events;
            res.channels++;
            res.programmes += events.length;
          }
        }
        pump();
      });
  }

  if (!jobs.length) return done();
  pump();
}

// ---------------------------------------------------------------- Senderliste direkt von der Box

// Adresse der Box auf Ursprung reduzieren (http://[user:pass@]host[:port]). Wirft Error mit deutscher Meldung.
function normalizeBase(input) {
  var s = String(input || '').replace(/^\s+|\s+$/g, '');
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new Error('Bitte die Adresse der Box angeben, z. B. http://192.168.1.5 (mit Anmeldung: http://root:passwort@192.168.1.5).');
  var p = url.parse(s);
  if (!p.hostname) throw new Error('Ungueltige Adresse der Box.');
  return p.protocol + '//' + (p.auth ? p.auth + '@' : '') + p.hostname + (p.port ? ':' + p.port : '');
}

function cleanBouquetName(n) {
  return String(n || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

// Marker, Trennzeilen und verschachtelte Bouquets sind keine Sender
function isRealService(sref) {
  var m = /^1:(\d+):/.exec(sref);
  if (!m) return true;
  var t = parseInt(m[1], 10);
  return t !== 64 && t !== 832 && t !== 7 && t !== 128;
}

// OpenWebif /api/getallservices -> { channels, groups }. Jedes Bouquet wird zur Gruppe.
function parseServices(buf, base, streamPort, streamAuth, plId) {
  var data = JSON.parse(buf.toString('utf8'));
  var bq = data && data.services;
  if (!Array.isArray(bq)) throw new Error('Antwort ist keine OpenWebif-Senderliste.');
  var p = url.parse(base);
  var host = p.hostname.indexOf(':') >= 0 ? '[' + p.hostname + ']' : p.hostname;
  var streamBase = p.protocol + '//' + (streamAuth && p.auth ? p.auth + '@' : '') + host + ':' + streamPort + '/';

  // Name ohne "(TV)"-Anhang, solange das keine doppelten Gruppennamen ergibt
  var plain = {};
  var i;
  for (i = 0; i < bq.length; i++) {
    var n0 = cleanBouquetName(bq[i].servicename).replace(/\s*\(TV\)$/i, '');
    plain[n0] = (plain[n0] || 0) + 1;
  }
  var channels = [];
  var groups = [];
  var usedNames = {};
  for (i = 0; i < bq.length; i++) {
    var b = bq[i];
    var subs = Array.isArray(b.subservices) ? b.subservices : [];
    var full = cleanBouquetName(b.servicename) || ('Bouquet ' + (i + 1));
    var short = full.replace(/\s*\(TV\)$/i, '') || full;
    var gname = plain[short] === 1 ? short : full;
    while (usedNames[gname]) gname += ' ';
    var count = 0;
    for (var j = 0; j < subs.length; j++) {
      var sv = subs[j];
      if (!sv || !sv.servicereference || !sv.servicename || !isRealService(sv.servicereference)) continue;
      var sref = String(sv.servicereference);
      channels.push({
        id: crypto.createHash('sha1').update(plId + '|e2|' + sref).digest('hex').substring(0, 10),
        name: String(sv.servicename).replace(/^\s+|\s+$/g, ''),
        group: gname, logo: '', tvgId: '', tvgName: '', chno: '',
        url: streamBase + sref, ua: '', referrer: ''
      });
      count++;
    }
    if (!count) continue;
    usedNames[gname] = true;
    groups.push({ name: gname, count: count });
  }
  return { channels: channels, groups: groups, epgUrl: '' };
}

// Bouquets und Sender von der Box holen. cb(err, { channels, groups, epgUrl })
function fetchServices(pl, plId, cb) {
  var base;
  try { base = normalizeBase(pl.url); } catch (e) { return cb(e); }
  fetcher.fetchBuffer(base + '/api/getallservices', { timeout: 30000, maxBytes: 20 * 1024 * 1024 }, function (err, buf) {
    if (err) return cb(new Error('OpenWebif ' + maskAuth(base) + ': ' + err.message));
    var parsed;
    try { parsed = parseServices(buf, base, pl.e2Port || 8001, !!pl.e2Auth, plId); }
    catch (e2) { return cb(new Error('Antwort der Box nicht lesbar (OpenWebif?): ' + e2.message)); }
    cb(null, parsed);
  });
}

module.exports = { normalizeBase: normalizeBase, parseServices: parseServices, fetchServices: fetchServices, detect: detect, piconUrl: piconUrl, annotate: annotate, collect: collect, fetchAll: fetchAll, key: key, parseEvents: parseEvents };
