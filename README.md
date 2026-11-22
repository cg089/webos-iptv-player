# IPTV Player für LG webOS

Eigener IPTV-Player für LG-Fernseher mit webOS 4.x (entwickelt und getestet auf einem gerooteten 75UK6200PLB, Firmware 05.50.70; ohne Root siehe „Ohne Root“).
M3U-Playlisten und XMLTV-Programmführer werden über eine **Weboberfläche** eingerichtet und **lokal auf dem Fernseher** gespeichert.

## Installieren

Fertige IPK: `dist/org.iptvplayer.app_1.3.0_all.ipk` (neu bauen: `bash tools/build.sh`, braucht Node.js und `@webos-tools/cli`).

Per Homebrew Channel / webOS Dev Manager hochladen, oder per Kommandozeile:

```bash
ares-install --device tv dist/org.iptvplayer.app_1.3.0_all.ipk
```

Danach erscheint **IPTV Player** im Launcher. Er läuft neben dem SMB Player (anderer Port: 8766).

### Ohne Root (Entwicklermodus) – ungetestet

Root ist voraussichtlich **nicht nötig**. Die App und der Node-Dienst brauchen keine Root-Rechte (der Dienst läuft auch auf dem Testgerät als normaler App-Benutzer). Auf einem nicht gerooteten TV sollte die Installation über den **Entwicklermodus** gehen:

1. Auf dem TV die LG-App „Developer Mode“ installieren, Entwicklermodus einschalten und den Fernseher neu starten.
2. Am PC das Gerät einrichten (`ares-setup-device`, Passphrase aus der Developer-Mode-App) und die IPK mit `ares-install --device tv …` installieren (siehe oben).

Bekannte Einschränkungen und offene Punkte:

- **Kein Autostart:** Das Skript `service/autostart.sh` braucht Root. Ohne Root ist die Einrichtungsseite nur erreichbar, solange die App geöffnet ist.
- **Sitzung des Entwicklermodus:** Er läuft nach LGs Vorgabe zeitlich begrenzt (ca. 50 Stunden) und muss in der Developer-Mode-App verlängert werden.
- **Ungetestet:** Ob webOS dem Dienst ohne Root alles erlaubt (eigener Port 8766, Netzwerkzugriff), ist nicht geprüft. Erfahrungsberichte (Issues) sind willkommen.

## Einrichten

1. App am TV starten. Beim ersten Start zeigt sie die Adresse der Einrichtungsseite, z. B. `http://192.168.1.50:8766/`.
2. Diese Adresse am PC oder Handy im selben Netzwerk öffnen.
3. **Playlist hinzufügen**: Adresse einer M3U-Playlist (auch Xtream-Codes: `get.php?username=…&password=…&type=m3u_plus`) oder M3U-Datei hochladen. „Quelle testen“ prüft vorher.
4. Optional: **Gruppen** ausblenden, **EPG-Adresse** eintragen (sonst wird `url-tvg` aus der Playlist genutzt).
5. Am TV mit OK / Gelb die Liste neu laden.

Die Konfiguration liegt in `…/org.iptvplayer.app.service/data/config.json` (Rechte 600, enthält Playlist-Adressen mit Zugangsdaten im Klartext), Favoriten und Verlauf in `state.json` daneben. **Ein App-Update überschreibt diesen Ordner – vorher sichern.**

## Enigma2-Receiver (VU+, Dreambox, …)

### Sender direkt von der Box laden (empfohlen)

Als Quelle **Enigma2-Receiver** wählen und nur die Adresse der Box eintragen, bei Anmeldung mit Zugangsdaten: `http://root:passwort@192.168.1.5`. Der Dienst holt Bouquets und Sender über die OpenWebif-Schnittstelle (`/api/getallservices`), ganz ohne M3U-Export:

- Jedes **Bouquet wird zur Gruppe** (Reihenfolge und Namen wie am Receiver). Ein „(TV)“ am Ende des Namens wird entfernt, solange der Name dadurch nicht doppelt vorkommt.
- „Alle Sender“ zeigt jeden Sender nur einmal, auch wenn er in mehreren Bouquets steht. Marker und leere Bouquets werden ausgelassen.
- Nicht gewünschte Bouquets lassen sich über **Bouquets** (Gruppen ausblenden) abwählen. Ausgeblendete Bouquets werden auch nicht für den Programmführer abgefragt.
- Stream-Adresse: `http://Box:8001/<Service-Referenz>`. Den Port (Standard 8001) kann man ändern. Schützt die Box das Streaming mit Passwort, die Option „Benutzername und Passwort auch für die Streams“ einschalten.
- Picons und EPG kommen wie unten beschrieben automatisch von der Box. Änderungen am Receiver erscheinen nach „Aktualisieren“ oder spätestens nach der eingestellten Aktualisierungszeit.

