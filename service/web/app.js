'use strict';
// Konfigurations-Weboberflaeche. Alle dynamischen Inhalte per textContent (kein innerHTML).

function $(id) { return document.getElementById(id); }

function api(method, url, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'Ungültige Antwort (HTTP ' + r.status + ')' }; });
  });
}

function show(el, kind, text) {
  el.hidden = false;
  el.className = 'result ' + kind;
  el.textContent = text;
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ago(ms) {
  if (!ms) return 'noch nie';
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'gerade eben';
  if (s < 5400) return 'vor ' + Math.round(s / 60) + ' Min.';
  if (s < 172800) return 'vor ' + Math.round(s / 3600) + ' Std.';
  return 'vor ' + Math.round(s / 86400) + ' Tagen';
}

function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return u; }
}

// ---------------------------------------------------------------- Status und Einstellungen
var lastInfo = null;
var settingsLoaded = false;
var epgPoll = null;

function epgText(e) {
  if (!e) return '';
  if (e.loading) return 'EPG wird geladen …';
  if (!e.urls || !e.urls.length) return 'EPG: keine Quelle (Adresse eintragen oder eine Playlist mit url-tvg verwenden).';
  var t = 'EPG: ' + e.programmes + ' Sendungen für ' + e.channels + ' Sender, geladen ' + ago(e.loadedAt) + '.';
  if (e.error) t += ' Fehler: ' + e.error;
  return t;
}

