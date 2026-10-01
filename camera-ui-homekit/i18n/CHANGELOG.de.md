## [1.3.4]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.3.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.3.2]

- **Das Livebild von unterwegs bleibt sauber.** Das Video wurde in größeren Stücken gesendet, als die Home-App angefordert hatte, sodass das Bild unterwegs immer stärker gestört wurde
- Die Bridge warnt nicht mehr, dass keine Serveradresse gesetzt ist, wenn eine Adresse gesetzt, auf diesem Rechner aber nicht vorhanden ist. Die Warnung nennt jetzt die ignorierte Adresse und die Adressen, die das Plugin findet

## [1.3.1]

- **Eine Kamera, die ihr Videoformat wechselt, wird wieder übernommen.** Wurde der Hauptstream einer Kamera bei laufendem ViON von H.264 auf H.265 umgestellt, zeichnete HomeKit einen H.265-Stream auf, der als H.264 gekennzeichnet war, und Apple verwarf die Aufzeichnung kurz nach dem Start. Das Gerät folgt jetzt der Änderung
- **Sauberer Ton im lokalen Livebild unter iOS 27.** HEVC-Kameras mit dem neuen Secure Video konnten zu Hause verzerrt klingen. Der Ton wird jetzt so gesendet, wie Apple es dort erwartet; die Wiedergabe von unterwegs war nicht betroffen

## [1.3.0]

- **HomeKit Secure Video für iOS 27.** Kameras mit HEVC-Hauptstream (H.265) nutzen die neuen Secure-Video-Dienste von Apple: Livebild zu Hause und unterwegs, Aufzeichnung und Gegensprechen laufen auf dem ursprünglichen HEVC-Stream der Kamera, ohne ihn umzukodieren, sodass eine 4K-Kamera nicht mehr jeweils einen Prozessorkern belegt. Erfordert iOS 27 / tvOS 27 auf dem Wiedergabegerät und auf der Steuerzentrale. Die Wiedergabe von unterwegs unterstützt Apple nur mit HEVC, H.264-Kameras bleiben im klassischen Modus
- **Klassischen Modus erzwingen.** Ein Schalter pro Kamera in den erweiterten Einstellungen hält eine Kamera bei den klassischen HomeKit-Diensten, für Haushalte, die bei iOS 26 oder älter bleiben
- Ein fehlgeschlagener Start löscht die Kopplung einer Kamera nicht mehr. Zuvor entfernte ein Fehler beim Bekanntmachen der Kamera während des Starts das Gerät samt Kopplung, sodass die Kamera erneut zu Home hinzugefügt werden musste

## [1.2.11]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.10]

- Fehlerbehebungen und Verbesserungen

## [1.2.9]

- Fehlerbehebungen und Verbesserungen

## [1.2.8]

- Wenn ein Livebild endet, meldet eine Zeile im Protokoll, was das Apple-Gerät über die Verbindung gemessen hat: Paketverlust, Jitter, Umlaufzeit und Anforderungen eines Vollbilds. Hat das Gerät keine Berichte gesendet, steht das in der Zeile
- Kleinere Fehlerbehebungen und Verbesserungen

## [1.2.7]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.5]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.4]

- Eine veraltete Netzwerkadresse stoppt die Bridge nicht mehr. Ist in ViON eine Adresse eingestellt, die der Rechner nicht mehr hat (geänderte IP-Adresse, alte Konfiguration), überspringen die Bridge und die Kameras diese Adresse mit einer Warnung und bleiben über die übrigen erreichbar, statt nicht zu starten

## [1.2.3]

- Neue Sensortypen erreichen HomeKit. Sensoren für Kohlenmonoxid, Kohlendioxid (Wert plus Alarm über 1500 ppm), Helligkeit und Vibration erscheinen jetzt in der Home-App; Vibration wird als Bewegungssensor angezeigt, weil HomeKit keine Kategorie für Vibration kennt. Sensoren für Gas, Hitze, Kälte, Sabotage, Störung und Stromversorgung bleiben nur in ViON, HomeKit hat keinen passenden Gerätetyp

## [1.2.2]

- Kleinere Fehlerbehebungen und Verbesserungen

## [1.2.1]

- Die Home-App findet die Bridge wieder. Sie meldete sich unter einem Namen, mit dem das Netzwerk nicht zurechtkam, sodass Home sie nie sah und die Kopplung per QR-Code in eine Zeitüberschreitung lief. Die Bridge wurde umbenannt
- Die Bridge startet jetzt auch, wenn noch kein Sensor freigegeben ist. QR-Code, PIN und Port sind ab dem ersten Start vorhanden, sodass Sie die Bridge vorab koppeln können und später freigegebene Sensoren sofort in der Home-App erscheinen

## [1.2.0]

- Neue Bridge für eigenständige Sensoren. Kontakt-, Präsenz-, Rauch-, Leck-, Temperatur- und Feuchtigkeitssensoren, Schlösser, Garagentore, Schalter und Sicherheitssysteme sowie eigenständige Lichter und Sirenen kommen über eine einzige Bridge. Koppeln Sie sie einmal, und jeder später freigegebene Sensor kommt automatisch hinzu. QR-Code, PIN, Port und eine Schaltfläche zum Zurücksetzen befinden sich in den Plugin-Einstellungen
- Kameras in der Home-App zeigen jetzt die Ausstattung der Kamera: Scheinwerfer, Sirene und Akku erscheinen an der Kamera selbst, neben Bewegung und Türklingel
- Der Schalter „Sensor freigeben“ auf der Seite „Sensoren“ bestimmt, was HomeKit erreicht. Ausschalten entfernt den Sensor, Einschalten bringt ihn zurück
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.7]

- Neue Kameraeinstellung zum Ausschalten der Hardwarebeschleunigung

## [1.1.6]

- Deaktivierte und nicht erreichbare Kameras bleiben in HomeKit und zeigen ein Platzhalterbild, statt zu verschwinden. Schnappschüsse und Livebild zeigen „Privatmodus“ für deaktivierte Kameras, „offline“ für nicht verbundene und ein Ersatzbild, wenn kein Schnappschuss vorhanden ist
- Aufzeichnungen mit HomeKit Secure Video und das Livebild werden nach Wiederholungen, erneuten Verbindungen und fehlgeschlagenen Starts zuverlässig beendet. Lange laufende Systeme verbrauchen nicht mehr immer mehr Prozessorleistung und Arbeitsspeicher, wenn eine Kamera ständig ausfällt

## [1.1.5]

- Fehlerbehebungen und Verbesserungen

## [1.1.4]

- Fehlerbehebungen und Verbesserungen

## [1.1.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.2]

- Fehlerbehebungen und Verbesserungen

## [1.1.1]

- Fehlerbehebungen und Verbesserungen

## [1.1.0]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.2]

- Fehlerbehebungen und Verbesserungen

## [1.0.1]

- Fehlerbehebungen und Verbesserungen

## [1.0.0]

- Erste Version
