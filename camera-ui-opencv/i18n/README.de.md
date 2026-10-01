# OpenCV

Erkennt Bewegung im Kamerabild. Für jede Kamera wählen Sie eines von drei Erkennungsverfahren und stellen dessen Empfindlichkeit ein.

## Funktionen

- Erkennt Bewegung im Kamerabild und markiert die Bereiche, in denen sich etwas bewegt
- Drei Erkennungsverfahren: „Bilddifferenz“ vergleicht jedes Bild mit dem vorherigen, „Hintergrundsubtraktion“ lernt die ruhige Szene und meldet, was davon abweicht, „Standard“ vergleicht geglättete Bilder mit einstellbarem Schwellenwert
- Eigene Einstellungen für jedes Verfahren und jede Kamera
- Eine Schaltfläche zum Zurücksetzen für jedes Verfahren und eine für alle Einstellungen
- Läuft auf dem Prozessor, eine Grafikkarte ist nicht nötig
- Dieselben Verfahren stehen im Test der Bewegungserkennung und in Automatisierungen zur Verfügung

## Einstellungen

- „Bewegungsdetektor“: das Erkennungsverfahren für die Kamera. Voreingestellt ist „Hintergrundsubtraktion“
- „Fläche“: die Mindestgröße der erkannten Bewegung in Pixeln. Kleinere Bewegungen werden nicht berücksichtigt
- „Schwellenwert“: die Empfindlichkeit. Je höher der Wert, desto geringer die Empfindlichkeit
- „Weichzeichnung“ (Verfahren „Standard“): glättet das Bild, um Rauschen zu unterdrücken
- „Ausdehnung“ (Verfahren „Standard“): dehnt die Bereiche der erkannten Bewegung aus
- „Lernrate“ (Verfahren „Hintergrundsubtraktion“): wie schnell sich der Hintergrund an Änderungen der Szene anpasst, von 0 bis 1; -1 bedeutet automatisch
