'use strict';
// Programmfuehrer (XMLTV): wird als Strom eingelesen, damit auch grosse Dateien (100 MB+) auf dem TV
// nicht den Speicher sprengen. Behalten werden nur Sender, die in den Playlisten vorkommen, und nur
// Sendungen von kurz vor jetzt bis ca. 36 Stunden voraus.
var zlib = require('zlib');
var fetcher = require('./fetcher');
var enigma2 = require('./enigma2');

var KEEP_BEFORE = 3 * 3600;       // Sekunden
var KEEP_AFTER = 36 * 3600;
var MAX_PROGRAMMES = 300000;

var index = { byId: {}, nameToId: {}, lowerToId: {} };
var status = { urls: [], loadedAt: 0, loading: false, channels: 0, programmes: 0, error: '' };
var e2index = {};          // Enigma2: "Box|Service-Referenz" -> Sendungen

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u00e4\u00f6\u00fc\u00df]+/g, '');
}

function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (m, e) {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    var code = e.charAt(1) === 'x' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCharCode(code > 0xffff ? 0xfffd : code) : '';
  });
}

// "20260101123000 +0100" -> Sekunden seit 1970 (oder 0)
function parseTime(s) {
  var m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4}|Z)?\s*$/.exec(s || '');
  if (!m) return 0;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7] && m[7] !== 'Z') {
    var sign = m[7].charAt(0) === '-' ? -1 : 1;
    var off = sign * (parseInt(m[7].substring(1, 3), 10) * 3600 + parseInt(m[7].substring(3, 5), 10) * 60);
    t -= off;
  }
  return t;
}

function attr(tag, name) {
  var m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag);
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2]) : '';
}

function inner(block, name) {
  var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(block);
  return m ? decodeEntities(m[1]).replace(/^\s+|\s+$/g, '') : '';
}

// Streaming-Parser. wanted = { ids: {kleingeschriebene tvg-id: true}, names: {normalisierter Name: true} }
function Parser(wanted, target, nowSec) {
  this.wanted = wanted;
  this.target = target;          // { byId, nameToId, lowerToId }
  this.now = nowSec;
  this.buf = '';
  this.wantedEpg = {};           // XMLTV-Kanal-ID -> true
  this.count = 0;
  this.channels = 0;
  this.sawChannelTags = false;
}

Parser.prototype.write = function (chunk) {
  this.buf += chunk;
  var re = /<(programme|channel)(?=[\s>\/])/;
  for (;;) {
    var m = re.exec(this.buf);
    if (!m) {
      // Rest behalten, falls ein Tag-Anfang an der Chunk-Grenze liegt
      if (this.buf.length > 16) this.buf = this.buf.substring(this.buf.length - 16);
      return;
    }
    if (m.index > 0) this.buf = this.buf.substring(m.index);
    var kind = m[1];
    var endTag = '</' + kind + '>';
    var open = this.buf.substring(0, this.buf.indexOf('>') + 1);
    var end, block;
    if (open.length > 1 && open.charAt(open.length - 2) === '/') {        // <tag ... />
      block = open;
      end = open.length;
    } else {
      end = this.buf.indexOf(endTag);
      if (end < 0) {
        if (this.buf.length > 2000000) this.buf = this.buf.substring(1);   // kaputtes Element ueberspringen
        return;
      }
      end += endTag.length;
      block = this.buf.substring(0, end);
    }
    this.buf = this.buf.substring(end);
    if (kind === 'channel') this.channel(block); else this.programme(block);
  }
};

Parser.prototype.channel = function (block) {
  this.sawChannelTags = true;
  var id = attr(block.substring(0, block.indexOf('>') + 1), 'id');
  if (!id) return;
  var names = [];
  var re = /<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/g;
  var m;
  while ((m = re.exec(block)) !== null) names.push(decodeEntities(m[1]));
  var hit = !!this.wanted.ids[id.toLowerCase()];
  var i;
  for (i = 0; i < names.length && !hit; i++) if (this.wanted.names[normName(names[i])]) hit = true;
  if (!hit) return;
  this.wantedEpg[id] = true;
  this.target.lowerToId[id.toLowerCase()] = id;
  this.channels++;
  for (i = 0; i < names.length; i++) {
    var n = normName(names[i]);
    if (n && !this.target.nameToId[n]) this.target.nameToId[n] = id;
  }
};

