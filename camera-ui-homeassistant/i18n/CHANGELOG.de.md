## [1.0.18]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.0.17]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.16]

- **Home-Assistant-Entitäten werden wieder zur Übernahme angeboten.** Ein einzelnes Gerät mit Zahlen in seinen Kennungen oder eine Entität, deren Name nur aus einer Zahl bestand, ließ die gesamte Suche scheitern.

## [1.0.15]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.14]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.13]

- **Ein Tipp auf die Benachrichtigung öffnet das Ereignis.** Die Home-Assistant-App springt in das ViON-Panel, direkt zur Zeitleiste der Kamera im Moment der Erkennung. Erfordert die ViON-Integration für Home Assistant mit dem Panel in der Seitenleiste; ohne sie öffnet der Tipp weiterhin nur die App.

## [1.0.12]

**Erfordert ViON 2.1.13 oder neuer.**

- **Übernommene Entitäten bleiben übernommen, auch nach einem Neustart des Plugins oder von ViON.** Die Liste führt jetzt ViON, das Plugin kann sie nicht mehr verlieren.
- **Wird eine Entität in Home Assistant umbenannt, bleibt der Sensor erhalten**, samt Kamera-Zuweisungen, Automatisierungen und Verlauf.
- **In Home Assistant gelöschte Entitäten werden in ViON als entfernt markiert.** Sie bleiben mit allem, was ihnen zugewiesen ist, bestehen, bis Sie sie auch auf der Seite „Sensoren“ löschen.
- **Bilder in Benachrichtigungen erscheinen auf dem Telefon.** Ohne Fernzugriff ließ sich das Bild nur im Heimnetz laden, Home-Assistant-Benachrichtigungen kamen deshalb meist ohne Bild an. Bilder werden jetzt über Home Assistant selbst geladen. Erfordert die ViON-Integration für Home Assistant 0.4.0.
- **Eine Push-Nachricht pro Telefon.** Das Plugin bot den Sammeldienst für Benachrichtigungen von Home Assistant, den eigenen Dienst des Telefons und die Benachrichtigungs-Entität des Telefons als drei getrennte Ziele an, eine Benachrichtigung kam deshalb bis zu dreimal an. Jetzt werden nur noch echte Geräte als Ziele aufgeführt. Folgemeldungen zum selben Ereignis ersetzen die Benachrichtigung, statt sich zu stapeln, und stille Aktualisierungen bleiben still.
- Einmalig nach diesem Update: Mit Version 1.0.11 übernommene Entitäten erscheinen wieder als entdeckt, ihre alten Einträge werden als entfernt markiert. Löschen Sie die alten Einträge und übernehmen Sie die Entitäten erneut.

## [1.0.11]

- Entitäten werden jetzt nach Ihrer Auswahl importiert. Statt jede Entität zu importieren, die es versteht, führt das Plugin sie im Bereich „Entdeckt“ der Seite „Sensoren“ auf, mit Name, Typ und Raum. Sie wählen aus, was übernommen wird; das Löschen eines Sensors dort beendet dessen Import dauerhaft. Das gilt auch für Entitäten, die frühere Versionen importiert haben: Nach dem Update erscheinen sie alle wieder als entdeckt, wählen Sie also die aus, die Sie tatsächlich nutzen. Ihre alten Einträge werden automatisch bereinigt, eine erneut übernommene Entität beginnt daher neu, ohne frühere Kamera-Zuweisungen. Erfordert ViON 2.1.11 oder neuer.

## [1.0.10]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.8]

- Die Protokollmeldung über importierte Entitäten erscheint jetzt nur noch beim Start und wenn tatsächlich Entitäten hinzugekommen oder entfallen sind, statt sich alle paar Minuten zu wiederholen
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.7]

- **Verbindung innerhalb des Home-Assistant-Add-ons behoben.** Dem Add-on fehlte die Berechtigung für den Zugriff auf Home Assistant, die automatische Verbindung wurde deshalb stets mit der Meldung „rejected the access token“ abgelehnt. Aktualisieren Sie das ViON-Add-on auf 0.1.7, dann funktioniert die Verbindung wieder ohne jede Konfiguration.
- **Eine manuell eingetragene URL und ein Token haben jetzt Vorrang vor der Add-on-Verbindung.** Zuvor hatte die automatische Verbindung des Add-ons immer Vorrang, eigene Zugangsdaten blieben daher wirkungslos.
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.6]

- **Benachrichtigungs-Entitäten funktionieren als Ziele.** Benachrichtigungs-Entitäten von Home Assistant erscheinen jetzt unter „Einstellungen“ > „Benachrichtigungen“. Ein Ziel, an das der Versand immer mit einem Fehler scheiterte, wird nicht mehr angezeigt. Diese Ziele übertragen nur Titel und Text; ein Bild nimmt Home Assistant dort nicht an.

## [1.0.5]

**Erfordert ViON 2.1.3 oder neuer. Wenn Sie die ViON-Integration in Home Assistant nutzen, aktualisieren Sie auch diese.**

- **Importierte Sensoren überfluten Home Assistant nicht mehr mit ViON-Geräten.** Importierte Sensoren werden standardmäßig nicht mehr an andere Systeme weitergegeben und mit ihrer Herkunft gekennzeichnet. Die ViON-Integration und die MQTT-Anbindung senden sie daher nie zurück an Home Assistant, auch wenn Sie sie an andere Systeme wie HomeKit weitergeben. Bestehende Importe werden beim nächsten Start des Plugins gekennzeichnet; laden Sie die ViON-Integration in Home Assistant einmal neu, um die überzähligen Geräte zu entfernen.

## [1.0.4]

- **Importschleife mit der MQTT-Anbindung von ViON behoben.** Sensoren, die ViON an Home Assistant weitergegeben hatte, konnten sofort wieder importiert werden, wodurch endlos Duplikate entstanden. Neue Entitäten werden jetzt nur noch nach einer Prüfung übernommen, die von ViON selbst weitergegebene Sensoren erkennt; ist diese Prüfung nicht möglich, pausiert der Import, statt ungeprüft weiterzulaufen.

## [1.0.3]

- Fehlerbehebungen

## [1.0.2]

- **Benachrichtigungsdienste von Home Assistant stellen ViON-Benachrichtigungen zu.** Unter „Einstellungen“ > „Benachrichtigungen“ bietet das Plugin jetzt jeden Benachrichtigungsdienst, den Home Assistant kennt (Companion-App, Sprachausgabe, Telegram und weitere), als Ziel an. Wählen Sie einen Dienst, und ViON-Meldungen kommen auf diesem Kanal mit Titel, Text und Bild an.

## [1.0.1]

- Kleinere Korrekturen und Verbesserungen

## [1.0.0]

- Erste Veröffentlichung
