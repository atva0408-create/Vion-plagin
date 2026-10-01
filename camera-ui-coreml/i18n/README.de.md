# CoreML

Erkennt Objekte, Gesichter und Kennzeichen im Video Ihrer Kameras auf einem Mac mit Apple CoreML und stellt die semantische Suche (CLIP) bereit.

## Funktionen

- Erkennt Personen, Fahrzeuge und Tiere
- Erkennt Gesichter und erkennt bekannte Personen wieder
- Erkennt Kennzeichen und liest ihren Text
- Stellt die semantische Suche mit CLIP für Ereignisse bereit
- Richtet sich nach den Konfidenzwerten aus den Erkennungseinstellungen der Kamera
- Lässt Sie wählen, welche Teile der Apple-Hardware die Arbeit übernehmen: CPU, GPU und Neural Engine
- Lädt seine Modelle selbst herunter

## Voraussetzungen

- Ein ViON-Server, der auf einem Mac (macOS) läuft
- Damit Gesichter Namen erhalten, muss dieses Plugin für jede Kamera als „Gesichtserkennung“ ausgewählt sein: Kameraeinstellungen, „Plugins“, „Erkennungen“

## Einstellungen

- **CLIP-Modell (Bilder)**: das Modell für die semantische Suche, gilt für alle Kameras. Nach einem Wechsel müssen die Aufzeichnungen neu indexiert werden
- **Modell für die Gesichtswiedererkennung**: gilt für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu berechnet
- **Recheneinheiten**: wo CoreML die Modelle ausführt. ALL nutzt CPU, GPU und Neural Engine; die anderen Optionen nutzen nur einen Teil davon
- **Aktive Hardware**: zeigt, wo die Modelle laufen
- **Modelle neu herunterladen**: löscht die heruntergeladenen Modelle und lädt die aktuellen erneut herunter
- **Einstellungen zurücksetzen**: setzt alle Einstellungen des Plugins auf die Standardwerte zurück
- Je Kamera, in den Gruppen „Objekterkennung“, „Gesichtserkennung“ und „Kennzeichen“: **Modell**, **Erkennungsmodell** und **OCR-Modell**. „Standard“ folgt dem empfohlenen Modell
