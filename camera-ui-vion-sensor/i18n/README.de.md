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

## Aufstellung

Am besten sieht der Sensor, was sich nahe der Linie zwischen Platine und Router bewegt. Stellen Sie den
2,4-GHz-Kanal des Routers fest (nicht „Auto“) und 20 MHz Breite ein: ein wechselnder Kanal sieht aus wie Bewegung.
