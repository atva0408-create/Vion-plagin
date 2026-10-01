# HomeKit

Zeigt Ihre ViON-Kameras und -Sensoren in der Home-App von Apple.

## Funktionen

- Jede Kamera wird ein eigenes Gerät in der Home-App, mit Livebild, Aufzeichnung über HomeKit Secure Video und Gegensprechen.
- Kameras mit H.265-Hauptstream (HEVC) nutzen das neue Secure Video von iOS 27, ohne das Video umzukodieren, sodass selbst 4K-Kameras den Server kaum belasten. H.264-Kameras arbeiten im klassischen Modus.
- Bewegung, Türklingel, Scheinwerfer, Sirene und Akku einer Kamera erscheinen an der Kamera selbst.
- Sensoren ohne Kamera kommen über eine gemeinsame Bridge: Kontakt-, Präsenz-, Rauch-, Leck-, Temperatur-, Feuchtigkeits-, Kohlenmonoxid-, Kohlendioxid-, Helligkeits- und Vibrationssensoren, Schlösser, Garagentore, Schalter, Sicherheitssysteme, Lichter und Sirenen. Die Bridge wird einmal gekoppelt; später hinzugefügte Sensoren erscheinen von selbst.
- Deaktivierte und nicht erreichbare Kameras bleiben in der Home-App und zeigen ein Platzhalterbild.

## Voraussetzungen

- Für das neue Secure Video: iOS 27 oder tvOS 27 auf den Wiedergabegeräten und auf der Steuerzentrale.
- Für Sensoren: „Sensor freigeben“ ist für jeden Sensor auf der Seite „Sensoren“ aktiviert.

## Einstellungen

- „QR-Code“ und „PIN“: in der Home-App scannen oder eingeben, um zu koppeln. Jede Kamera hat eigene; die der Bridge stehen in den Plugin-Einstellungen.
- „Kopplung zurücksetzen“: hebt die Kopplung auf und erzeugt einen neuen Kopplungscode.
- „Klassischen Modus erzwingen“: hält eine Kamera bei den klassischen HomeKit-Diensten, für Haushalte, die bei iOS 26 oder älter bleiben.
- „Hardwarebeschleunigung verwenden“: für eine Kamera ausschalten, deren Video instabil läuft.
