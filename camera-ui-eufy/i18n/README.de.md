# Eufy

Bindet Kameras, Türklingeln, HomeBases und Sensoren von Eufy in ViON ein. Sie melden sich einmal mit Ihrem Eufy-Konto an, und die Geräte dieses Kontos erscheinen in ViON.

## Funktionen

- Livebild über P2P oder über RTSP, wo die Kamera es anbietet, mit Gegensprechen bei Kameras mit Lautsprecher
- Bewegung, Personen, Fahrzeuge, Haustiere, Geräusche, Klingeln an der Tür und der Akkustand kommen als Sensoren der Kamera an
- Scheinwerfer, Sirene, Schwenken und Neigen sowie das Ein- und Ausschalten der Kamera erscheinen als Bedienelemente, sofern die Kamera sie unterstützt
- Tür- und Fenstersensoren, Bewegungs-, Wasser-, Rauch- und CO-Melder, Schlösser sowie Sicherheitsmodus und Sirene einer HomeBase lassen sich auf der Seite „Sensoren“ hinzufügen
- Snapshots stammen aus der letzten Eufy-Benachrichtigung, eine Akkukamera wird dafür nicht geweckt
- Läuft neben der Eufy-App und anderen Integrationen im selben Konto

## Voraussetzungen

- Ein Eufy-Konto: E-Mail-Adresse, Passwort und Land
- Eufy kann ein Captcha verlangen oder einen Bestätigungscode schicken; die Einstellungen zeigen dann ein Feld dafür. Die Anmeldung wird gespeichert, nach einem Neustart wird nicht erneut gefragt

## Einstellungen

- **E-Mail**, **Passwort**, **Land** und **Anmelden**: Ihr Eufy-Konto. **Abmelden** beendet die Sitzung und vergisst die gespeicherte Anmeldung
- **Stream-Modus** (je Kamera, wo RTSP angeboten wird): P2P funktioniert mit jeder Kamera; RTSP braucht Netzstrom, und eine HomeBase liefert nur eine Kamera über RTSP
- **Maximale Livebild-Dauer**: Akkukameras beenden die Übertragung nach so vielen Sekunden
- **Geräte ignorieren**: Seriennummern der Eufy-Geräte, die nicht angeboten werden sollen
