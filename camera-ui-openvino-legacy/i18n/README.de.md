# OpenVino Legacy

Objekt-, Gesichts- und Kennzeichenerkennung für ältere Intel-Grafik. Mit dem regulären OpenVino-Plugin können diese Chips die Modelle nicht laden, und jedes Modell weicht stillschweigend auf den Prozessor aus.

## Funktionen

- Objekterkennung: Personen, Fahrzeuge und Tiere
- Gesichtserkennung und Gesichtswiedererkennung
- Findet Kennzeichen und liest ihren Text
- KI-Suche per Beschreibung
- Findet ähnlich aussehende Personen über Kameras hinweg (Personen-Wiedererkennung, pro Kamera eingeschaltet) und umreißt Personen, Fahrzeuge und Tiere (Segmentierung)

## Voraussetzungen

- Verwenden Sie es anstelle des regulären OpenVino-Plugins, wenn Ihre Intel-Grafik zur 10. Core-Generation gehört oder älter ist (Gen9/Gen11-Grafik, zum Beispiel HD/UHD Graphics 610 bis 630)
- Wichtig ist es vor allem unter Windows, wo der Bestandteil, auf den diese Chips angewiesen sind, zum Grafiktreiber gehört und sich nicht separat aktualisieren lässt
- Unter Linux mit dem Docker-Image von ViON wird es meist nicht benötigt: Das Image enthält bereits, was ältere Intel-Grafik braucht
- Ab der 11. Core-Generation (Iris Xe, Arc) verwenden Sie das reguläre OpenVino-Plugin: Es ist dort schneller und erhält weiterhin Korrekturen

## Einstellungen

- „Gerät“: 'Default' ermittelt das Gerät selbst (NPU, GPU oder CPU); AUTO überlässt OpenVINO die Wahl; CPU, GPU und NPU erzwingen ein Gerät; Einträge mit Nummer wie GPU.0 und GPU.1 wählen eine von mehreren Karten.
- „Aktive Hardware“: zeigt das Gerät, auf dem die Modelle derzeit laufen
- „CLIP-Modell (Bilder)“: das Modell der KI-Suche für alle Kameras. Indexieren Sie nach einem Wechsel die Aufzeichnungen neu.
- „Modell für Gesichtswiedererkennung“: ein Modell für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu verarbeitet.
- Je Kamera: die Modelle für Objekterkennung, Gesichtserkennung und Kennzeichen. „Standard“ folgt dem empfohlenen Modell.