Parser.prototype.programme = function (block) {
  if (this.count >= MAX_PROGRAMMES) return;
  var open = block.substring(0, block.indexOf('>') + 1);
  var chan = attr(open, 'channel');
  if (!chan) return;
  if (this.sawChannelTags ? !this.wantedEpg[chan] : !this.wanted.ids[chan.toLowerCase()]) return;
  var s = parseTime(attr(open, 'start'));
  var e = parseTime(attr(open, 'stop'));
  if (!s) return;
  if (!e || e <= s) e = s + 1800;
  if (e < this.now - KEEP_BEFORE || s > this.now + KEEP_AFTER) return;
  var t = inner(block, 'title');
  if (!t) return;
  var d = inner(block, 'desc');
  var list = this.target.byId[chan];
  if (!list) {
    list = this.target.byId[chan] = [];
    this.target.lowerToId[chan.toLowerCase()] = chan;
  }
  list.push({ s: s, e: e, t: t.substring(0, 160), d: d.substring(0, 900) });
  this.count++;
};

function loadOne(target, urlStr, wanted, opts, nowSec, cb) {
  var parser = new Parser(wanted, target, nowSec);
  var called = false;
  function finish(err) {
    if (called) return;
    called = true;
    cb(err, parser);
  }
  fetcher.open(urlStr, { insecure: opts.insecure, timeout: 30000, gzip: true, ua: opts.ua }, function (err, res, finalUrl, req) {
    if (err) return finish(new Error(fetcher.explain(err)));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      return finish(new Error(fetcher.httpStatusText(res.statusCode)));
    }
    var src = null;
    var first = true;
    res.on('error', function (e) { finish(new Error(fetcher.explain(e))); });
    res.on('data', function (d) {
      if (first) {
        first = false;
        var gz = /gzip/i.test(res.headers['content-encoding'] || '') || (d.length > 1 && d[0] === 0x1f && d[1] === 0x8b);
        if (gz) {
          src = zlib.createGunzip();
          src.setEncoding('utf8');
          src.on('data', function (s) { parser.write(s); });
          src.on('end', function () { finish(null); });
          src.on('error', function () { finish(new Error('Entpacken (gzip) fehlgeschlagen.')); });
        } else {
          src = { decoder: new (require('string_decoder').StringDecoder)('utf8') };
        }
      }
      if (src.write) {
        // Gegendruck: bei langsamem Entpacken/Parsen den Download anhalten
        if (src.write(d) === false) {
          res.pause();
          src.once('drain', function () { res.resume(); });
        }
      } else {
        parser.write(src.decoder.write(d));
      }
    });
    res.on('end', function () {
      if (src && src.end) src.end(); else finish(null);
    });
  });
}

