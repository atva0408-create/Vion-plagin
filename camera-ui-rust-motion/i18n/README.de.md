# Rust Motion

Erkennt Bewegung im Kamerabild bei geringer Prozessorlast. Auch kleine und langsame Bewegungen werden erfasst.

## Funktionen

- Erkennt Bewegung im Kamerabild und markiert die Bereiche, in denen sich etwas bewegt
- Belastet den Prozessor wenig und braucht keine Grafikkarte
- Erkennt kleine und langsame Bewegungen zuverlässig, bei Tag und bei Nacht
- Zählt nahe beieinanderliegende veränderte Bereiche als eine Bewegung: Ein Tier in der Ferne ist eine Erkennung statt mehrerer Punkte
- Beginnt nach einer Kamerabewegung oder einem plötzlichen Belichtungswechsel neu, statt das ganze Bild zu markieren
- Eigene Einstellungen für jede Kamera und eine Schaltfläche, die die Standardwerte wiederherstellt

## Voraussetzungen

- Der Detektor ist nicht für jedes Serversystem verfügbar. Fehlt er für Ihres, fügt das Plugin den Kameras keinen Bewegungssensor hinzu

## Einstellungen

- „Fläche“: die Mindestgesamtgröße benachbarter veränderter Bereiche, die als Bewegung gilt
- „Schwellenwert“: die Helligkeitsänderung, ab der ein Pixel als verändert gilt
- „Weichzeichnungsradius“: glättet das Bild vor der Erkennung, um Rauschen zu verringern
- „Ausdehnungsgröße“: fasst benachbarte veränderte Pixel zu einem Bereich zusammen
- „Haltezeit des Vergleichsbilds“: wie viele Sekunden das Vergleichsbild behalten wird. Höhere Werte erfassen sehr langsame Bewegung, niedrigere halten die Bewegungsrahmen näher an der aktuellen Position
