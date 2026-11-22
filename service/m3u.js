'use strict';
// M3U/M3U8-Playlisten einlesen (IPTV: #EXTINF mit tvg-*-Attributen, #EXTGRP, #EXTVLCOPT, Kodi-Header per "|").
var crypto = require('crypto');

var NO_GROUP = 'Ohne Gruppe';

function parseAttrs(s) {
  var out = {};
  var re = /([A-Za-z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s",]+))/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

// "#EXTINF:-1 tvg-id="x" group-title="A,B",Name" -> Attribute und Name trennen.
// Das erste Komma ausserhalb von Anfuehrungszeichen trennt Attribute und Anzeigename.
function splitExtinf(line) {
  var rest = line.substring(line.indexOf(':') + 1);
  var inQuote = '';
  var comma = -1;
  for (var i = 0; i < rest.length; i++) {
    var c = rest.charAt(i);
    if (inQuote) {
      if (c === inQuote) inQuote = '';
    } else if (c === '"' || c === "'") {
      // Nur als Anfuehrungszeichen werten, wenn davor ein "=" steht
      var j = i - 1;
      while (j >= 0 && rest.charAt(j) === ' ') j--;
      if (j >= 0 && rest.charAt(j) === '=') inQuote = c;
    } else if (c === ',') {
      comma = i;
      break;
    }
  }
  var head = comma < 0 ? rest : rest.substring(0, comma);
  var name = comma < 0 ? '' : rest.substring(comma + 1);
  return { head: head, name: name.replace(/^\s+|\s+$/g, '') };
}

// Kodi-Stil: http://host/stream.ts|User-Agent=Foo&Referer=http://x
function splitUrlHeaders(u) {
  var out = { url: u, ua: '', referrer: '' };
  var bar = u.indexOf('|');
  if (bar < 0 || !/^https?:\/\//i.test(u)) return out;
  var tail = u.substring(bar + 1);
  if (!/^[A-Za-z-]+=/.test(tail)) return out;
  out.url = u.substring(0, bar);
  var pairs = tail.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    var k = pairs[i].substring(0, eq).toLowerCase();
    var v = pairs[i].substring(eq + 1);
    try { v = decodeURIComponent(v); } catch (e) { /* unveraendert lassen */ }
    if (k === 'user-agent') out.ua = v;
    else if (k === 'referer' || k === 'referrer') out.referrer = v;
  }
  return out;
}

function nameFromUrl(u) {
  var m = /([^\/?#]+)(?:[?#].*)?$/.exec(u);
  return m ? m[1] : u;
}

function idFor(playlistId, key, seen) {
  var base = crypto.createHash('sha1').update(playlistId + '|' + key).digest('hex').substring(0, 10);
  var n = seen[base] = (seen[base] || 0) + 1;
  return n === 1 ? base : base + '-' + n;
}

// Rueckgabe: { channels: [...], groups: [{name,count}], epgUrl: '' }
function parse(text, playlistId) {
  text = String(text || '').replace(/^﻿/, '');
  var lines = text.split(/\r\n|\n|\r/);
  var channels = [];
  var groupIndex = {};
  var groups = [];
  var seenIds = {};
  var epgUrl = '';
  var cur = null;          // Daten des letzten #EXTINF, wartet auf die URL
  var extGroup = '';
  var i, line;

  for (i = 0; i < lines.length; i++) {
    line = lines[i].replace(/^\s+|\s+$/g, '');
    if (!line) continue;

    if (line.charAt(0) === '#') {
      if (line.substring(0, 7) === '#EXTM3U') {
        var ha = parseAttrs(line);
        if (!epgUrl) epgUrl = ha['url-tvg'] || ha['x-tvg-url'] || ha['tvg-url'] || '';
      } else if (line.substring(0, 8).toUpperCase() === '#EXTINF:') {
        var sp = splitExtinf(line);
        var at = parseAttrs(sp.head);
        cur = {
          name: sp.name || at['tvg-name'] || '',
          group: at['group-title'] || '',
          logo: at['tvg-logo'] || at['logo'] || '',
          tvgId: at['tvg-id'] || '',
          tvgName: at['tvg-name'] || '',
          chno: at['tvg-chno'] || at['channel-number'] || '',
          ua: '',
          referrer: ''
        };
      } else if (line.substring(0, 8).toUpperCase() === '#EXTGRP:') {
        extGroup = line.substring(8).replace(/^\s+|\s+$/g, '');
      } else if (line.substring(0, 11).toUpperCase() === '#EXTVLCOPT:') {
        var opt = line.substring(11);
        var eq = opt.indexOf('=');
        if (eq > 0 && cur) {
          var k = opt.substring(0, eq).toLowerCase();
          var v = opt.substring(eq + 1).replace(/^\s+|\s+$/g, '');
          if (k === 'http-user-agent') cur.ua = v;
          else if (k === 'http-referrer' || k === 'http-referer') cur.referrer = v;
        }
      }
      continue;
    }

    // Stream-Adresse
    var h = splitUrlHeaders(line);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(h.url)) { cur = null; continue; }   // keine Adresse (z. B. relative Pfade)
    var c = cur || { name: '', group: '', logo: '', tvgId: '', tvgName: '', chno: '', ua: '', referrer: '' };
    cur = null;
    var group = c.group || extGroup || NO_GROUP;
    var name = c.name || nameFromUrl(h.url);
    var ch = {
      id: idFor(playlistId, (c.tvgId || name) + '|' + group, seenIds),
      name: name,
      group: group,
      logo: c.logo,
      tvgId: c.tvgId,
      tvgName: c.tvgName,
      chno: c.chno,
      url: h.url,
      ua: c.ua || h.ua,
      referrer: c.referrer || h.referrer
    };
    channels.push(ch);
    var gi = groupIndex[group];
    if (gi === undefined) {
      gi = groupIndex[group] = groups.length;
      groups.push({ name: group, count: 0 });
    }
    groups[gi].count++;
  }
  return { channels: channels, groups: groups, epgUrl: epgUrl };
}

module.exports = { parse: parse, parseAttrs: parseAttrs, splitExtinf: splitExtinf, NO_GROUP: NO_GROUP };
