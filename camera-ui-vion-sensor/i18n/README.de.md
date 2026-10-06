# ViON Sensor

Ein Sicherheitssensor auf einer ESP32-CAM-Platine. Er erkennt Menschen, die sich im Raum bewegen, daran, wie sie das
WLAN-Signal zwischen Platine und Router verändern (Wi-Fi Sensing): ohne Video, im Dunkeln und durch eine Tür. Die
Kamera der Platine ist optional.

## Eine Platine einrichten

1. Spielen Sie die Firmware ViON Sensor einmal per USB auf (Ordner `sensor esp VION` im ViON-Projekt).
2. Schalten Sie die Platine dort ein, wo sie überwachen soll. Sie öffnet ihr eigenes Netz **ViON-Sensor-XXXX**:
   verbinden Sie ein Telefon damit, wählen Sie Ihr Heimnetz (2,4 GHz) und geben Sie das Passwort ein.
3. Öffnen Sie in ViON **Sensoren → Gefunden** und fügen Sie **ViON Sensor XXXX** hinzu. Die Platine gibt diesem ViON
   ihren Schlüssel: danach antwortet sie nur ihm.
4. 30 Sekunden nach dem Start lernt der Sensor den leeren Raum: halten Sie ihn so lange leer.

Erscheint die Platine nicht, tragen Sie ihre Adresse in den Einstellungen dieses Plugins ein.

## Einstellungen eines Sensors

- **Empfindlichkeitsschwelle** — um wie viel stärker sich das Signal ändern muss als im leeren Raum. Niedriger ist
  empfindlicher, gibt aber mehr Fehlalarme; beginnen Sie mit 1,4.
- **Bewegung hält an, Sekunden** — wie lange der Sensor nach der letzten Bewegung auf „Bewegung“ bleibt.
- **Kamera** — schaltet die Kamera der Platine ein; sie erscheint dann unter **Kameras → Gefunden**. Die Platine
  startet neu und kalibriert erneut.
- **Kalibrieren** — den leeren Raum neu lernen (verlassen Sie ihn vorher).
- **Firmware aktualisieren** — erscheint, wenn eine neue Firmware erschienen ist; die Platine lädt und prüft sie selbst.
- **Sensor zurücksetzen** — die Platine vergisst das WLAN und dieses ViON.

Dreimal schnell hintereinander einschalten (jeweils kürzer als 10 Sekunden) setzt die Platine ebenfalls zurück.

## Anwesenheit und Radar (Firmware 1.1.0)

- **Anwesenheit** — der zweite Sensor einer Platine, angeboten unter **„Sensoren → Gefunden“**, sobald ihr
  Bewegungssensor hinzugefügt ist. Er erkennt auch eine still stehende Person (Algorithmus Espressif esp-radar) und
  lernt den leeren Raum in denselben 30 s wie die Kalibrierung. Ist das WLAN-Signal zu ungleichmäßig, lernt er nicht,
  und die Anwesenheit bleibt bis zur nächsten Kalibrierung unbekannt; die Bewegung funktioniert wie bisher.
- **Bewegung aus** — welcher Algorithmus die Bewegung in ViON liefert: der eigene, der von Espressif oder einer von
  beiden. Beide laufen ständig.
- **Radar HLK-LD2450** (optional): an die Platine angeschlossen (TX des Radars an GPIO13, RX an GPIO14, 5 V und GND),
  liefert er dem Grundriss die Positionen von bis zu drei Personen.
- Eine Firmware, die nicht startet, bringt die Platine selbst zur vorherigen zurück; die Einstellungen zeigen es.

## Platinen mit der ESPectre-Firmware

Statt der ViON-Sensor-Firmware kann auf einer Platine [ESPectre](https://github.com/francescopace/espectre) laufen (von
Francesco Pace, freie Software unter GPLv3): die offizielle Version, unverändert. ESPectre erkennt Bewegung mit einem
statistischen Detektor oder einem kleinen neuronalen Netz, das seine Autoren trainiert haben. Dieses Plugin spricht mit
der Platine nur über das Netzwerk.

1. Flashen Sie die offizielle **Native**-Firmware für den Chip der Platine per USB auf
   [espectre.dev/tools/flash](https://espectre.dev/tools/flash/) (Chrome am Computer) und richten Sie dort das WLAN ein:
   die Platine hat kein eigenes WLAN.
2. Öffnen Sie in ViON **Sensoren**, **Gefunden** und fügen Sie die Platine hinzu (Hersteller ESPectre). Sie wird per
   mDNS gefunden; sonst tragen Sie ihre Adresse in den Einstellungen dieses Plugins ein.
3. Die Einstellungen des Sensors: **Erkennung** (Leicht oder Hohe Genauigkeit — das neuronale Netz, ohne Kalibrierung),
   **Bewegungsschwelle** (eine Wahrscheinlichkeit, 0–1), **Messungen bis Bewegungsbeginn** und **bis Bewegungsende**,
   **Signalquelle**, **Kalibrieren** und das Firmware-Update aus den ESPectre-Versionen. **Bewegung hält an, Sekunden**
   (ohne Einstellung 8) speichert ViON: wie lange der Sensor nach der letzten Bewegungsmessung der Platine in Bewegung
   bleibt.

Die ESPectre-API hat kein Passwort: jedes Gerät im Heimnetz kann diese Einstellungen ändern. ESPectre sieht nur
Bewegung: es unterscheidet keinen Menschen von einem Tier, zählt keine Personen und beweist keinen leeren Raum.

## Aufstellung

Am besten sieht der Sensor, was sich nahe der Linie zwischen Platine und Router bewegt. Stellen Sie den
2,4-GHz-Kanal des Routers fest (nicht „Auto“) und 20 MHz Breite ein: ein wechselnder Kanal sieht aus wie Bewegung.
