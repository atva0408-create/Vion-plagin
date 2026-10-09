# OpenVino

Erkennt Objekte, Gesichter und Kennzeichen im Kamerabild und macht Aufzeichnungen per Beschreibung durchsuchbar. Es ist für Intel-Hardware optimiert: Prozessor, Intel-Grafik oder Intel NPU.

## Funktionen

- Objekterkennung: Personen, Fahrzeuge und Tiere
- Gesichtserkennung und Gesichtswiedererkennung
- Findet Kennzeichen und liest ihren Text
- KI-Suche per Beschreibung; mit dem mehrsprachigen Modell auch auf Russisch und in rund 100 weiteren Sprachen
- Findet ähnlich aussehende Personen über Kameras hinweg (Personen-Wiedererkennung, pro Kamera eingeschaltet) und umreißt Personen, Fahrzeuge und Tiere (Segmentierung)
- Nutzt einen Detektor, den ViON Cloud mit den von Ihnen geprüften Bildern nachtrainiert hat, sobald er veröffentlicht ist
- Beantwortet Ja/Nein-Fragen zu einem erkannten Objekt, auf die es trainiert wurde, zum Beispiel „Person mit Tüte“
- Lässt Sie in Systemen mit mehreren Grafikkarten das genaue Gerät wählen

## Voraussetzungen

- Linux oder Windows
- Unter Windows mit Intel-Grafik bis zur 10. Core-Generation (HD/UHD Graphics 610 bis 630) verwenden Sie stattdessen das Plugin OpenVino Legacy: Die Treiber dieser Chips funktionieren nicht mit der aktuellen OpenVINO-Version

## Einstellungen

- „Gerät“: 'Default' ermittelt das Gerät selbst (NPU, GPU oder CPU); AUTO überlässt OpenVINO die Wahl; CPU, GPU und NPU erzwingen ein Gerät; Einträge mit Nummer wie GPU.0 und GPU.1 wählen eine von mehreren Karten.
- „Aktive Hardware“: zeigt das Gerät, auf dem die Modelle derzeit laufen
- „CLIP-Modell (Bilder)“: das Modell der KI-Suche für alle Kameras. Indexieren Sie nach einem Wechsel die Aufzeichnungen neu.
- „Modell für Gesichtswiedererkennung“: ein Modell für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu verarbeitet.
- Je Kamera: die Modelle für Objekterkennung, Gesichtserkennung und Kennzeichen. „Standard“ folgt dem empfohlenen Modell.
