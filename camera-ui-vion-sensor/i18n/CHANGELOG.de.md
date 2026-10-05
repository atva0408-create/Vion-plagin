# Änderungsprotokoll

## [0.2.0]

### Hinzugefügt

- Im Grundriss lassen sich Bewegung, Kalibrierungszeit, fehlende Router-Pakete und Verbindungsstatus zusammen mit der Sensorkamera anzeigen. Die Live-Werte stammen aus dem Zwischenspeicher, ohne zusätzliche Anfragen an die Platine.
- **Anwesenheit** (Firmware 1.1.0): ein zweiter Sensor der Platine, angeboten unter „Sensoren → Gefunden“, sobald ihr Bewegungssensor hinzugefügt ist. Er erkennt auch eine still stehende Person (Algorithmus Espressif esp-radar). Seine Empfindlichkeit steht in den Einstellungen des Sensors, ebenso die Wahl, welcher Algorithmus die Bewegung liefert: ViON, Espressif oder einer von beiden.
- **Radar HLK-LD2450** an der Platine: die Positionen von bis zu drei Personen gehen an den Grundriss.
- Ein Firmware-Update, das nicht startete (die Platine kehrte selbst zurück), steht in den Einstellungen und im Protokoll.

## [0.1.0]

### Hinzugefügt

- **ViON Sensor:** ein Sicherheitssensor auf einer ESP32-CAM-Platine, der Bewegung am WLAN-Signal erkennt. Die Platine
  wird im Netz von selbst gefunden, unter „Sensoren → Gefunden“ hinzugefügt und aus ViON eingerichtet und aktualisiert;
  ihre Kamera ist optional.
