# ONNX

Erkennt Objekte, Gesichter und Kennzeichen im Kamerabild und macht Aufzeichnungen per Beschreibung durchsuchbar. Es läuft auf einer NVIDIA-Grafikkarte oder, wenn keine vorhanden ist, auf dem Prozessor.

## Funktionen

- Objekterkennung: Personen, Fahrzeuge und Tiere
- Gesichtserkennung und Gesichtswiedererkennung
- Findet Kennzeichen und liest ihren Text
- KI-Suche per Beschreibung; mit dem mehrsprachigen Modell auch auf Russisch und in rund 100 weiteren Sprachen
- Nutzt einen Detektor, den ViON Cloud mit den von Ihnen geprüften Bildern nachtrainiert hat, sobald er veröffentlicht ist
- Beantwortet Ja/Nein-Fragen zu einem erkannten Objekt, auf die es trainiert wurde, zum Beispiel „Person mit Tüte“
- Kann mehrere NVIDIA-Grafikkarten gleichzeitig nutzen

## Voraussetzungen

- Linux oder Windows
- Für eine NVIDIA-Grafikkarte: CUDA 13, cuDNN 9 für CUDA 13 und NVIDIA-Treiber 580 oder neuer
- Für NVIDIA-Karten, die älter als die GTX 1650 sind (Maxwell, Pascal, Volta), und für Systeme, die bei CUDA 12 bleiben, verwenden Sie stattdessen das Plugin ONNX Legacy

## Einstellungen

- „Ausführungsanbieter“: 'auto' nutzt CUDA unter Linux und Windows (x86_64), sonst den Prozessor; mit 'tensorrt' (NVIDIA TensorRT) dauert der erste Start länger. Bei einem Fehler übernimmt der Prozessor.
- „CUDA-Geräte-IDs“: welche Grafikkarten verwendet werden, zum Beispiel "0,1"
- „CLIP-Modell (Bilder)“: das Modell der KI-Suche für alle Kameras. Indexieren Sie nach einem Wechsel die Aufzeichnungen neu.
- „Modell für Gesichtswiedererkennung“: ein Modell für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu verarbeitet.
- Je Kamera: die Modelle für Objekterkennung, Gesichtserkennung und Kennzeichen. „Standard“ folgt dem empfohlenen Modell.
