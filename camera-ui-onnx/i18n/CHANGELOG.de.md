## Noch nicht veröffentlicht

- Bei einem fehlgeschlagenen Modul-Update bleibt der funktionierende Detektor aktiv. Parallele Updates erzeugen einen Ersatz, überholte Ladevorgänge werden verworfen und die Eingangsgröße der Kamera wird nach dem Wechsel aktualisiert.
- Ein nach dem Stoppen oder Providerwechsel abgeschlossener Ladevorgang aktiviert die alte Sitzung nicht erneut.

## [1.5.0]

- Ähnlich aussehende Personen lassen sich über Kameras hinweg finden, zusammen mit ViON NVR 0.12.0: Wählen Sie dieses Plugin in den Einstellungen der Kamera → Plugins → Sensor-Typen → „Personen-Wiedererkennung“. Es merkt sich, wie Kleidung und Statur einer Person aussehen, nicht wer sie ist. Das Modell lädt mit der ersten Person, die eine solche Kamera sieht, nicht beim Start
- Die Suche nach Bild findet zuerst die größte Person auf dem Bild und schneidet sie aus, so wie der Server die Personen aus den Bildern schneidet
- Segmentierung: Das Plugin umreißt Personen, Fahrzeuge und Tiere, auf seiner Seite und für den Server; auch dieses Modell lädt erst, wenn es zum ersten Mal gebraucht wird
- Benötigt ViON 2.4.0 oder neuer: Beim Hinzufügen des Plugins zu einer Kamera bleibt die Personen-Wiedererkennung dort ausgeschaltet

## [1.4.6]

- Eine nicht mehr ausgelieferte Modulversion wird entladen, und ein aktualisiertes Modul aus dem Store wird neu geladen: beides brach seit 1.4.4 mit einem Fehler ab

## [1.4.5]

- Trainingsmodule aus der ViON Cloud: Der Detektor eines Objektmoduls (zum Beispiel „Fahrrad“) läuft neben dem Detektor der Kamera auf den Kameras, für die das Modul in ViON eingeschaltet ist, und die Klassifikatoren der Fragemodule laufen nur auf ihren Kameras; eine nicht mehr ausgelieferte Modulversion wird entladen

## [1.4.4]

- Detektormodule aus dem ViON-Store: ein im Store unter „Module“ installiertes Modul erscheint unter den Objektmodellen dieses Plugins und wird wie diese verwendet; ein aktualisiertes Modul wird neu geladen

## [1.4.3]

- Die Objekterkennung bekommt Bilder in der Größe, die das gewählte Modell erwartet: Sie bekam 320×320 unabhängig vom Modell, und ein Modellwechsel konnte den Detektor doppelt stoppen und starten

## [1.4.2]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.4.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.4.0]

- **Von ViON trainierte Modelle.** Hat ViON Cloud einen Detektor veröffentlicht, der mit den von Ihnen geprüften Bildern nachtrainiert wurde, wechselt die Einstellung „Standard“ des Objektmodells von selbst darauf, ohne Neustart. Eigene Kategorien aus dem Editor „Training“ (zum Beispiel „Fahrrad“) kommen mit dem Modell. Lässt sich ein Modell nicht laden, bleibt die Kamera nicht ohne Objekterkennung: Es arbeitet das Standardmodell.
- **Objektmerkmale.** Ein neuer Klassifikator „ViON: признаки“ (Merkmale): Trainierte Klassifikatoren beantworten Fragen wie „Person · mit Tüte“ (ja / nein); die Antwort wird im Ereignis als Attribut gespeichert. ViON schaltet ihn auf den Kameras, auf denen dieses Plugin Objekte erkennt, von selbst ein.

## [1.3.0]

- **Suche auf Russisch.** Ein neues Suchmodell, das mehrsprachige SigLIP: Anfragen in der KI-Suche der Aufzeichnungen können auf Russisch (und in rund 100 weiteren Sprachen) geschrieben werden, ohne Übersetzung. Das Modell wählen Sie in der Plugin-Einstellung „CLIP-Modell (Bilder)“; nach dem Wechsel des Modells klicken Sie auf „Suche neu indexieren“.
- Die CLIP-Modelle in den Einstellungen tragen jetzt Bezeichnungen, die zeigen, welche nur englische Anfragen verstehen

