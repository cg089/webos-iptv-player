'use strict';
// Entwicklungshilfe: liefert die TV-App im Browser aus (http://localhost:18090/) und leitet /api und /p an den Dienst weiter.
//   node test/dev-app-server.js [Port] [Dienst-Port]
var http = require('http');
var fs = require('fs');
var path = require('path');
var port = parseInt(process.argv[2], 10) || 18090;
var svc = parseInt(process.argv[3], 10) || 8766;
var root = path.join(__dirname, '..', 'app');
var types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };

http.createServer(function (req, res) {
  if (/^\/(api|p)\//.test(req.url)) {
    var h = {};
    for (var k in req.headers) if (k !== 'host' && k !== 'origin') h[k] = req.headers[k];
    var up = http.request({ host: '127.0.0.1', port: svc, method: req.method, path: req.url, headers: h }, function (r) {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', function () { res.writeHead(502); res.end(); });
    req.pipe(up);
    res.on('close', function () { up.abort(); });
    return;
  }
  var p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(root, p), function (err, data) {
    if (err) { res.writeHead(404); return res.end(); }
    if (p === '/js/app.js') data = new Buffer(data.toString('utf8').replace("'http://127.0.0.1:' + DEFAULT_PORT", 'location.origin'), 'utf8');
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', function () { console.log('App auf http://localhost:' + port + '/'); });