Die M3U-Variante (Datei oder Adresse) bleibt daneben unverändert möglich.

### Mit M3U-Playlist

Playlisten wie die vom Receiver exportierte `services.m3u8` (Stream-Adressen `http://box:8001/1:0:19:283D:41B:1:FFFF0182:0:0:0:`) werden automatisch erkannt:

- **Senderlogos**: Die Service-Referenz aus der Adresse ergibt die Picon-Adresse `http://box/picon/1_0_19_283D_41B_1_FFFF0182_0_0_0.png`. Das setzt voraus, dass auf der Box Picons installiert sind.
- **Programmführer**: Pro Sender wird `http://box/api/epgservice?sRef=…` (OpenWebif) abgefragt, auch ohne `tvg-id` und ohne XMLTV. Verlangt OpenWebif eine Anmeldung (die Box antwortet dann mit HTTP 401, wie bei der VU+ des Entwicklers) oder läuft es auf einem anderen Port, die **OpenWebif-Adresse** in der Playlist eintragen (z. B. `http://root:passwort@192.168.10.252:8080`). Fehler (Box nicht erreichbar, 401 …) stehen in der Statuszeile der Weboberfläche.
- Mit „Enigma2-Erkennung abschalten“ lässt sich das pro Playlist ausschalten. IPTV-Dienste der Box (`4097:`/`5001:`) haben weder Picon noch EPG.
- Hinweis: Die Receiver-Exporte enthalten keine Gruppen, alle Sender erscheinen in „Ohne Gruppe“.

## Puffer (Stream-Cache)

Der Player des TVs lässt sich von der App aus nicht auf einen größeren Puffer einstellen (LGs `mediaOption` kennt dafür keine Parameter). Deshalb gibt es den Puffer im TV-Dienst: Einstellungen → **Puffer** (Klein 4 MB, Mittel 12 MB, Groß 32 MB). Alle Sender laufen dann über den Dienst, der vor dem Start 1–3 MB vorlädt (maximal 4 s) und danach schneller vom Anbieter liest, als der Player abnimmt. Das gleicht Netzwerk-Aussetzer zwischen Box und TV aus. Der Sender startet dadurch etwas später. Ob das ein „verwaschenes“ Bild behebt, hängt von der Ursache ab (Netzwerk-Aussetzer ja, Probleme im Stream selbst nein).

## Bedienung am TV

| Taste | Liste | Player |
|---|---|---|
| ↑ ↓ | Auswahl | nächster / vorheriger Sender |
| ← → / CH ± | 10 Zeilen springen | (CH ± wie ↑ ↓) |
| OK | Öffnen / Abspielen | Senderliste einblenden |
| Ziffern | – | Kanalnummer eingeben |
| Rot | Favorit an/aus | Favorit an/aus |
| Grün | Startseite: zuletzt gesehener Sender | vorheriger Sender |
| Gelb | Neu laden | Neu verbinden (probiert die andere Zugriffsart zuerst) |
| Blau | Suche | Programmdetails (auch Info-Taste) |
| Zurück | eine Ebene hoch | Liste |

In der Senderliste zeigt jede Zeile Kanalnummer, einen Fortschrittsbalken der laufenden Sendung, den Sender und die Sendung (gleiche Schriftgröße). Rechts steht das Infofenster zum markierten Sender: Logo, Start- und Endzeit, Titel, Beschreibung und die nächsten Sendungen; es wechselt beim Hoch-/Runterfahren in der Liste.

Die Startseite bietet Favoriten, zuletzt gesehen, alle Sender und die Gruppen. Bei mehreren Playlisten erscheint zuerst die Playlist-Auswahl. In der Senderliste stehen Logo, Kanalnummer und die laufende Sendung (mit EPG).

## Wie es funktioniert

