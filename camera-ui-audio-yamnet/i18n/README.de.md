# YAMNet Audio Detection

Wertet den Ton Ihrer Kameras aus, erkennt typische Geräusche wie Glasbruch, eine Sirene oder Hundegebell und meldet sie an ViON.

## Funktionen

- Erkennt zwölf Arten von Geräuschen: Türklingel, Glasbruch, Sirene, Sprache, Schuss, Hundegebell, Babygeschrei, Alarm, Schrei, Katze, Autoalarm und Rauchmelder
- Meldet jedes Geräusch einmal und unter den Namen, die ViON für Geräusche verwendet
- Verwendet den Konfidenzwert aus den Einstellungen der Kamera, sodass die Empfindlichkeit je Kamera an einer Stelle festgelegt wird
- Benötigt keine eigene Einrichtung: Das Plugin achtet immer auf alle diese Geräusche
- Lädt sein Modell beim ersten Start selbst herunter
- Läuft auf dem Prozessor des Servers

## Voraussetzungen

- Eine Kamera, die Ton überträgt

## Einstellungen

- Das Plugin hat keine eigenen Einstellungen. Wie sicher es sein muss, bevor es ein Geräusch meldet, legen Sie je Kamera mit „Audio-Konfidenz“ in den Einstellungen der Kamera fest; ist dort nichts festgelegt, gilt der Wert 0.7
- **Überwachte Geräusche** und **Konfidenzschwelle** werden nur beim Testen der Erkennung verwendet