// urls: Liste von XMLTV-Adressen; channels: alle Sender der Playlisten.
// Zusaetzlich werden fuer Enigma2-Sender (Stream-Adresse mit Service-Referenz) die Daten der Box per OpenWebif geholt.
function load(urls, channels, opts, cb) {
  opts = opts || {};
  if (status.loading) return cb && cb(new Error('EPG wird bereits geladen.'));
  var jobs = enigma2.collect(channels);
  if (!urls.length && !jobs.length) {
    index = { byId: {}, nameToId: {}, lowerToId: {} };
    e2index = {};
    status = { urls: [], loadedAt: 0, loading: false, channels: 0, programmes: 0, error: '' };
    return cb && cb(null, status);
  }
  var wanted = { ids: {}, names: {} };
  var i;
  for (i = 0; i < channels.length; i++) {
    var c = channels[i];
    if (c.tvgId) wanted.ids[c.tvgId.toLowerCase()] = true;
    var n1 = normName(c.name), n2 = normName(c.tvgName);
    if (n1) wanted.names[n1] = true;
    if (n2) wanted.names[n2] = true;
  }
  status.loading = true;
  var shown = urls.slice();
  var bases = {};
  for (i = 0; i < jobs.length; i++) bases[jobs[i].base.replace(/^(https?:\/\/)[^@\/]*@/, '$1')] = true;
  for (var b in bases) if (bases.hasOwnProperty(b)) shown.push('OpenWebif ' + b);
  status.urls = shown;
  var target = { byId: {}, nameToId: {}, lowerToId: {} };
  var nowSec = Math.floor(new Date().getTime() / 1000);
  var errors = [];
  var total = 0, chans = 0;
  var pos = 0;

  function next() {
    if (pos >= urls.length) return runEnigma2();
    var u = urls[pos++];
    loadOne(target, u, wanted, opts, nowSec, function (err, parser) {
      if (err) errors.push(u + ': ' + err.message);
      else { total += parser.count; chans += parser.channels; }
      next();
    });
  }

  function runEnigma2() {
    if (!jobs.length) return end(null);
    enigma2.fetchAll(jobs, { insecure: opts.insecure }, function (r) {
      for (var k = 0; k < r.errors.length; k++) errors.push(r.errors[k]);
      end(r);
    });
  }

  function end(e2result) {
    var id;
    for (id in target.byId) {
      if (target.byId.hasOwnProperty(id)) target.byId[id].sort(function (a, b2) { return a.s - b2.s; });
    }
    var e2total = e2result ? e2result.programmes : 0;
    if (total > 0 || e2total > 0 || !errors.length) {     // bei komplettem Fehlschlag den alten Stand behalten
      index = target;
      e2index = e2result ? e2result.map : {};
    }
    status.loading = false;
    status.loadedAt = new Date().getTime();
    status.channels = chans + (e2result ? e2result.channels : 0);
    status.programmes = total + e2total;
    status.error = errors.join(' | ');
    if (cb) cb(errors.length && !status.programmes ? new Error(status.error) : null, status);
  }
  next();
}

// Sendungsliste eines Senders: Enigma2-Daten der Box, sonst XMLTV
function listFor(ch) {
  if (ch.e2b && ch.e2r) {
    var l = e2index[enigma2.key(ch.e2b, ch.e2r)];
    if (l) return l;
  }
  if (ch.tvgId) {
    var id = index.lowerToId[ch.tvgId.toLowerCase()];
    if (id && index.byId[id]) return index.byId[id];
  }
  var n = normName(ch.name);
  if (n && index.nameToId[n] && index.byId[index.nameToId[n]]) return index.byId[index.nameToId[n]];
  n = normName(ch.tvgName);
  if (n && index.nameToId[n] && index.byId[index.nameToId[n]]) return index.byId[index.nameToId[n]];
  return null;
}

// Aktuelle und naechste Sendung. Rueckgabe: { now: {t,s,e,d}|null, next: {...}|null }
function nowNext(ch, nowSec) {
  var list = listFor(ch);
  if (!list) return { now: null, next: null };
  nowSec = nowSec || Math.floor(new Date().getTime() / 1000);
  for (var i = 0; i < list.length; i++) {
    if (list[i].e > nowSec) {
      if (list[i].s <= nowSec) return { now: list[i], next: list[i + 1] || null };
      return { now: null, next: list[i] };
    }
  }
  return { now: null, next: null };
}

function upcoming(ch, count, nowSec) {
  var list = listFor(ch);
  if (!list) return [];
  nowSec = nowSec || Math.floor(new Date().getTime() / 1000);
  var out = [];
  for (var i = 0; i < list.length && out.length < count; i++) {
    if (list[i].e > nowSec) out.push(list[i]);
  }
  return out;
}

module.exports = {
  load: load,
  nowNext: nowNext,
  upcoming: upcoming,
  status: function () { return status; },
  parseTime: parseTime,
  Parser: Parser,
  normName: normName
};
