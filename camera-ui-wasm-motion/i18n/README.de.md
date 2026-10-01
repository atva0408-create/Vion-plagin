# WASM Motion

Erkennt Bewegung im Kamerabild. Das Plugin läuft auf jedem System und braucht keine zusätzlichen Komponenten.

## Funktionen

- Erkennt Bewegung durch den Vergleich der Pixel des Kamerabilds und markiert die Bereiche, in denen sich etwas bewegt
- Läuft auf jedem System ohne zusätzliche Komponenten und ohne Grafikkarte
- Die Empfindlichkeit lässt sich für jede Kamera getrennt einstellen
- Eine Schaltfläche stellt die Standardwerte wieder her

## Einstellungen

- „Fläche“: die Mindestgröße eines Bereichs, der als Bewegung gilt
- „Schwellenwert“: die Helligkeitsänderung, ab der ein Pixel als verändert gilt
- „Weichzeichnungsradius“: glättet das Bild vor der Erkennung, um Rauschen zu verringern
- „Ausdehnungsgröße“: fasst benachbarte veränderte Pixel zu einem Bereich zusammen
- „Einstellungen zurücksetzen“: stellt die Standardwerte der Erkennung wieder her
