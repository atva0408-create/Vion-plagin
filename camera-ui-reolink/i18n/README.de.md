# Reolink

Bindet Kameras, Türklingeln, NVRs und Home Hubs von Reolink in ViON ein, über das Protokoll, das auch die Reolink-App verwendet. Funktioniert mit allen Reolink-Modellen, auch mit Akkukameras und Modellen ohne RTSP oder ONVIF.

## Funktionen

- Findet Reolink-Geräte im lokalen Netzwerk; andere lassen sich von Hand per IP-Adresse oder UID hinzufügen
- Livebild nahezu in Echtzeit, mit Gegensprechen
- Bewegung, erkannte Objekte, Babyweinen, Klingeln an der Tür und der Akkustand kommen als Sensoren an
- Sirene, Scheinwerfer und PTZ mit den in der Reolink-App gespeicherten Positionen, sofern die Kamera sie hat
- Jeder Kanal eines NVR oder Home Hub und das Teleobjektiv einer Kamera mit zwei Objektiven werden zu eigenen Kameras
- Akkukameras schlafen zwischen Ereignissen, damit der Akku hält

## Voraussetzungen

- Benutzername und Passwort des lokalen Kontos der Kamera, wie in der Reolink-App festgelegt
- Die Kamera muss vom ViON-Server aus per IP-Adresse (Port 9000) oder, im selben Netzwerksegment, per UID erreichbar sein
- Akkukameras müssen den ViON-Server auf dem unter „Port für Ereignismeldungen“ eingestellten Port erreichen können

## Einstellungen

- **Kameraname**, **IP-Adresse**, **UID**, **Kamera hinzufügen**: fügen eine Kamera von Hand hinzu; sie erscheint danach unter den entdeckten Kameras
- **Zum Livebild aufholen (Sekunden)**: wie weit das Bild zurückliegen darf, bevor alte Bilder übersprungen werden; mit 0 bleibt alles erhalten
- **Dauerhafte Stromversorgung**: für Akkumodelle mit fester Stromversorgung, etwa eine Türklingel am Klingeltransformator; die Kamera reagiert schneller, ein Akku wäre aber innerhalb eines Tages leer
