'use strict';
// Stream-Proxy: holt Streams im Auftrag des TV-Players. Noetig, wenn ein Anbieter einen bestimmten
// User-Agent/Referer verlangt oder sein Zertifikat vom TV nicht akzeptiert wird. HLS-Playlisten werden
// umgeschrieben, damit auch die Segmente ueber den Proxy laufen.
//
// Adressen: /p/<Signatur>/<Nutzlast>.<Endung>. Die Nutzlast (Base64url-JSON mit Ziel-URL) ist mit
// HMAC-SHA256 signiert - es werden nur Adressen bedient, die dieser Dienst selbst erzeugt hat
// (kein offener Proxy fuer beliebige Ziele).
var crypto = require('crypto');
var url = require('url');
var fetcher = require('./fetcher');

var MAX_PLAYLIST = 4 * 1024 * 1024;
var GC_EVERY = 12 * 1024 * 1024;
var gcBytes = 0;

var secret = '';
function setSecret(s) { secret = String(s || ''); }

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Buffer(s, 'base64');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').substring(0, 32);
}

function extOf(target) {
  var p = '';
  try { p = url.parse(target).pathname || ''; } catch (e) { p = ''; }
  var m = /\.([A-Za-z0-9]{1,5})$/.exec(p);
  return m ? '.' + m[1].toLowerCase() : '';
}

// o: { ua, referrer, insecure }
function makeUrl(target, o) {
  o = o || {};
  var data = { u: target };
  if (o.ua) data.a = o.ua;
  if (o.referrer) data.r = o.referrer;
  if (o.insecure) data.i = 1;
  if (o.buffer) data.b = o.buffer;
  var payload = b64url(new Buffer(JSON.stringify(data), 'utf8'));
  return '/p/' + sign(payload) + '/' + payload + extOf(target);
}

function verify(sig, payload) {
  var expect = sign(payload);
  if (typeof sig !== 'string' || sig.length !== expect.length) return false;
  var diff = 0;
  for (var i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

function rewritePlaylist(text, base, o) {
  var lines = text.split(/\r\n|\n|\r/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.replace(/\s+/g, '')) continue;
    if (line.charAt(0) === '#') {
      lines[i] = line.replace(/URI="([^"]*)"/g, function (m, u) {
        return 'URI="' + makeUrl(url.resolve(base, u), o) + '"';
      });
    } else {
      lines[i] = makeUrl(url.resolve(base, line.replace(/^\s+|\s+$/g, '')), o);
    }
  }
  return lines.join('\n');
}

function isPlaylistType(ctype, target) {
  if (/mpegurl/i.test(ctype || '')) return true;
  var p = '';
  try { p = url.parse(target).pathname || ''; } catch (e) { p = ''; }
  return /\.m3u8?$/i.test(p);
}

function guessType(target) {
  var e = extOf(target);
  if (e === '.ts') return 'video/mp2t';
  if (e === '.m3u8' || e === '.m3u') return 'application/vnd.apple.mpegurl';
  if (e === '.mp4' || e === '.m4s') return 'video/mp4';
  if (e === '.aac') return 'audio/aac';
  if (e === '.mp3') return 'audio/mpeg';
  return '';
}

function countBytes(n) {
  gcBytes += n;
  if (gcBytes >= GC_EVERY) {
    gcBytes = 0;
    if (typeof global.gc === 'function') global.gc();
  }
}

