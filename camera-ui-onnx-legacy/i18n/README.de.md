# ONNX Legacy

Objekt-, Gesichts- und Kennzeichenerkennung für ältere NVIDIA-Grafikkarten und für Systeme, die bei CUDA 12 bleiben. Mit dem regulären ONNX-Plugin weicht die Erkennung auf diesen Karten stillschweigend auf den Prozessor aus.

## Funktionen

- Objekterkennung: Personen, Fahrzeuge und Tiere
- Gesichtserkennung und Gesichtswiedererkennung
- Findet Kennzeichen und liest ihren Text
- KI-Suche per Beschreibung

## Voraussetzungen

- Verwenden Sie es anstelle des regulären ONNX-Plugins, wenn Ihre NVIDIA-Karte älter als eine GTX 1650 ist: Maxwell (GTX-700/900-Serie), Pascal (GTX-10-Serie, Quadro P400 bis P4000, Tesla P4/P40/P100) oder Volta (Titan V, Tesla V100)
- Oder wenn Sie ein installiertes CUDA 12 behalten möchten
- CUDA 12.x, cuDNN 9.x für CUDA 12 und NVIDIA-Treiber 525 oder neuer
- Linux oder Windows
- Auf einer GTX 1650 oder neuer verwenden Sie das reguläre ONNX-Plugin: Es arbeitet mit CUDA 13, unterstützt die RTX-50-Serie nativ und erhält weiterhin Korrekturen

## Einstellungen

- „Ausführungsanbieter“: 'auto' nutzt CUDA unter Linux und Windows (x86_64), sonst den Prozessor; mit 'tensorrt' (NVIDIA TensorRT) dauert der erste Start länger. Bei einem Fehler übernimmt der Prozessor.
- „CUDA-Geräte-IDs“: welche Grafikkarten verwendet werden, zum Beispiel "0,1"
- „CLIP-Modell (Bilder)“: das Modell der KI-Suche für alle Kameras. Indexieren Sie nach einem Wechsel die Aufzeichnungen neu.
- „Modell für Gesichtswiedererkennung“: ein Modell für alle Kameras. Nach einem Wechsel werden die gespeicherten Gesichter neu verarbeitet.
- Je Kamera: die Modelle für Objekterkennung, Gesichtserkennung und Kennzeichen. „Standard“ folgt dem empfohlenen Modell.
