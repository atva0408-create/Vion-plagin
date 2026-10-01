# NCNN

Erkennt Objekte, Gesichter und Kennzeichen im Video Ihrer Kameras. Das Plugin läuft auf dem Prozessor des Servers oder, sofern vorhanden, auf einer Grafikkarte mit Vulkan-Unterstützung.

## Funktionen

- Erkennt Personen, Fahrzeuge und Tiere
- Erkennt Gesichter und erkennt bekannte Personen wieder
- Erkennt Kennzeichen und liest ihren Text
- Nutzt eine Grafikkarte mit Vulkan, sofern vorhanden, und sonst den Prozessor
- Richtet sich nach den Konfidenzwerten aus den Erkennungseinstellungen der Kamera
- Lädt seine Modelle selbst herunter

## Voraussetzungen

- Für eine schnellere Erkennung eine Grafikkarte mit Vulkan-Unterstützung; ohne sie läuft das Plugin auf dem Prozessor
- Damit Gesichter Namen erhalten, muss dieses Plugin für jede Kamera als „Gesichtserkennung“ ausgewählt sein: Kameraeinstellungen, „Plugins“, „Erkennungen“

## Einstellungen

- **Modell für die Gesichtswiedererkennung**: gilt für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu berechnet
- **Vulkan (GPU) verwenden**: Ist die Option eingeschaltet, laufen die Modelle über Vulkan auf der Grafikkarte, sofern sie verfügbar ist; andernfalls auf dem Prozessor
- **Vulkan-Gerät**: welche Grafikkarte in Systemen mit mehreren verwendet wird; „Automatisch“ überlässt die Wahl dem System
- **Aktive Hardware**: zeigt, wo die Modelle laufen
- **Modelle neu herunterladen**: löscht die heruntergeladenen Modelle und lädt die aktuellen erneut herunter
- **Einstellungen zurücksetzen**: setzt alle Einstellungen des Plugins auf die Standardwerte zurück
- Je Kamera, in den Gruppen „Objekterkennung“, „Gesichtserkennung“ und „Kennzeichen“: **Modell**, **Erkennungsmodell** und **OCR-Modell**. „Standard“ folgt dem empfohlenen Modell