function fail(res, code, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

// parts = ['', 'p', sig, 'payload.ext']
function handle(req, res, parts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Methode nicht erlaubt');
  var sig = parts[2] || '';
  var payload = String(parts[3] || '').replace(/\..*$/, '');
  if (!payload || !verify(sig, payload)) return fail(res, 403, 'Ungueltige Proxy-Adresse');
  var data;
  try { data = JSON.parse(fromB64url(payload).toString('utf8')); } catch (e) { return fail(res, 400, 'Ungueltige Proxy-Adresse'); }
  if (!data || typeof data.u !== 'string') return fail(res, 400, 'Ungueltige Proxy-Adresse');

  var o = { ua: data.a || '', referrer: data.r || '', insecure: !!data.i, buffer: data.b || 0 };
  var capBytes = Math.max(1048576, Math.min(64, parseInt(o.buffer, 10) || 0) * 1048576);   // Warteschlange: mindestens 1 MB (Gegendruck)
  var preBytes = o.buffer ? Math.min(capBytes / 4, 3 * 1048576) : 0;                          // vor dem Start sammeln
  var upstream = null;
  var closed = false;
  res.on('close', function () { closed = true; if (upstream) upstream.destroy(); });

  fetcher.open(data.u, { ua: o.ua, referrer: o.referrer, insecure: o.insecure, range: req.headers.range, timeout: 25000 },
    function (err, up, finalUrl) {
      if (err) return fail(res, 502, fetcher.explain(err));
      upstream = up;
      if (closed) { up.destroy(); return; }
      if (up.statusCode >= 400) {
        up.resume();
        return fail(res, 502, fetcher.httpStatusText(up.statusCode));
      }

      var ctype = up.headers['content-type'] || '';
      var mode = '';                 // '' = noch offen, 'pass' = durchreichen, 'hls' = Playlist umschreiben
      var parts2 = [];
      var size = 0;

      // Durchreichen mit Warteschlange: bei gesetztem Puffer wird vor dem Start vorgeladen und danach
      // schneller vom Anbieter gelesen als der Player abnimmt - das gleicht Netzwerk-Aussetzer aus.
      var q = [], queued = 0, started = false, ended = false, waitingDrain = false, upPaused = false, preTimer = null, head = null;

      function begin() {
        if (started || closed) return;
        started = true;
        clearTimeout(preTimer);
        res.writeHead(head.code, head.headers);
        if (req.method === 'HEAD') { res.end(); up.destroy(); return; }
        flush();
      }

      function flush() {
        if (!started || closed) return;
        while (q.length && !waitingDrain) {
          var d = q.shift();
          queued -= d.length;
          countBytes(d.length);
          if (res.write(d) === false) {
            waitingDrain = true;
            res.once('drain', function () { waitingDrain = false; flush(); });
          }
        }
        if (upPaused && queued < capBytes / 2) { upPaused = false; up.resume(); }
        if (ended && !q.length && !waitingDrain) res.end();
      }

      function startPass(first) {
        mode = 'pass';
        var h = { 'Cache-Control': 'no-cache', 'Accept-Ranges': up.headers['accept-ranges'] || 'none' };
        var ct = ctype;
        if (!ct || /octet-stream|text\/plain|text\/html/i.test(ct)) ct = guessType(finalUrl) || ct || 'video/mp2t';
        h['Content-Type'] = ct;
        if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
        if (up.headers['content-range']) h['Content-Range'] = up.headers['content-range'];
        head = { code: up.statusCode === 206 ? 206 : 200, headers: h };
        if (preBytes) preTimer = setTimeout(begin, 4000);     // spaetestens nach 4 s starten
        enqueue(first);
        if (!preBytes) begin();
      }

      function enqueue(d) {
        q.push(d);
        queued += d.length;
        if (!started && queued >= preBytes) begin();
        else if (started) flush();
        if (queued >= capBytes && !upPaused) { upPaused = true; up.pause(); }
      }

      up.on('data', function (d) {
        if (closed) return;
        if (mode === '') {
          var head = d.toString('utf8', 0, Math.min(d.length, 16)).replace(/^﻿/, '');
          mode = (isPlaylistType(ctype, finalUrl) || head.indexOf('#EXTM3U') === 0) ? 'hls' : 'pass-pending';
          if (mode === 'pass-pending') return startPass(d);
        }
        if (mode === 'hls') {
          size += d.length;
          if (size > MAX_PLAYLIST) { up.destroy(); return fail(res, 502, 'Playlist zu gross'); }
          parts2.push(d);
        } else {
          enqueue(d);
        }
      });
      up.on('end', function () {
        if (closed) return;
        if (mode === 'hls') {
          var text = Buffer.concat(parts2).toString('utf8').replace(/^﻿/, '');
          // Ist es doch keine Playlist (z. B. Endung .m3u8, aber Medieninhalt), unveraendert durchreichen
          if (text.indexOf('#EXTM3U') !== 0) {
            res.writeHead(200, { 'Content-Type': ctype || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            return res.end(Buffer.concat(parts2));
          }
          var body = new Buffer(rewritePlaylist(text, finalUrl, o), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache'
          });
          return res.end(req.method === 'HEAD' ? undefined : body);
        }
        if (mode === '') {             // leere Antwort
          res.writeHead(200, { 'Content-Length': 0 });
          return res.end();
        }
        ended = true;
        if (!started) begin();         // Strom endete vor dem Vorladen: sofort ausliefern
        flush();
      });
      up.on('error', function () { fail(res, 502, 'Stream-Verbindung abgebrochen'); });
    });
}

module.exports = { handle: handle, makeUrl: makeUrl, setSecret: setSecret, rewritePlaylist: rewritePlaylist, verify: verify };
