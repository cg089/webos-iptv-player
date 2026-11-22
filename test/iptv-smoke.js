'use strict';
// Rauchtest: startet einen Test-Anbieter (Playlist, EPG, TS-/HLS-Streams) und den IPTV-Server und prueft die API.
// Aufruf:  node test/iptv-smoke.js     (laeuft mit Node 0.12 und neueren Versionen; reines ES5)
var http = require('http');
var zlib = require('zlib');
var fs = require('fs');
var os = require('os');
var path = require('path');
var assert = require('assert');

var tmp = path.join(os.tmpdir(), 'iptv-smoke-' + process.pid);
fs.mkdirSync(tmp);
var APP_PORT = 18766 + (process.pid % 500);
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ version: 1, port: APP_PORT }));
process.env.IPTV_DATA = tmp;

var failures = 0;
var seen = [];            // was der Test-Anbieter gesehen hat
var up;                   // Test-Anbieter
var UP;
var e2Auth = '';

function ok(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

function pad(n, l) { n = String(n); while (n.length < (l || 2)) n = '0' + n; return n; }
function xmltv(sec, off) {
  var d = new Date(sec * 1000);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + ' ' + (off || '+0000');
}

// Zeit in lokaler Schreibweise eines anderen Zeitzonen-Versatzes (Stunden), z. B. +0200
function xmltvTz(sec, hours) {
  return xmltv(sec + hours * 3600).replace(' +0000', ' ' + (hours < 0 ? '-' : '+') + pad(Math.abs(hours)) + '00');
}

function tsBytes(n) {
  var b = new Buffer(n);
  for (var i = 0; i < n; i++) b[i] = i % 188 === 0 ? 0x47 : (i * 7) & 0xff;
  return b;
}

function makeEpg() {
  var now = Math.floor(Date.now() / 1000);
  var h = 3600;
  var x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="test">\n';
  x += '<channel id="news1.de"><display-name>News Eins HD</display-name></channel>\n';
  x += '<channel id="sport.2"><display-name lang="de">Sport 2 (kommt auch als Duplikat)</display-name></channel>\n';
  x += '<channel id="other"><display-name>Nicht in der Playlist</display-name></channel>\n';
  x += '<programme start="' + xmltv(now - h) + '" stop="' + xmltv(now + h / 2) + '" channel="news1.de"><title lang="de">Tagesschau &amp; Wetter</title><desc>Nachrichten des Tages &lt;live&gt;</desc></programme>\n';
  x += '<programme start="' + xmltvTz(now + h / 2, 1) + '" stop="' + xmltv(now + 2 * h) + '" channel="news1.de"><title><![CDATA[Spätausgabe]]></title></programme>\n';
  x += '<programme start="' + xmltv(now - 10 * h) + '" stop="' + xmltv(now - 9 * h) + '" channel="news1.de"><title>Zu alt</title></programme>\n';
  x += '<programme start="' + xmltv(now + 100 * h) + '" stop="' + xmltv(now + 101 * h) + '" channel="news1.de"><title>Zu weit weg</title></programme>\n';
  x += '<programme start="' + xmltvTz(now - 1800, 2) + '" stop="' + xmltv(now + 1800) + '" channel="sport.2"><title>Spiel des Tages</title></programme>\n';
  x += '<programme start="' + xmltv(now - h) + '" stop="' + xmltv(now + h) + '" channel="other"><title>Unerwuenscht</title></programme>\n';
  x += '</tv>\n';
  return x;
}

function m3uText() {
  return [
    '#EXTM3U url-tvg="http://127.0.0.1:' + UP + '/epg.xml.gz"',
    '#EXTINF:-1 tvg-id="news1.de" tvg-name="News Eins" tvg-logo="http://x/logo.png" group-title="Nachrichten, Politik",News Eins HD',
    'http://127.0.0.1:' + UP + '/live/news1.ts',
    '#EXTINF:-1 tvg-id="" group-title="Sport",Sport 1',
    '#EXTVLCOPT:http-user-agent=SpecialAgent/1.0',
    '#EXTVLCOPT:http-referrer=http://ref.example/',
    'http://127.0.0.1:' + UP + '/needua/sport1.ts',
    '#EXTINF:-1 group-title="Sport",Sport 2 (kommt auch als Duplikat)',
    'http://127.0.0.1:' + UP + '/live/sport2.ts',
    '#EXTINF:-1 group-title="Sport",Sport 2 (kommt auch als Duplikat)',
    'http://127.0.0.1:' + UP + '/live/sport2b.ts',
    '#EXTGRP:Kino',
    '#EXTINF:-1,Film HLS',
    'http://127.0.0.1:' + UP + '/hls/index.m3u8',
    '#EXTINF:-1 tvg-id="kodi",Kodi Stil',
    'http://127.0.0.1:' + UP + '/live/kodi.ts|User-Agent=KodiUA&Referer=http://k/',
    ''
  ].join('\r\n');
}

function startUpstream(cb) {
  var live = tsBytes(300000);
  up = http.createServer(function (req, res) {
    seen.push({ url: req.url, ua: req.headers['user-agent'], ref: req.headers.referer, range: req.headers.range });
    var u = req.url.split('?')[0];
    if (u === '/list.m3u') {
      var body = new Buffer(m3uText(), 'utf8');
      if (/gzip/.test(req.headers['accept-encoding'] || '') && req.url.indexOf('gz=1') >= 0) {
        zlib.gzip(body, function (e, gz) {
          res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl', 'Content-Encoding': 'gzip' });
          res.end(gz);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return res.end(body);
    }
    if (u === '/list-redirect.m3u') { res.writeHead(302, { Location: '/list.m3u' }); return res.end(); }
    if (u === '/missing.m3u') { res.writeHead(404); return res.end(); }
    if (u === '/bad.m3u') { res.writeHead(200); return res.end('hello world'); }
    if (u === '/epg.xml.gz') {
      zlib.gzip(new Buffer(makeEpg(), 'utf8'), function (e, gz) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(gz);
      });
      return;
    }
    if (u === '/needua/sport1.ts') {
      if (req.headers['user-agent'] !== 'SpecialAgent/1.0' || req.headers.referer !== 'http://ref.example/') { res.writeHead(403); return res.end('no'); }
    }
    if (/^\/picon\//.test(u)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end('PNG:' + (req.headers.authorization || 'keine')); }
    if (u === '/api/getallservices') {
      e2Auth = req.headers.authorization || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      var DE = '1:0:19:283D:41B:1:FFFF0182:0:0:0:', ZDF = '1:0:19:2B66:437:1:FFFF01C2:0:0:0:', ORF = '1:0:16:CBB0:2710:F001:FFFF0000:0:0:0:';
      var sv = function (r, nme, pos) { return { servicereference: r, servicename: nme, program: pos, pos: pos }; };
      return res.end(JSON.stringify({ result: true, services: [
        { servicereference: '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet', servicename: 'Favourites (TV)', subservices: [sv(DE, 'Das Erste HD', 1), sv(ZDF, 'ZDF HD', 2), sv('1:64:1:0:0:0:0:0:0:0:', '-----', 3)] },
        { servicereference: '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.fav2.tv" ORDER BY bouquet', servicename: 'Favourites', subservices: [sv(ZDF, 'ZDF HD', 1), sv(ORF, 'ORF 1', 2)] },
        { servicereference: '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.sport.tv" ORDER BY bouquet', servicename: 'Sport (TV)', subservices: [sv(ORF, 'ORF 1', 1)] },
        { servicereference: '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.leer.tv" ORDER BY bouquet', servicename: 'Leer (TV)', subservices: [] }
      ] }));
    }
    if (u === '/api/epgservice') {
      var sr = decodeURIComponent((req.url.split('sRef=')[1] || '').split('&')[0]);
      if (sr.indexOf('1:0:19:283D') !== 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ events: [], result: true })); }
      var nw = Math.floor(Date.now() / 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: true, events: [
        { id: 1, begin_timestamp: nw - 600, duration_sec: 1800, title: 'Heute-Journal', shortdesc: 'Kurz', longdesc: 'Lange &quot;Beschreibung&quot; &amp; mehr', sref: sr },
        { id: 2, begin_timestamp: nw + 1200, duration_sec: 3600, title: 'Wetter', shortdesc: '', longdesc: '', sref: sr },
        { id: 3, begin_timestamp: nw - 99999, duration_sec: 60, title: 'Zu alt', sref: sr },
        { id: 4, begin_timestamp: null, duration_sec: null, title: 'Ohne Zeit', sref: sr }
      ] }));
    }
    if (/^\/(live|needua)\//.test(u) || /^\/1:0:/.test(u)) {
      var m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (m) {
        var s = parseInt(m[1], 10), e2 = m[2] ? parseInt(m[2], 10) : live.length - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes ' + s + '-' + e2 + '/' + live.length, 'Content-Length': e2 - s + 1, 'Accept-Ranges': 'bytes' });
        return res.end(live.slice(s, e2 + 1));
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': live.length });
      // in Stuecken senden (wie ein Live-Strom)
      var pos = 0;
      (function pump() {
        if (pos >= live.length) return res.end();
        res.write(live.slice(pos, pos + 20000));
        pos += 20000;
        setTimeout(pump, 1);
      })();
      return;
    }
    if (u === '/hls/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:4\r\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\r\n#EXTINF:4,\r\nseg0.ts\r\n#EXTINF:4,\r\n/hls/seg1.ts?x=1\r\n#EXT-X-ENDLIST\r\n');
    }
    if (u === '/hls/seg0.ts' || u === '/hls/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(live.slice(0, 5000)); }
    if (u === '/hls/key.bin') { res.writeHead(200); return res.end('0123456789abcdef'); }
    if (u === '/noext') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end('#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:' + UP + '/hls/seg0.ts\n'); }
    res.writeHead(404);
    res.end();
  });
  up.listen(0, '127.0.0.1', function () { UP = up.address().port; cb(); });
}

