'use strict';
// Entwicklungshilfe: simuliert einen IPTV-Anbieter (Playlist, EPG, Logos, MP4-Streams) fuer Tests im Browser.
//   node test/dev-upstream.js [Port] [Pfad-zu-test.mp4]
var http = require('http');
var fs = require('fs');

var port = parseInt(process.argv[2], 10) || 18080;
var mp4Path = process.argv[3] || '';
var video = mp4Path ? fs.readFileSync(mp4Path) : new Buffer(0);

var GROUPS = [['Nachrichten', 8], ['Sport', 12], ['Kino', 20], ['Kinder', 10], ['Musik', 10]];
var NAMES = {
  Nachrichten: ['Tagesblick', 'Welt Aktuell', 'News 24', 'Info Kanal', 'Region Nord', 'Region Sued', 'Euro News', 'Wetter TV'],
  Sport: ['Sport Live', 'Fussball 1', 'Fussball 2', 'Tennis HD', 'Formel Eins', 'Handball', 'Golf Kanal', 'Box Arena', 'Ski Alpin', 'Rad Tour', 'Basket', 'Eishockey'],
  Kino: [], Kinder: [], Musik: []
};

function pad(n) { return (n < 10 ? '0' : '') + n; }
function xt(sec) {
  var d = new Date(sec * 1000);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + ' +0000';
}

var channels = [];
var num = 0;
GROUPS.forEach(function (g) {
  for (var i = 0; i < g[1]; i++) {
    num++;
    var nm = NAMES[g[0]][i] || (g[0] + ' ' + (i + 1));
    channels.push({ n: num, id: 'ch' + num, name: nm, group: g[0] });
  }
});
channels.push({ n: ++num, id: 'ch' + num, name: 'Defekter Sender', group: 'Kino', dead: true });
channels.push({ n: ++num, id: 'ch' + num, name: 'Nur mit User-Agent', group: 'Kino', needUa: true });

function playlist() {
  var base = 'http://127.0.0.1:' + port;
  var out = ['#EXTM3U url-tvg="' + base + '/epg.xml"'];
  channels.forEach(function (c) {
    out.push('#EXTINF:-1 tvg-id="' + c.id + '" tvg-name="' + c.name + '" tvg-logo="' + base + '/logo/' + c.n + '.svg" group-title="' + c.group + '",' + c.name);
    if (c.needUa) { out.push('#EXTVLCOPT:http-user-agent=DevAgent/1.0'); out.push(base + '/ua/' + c.n + '.mp4'); }
    else if (c.dead) out.push('http://127.0.0.1:1/dead.ts');
    else out.push(base + '/v/' + c.n + '.mp4');
  });
  return out.join('\n') + '\n';
}

function epg() {
  var now = Math.floor(Date.now() / 1000);
  var start = now - (now % 7200) - 7200;
  var x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  var shows = ['Morgenmagazin', 'Spielfilm: Die lange Nacht', 'Doku: Berge & Taeler', 'Das grosse Quiz', 'Nachrichten', 'Live-Uebertragung', 'Serie: Neues vom Land', 'Konzertabend'];
  channels.forEach(function (c) {
    x += '<channel id="' + c.id + '"><display-name>' + c.name + '</display-name></channel>\n';
    for (var k = 0; k < 8; k++) {
      var s = start + k * 7200 + (c.n % 4) * 900;
      x += '<programme start="' + xt(s) + '" stop="' + xt(s + 7200) + '" channel="' + c.id + '"><title>' + shows[(k + c.n) % shows.length] + '</title><desc>Beschreibung der Sendung auf ' + c.name + '. Ein laengerer Text, der zeigt, wie die Detailansicht mehrere Zeilen darstellt, ohne dass etwas abgeschnitten wird oder aus dem Bild laeuft.</desc></programme>\n';
    }
  });
  return x + '</tv>\n';
}

http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  console.log(req.method, req.url, req.headers['user-agent'] || '');
  var m;
  if (u === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(playlist()); }
  if (u === '/epg.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(epg()); }
  if ((m = /^\/logo\/(\d+)\.svg$/.exec(u))) {
    var hue = (parseInt(m[1], 10) * 47) % 360;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="152" height="104"><rect width="152" height="104" rx="14" fill="hsl(' + hue + ',55%,38%)"/><text x="76" y="68" font-size="52" font-family="Arial" text-anchor="middle" fill="#fff">' + m[1] + '</text></svg>');
  }
  if ((m = /^\/(v|ua)\/(\d+)\.mp4$/.exec(u))) {
    if (m[1] === 'ua' && req.headers['user-agent'] !== 'DevAgent/1.0') { res.writeHead(403); return res.end('UA'); }
    var r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (r) {
      var s = r[1] === '' ? 0 : parseInt(r[1], 10), e = r[2] === '' ? video.length - 1 : Math.min(parseInt(r[2], 10), video.length - 1);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + s + '-' + e + '/' + video.length, 'Content-Length': e - s + 1 });
      return res.end(video.slice(s, e + 1));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': video.length });
    return res.end(video);
  }
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1', function () { console.log('Test-Anbieter auf http://127.0.0.1:' + port + '/list.m3u'); });
