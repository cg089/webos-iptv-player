'use strict';
// HTTP(S)-Abrufe: Weiterleitungen, gzip, Zeitlimits, optional ohne Zertifikatspruefung.
// open() liefert die Antwort als Stream (fuer den Stream-Proxy), fetchBuffer() sammelt sie ein.
var http = require('http');
var https = require('https');
var url = require('url');
var zlib = require('zlib');

var DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';
var MAX_REDIRECTS = 6;

function explain(err) {
  var c = err && err.code;
  var msg = (err && err.message) || String(err);
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Server nicht gefunden (Namensaufloesung fehlgeschlagen).';
  if (c === 'ECONNREFUSED') return 'Verbindung abgelehnt (Server nicht erreichbar oder falscher Port).';
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || c === 'ETIMEOUT') return 'Zeitueberschreitung beim Verbinden.';
  if (c === 'ECONNRESET') return 'Verbindung vom Server getrennt.';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'Server im Netzwerk nicht erreichbar.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|LEAF_SIGNATURE|ISSUER/i.test(String(c) + ' ' + msg)) {
    return 'Zertifikat nicht akzeptiert (' + (c || msg) + '). Die Option "Zertifikate nicht pruefen" kann helfen.';
  }
  return msg;
}

function httpStatusText(code) {
  if (code === 401) return 'Anmeldung abgelehnt (HTTP 401) - Zugangsdaten pruefen.';
  if (code === 403) return 'Zugriff verweigert (HTTP 403) - evtl. ist ein anderer User-Agent noetig.';
  if (code === 404) return 'Nicht gefunden (HTTP 404).';
  if (code === 429) return 'Zu viele Anfragen (HTTP 429).';
  if (code >= 500) return 'Serverfehler (HTTP ' + code + ').';
  return 'Unerwartete Antwort (HTTP ' + code + ').';
}

// opts: { headers, ua, referrer, insecure, timeout, method, range, gzip }
// cb(err, res, finalUrl, req)   res = IncomingMessage (nicht entpackt)
function open(target, opts, cb) {
  opts = opts || {};
  var redirects = 0;
  var finished = false;
  var current = null;

  function done(err, res, finalUrl) {
    if (finished) return;
    finished = true;
    cb(err, res, finalUrl, current);
  }

  function go(u) {
    var p;
    try { p = url.parse(u); } catch (e) { return done(new Error('Ungueltige Adresse')); }
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return done(new Error('Nur http:// und https:// werden unterstuetzt.'));
    if (!p.hostname) return done(new Error('Ungueltige Adresse'));

    var headers = {
      'User-Agent': opts.ua || DEFAULT_UA,
      'Accept': '*/*',
      'Connection': 'close'
    };
    if (opts.gzip) headers['Accept-Encoding'] = 'gzip';
    if (opts.referrer) headers['Referer'] = opts.referrer;
    if (opts.range) headers['Range'] = opts.range;
    var k;
    if (opts.headers) for (k in opts.headers) if (opts.headers.hasOwnProperty(k)) headers[k] = opts.headers[k];

    var o = {
      protocol: p.protocol,
      hostname: p.hostname,
      port: p.port ? parseInt(p.port, 10) : (p.protocol === 'https:' ? 443 : 80),
      path: p.path || '/',
      method: opts.method || 'GET',
      headers: headers,
      agent: false
    };
    if (p.auth) o.auth = p.auth;
    if (p.protocol === 'https:' && opts.insecure) o.rejectUnauthorized = false;

    var req = (p.protocol === 'https:' ? https : http).request(o, function (res) {
      var code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (++redirects > MAX_REDIRECTS) return done(new Error('Zu viele Weiterleitungen.'));
        return go(url.resolve(u, res.headers.location));
      }
      req.setTimeout(0);   // ab hier darf ein Live-Stream beliebig lange laufen
      done(null, res, u);
    });
    current = req;
    req.setTimeout(opts.timeout || 20000, function () {
      var e = new Error('Zeitueberschreitung');
      e.code = 'ETIMEDOUT';
      req.abort();
      done(e);
    });
    req.on('error', function (err) { done(err); });
    req.end();
  }

  go(target);
}

// Antwort komplett einsammeln (mit Groessenlimit), gzip entpacken. cb(err, buffer, finalUrl)
function fetchBuffer(target, opts, cb) {
  opts = opts || {};
  var maxBytes = opts.maxBytes || 64 * 1024 * 1024;
  var o = {};
  var k;
  for (k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
  o.gzip = true;
  var called = false;
  function finish(err, buf, finalUrl) { if (called) return; called = true; cb(err, buf, finalUrl); }

  open(target, o, function (err, res, finalUrl, req) {
    if (err) return finish(new Error(explain(err)));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      return finish(new Error(httpStatusText(res.statusCode)));
    }
    var parts = [];
    var size = 0;
    var head = null;
    var gunzip = null;

    function onData(d) {
      size += d.length;
      if (size > maxBytes) {
        req.abort();
        return finish(new Error('Die Datei ist zu gross (mehr als ' + Math.round(maxBytes / 1048576) + ' MB).'));
      }
      parts.push(d);
    }
    function onEnd() { finish(null, Buffer.concat(parts), finalUrl); }
    function onErr(e) { finish(new Error(explain(e))); }

    res.on('error', onErr);
    // gzip: laut Header oder an den Magic Bytes (viele EPG-Quellen liefern .xml.gz ohne Header)
    res.on('data', function sniff(d) {
      if (head === null) {
        head = true;
        var gz = /gzip/i.test(res.headers['content-encoding'] || '') || (d.length > 1 && d[0] === 0x1f && d[1] === 0x8b);
        if (gz) {
          gunzip = zlib.createGunzip();
          gunzip.on('data', onData);
          gunzip.on('end', onEnd);
          gunzip.on('error', function () { finish(new Error('Entpacken (gzip) fehlgeschlagen.')); });
        }
      }
      if (gunzip) gunzip.write(d); else onData(d);
    });
    res.on('end', function () { if (gunzip) gunzip.end(); else onEnd(); });
  });
}

module.exports = { open: open, fetchBuffer: fetchBuffer, explain: explain, httpStatusText: httpStatusText, DEFAULT_UA: DEFAULT_UA };