## [1.2.15]

- Erfordert ViON 2.2.5 oder neuer
- **Wählen Sie nach dem Update dieses Plugin für die Gesichtswiedererkennung jeder Kamera aus** (Kameraeinstellungen, „Plugins“, „Erkennungen“). Bis dahin werden Gesichter erkannt, aber nicht benannt. Seine neuen Gesichtsmodelle lädt das Plugin beim ersten Start herunter.
- **Die Gesichtswiedererkennung ist jetzt ein eigener Sensor und richtet das Gesicht vor dem Wiedererkennen aus.** Sie erkennt deutlich mehr Personen wieder, und ein Gesicht von der Seite oder steil von oben erhält keinen Namen statt eines falschen. Das Wiedererkennungsmodell wird einmal für das ganze Plugin festgelegt; die gespeicherten Bilder der Personen verarbeitet ViON von selbst neu.
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.14]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.13]

- **TensorRT ist nach einem Modell- oder Plugin-Update schneller bereit.** Die Messwerte der vorherigen Vorbereitung bleiben erhalten und werden wiederverwendet.
- **Fehlen die TensorRT-Bibliotheken, nennt das Protokoll jetzt das passende Docker-Image.** Ist 'tensorrt' gewählt, verweist es auf das ViON-Image mit NVIDIA-Unterstützung (TensorRT), das sie enthält.
- Kleinere Fehlerbehebungen

## [1.2.12]

- **Lässt sich CUDA nicht laden, nennt das Protokoll jetzt das passende Docker-Image.** Dieses Plugin benötigt die CUDA-13-Bibliotheken: das ViON-Image mit NVIDIA-Unterstützung (CUDA) und den NVIDIA-Treiber 580 oder neuer auf dem Host. Auf einem System mit CUDA 12 verwenden Sie das ViON-Image mit NVIDIA-Unterstützung (CUDA 12) zusammen mit dem Plugin ONNX Legacy.

## [1.2.11]

- **Kennzeichen werden wieder gelesen.** Jede Lesung wurde als unlesbar bewertet und verworfen, bevor sie ein Ereignis erreichte, ganz gleich, was die Kamera sah. Falls Sie die Lesekonfidenz in den Kameraeinstellungen gesenkt haben, um das zu umgehen, stellen Sie sie wieder zurück.

## [1.2.9]

- Für die semantische Suche steht ein zweites CLIP-Modell zur Verfügung, und das Modell ist jetzt eine einzige Plugin-Einstellung statt einer Auswahl je Kamera. Nach dem Wechsel bietet die Ansicht der Aufzeichnungen an, die vorhandenen Ereignisse neu zu indexieren, damit auch ältere Aufzeichnungen durchsuchbar bleiben.
- Die Objekterkennung richtet sich nach den Konfidenzwerten je Typ (Person, Fahrzeug, Tier) aus den Kameraeinstellungen

## [1.2.8]

- Die Konfidenzschwellen wurden aus den Plugin-Einstellungen entfernt. Objekt-, Gesichts- und Kennzeichenerkennung verwenden jetzt die Werte aus den Erkennungseinstellungen der Kamera; sie werden also an einer Stelle festgelegt, und eine Änderung wirkt sofort.
- Das Plugin meldet, welches Modell geladen ist und auf welchem Gerät es läuft, sodass ViON dies in den Metriken der Kamera anzeigen kann

## [1.2.6]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.5]

- **Das empfohlene Modell für die Gesichtserkennung hat sich geändert.** Hinter der Option „Standard“ steht jetzt ein stärkeres Modell: In Testaufnahmen findet es in 82 % der Bilder ein Gesicht, in denen das bisherige 30 % schaffte, und es hält einen Hinterkopf nicht mehr für ein Gesicht. Ihre aktuelle Auswahl bleibt unverändert. Neue Installationen erhalten es sofort; in einer bestehenden wählen Sie „Standard“ in der Modellliste oder verwenden „Einstellungen zurücksetzen“. Eine Gesichtsprüfung kostet dann etwa doppelt so viel Rechenleistung und läuft nur, wenn eine Person gesehen wurde.

