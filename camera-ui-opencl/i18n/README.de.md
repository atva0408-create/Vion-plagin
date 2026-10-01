# OpenCL

Erkennt Bewegung im Kamerabild und führt die Auswertung auf der Grafikkarte aus.

## Funktionen

- Erkennt Bewegung im Kamerabild und markiert die Bereiche, in denen sich etwas bewegt
- Führt die Auswertung auf der Grafikkarte aus
- Sie können wählen, welches Gerät die Auswertung übernimmt – hilfreich in Systemen mit mehreren Grafikkarten
- Eigene Empfindlichkeitseinstellungen für jede Kamera und eine Schaltfläche, die die Standardwerte wiederherstellt
- Steht im Test der Bewegungserkennung und in Automatisierungen zur Verfügung

## Voraussetzungen

- Eine Grafikkarte mit installiertem OpenCL-Treiber. Ohne OpenCL auf dem Server startet die Bewegungserkennung nicht
- Wird keine Grafikkarte gefunden, nutzt das Plugin den Prozessor, sofern für ihn ein OpenCL-Treiber installiert ist

## Einstellungen

- „OpenCL-Gerät“: das Gerät, das die Auswertung übernimmt. 'auto' nimmt die erste gefundene Grafikkarte; die übrigen Einträge sind die erkannten Geräte, nummeriert wie im Hinweis unter dem Feld
- „Fläche“: die Mindestgröße der erkannten Bewegung in Pixeln. Kleinere Bewegungen werden nicht berücksichtigt
- „Schwellenwert“: die Empfindlichkeit, von 0 bis 1. Je höher der Wert, desto geringer die Empfindlichkeit
- „Weichzeichnung“: glättet das Bild, um Rauschen zu unterdrücken
- „Ausdehnung“: dehnt die Bereiche der erkannten Bewegung aus