- **App** (`app/`): HTML/ES5 für Chromium 53, spielt Streams im `<video>`-Element des TVs ab (Hardware-Decoder, HLS und MPEG-TS).
- **Dienst** (`service/`): Node.js-Dienst (läuft auf dem TV mit Node 0.12). Lädt und parst Playlisten, liest den XMLTV-Programmführer als Datenstrom (nur Sender der Playlist, ca. −3 h bis +36 h), liefert die Weboberfläche und die API unter Port 8766.
- **Stream-Proxy** (`/p/…`): Der Dienst kann Streams für den Player holen – mit eigenem User-Agent/Referer (`#EXTVLCOPT`, Kodi-Stil `|User-Agent=…`), über Weiterleitungen und optional ohne Zertifikatsprüfung. HLS-Playlisten werden umgeschrieben. Die Adressen sind per HMAC signiert (kein offener Proxy).
- **Zugriffsart „automatisch“**: Direkt abspielen, wenn möglich; über den Dienst, wenn der Sender es braucht; bei Fehlern wird die andere Variante automatisch versucht.
- Der Server läuft als Kindprozess mit `--expose-gc` (Node 0.12 räumt Netzwerkpuffer sonst zu spät auf; der TV hat nur ~860 MB RAM).

### Dauerbetrieb (optional)

`service/autostart.sh` startet den Server beim Booten (Homebrew-Channel-Init-Skript):

```bash
ln -s /media/developer/apps/usr/palm/services/org.iptvplayer.app.service/autostart.sh /var/lib/webosbrew/init.d/90-iptvplayer
```

Dann ist die Weboberfläche auch erreichbar, wenn die App nicht geöffnet ist. (Auf dem TV nicht getestet.)

## Zugriffsschutz

Ohne Passwort kann jedes Gerät im Heimnetz die Einrichtungsseite öffnen. Optional lässt sich ein Passwort setzen (Basic-Auth; der TV selbst über 127.0.0.1 braucht es nicht). Schreibende Aufrufe von fremden Webseiten werden abgewiesen, lesende Aufrufe der Playlisten (mit Zugangsdaten) nur vom eigenen Ursprung oder vom TV selbst erlaubt.

## Grenzen

- Nur M3U/M3U8 (kein Xtream-JSON-API, keine Stalker-Portale), EPG per XMLTV oder OpenWebif.
- Was der TV nicht dekodiert (z. B. bestimmte Audiocodecs), spielt auch hier nicht. DRM-geschützte Streams gehen nicht.
- Die Programmdaten liegen nur im Speicher und werden beim Dienststart neu geladen.

## Getestet

- API, Parser, Proxy (Header, Range, HLS-Umschreibung, Signatur), EPG (gzip, Zeitzonen, Entities), Favoriten, Gruppen, Datei-Upload, Zugriffsschutz: `node test/iptv-smoke.js` (läuft unter Node 0.12 und neuer; 60+ Prüfungen).
- App im Desktop-Browser mit simuliertem Anbieter (`test/dev-upstream.js`, `test/dev-app-server.js`): Liste, Logos, EPG, Zapping, Zifferneingabe, Overlay, Suche, Favoriten, Proxy-Wiedergabe, „Kein Signal“-Fall.
- Enigma2: Erkennung, Picon-Adressen und EPG-Abruf gegen einen **simulierten** OpenWebif-Server (Antwortformat `/api/epgservice` nach bestem Wissen, nicht gegen eine echte Box geprüft); Proxy-Puffer mit schnellem und langsamem Anbieter.
- **Nicht auf dem TV getestet**: Installation, Start über Luna, Wiedergabe echter HLS/TS-Streams im webOS-Player, Fernbedienungstasten (Farbtasten, Ziffern, Bildschirmtastatur bei der Suche), Autostart-Skript.

## Fehlersuche

- *Dienst nicht erreichbar*: Log liegt in `…/data/server.log` (per SSH).
- *Sender geht nicht*: Gelb drücken (andere Zugriffsart), in der Weboberfläche „Streams immer über den TV-Dienst leiten“ oder „Zertifikate nicht prüfen“ aktivieren, User-Agent der Playlist setzen.
- *Playlist lädt nicht*: „Quelle testen“ zeigt die genaue Fehlermeldung (404, 403, Zertifikat, Zeitüberschreitung …).

## Lizenz und Hinweise

MIT-Lizenz, siehe [LICENSE](LICENSE). Das Projekt steht in keiner Verbindung zu LG Electronics. Es spielt nur Streams ab, die du selbst bereitstellst; für die Rechtmäßigkeit der Inhalte bist du verantwortlich. Die fertige IPK gibt es unter „Releases“.