## [1.2.4]

- **Eine Schaltfläche „Einstellungen zurücksetzen“ in jedem Einstellungsbereich.** Ein Klick setzt alle Werte des Bereichs auf die Standardwerte zurück, einschließlich der Modelle.
- **Eine neue Auswahl „Standard“ in jeder Modellliste.** Sie folgt dem empfohlenen Modell für die jeweilige Aufgabe, sodass Plugin-Updates die Wahl automatisch verbessern können. Wer ein bestimmtes Modell wählt, legt es weiterhin fest. Bestehende Installationen behalten ihre aktuelle Auswahl.
- **Fünf neue Modelle für die Gesichtserkennung.** Kleine und mittlere Größen sowie 640-px-Varianten jeder Größe (t, s, m). Die 640-px-Modelle finden kleine und weit entfernte Gesichter, die das 320-px-Standardmodell übersieht, bei höherem Rechenaufwand. Das Standardmodell bleibt unverändert.

## [1.2.3]

- Das Plugin ist auf CUDA 13 umgestiegen. Die RTX-50-Serie wird jetzt nativ unterstützt. Ihr System benötigt CUDA 13, cuDNN 9 für CUDA 13 und den NVIDIA-Treiber 580 oder neuer.
- NVIDIA-Grafikkarten vor der GTX 1650 (Maxwell, Pascal, Volta) haben mit CUDA 13 die GPU-Unterstützung verloren. Verwenden Sie auf diesen Karten das neue Schwester-Plugin „ONNX Legacy“: Es bleibt bei CUDA 12, und die Karten arbeiten weiter auf der GPU. Es ist auch die richtige Wahl, wenn Sie ein installiertes CUDA 12 behalten möchten. Das Protokoll verweist darauf, wenn die Erkennung auf der GPU fehlschlägt.

## [1.2.2]

- Behoben: Die Kennzeichenerkennung schlug fehl, sobald genau ein Kennzeichen im Bild war. Im Protokoll stand ein Fehler der Kennzeichenerkennung, und das Kennzeichen wurde nicht gelesen. Zwei oder mehr Kennzeichen funktionierten.

## [1.2.1]

- CUDA funktioniert wieder unter Linux und Windows. Die Korrektur aus 1.2.0 wurde kurz vor der Veröffentlichung rückgängig gemacht, sodass die Erkennung auf dem Prozessor blieb, egal was in der Einstellung „Ausführungsanbieter“ gewählt war.
- Fehlt der gewählte Anbieter in der Installation, steht das jetzt im Protokoll; zuvor lief das Plugin stillschweigend auf dem Prozessor

## [1.2.0]

- Modelle für den Prozessor laden nach dem ersten Start schneller. Das vorbereitete Modell bleibt auf dem Datenträger gespeichert und wird wiederverwendet, statt bei jedem Start des Plugins neu aufgebaut zu werden.
- Behoben: Die Schaltfläche „Modelle neu herunterladen“ tat nichts; ein Klick führte nur zu einem Fehler im Protokoll
- CUDA funktioniert wieder. Unter Linux blieb die Erkennung oft auf dem Prozessor, egal was in der Einstellung „Ausführungsanbieter“ gewählt war.
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.5]

- Heruntergeladene Modelle werden nicht mehr in Sicherungen aufgenommen
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.4]

- Interne Verbesserungen

## [1.1.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.2]

- Fehlerbehebungen und Verbesserungen

## [1.1.1]

- Die Option CoreML wurde aus der Einstellung „Ausführungsanbieter“ entfernt; 'auto' wählt jetzt CUDA unter Linux und Windows (x86_64) und sonst den Prozessor
- CUDA ist für eine schnellere Erkennung abgestimmt
- Ein Modell, das sich nicht laden lässt, wird jetzt im Protokoll gemeldet und bei der nächsten Anfrage erneut geladen; schlägt ein Modell fehl, werden die übrigen trotzdem geladen
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.0]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.3]

- Fehlerbehebungen und Verbesserungen

## [1.0.2]

- Fehlerbehebungen und Verbesserungen

## [1.0.1]

- Fehlerbehebungen und Verbesserungen

## [1.0.0]

- Erste Veröffentlichung