function call(method, p, body, headers, rawBody) {
  return function (cb) {
    var data = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
    var h = headers || {};
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    if (data !== null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    var r = http.request({ host: '127.0.0.1', port: APP_PORT, method: method, path: p, headers: h, agent: false }, function (res) {
      var parts = [];
      res.on('data', function (d) { parts.push(d); });
      res.on('end', function () {
        var buf = Buffer.concat(parts);
        var json = null;
        if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; } }
        cb(null, { status: res.statusCode, headers: res.headers, buf: buf, json: json });
      });
    });
    r.on('error', function (e) { cb(e); });
    r.end(data);
  };
}

function series(steps, done) {
  var i = 0;
  (function next() {
    if (i >= steps.length) return done();
    var s = steps[i++];
    var fin = false;
    var t = setTimeout(function () { if (!fin) { fin = true; failures++; console.log('  FAIL Zeitueberschreitung in Schritt ' + i); next(); } }, 20000);
    s(function () { if (fin) return; fin = true; clearTimeout(t); next(); });
  })();
}

function wait(cond, ms, cb) {
  var t0 = Date.now();
  (function poll() {
    if (cond()) return cb(true);
    if (Date.now() - t0 > ms) return cb(false);
    setTimeout(poll, 50);
  })();
}

var plId = null, chId = {}, server, m3uUrl, e2id = null, deadId = null;

