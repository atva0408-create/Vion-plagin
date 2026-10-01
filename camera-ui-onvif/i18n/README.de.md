# Onvif

Bindet Kameras, die den ONVIF-Standard unterstützen, in ViON ein. Das Plugin findet sie im Netzwerk, übernimmt ihre Videostreams und reicht die Ereignisse und die PTZ-Steuerung weiter, die die Kamera selbst anbietet.

## Funktionen

- Findet ONVIF-Kameras im lokalen Netzwerk und zeigt sie in der Liste der entdeckten Kameras
- Fügt die Kamera mit ihren Videostreams in hoher, mittlerer und niedriger Qualität und ihrem Snapshot hinzu, soweit die Kamera sie anbietet
- Steuert PTZ-Kameras: Schwenken, Neigen, Zoom und die auf der Kamera gespeicherten Presets; Presets, die Sie in der App der Kamera anlegen oder umbenennen, erscheinen innerhalb einer Minute
- Reicht weiter, was die Kamera selbst erkennt: Bewegung, Personen, Fahrzeuge und Tiere, Geräusche und Gesichter
- Verbindet sich von selbst neu, wenn eine Kamera nicht erreichbar war

## Voraussetzungen

- Eine Kamera mit ONVIF-Unterstützung, die vom ViON-Server aus über das Netzwerk erreichbar ist
- Benutzername und Passwort des ONVIF-Kontos der Kamera
- Ereignisse und PTZ erscheinen nur, wenn die Kamera sie selbst unterstützt

## Einstellungen

- **Benutzername** und **Passwort**: das ONVIF-Konto der Kamera. Sie werden beim Hinzufügen der Kamera abgefragt
- **URL**: die Adresse der Kamera. Ändern Sie sie, wenn die Kamera eine neue Adresse bekommt
- **Neu verbinden**: baut die Verbindung zur Kamera neu auf
- Die Sensoreinstellungen zeigen zur Information, welche **Ereignisthemen** der Kamera einen Sensor speisen, und für PTZ die **Achsen**, **Bewegungsarten** und **Presets** der Kamera
