# Home Assistant

Bringt die Geräte Ihres Home Assistant in ViON und stellt ViON-Benachrichtigungen über Home Assistant zu.

## Funktionen

- Führt die nutzbaren Home-Assistant-Entitäten im Bereich „Entdeckt“ der Seite „Sensoren“ auf, mit Name, Typ und Raum; Sie übernehmen die gewünschten
- Macht aus Entitäten für Bewegung, Anwesenheit, Kontakt, Türklingel, Rauch, Wasserleck, Gas, Kohlenmonoxid und weiteren unterstützten Entitäten ViON-Sensoren, die Sie Kameras als Auslöser der Erkennung zuweisen können
- Übernimmt Schlösser, Garagentore, Alarmzentralen, Schalter, Lampen und Sirenen als Bedienelemente: Schalten in ViON schaltet sie in Home Assistant
- Bietet die Benachrichtigungsdienste von Home Assistant (Companion-App, Telegram und weitere) unter „Einstellungen“ > „Benachrichtigungen“ als Ziele an
- Behält einen Sensor samt Kamera-Zuweisungen, wenn seine Entität in Home Assistant umbenannt wird, und markiert ihn als entfernt, wenn die Entität dort gelöscht wird
- Bietet niemals Entitäten an, die ViON selbst an Home Assistant weitergegeben hat

## Voraussetzungen

- Ein langlebiges Zugriffstoken, erstellt in Ihrem Home-Assistant-Profil unter „Sicherheit“
- Keine Eingaben, wenn ViON als Add-on von Home Assistant läuft: Das Plugin verbindet sich selbst
- Für Bilder in Benachrichtigungen und das Öffnen des Ereignisses per Tipp auf die Benachrichtigung: die ViON-Integration für Home Assistant

## Einstellungen

- **URL von Home Assistant**: die Adresse Ihres Home Assistant einschließlich Port
- **Zugriffstoken**: das langlebige Zugriffstoken
- **Ausgeschlossene Entitäten**: kommagetrennte Entitäts-IDs, die nicht zur Übernahme angeboten werden sollen