function main() {
  server = require('../service/server');
  m3uUrl = 'http://127.0.0.1:' + UP + '/list.m3u';

  series([
    function (n) { server.start(function (e) { ok(!e, 'Server startet auf Port ' + APP_PORT); n(); }); },

    function (n) { call('GET', '/api/info')(function (e, r) { ok(r.json && r.json.ok && r.json.name === 'IPTV Player', 'GET /api/info'); n(); }); },

    // ---- Quelle testen
    function (n) { call('POST', '/api/test', { type: 'url', url: m3uUrl })(function (e, r) {
      ok(r.json && r.json.ok && r.json.count === 6, 'Test: 6 Sender gefunden (' + (r.json && (r.json.message || r.json.error)) + ')');
      ok(r.json && r.json.groups === 3, 'Test: 3 Gruppen');
      ok(r.json && r.json.epgUrl === 'http://127.0.0.1:' + UP + '/epg.xml.gz', 'Test: url-tvg aus dem Header');
      n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'http://127.0.0.1:' + UP + '/missing.m3u' })(function (e, r) {
      ok(r.json && r.json.ok === false && /404/.test(r.json.error), 'Test 404: ' + (r.json && r.json.error)); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'http://127.0.0.1:' + UP + '/bad.m3u' })(function (e, r) {
      ok(r.json && r.json.ok === false && /keine Sender/.test(r.json.error), 'Test keine M3U: ' + (r.json && r.json.error)); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'http://127.0.0.1:1/x.m3u' })(function (e, r) {
      ok(r.json && r.json.ok === false && /abgelehnt|erreichbar/.test(r.json.error), 'Test Verbindung abgelehnt: ' + (r.json && r.json.error)); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'ftp://x/y' })(function (e, r) {
      ok(r.status === 400, 'Test ungueltige Adresse -> 400'); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'http://127.0.0.1:' + UP + '/list-redirect.m3u' })(function (e, r) {
      ok(r.json && r.json.ok && r.json.count === 6, 'Test folgt Weiterleitung'); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'url', url: 'http://127.0.0.1:' + UP + '/list.m3u?gz=1' })(function (e, r) {
      ok(r.json && r.json.ok && r.json.count === 6, 'Test mit gzip-Antwort'); n(); }); },

    // ---- Fremder Ursprung wird abgewiesen
    function (n) { call('POST', '/api/playlists', { type: 'url', url: m3uUrl }, { Origin: 'http://evil.example' })(function (e, r) {
      ok(r.status === 403, 'Fremder Origin bei POST -> 403'); n(); }); },
    function (n) { call('GET', '/api/playlists', undefined, { Origin: 'http://evil.example', Host: 'example.test:1' })(function (e, r) {
      // Loopback-Zugriff ist erlaubt (die TV-App ruft ueber 127.0.0.1 auf)
      ok(r.status === 200, 'GET ueber Loopback bleibt moeglich'); n(); }); },

    // ---- Playlist anlegen
    function (n) { call('POST', '/api/playlists', { name: 'Test', type: 'url', url: m3uUrl, ua: 'TestUA/9' })(function (e, r) {
      ok(r.json && r.json.ok, 'Playlist gespeichert: ' + JSON.stringify(r.json && (r.json.error || r.json.playlist && r.json.playlist.count)));
      plId = r.json && r.json.playlist && r.json.playlist.id;
      ok(r.json && r.json.playlist && r.json.playlist.count === 6, 'Playlist hat 6 Sender');
      var ua = null; for (var i = 0; i < seen.length; i++) if (seen[i].url === '/list.m3u') ua = seen[i].ua;
      ok(ua === 'TestUA/9', 'Playlist wurde mit eigenem User-Agent geholt (' + ua + ')');
      var st = fs.statSync(path.join(tmp, 'config.json'));
      ok((st.mode & parseInt('077', 8)) === 0, 'config.json nur fuer den Besitzer lesbar');
      n(); }); },

    function (n) { call('GET', '/api/library')(function (e, r) {
      ok(r.json && r.json.playlists.length === 1 && r.json.playlists[0].count === 6, '/api/library');
      n(); }); },
    function (n) { call('GET', '/api/groups')(function (e, r) {
      var names = r.json.groups.map(function (g) { return g.name + ':' + g.count; });
      ok(names.join('|') === 'Nachrichten, Politik:1|Sport:3|Kino:2', 'Gruppen: ' + names.join(' | '));
      n(); }); },
    function (n) { call('GET', '/api/channels?group=' + encodeURIComponent('Sport'))(function (e, r) {
      ok(r.json.total === 3 && r.json.channels[0].name === 'Sport 1' && r.json.channels[2].n === 3, 'Sender der Gruppe Sport');
      ok(r.json.channels[1].id !== r.json.channels[2].id, 'Doppelte Sender bekommen eigene IDs');
      ok(!JSON.stringify(r.json).match(/127\.0\.0\.1:\d+\/live/), 'Sender-Liste enthaelt keine Stream-Adressen');
      r.json.channels.forEach(function (c) { chId[c.name + c.n] = c.id; });
      chId.sport1 = r.json.channels[0].id;
      n(); }); },
    function (n) { call('GET', '/api/channels?q=news')(function (e, r) {
      ok(r.json.total === 1 && r.json.channels[0].name === 'News Eins HD', 'Suche "news"');
      chId.news = r.json.channels[0].id; n(); }); },
    function (n) { call('GET', '/api/channels?q=hls')(function (e, r) { chId.hls = r.json.channels[0].id; ok(r.json.channels[0].group === 'Kino', '#EXTGRP wird als Gruppe uebernommen'); n(); }); },
    function (n) { call('GET', '/api/channels?q=kodi')(function (e, r) { chId.kodi = r.json.channels[0].id; n(); }); },

    // ---- Wiedergabe-Angaben und Proxy
    function (n) { call('POST', '/api/play', { id: chId.news, ctx: { group: 'Nachrichten, Politik' } })(function (e, r) {
      var c = r.json && r.json.channel;
      ok(c && c.url === 'http://127.0.0.1:' + UP + '/live/news1.ts' && c.needsProxy === false, '/api/play: direkte Adresse, kein Proxy noetig');
      ok(c && /^\/p\/[0-9a-f]{32}\/[A-Za-z0-9_-]+\.ts$/.test(c.proxyUrl), 'Proxy-Adresse hat Signatur und Endung: ' + (c && c.proxyUrl.substring(0, 50)));
      n(); }); },
    function (n) { call('POST', '/api/play', { id: chId.news })(function (e, r) {
      var proxyUrl = r.json.channel.proxyUrl;
      call('GET', proxyUrl)(function (e2, r2) {
        ok(r2.status === 200 && r2.buf.length === 300000 && r2.buf[0] === 0x47 && r2.buf[188] === 0x47, 'Proxy liefert den TS-Strom komplett (' + r2.buf.length + ' Bytes)');
        ok(/mp2t/.test(r2.headers['content-type']), 'Proxy: Content-Type video/mp2t');
        call('GET', proxyUrl, undefined, { Range: 'bytes=1000-1999' })(function (e3, r3) {
          ok(r3.status === 206 && r3.buf.length === 1000 && /^bytes 1000-1999\/300000$/.test(r3.headers['content-range']), 'Proxy reicht Range-Anfragen durch');
          var tampered = proxyUrl.replace(/\/p\/[0-9a-f]{2}/, function (m) { return m.substring(0, 3) + (m.charAt(3) === '0' ? '1' : '0') + m.charAt(4); });
          call('GET', tampered)(function (e4, r4) {
            ok(r4.status === 403, 'Manipulierte Signatur -> 403');
            call('GET', '/p/' + proxyUrl.split('/')[2] + '/x')(function (e5, r5) { ok(r5.status === 403 || r5.status === 400, 'Falsche Nutzlast abgewiesen'); n(); });
          });
        });
      }); }); },
    function (n) { call('POST', '/api/play', { id: chId.sport1 })(function (e, r) {
      var c = r.json.channel;
      ok(c.needsProxy === true, 'Sender mit #EXTVLCOPT braucht den Proxy');
      call('GET', c.proxyUrl)(function (e2, r2) {
        ok(r2.status === 200 && r2.buf.length === 300000, 'Proxy sendet User-Agent und Referer des Senders (Status ' + r2.status + ')');
        call('GET', c.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''))(function () {});
        n(); }); }); },
    function (n) { call('POST', '/api/play', { id: chId.kodi })(function (e, r) {
      call('GET', r.json.channel.proxyUrl)(function () {
        var s = null; for (var i = 0; i < seen.length; i++) if (seen[i].url === '/live/kodi.ts') s = seen[i];
        ok(s && s.ua === 'KodiUA' && s.ref === 'http://k/', 'Kodi-Stil "|User-Agent=..&Referer=.." wird angewendet');
        ok(r.json.channel.url === 'http://127.0.0.1:' + UP + '/live/kodi.ts', 'Kodi-Header aus der Stream-Adresse entfernt');
        n(); }); }); },
    function (n) { call('POST', '/api/play', { id: chId.hls })(function (e, r) {
      var pu = r.json.channel.proxyUrl;
      ok(/\.m3u8$/.test(pu), 'HLS-Proxy-Adresse endet auf .m3u8');
      call('GET', pu)(function (e2, r2) {
        var text = r2.buf.toString('utf8');
        ok(r2.status === 200 && /mpegurl/.test(r2.headers['content-type']), 'HLS-Playlist ueber den Proxy');
        var lines = text.split('\n');
        var segLines = lines.filter(function (l) { return /^\/p\//.test(l); });
        ok(segLines.length === 2, 'Segment-Adressen umgeschrieben (' + segLines.length + ')');
        ok(/URI="\/p\/[0-9a-f]{32}\//.test(text), 'Schluessel-URI umgeschrieben');
        ok(text.indexOf('127.0.0.1:' + UP) < 0, 'Keine Originaladresse in der Playlist');
        call('GET', segLines[1])(function (e3, r3) {
          ok(r3.status === 200 && r3.buf.length === 5000, 'Segment ueber den Proxy abrufbar');
          n(); });
      }); }); },

    // ---- Favoriten, zuletzt gesehen
    function (n) { call('POST', '/api/favorite', { id: chId.news, on: true })(function (e, r) {
      ok(r.json && r.json.ok, 'Favorit setzen'); n(); }); },
    function (n) { call('GET', '/api/channels?fav=1')(function (e, r) {
      ok(r.json.total === 1 && r.json.channels[0].fav === true, 'Favoritenliste'); n(); }); },
    function (n) { call('GET', '/api/channels?recent=1')(function (e, r) {
      ok(r.json.total >= 4 && r.json.channels[0].id === chId.hls, 'Zuletzt gesehen: neuester zuerst'); n(); }); },
    function (n) { call('POST', '/api/favorite', { id: 'gibtesnicht', on: true })(function (e, r) { ok(r.status === 404, 'Unbekannter Favorit -> 404'); n(); }); },
    function (n) { call('GET', '/api/library')(function (e, r) {
      ok(r.json.favCount === 1 && r.json.last && r.json.last.id === chId.hls, 'Library: favCount und letzter Sender'); n(); }); },

    // ---- EPG
    function (n) { call('POST', '/api/settings', { epgUrl: '' })(function () { n(); }); },
    function (n) {
      call('POST', '/api/epg/refresh', {})(function () {
        wait(function () { return seenEpg() && !require('../service/epg').status().loading; }, 8000, function (done) {
          var st = require('../service/epg').status();
          ok(done && st.programmes === 3 && !st.error, 'EPG geladen: ' + st.programmes + ' Sendungen fuer ' + st.channels + ' Sender' + (st.error ? ' (' + st.error + ')' : ''));
          n();
        });
      }); },
    function (n) { call('GET', '/api/channels?q=news')(function (e, r) {
      var c = r.json.channels[0];
      ok(c.now && c.now.t === 'Tagesschau & Wetter', 'EPG: aktuelle Sendung ("' + (c.now && c.now.t) + '", Entities decodiert)');
      ok(c.next && c.next.t === 'Spätausgabe', 'EPG: naechste Sendung (CDATA)');
      n(); }); },
    function (n) { call('GET', '/api/channels?group=Sport')(function (e, r) {
      ok(r.json.channels[1].now && r.json.channels[1].now.t === 'Spiel des Tages', 'EPG ueber Sendernamen zugeordnet (ohne tvg-id)');
      ok(!r.json.channels[0].now, 'Sender ohne EPG hat keine Sendung');
      n(); }); },
    function (n) { call('GET', '/api/epg?id=' + chId.news)(function (e, r) {
      ok(r.json.epg.upcoming.length === 2 && /live/.test(r.json.epg.now.d), 'EPG-Detail mit Beschreibung');
      n(); }); },

    // ---- Gruppen ausblenden
    function (n) { call('GET', '/api/playlists/' + plId + '/groups')(function (e, r) {
      ok(r.json.groups.length === 3 && !r.json.groups[0].hidden, 'Gruppenliste zum Ausblenden'); n(); }); },
    function (n) { call('POST', '/api/playlists/' + plId + '/hidden', { hidden: ['Sport'] })(function (e, r) {
      ok(r.json.ok, 'Gruppe ausgeblendet');
      call('GET', '/api/groups')(function (e2, r2) {
        ok(r2.json.groups.map(function (g) { return g.name; }).indexOf('Sport') < 0, 'Ausgeblendete Gruppe erscheint nicht mehr');
        call('GET', '/api/channels?q=sport')(function (e3, r3) { ok(r3.json.total === 0, 'Ausgeblendete Sender nicht in der Suche'); n(); });
      }); }); },
    function (n) { call('POST', '/api/playlists/' + plId + '/hidden', { hidden: [] })(function () { n(); }); },

    // ---- Datei-Playlist hochladen
    function (n) { call('POST', '/api/playlists', { name: 'Datei', type: 'file', content: '#EXTM3U\n#EXTINF:-1 group-title="X",Eins\nhttp://127.0.0.1:' + UP + '/live/a.ts\n#EXTINF:-1 group-title="X",Zwei\nhttp://127.0.0.1:' + UP + '/live/b.ts\n' })(function (e, r) {
      ok(r.json && r.json.ok && r.json.playlist.count === 2, 'Datei-Playlist: 2 Sender');
      var id2 = r.json.playlist.id;
      call('POST', '/api/playlists', { type: 'file', content: 'kein m3u' })(function (e2, r2) {
        ok(r2.status === 400 && /M3U/.test(r2.json.error), 'Keine M3U-Datei wird abgelehnt');
        call('GET', '/api/channels?playlist=' + id2)(function (e3, r3) {
          ok(r3.json.total === 2, 'Abfrage nur einer Playlist');
          call('DELETE', '/api/playlists/' + id2)(function (e4, r4) {
            ok(r4.json.ok, 'Playlist geloescht');
            ok(!fs.existsSync(path.join(tmp, 'pl-' + id2 + '.m3u')), 'Hochgeladene Datei entfernt');
            n(); });
        }); }); }); },


    // ---- Enigma2 / OpenWebif: Picons und EPG ohne tvg-id
    function (n) { call('POST', '/api/playlists', { name: 'VU+', type: 'file', owifUrl: 'http://127.0.0.1:' + UP, content: '#EXTM3U\n#EXTVLCOPT--http-reconnect=true\n#EXTINF:-1,Das Erste HD\n#EXTVLCOPT:program=10301\nhttp://127.0.0.1:' + UP + '/1:0:19:283D:41B:1:FFFF0182:0:0:0:\n#EXTINF:-1,ORF 1\n#EXTVLCOPT:program=52144\nhttp://127.0.0.1:' + UP + '/1:0:16:CBB0:2710:F001:FFFF0000:0:0:0:\n#EXTINF:-1,Eingang\nhttp://127.0.0.1:' + UP + '/4097:0:1:0:0:0:0:0:0:0:rtsp%3a//192.168.10.36%3a8554/Eingang_Sub:Eingang\n' })(function (e, r) {
      ok(r.json && r.json.ok && r.json.playlist.count === 3 && r.json.playlist.owifUrl === 'http://127.0.0.1:' + UP, 'Enigma2-Playlist (ohne Gruppen/tvg-id) geladen');
      e2id = r.json.playlist.id;
      n(); }); },
    function (n) { wait(function () { var st = require('../service/epg').status(); return !st.loading && st.programmes > 0 && /OpenWebif/.test((st.urls || []).join(' ')); }, 8000, function (okw) {
      var st = require('../service/epg').status();
      ok(okw && st.error === '' , 'Enigma2-EPG geladen (' + st.programmes + ' Sendungen, Fehler: "' + st.error + '")'); n(); }); },
    function (n) { call('GET', '/api/channels?playlist=' + e2id)(function (e, r) {
      var c = r.json.channels;
      ok(c[0].logo === 'http://127.0.0.1:' + UP + '/picon/1_0_19_283D_41B_1_FFFF0182_0_0_0.png', 'Picon-Adresse aus der Service-Referenz: ' + c[0].logo);
      ok(c[0].now && c[0].now.t === 'Heute-Journal' && c[0].next && c[0].next.t === 'Wetter', 'OpenWebif-EPG: laufende und naechste Sendung');
      ok(!c[1].now && c[1].logo.indexOf('1_0_16_CBB0_2710_F001_FFFF0000_0_0_0.png') > 0, 'Sender ohne EPG-Eintraege, aber mit Picon');
      ok(c[2].logo === '' && !c[2].now, 'rtsp-Eingang bekommt weder Picon noch EPG');
      ok(c[0].group === 'Ohne Gruppe', 'Playlist ohne Gruppen: "Ohne Gruppe"');
      chId.e2 = c[0].id; n(); }); },
    function (n) { call('GET', '/api/epg?id=' + chId.e2)(function (e, r) {
      ok(r.json.epg.now.d === 'Lange "Beschreibung" & mehr', 'OpenWebif-Detail: Langtext statt Kurztext, Entities dekodiert'); n(); }); },
    function (n) { // Box ohne OpenWebif: Fehler wird gemeldet, nichts bricht
      call('POST', '/api/playlists', { name: 'Box tot', type: 'file', owifUrl: 'http://127.0.0.1:1', content: '#EXTM3U\n#EXTINF:-1,A\nhttp://127.0.0.1:9/1:0:19:AAAA:1:1:FFFF0000:0:0:0:\n#EXTINF:-1,B\nhttp://127.0.0.1:9/1:0:19:BBBB:1:1:FFFF0000:0:0:0:\n#EXTINF:-1,C\nhttp://127.0.0.1:9/1:0:19:CCCC:1:1:FFFF0000:0:0:0:\n#EXTINF:-1,D\nhttp://127.0.0.1:9/1:0:19:DDDD:1:1:FFFF0000:0:0:0:\n' })(function (e, r) {
        deadId = r.json.playlist.id;
        wait(function () { var st = require('../service/epg').status(); return !st.loading && /OpenWebif http:\/\/127\.0\.0\.1:1/.test(st.error + ' ' + (st.urls || []).join(' ')); }, 12000, function (okw) {
          var st = require('../service/epg').status();
          ok(okw && /127\.0\.0\.1:1: /.test(st.error), 'Unerreichbare Box wird gemeldet: ' + st.error.substring(0, 90));
          ok(st.programmes >= 2, 'Die uebrigen EPG-Daten bleiben erhalten');
          call('DELETE', '/api/playlists/' + deadId)(function () { n(); });
        }); }); },
    function (n) { call('POST', '/api/playlists', { type: 'file', owifUrl: 'ftp://x', content: '#EXTM3U\n' })(function (e, r) { ok(r.status === 400 && /OpenWebif/.test(r.json.error), 'Ungueltige OpenWebif-Adresse abgelehnt'); n(); }); },
    function (n) { call('POST', '/api/playlists', { name: 'Aus', type: 'file', owifOff: true, content: '#EXTM3U\n#EXTINF:-1,Z\nhttp://127.0.0.1:' + UP + '/1:0:19:283D:41B:1:FFFF0182:0:0:0:\n' })(function (e, r) {
      call('GET', '/api/channels?playlist=' + r.json.playlist.id)(function (e2, r2) {
        ok(r2.json.channels[0].logo === '', 'Enigma2-Erkennung abschaltbar (kein Picon)');
        call('DELETE', '/api/playlists/' + r.json.playlist.id)(function () { n(); }); }); }); },

    // ---- Enigma2-Quelle: Bouquets und Sender direkt von der Box
    function (n) { call('POST', '/api/playlists', { type: 'enigma2', url: 'ftp://box' })(function (e, r) { ok(r.status === 400 && /Box/.test(r.json.error), 'Enigma2: ungueltige Adresse abgelehnt'); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'enigma2', url: 'http://127.0.0.1:' + UP })(function (e, r) {
      ok(r.json.ok && r.json.count === 5 && r.json.groups === 3, 'Enigma2-Test: 5 Eintraege in 3 Bouquets (Marker und leeres Bouquet ausgelassen)'); n(); }); },
    function (n) { call('POST', '/api/test', { type: 'enigma2', url: 'http://127.0.0.1:1' })(function (e, r) {
      ok(r.json.ok === false && /OpenWebif/.test(r.json.error), 'Enigma2-Test: unerreichbare Box wird gemeldet'); n(); }); },
    function (n) { call('POST', '/api/playlists', { type: 'enigma2', name: 'Box', url: 'http://root:geheim@127.0.0.1:' + UP + '/irgendwas', e2Port: 9999 })(function (e, r) {
      var p = r.json.playlist;
      ok(r.json.ok && p.type === 'enigma2' && p.url === 'http://root:geheim@127.0.0.1:' + UP && p.e2Port === 9999, 'Enigma2-Quelle gespeichert (Adresse auf Box reduziert)');
      ok(p.count === 3 && p.groups === 3 && p.error === '', 'Enigma2: 3 eindeutige Sender in 3 Bouquets');
      ok(e2Auth === 'Basic ' + new Buffer('root:geheim').toString('base64'), 'Enigma2: Anmeldung wird an die Box geschickt');
      chId.box = p.id; n(); }); },
    function (n) { call('GET', '/api/groups?playlist=' + chId.box)(function (e, r) {
      var names = r.json.groups.map(function (g) { return g.name; }).join('|');
      ok(names === 'Favourites (TV)|Favourites|Sport', 'Bouquet-Namen: "(TV)" nur entfernt, wenn der Name eindeutig bleibt: ' + names); n(); }); },
    function (n) { call('GET', '/api/channels?playlist=' + chId.box)(function (e, r) {
      ok(r.json.total === 3, 'Alle Sender: ueberschneidende Bouquets ohne Doppelte');
      chId.boxCh = r.json.channels[0].id;
      ok(r.json.channels[0].name === 'Das Erste HD' && /^\/p\//.test(r.json.channels[0].logo), 'Enigma2: Picon ueber den Dienst (Anmeldung)');
      call('GET', '/api/channels?playlist=' + chId.box + '&group=Favourites')(function (e2, r2) {
        ok(r2.json.total === 2 && r2.json.channels[0].name === 'ZDF HD', 'Enigma2: Bouquet-Reihenfolge der Box'); n(); }); }); },
    function (n) { call('POST', '/api/play', { id: chId.boxCh, record: false })(function (e, r) {
      ok(r.json.channel.url === 'http://127.0.0.1:9999/1:0:19:283D:41B:1:FFFF0182:0:0:0:', 'Enigma2: Stream-Adresse mit Streaming-Port, ohne Zugangsdaten: ' + r.json.channel.url); n(); }); },
    function (n) { wait(function () { var st = require('../service/epg').status(); return !st.loading && st.programmes > 0; }, 8000, function () { n(); }); },
    function (n) { call('GET', '/api/channels?playlist=' + chId.box)(function (e, r) {
      ok(r.json.channels[0].now && r.json.channels[0].now.t === 'Heute-Journal', 'Enigma2: EPG ueber OpenWebif ohne weitere Einrichtung'); n(); }); },
    function (n) { call('POST', '/api/playlists', { id: chId.box, type: 'enigma2', name: 'Box', url: 'http://root:geheim@127.0.0.1:' + UP, e2Auth: true })(function (e, r) {
      call('POST', '/api/play', { id: chId.boxCh, record: false })(function (e2, r2) {
        ok(r2.json.channel.url === 'http://root:geheim@127.0.0.1:8001/1:0:19:283D:41B:1:FFFF0182:0:0:0:', 'Enigma2: Zugangsdaten in Stream-Adresse nur mit Option, Standardport 8001');
        call('DELETE', '/api/playlists/' + chId.box)(function () { n(); }); }); }); },

    // ---- Picons hinter OpenWebif-Anmeldung laufen ueber den Dienst
    function (n) { call('POST', '/api/playlists', { name: 'Auth', type: 'file', owifUrl: 'http://root:geheim@127.0.0.1:' + UP, content: '#EXTM3U\n#EXTINF:-1,Z\nhttp://127.0.0.1:' + UP + '/1:0:19:283D:41B:1:FFFF0182:0:0:0:\n' })(function (e, r) {
      call('GET', '/api/channels?playlist=' + r.json.playlist.id)(function (e2, r2) {
        var lg = r2.json.channels[0].logo;
        ok(/^\/p\/[0-9a-f]{32}\/.+\.png$/.test(lg) && lg.indexOf('geheim') < 0, 'Picon mit Anmeldung wird ueber den Dienst geleitet (Passwort nicht im Klartext in der Liste)');
        call('GET', lg)(function (e3, r3) {
          ok(r3.status === 200 && r3.buf.toString() === 'PNG:Basic ' + new Buffer('root:geheim').toString('base64'), 'Dienst schickt die Anmeldung zur Box mit');
          call('DELETE', '/api/playlists/' + r.json.playlist.id)(function () { n(); }); }); }); }); },

    // ---- Puffer im Proxy
    function (n) { call('POST', '/api/settings', { bufferMb: 4 })(function (e, r) { ok(r.json.ok && r.json.settings.bufferMb === 4, 'Puffer-Einstellung gespeichert'); n(); }); },
    function (n) { call('POST', '/api/settings', { bufferMb: 500 })(function (e, r) { ok(r.status === 400, 'Puffer ueber 64 MB abgelehnt'); n(); }); },
    function (n) { call('POST', '/api/play', { id: chId.e2, record: false })(function (e, r) {
      var pu = r.json.channel.proxyUrl;
      var payload = JSON.parse(new Buffer(pu.split('/')[3].replace(/\..*$/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      ok(payload.b === 4, 'Puffergroesse steckt in der signierten Proxy-Adresse');
      var t0 = Date.now();
      call('GET', pu)(function (e2, r2) {
        var ref = tsBytes(300000);
        ok(r2.status === 200 && r2.buf.length === 300000 && r2.buf.equals ? r2.buf.equals(ref) : r2.buf.length === 300000, 'Gepufferter Proxy liefert den Strom unveraendert (' + r2.buf.length + ' Bytes, ' + (Date.now() - t0) + ' ms)');
        n(); }); }); },
    function (n) { call('POST', '/api/settings', { bufferMb: 0 })(function () { n(); }); },

    // ---- Zugriffsschutz
    function (n) { call('POST', '/api/admin', { password: 'geheim' })(function (e, r) { ok(r.json.ok && r.json.hasAdminPassword, 'Zugriffsschutz setzen (Loopback bleibt frei)'); n(); }); },
    function (n) { call('GET', '/api/playlists', undefined, {})(function (e, r) { ok(r.status === 200, 'Loopback braucht kein Passwort'); n(); }); },
    function (n) { call('POST', '/api/admin', { password: '' })(function (e, r) { ok(!r.json.hasAdminPassword, 'Zugriffsschutz aus'); n(); }); },

    // ---- Einstellungen
    function (n) { call('POST', '/api/settings', { proxy: 'bogus' })(function (e, r) { ok(r.status === 400, 'Ungueltiger Proxy-Modus -> 400'); n(); }); },
    function (n) { call('POST', '/api/settings', { refreshHours: 0 })(function (e, r) { ok(r.status === 400, 'Ungueltige Stunden -> 400'); n(); }); },
    function (n) { call('POST', '/api/settings', { proxy: 'always', autoplayLast: true, showLogos: false, refreshHours: 6 })(function (e, r) {
      ok(r.json.ok && r.json.settings.proxy === 'always' && r.json.settings.autoplayLast === true && r.json.settings.refreshHours === 6, 'Einstellungen gespeichert'); n(); }); },

    // ---- Persistenz
    function (n) {
      require('../service/config').saveState();
      var cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      var st = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
      ok(cfg.playlists.length === 2 && cfg.settings.proxy === 'always' && cfg.secret.length >= 32, 'config.json enthaelt Playlist, Einstellungen und Schluessel');
      ok(st.favorites.length === 1 && st.recents.length >= 4 && st.last === chId.hls, 'state.json enthaelt Favoriten und Verlauf');
      n(); }
  ], function () {
    server.stop(function () {
      up.close();
      try {
        fs.readdirSync(tmp).forEach(function (f) { fs.unlinkSync(path.join(tmp, f)); });
        fs.rmdirSync(tmp);
      } catch (e) { /* egal */ }
      console.log(failures ? '\n' + failures + ' Test(s) fehlgeschlagen' : '\nAlle Tests bestanden');
      process.exit(failures ? 1 : 0);
    });
  });
}

function seenEpg() {
  for (var i = 0; i < seen.length; i++) if (seen[i].url === '/epg.xml.gz') return true;
  return false;
}

startUpstream(main);
