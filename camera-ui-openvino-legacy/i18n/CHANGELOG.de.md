## [1.3.0]

- Ähnlich aussehende Personen lassen sich über Kameras hinweg finden, zusammen mit ViON NVR 0.12.0: Wählen Sie dieses Plugin in den Einstellungen der Kamera → Plugins → Sensor-Typen → „Personen-Wiedererkennung“. Es merkt sich, wie Kleidung und Statur einer Person aussehen, nicht wer sie ist. Das Modell lädt mit der ersten Person, die eine solche Kamera sieht, nicht beim Start
- Die Suche nach Bild findet zuerst die größte Person auf dem Bild und schneidet sie aus, so wie der Server die Personen aus den Bildern schneidet
- Segmentierung: Das Plugin umreißt Personen, Fahrzeuge und Tiere, auf seiner Seite und für den Server; auch dieses Modell lädt erst, wenn es zum ersten Mal gebraucht wird
- Benötigt ViON 2.3.14 oder neuer: Beim Hinzufügen des Plugins zu einer Kamera bleibt die Personen-Wiedererkennung dort ausgeschaltet

## [1.2.22]

- Eine nicht mehr ausgelieferte Modulversion wird entladen, und ein aktualisiertes Modul aus dem Store wird neu geladen: beides brach seit 1.4.4 mit einem Fehler ab

## [1.2.21]

- Trainingsmodule aus der ViON Cloud: Der Detektor eines Objektmoduls (zum Beispiel „Fahrrad“) läuft neben dem Detektor der Kamera auf den Kameras, für die das Modul in ViON eingeschaltet ist, und die Klassifikatoren der Fragemodule laufen nur auf ihren Kameras; eine nicht mehr ausgelieferte Modulversion wird entladen

## [1.2.20]

- Detektormodule aus dem ViON-Store: ein im Store unter „Module“ installiertes Modul erscheint unter den Objektmodellen dieses Plugins und wird wie diese verwendet; ein aktualisiertes Modul wird neu geladen

## [1.2.19]

- Die Objekterkennung bekommt Bilder in der Größe, die das gewählte Modell erwartet: Sie bekam 320×320 unabhängig vom Modell, und ein Modellwechsel konnte den Detektor doppelt stoppen und starten

## [1.2.18]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.2.17]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.16]

- Erfordert ViON 2.2.5 oder neuer
- **Wählen Sie nach dem Update dieses Plugin für die Gesichtswiedererkennung jeder Kamera aus** (Kameraeinstellungen, „Plugins“, „Erkennungen“). Bis dahin werden Gesichter erkannt, aber nicht benannt. Seine neuen Gesichtsmodelle lädt das Plugin beim ersten Start herunter.
- **Die Gesichtswiedererkennung ist jetzt ein eigener Sensor und richtet das Gesicht vor dem Wiedererkennen aus.** Sie erkennt deutlich mehr Personen wieder, und ein Gesicht von der Seite oder steil von oben erhält keinen Namen statt eines falschen. Das Wiedererkennungsmodell wird einmal für das ganze Plugin festgelegt; die gespeicherten Bilder der Personen verarbeitet ViON von selbst neu.
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.15]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.14]

- Kleinere Fehlerbehebungen

## [1.2.13]

- **Kennzeichen werden wieder gelesen.** Jede Lesung wurde als unlesbar bewertet und verworfen, bevor sie ein Ereignis erreichte, ganz gleich, was die Kamera sah. Falls Sie die Lesekonfidenz in den Kameraeinstellungen gesenkt haben, um das zu umgehen, stellen Sie sie wieder zurück.

## [1.2.11]

- Das CLIP-Modell für die semantische Suche ist jetzt eine einzige Plugin-Einstellung statt einer Auswahl je Kamera
- Die Objekterkennung richtet sich nach den Konfidenzwerten je Typ (Person, Fahrzeug, Tier) aus den Kameraeinstellungen

## [1.2.10]

- Die Konfidenzschwellen wurden aus den Plugin-Einstellungen entfernt. Objekt-, Gesichts- und Kennzeichenerkennung verwenden jetzt die Werte aus den Erkennungseinstellungen der Kamera; sie werden also an einer Stelle festgelegt, und eine Änderung wirkt sofort.
- Das Plugin meldet, welches Modell geladen ist und auf welchem Gerät es läuft, sodass ViON dies in den Metriken der Kamera anzeigen kann

## [1.2.8]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.7]

- **Das empfohlene Modell für die Gesichtserkennung hat sich geändert.** Hinter der Option „Standard“ steht jetzt ein stärkeres Modell: In Testaufnahmen findet es in 82 % der Bilder ein Gesicht, in denen das bisherige 30 % schaffte, und es hält einen Hinterkopf nicht mehr für ein Gesicht. Ihre aktuelle Auswahl bleibt unverändert. Neue Installationen erhalten es sofort; in einer bestehenden wählen Sie „Standard“ in der Modellliste oder verwenden „Einstellungen zurücksetzen“. Eine Gesichtsprüfung kostet dann etwa doppelt so viel Rechenleistung und läuft nur, wenn eine Person gesehen wurde.

## [1.2.6]

- **Eine Schaltfläche „Einstellungen zurücksetzen“ in jedem Einstellungsbereich.** Ein Klick setzt alle Werte des Bereichs auf die Standardwerte zurück, einschließlich der Modelle.
- **Eine neue Auswahl „Standard“ in jeder Modellliste.** Sie folgt dem empfohlenen Modell für die jeweilige Aufgabe, sodass Plugin-Updates die Wahl automatisch verbessern können. Wer ein bestimmtes Modell wählt, legt es weiterhin fest. Bestehende Installationen behalten ihre aktuelle Auswahl.
- **Fünf neue Modelle für die Gesichtserkennung.** Kleine und mittlere Größen sowie 640-px-Varianten jeder Größe (t, s, m). Die 640-px-Modelle finden kleine und weit entfernte Gesichter, die das 320-px-Standardmodell übersieht, bei höherem Rechenaufwand. Das Standardmodell bleibt unverändert.

## [1.2.5]

- Lehnt die GPU ein Modell auch mit diesem Plugin ab, empfiehlt das Protokoll nicht mehr ausgerechnet dieses Plugin als Ausweg

## [1.2.4]

- Erste Veröffentlichung. Dieselben Funktionen wie das OpenVino-Plugin, aber auf dem älteren OpenVINO 2024.6 für Intel-Grafik bis zur 10. Core-Generation. Auf diesen Chips kann die aktuelle OpenVINO-Version die Grafik nicht nutzen, und die Erkennung lief stillschweigend auf dem Prozessor; mit diesem Plugin laden die Modelle wieder auf der GPU.