function loadInfo() {
  return api('GET', '/api/info').then(function (i) {
    lastInfo = i;
    var dl = $('info');
    dl.textContent = '';
    function row(k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    var urls = (i.ips || []).map(function (ip) { return 'http://' + ip + ':' + i.port + '/'; });
    row('Adresse dieser Seite', urls.length ? urls.join('  ·  ') : location.host);
    row('Version', i.version + ' (Node ' + i.node + ', ' + i.platform + ')');
    row('Konfiguration', i.configFile);
    row('Zugriffsschutz', i.hasAdminPassword ? 'aktiv' : 'aus');
    row('Programmführer', epgText(i.epg).replace(/^EPG: ?/, '') || '–');
    $('epgStatus').textContent = epgText(i.epg);
    if (!settingsLoaded && i.settings) fillSettings(i.settings);
    return i;
  }).catch(function () {
    $('info').textContent = 'Status nicht verfügbar.';
  });
}

function fillSettings(s) {
  settingsLoaded = true;
  $('s_epg').value = s.epgUrl || '';
  $('s_hours').value = s.refreshHours;
  $('s_proxy').value = s.proxy;
  $('s_autoplay').checked = !!s.autoplayLast;
  $('s_logos').checked = !!s.showLogos;
  $('s_buffer').value = String(s.bufferMb || 0);
}

$('btnSettings').onclick = function () {
  api('POST', '/api/settings', {
    epgUrl: $('s_epg').value,
    refreshHours: $('s_hours').value,
    proxy: $('s_proxy').value,
    autoplayLast: $('s_autoplay').checked,
    showLogos: $('s_logos').checked,
    bufferMb: $('s_buffer').value
  }).then(function (r) {
    if (!r.ok) return show($('settingsResult'), 'err', r.error || 'Speichern fehlgeschlagen');
    show($('settingsResult'), 'ok', 'Einstellungen gespeichert.');
    setTimeout(loadInfo, 600);
  });
};

function pollEpg() {
  clearInterval(epgPoll);
  epgPoll = setInterval(function () {
    loadInfo().then(function (i) {
      if (i && i.epg && !i.epg.loading) { clearInterval(epgPoll); loadPlaylists(); }
    });
  }, 1500);
}

$('btnEpg').onclick = function () {
  api('POST', '/api/epg/refresh', {}).then(function (r) {
    if (!r.ok) return show($('settingsResult'), 'err', r.error || 'Fehlgeschlagen');
    $('epgStatus').textContent = 'EPG wird geladen …';
    pollEpg();
  });
};

// ---------------------------------------------------------------- Playlisten
var playlists = [];

function renderList() {
  var ul = $('plList');
  ul.textContent = '';
  $('emptyHint').hidden = playlists.length > 0;
  playlists.forEach(function (p) {
    var li = el('li');
    var left = el('div');
    left.appendChild(el('div', 'title', p.name));
    var src = p.type === 'file' ? 'hochgeladene Datei' : (p.type === 'enigma2' ? 'Enigma2-Receiver ' + hostOf(p.url) : hostOf(p.url));
    var line = src + '  ·  ' + p.count + ' Sender in ' + p.groups + ' Gruppen  ·  aktualisiert ' + ago(p.fetchedAt);
    if (p.hiddenCount) line += '  ·  ' + p.hiddenCount + ' Gruppen ausgeblendet';
    left.appendChild(el('div', 'detail', line));
    if (p.error) left.appendChild(el('div', 'detail err', p.error));
    li.appendChild(left);

    var actions = el('div', 'actions');
    var refresh = el('button', null, 'Aktualisieren');
    refresh.onclick = function () {
      refresh.disabled = true;
      refresh.textContent = 'Lade …';
      api('POST', '/api/playlists/' + encodeURIComponent(p.id) + '/refresh', {}).then(function () { loadPlaylists(); });
    };
    var groups = el('button', null, p.type === 'enigma2' ? 'Bouquets' : 'Gruppen');
    groups.onclick = function () { openGroups(p); };
    var edit = el('button', null, 'Bearbeiten');
    edit.onclick = function () { openForm(p); };
    var del = el('button', 'danger', 'Löschen');
    del.onclick = function () {
      if (!confirm('Playlist „' + p.name + '“ wirklich löschen?')) return;
      api('DELETE', '/api/playlists/' + encodeURIComponent(p.id)).then(loadPlaylists);
    };
    actions.appendChild(refresh);
    actions.appendChild(groups);
    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

function loadPlaylists() {
  return api('GET', '/api/playlists').then(function (r) {
    playlists = r.playlists || [];
    renderList();
    loadInfo();
  });
}

$('btnRefreshAll').onclick = function () {
  var b = $('btnRefreshAll');
  b.disabled = true;
  b.textContent = 'Lade …';
  api('POST', '/api/library/refresh', {}).then(function () {
    b.disabled = false;
    b.textContent = 'Alle aktualisieren';
    loadPlaylists();
  });
};

// ---------------------------------------------------------------- Formular
var uploadContent = '';
var uploadName = '';

function syncType() {
  var t = $('f_type').value;
  var file = t === 'file';
  var e2 = t === 'enigma2';
  $('rowUrl').hidden = file;
  $('rowFile').hidden = !file;
  $('fileHint').hidden = !file;
  $('rowE2').hidden = !e2;
  $('urlLabel').textContent = e2 ? 'Adresse der Box (OpenWebif) *' : 'Adresse der Playlist *';
  $('f_url').placeholder = e2 ? 'http://192.168.1.5   (mit Anmeldung: http://root:passwort@192.168.1.5)' : 'http://anbieter.example/get.php?username=…&password=…&type=m3u_plus';
  // Optionen, die nur für M3U-Adressen gelten
  $('rowUa').hidden = e2;
  $('rowOwif').hidden = e2;
  $('rowOwifOff').hidden = e2;
  $('rowProxy').hidden = e2;
  $('rowInsecure').hidden = e2;
}
$('f_type').onchange = syncType;

$('f_file').onchange = function () {
  var f = this.files && this.files[0];
  uploadContent = '';
  uploadName = '';
  if (!f) { $('fileHint').textContent = ''; return; }
  if (f.size > 38 * 1024 * 1024) {
    $('fileHint').textContent = 'Die Datei ist zu groß (maximal 38 MB).';
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    uploadContent = String(reader.result || '');
    uploadName = f.name;
    $('fileHint').textContent = f.name + ' gelesen (' + Math.round(f.size / 1024) + ' KB).';
    if (!$('f_name').value) $('f_name').value = f.name.replace(/\.[^.]+$/, '');
  };
  reader.onerror = function () { $('fileHint').textContent = 'Datei konnte nicht gelesen werden.'; };
  reader.readAsText(f);
};

function openForm(p) {
  p = p || {};
  uploadContent = '';
  uploadName = '';
  $('formTitle').textContent = p.id ? 'Playlist bearbeiten' : 'Playlist hinzufügen';
  $('f_id').value = p.id || '';
  $('f_name').value = p.name || '';
  $('f_type').value = p.type || 'url';
  $('f_url').value = p.url || '';
  $('f_file').value = '';
  $('f_ua').value = p.ua || '';
  $('f_owif').value = p.owifUrl || '';
  $('f_owifoff').checked = !!p.owifOff;
  $('f_e2port').value = p.e2Port && p.e2Port !== 8001 ? p.e2Port : '';
  $('f_e2auth').checked = !!p.e2Auth;
  $('f_proxy').checked = !!p.proxyStreams;
  $('f_insecure').checked = !!p.insecureTls;
  $('fileHint').textContent = p.id && p.type === 'file' ? 'Ohne neue Datei bleibt die bisherige erhalten.' : '';
  syncType();
  $('result').hidden = true;
  $('formCard').hidden = false;
  $('formCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  (p.type === 'file' ? $('f_name') : $('f_url')).focus();
}

function closeForm() { $('formCard').hidden = true; }

function formData() {
  var d = {
    id: $('f_id').value || undefined,
    name: $('f_name').value,
    type: $('f_type').value,
    url: $('f_url').value,
    ua: $('f_ua').value,
    owifUrl: $('f_owif').value,
    owifOff: $('f_owifoff').checked,
    e2Port: $('f_e2port').value,
    e2Auth: $('f_e2auth').checked,
    proxyStreams: $('f_proxy').checked,
    insecureTls: $('f_insecure').checked
  };
  if (d.type === 'file' && uploadContent) d.content = uploadContent;
  return d;
}

$('btnNew').onclick = function () { openForm(); };
$('btnCancel').onclick = closeForm;

$('btnTest').onclick = function () {
  var btn = $('btnTest');
  btn.disabled = true;
  btn.textContent = 'Teste …';
  api('POST', '/api/test', formData()).then(function (r) {
    if (r.ok) show($('result'), 'ok', r.message + (r.sample && r.sample.length ? '  Beispiele: ' + r.sample.join(', ') + ' …' : '') + (r.epgUrl ? '  EPG-Adresse in der Playlist gefunden.' : ''));
    else show($('result'), 'err', r.error || 'Test fehlgeschlagen');
  }).catch(function (e) {
    show($('result'), 'err', 'Anfrage fehlgeschlagen: ' + e.message);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = 'Quelle testen';
  });
};

$('form').onsubmit = function (ev) {
  ev.preventDefault();
  var btn = $('btnSave');
  btn.disabled = true;
  btn.textContent = 'Speichere und lade …';
  api('POST', '/api/playlists', formData()).then(function (r) {
    if (!r.ok) return show($('result'), 'err', r.error || 'Speichern fehlgeschlagen');
    closeForm();
    loadPlaylists();
  }).catch(function (e) {
    show($('result'), 'err', 'Anfrage fehlgeschlagen: ' + e.message);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = 'Speichern';
  });
};

// ---------------------------------------------------------------- Gruppen ein-/ausblenden
var groupPlaylist = null;
var groupData = [];

function renderGroups() {
  var ul = $('groupList');
  ul.textContent = '';
  var f = $('g_filter').value.toLowerCase();
  groupData.forEach(function (g) {
    if (f && g.name.toLowerCase().indexOf(f) < 0) return;
    var li = el('li');
    var lab = el('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !g.hidden;
    cb.onchange = function () { g.hidden = !cb.checked; };
    lab.appendChild(cb);
    lab.appendChild(el('span', null, g.name));
    lab.appendChild(el('span', 'count', String(g.count)));
    li.appendChild(lab);
    ul.appendChild(li);
  });
}

function openGroups(p) {
  groupPlaylist = p;
  $('groupTitle').textContent = 'Gruppen von „' + p.name + '“';
  $('groupResult').hidden = true;
  $('g_filter').value = '';
  groupData = [];
  renderGroups();
  $('groupCard').hidden = false;
  $('groupCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  api('GET', '/api/playlists/' + encodeURIComponent(p.id) + '/groups').then(function (r) {
    if (!r.ok) return show($('groupResult'), 'err', r.error || 'Gruppen konnten nicht geladen werden');
    groupData = r.groups || [];
    renderGroups();
  });
}

$('g_filter').oninput = renderGroups;
$('gAll').onclick = function () { groupData.forEach(function (g) { g.hidden = false; }); renderGroups(); };
$('gNone').onclick = function () { groupData.forEach(function (g) { g.hidden = true; }); renderGroups(); };
$('gFiltered').onclick = function () {
  var f = $('g_filter').value.toLowerCase();
  groupData.forEach(function (g) { g.hidden = !(g.name.toLowerCase().indexOf(f) >= 0); });
  renderGroups();
};
$('gClose').onclick = function () { $('groupCard').hidden = true; };
$('gSave').onclick = function () {
  var hidden = groupData.filter(function (g) { return g.hidden; }).map(function (g) { return g.name; });
  api('POST', '/api/playlists/' + encodeURIComponent(groupPlaylist.id) + '/hidden', { hidden: hidden }).then(function (r) {
    if (!r.ok) return show($('groupResult'), 'err', r.error || 'Speichern fehlgeschlagen');
    show($('groupResult'), 'ok', 'Gespeichert. ' + hidden.length + ' Gruppen sind ausgeblendet.');
    loadPlaylists();
  });
};

// ---------------------------------------------------------------- Zugriffsschutz
$('btnAdmin').onclick = function () {
  var pw = $('a_pw').value;
  api('POST', '/api/admin', { password: pw }).then(function (r) {
    if (!r.ok) return show($('adminResult'), 'err', r.error || 'Fehlgeschlagen');
    $('a_pw').value = '';
    show($('adminResult'), 'ok', r.hasAdminPassword
      ? 'Zugriffsschutz aktiv. Der Browser fragt ab jetzt nach dem Passwort (Benutzername beliebig).'
      : 'Zugriffsschutz ausgeschaltet.');
    loadInfo();
  });
};

loadPlaylists();
setInterval(function () { if (lastInfo && lastInfo.epg && lastInfo.epg.loading) loadInfo(); }, 3000);
