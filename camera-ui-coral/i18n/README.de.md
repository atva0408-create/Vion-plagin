# Coral

Erkennt Personen, Fahrzeuge und Tiere im Kamerabild und nutzt für die Erkennung einen Coral Edge TPU als Beschleuniger.

## Funktionen

- Erkennt Personen, Fahrzeuge und Tiere im Video Ihrer Kameras
- Führt die Erkennung auf einem Coral Edge TPU aus und wechselt auf den Prozessor, wenn kein Edge TPU verfügbar ist
- Lässt Sie wählen, welcher Edge TPU verwendet wird, wenn mehrere angeschlossen sind
- Richtet sich nach den Konfidenzwerten, die in den Erkennungseinstellungen der Kamera je Objekttyp (Person, Fahrzeug, Tier) festgelegt sind
- Lädt sein Modell selbst herunter

## Voraussetzungen

- Ein ViON-Server unter Linux (x64 oder ARM64)
- Ein per USB oder PCIe angeschlossener Coral Edge TPU sowie die auf dem Server installierte Edge-TPU-Systemsoftware (libedgetpu). Ohne beides arbeitet das Plugin trotzdem, dann auf dem Prozessor

## Einstellungen

- **Edge TPU (Coral) verwenden**: Ist die Option eingeschaltet, läuft die Erkennung auf dem Coral Edge TPU, sofern er verfügbar ist; andernfalls wird der Prozessor verwendet
- **Edge-TPU-Gerät**: welcher Edge TPU verwendet wird, wenn mehrere angeschlossen sind: "usb", "pci", ":0", ":1" oder "usb:0". Lassen Sie das Feld leer, um den ersten verfügbaren zu verwenden
- **Aktive Hardware**: zeigt, wo die Modelle laufen
- **Modelle neu herunterladen**: löscht die heruntergeladenen Modelle und lädt die aktuellen erneut herunter
- **Einstellungen zurücksetzen**: setzt alle Einstellungen des Plugins auf die Standardwerte zurück
- **Modell**: wird je Kamera in der Gruppe „Objekterkennung“ festgelegt. „Standard“ folgt dem empfohlenen Modell
