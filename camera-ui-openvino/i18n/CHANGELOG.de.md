## [1.5.0]

- Ähnlich aussehende Personen lassen sich über Kameras hinweg finden, zusammen mit ViON NVR 0.12.0: Wählen Sie dieses Plugin in den Einstellungen der Kamera → Plugins → Sensor-Typen → „Personen-Wiedererkennung“. Es merkt sich, wie Kleidung und Statur einer Person aussehen, nicht wer sie ist. Das Modell lädt mit der ersten Person, die eine solche Kamera sieht, nicht beim Start
- Die Suche nach Bild findet zuerst die größte Person auf dem Bild und schneidet sie aus, so wie der Server die Personen aus den Bildern schneidet
- Segmentierung: Das Plugin umreißt Personen, Fahrzeuge und Tiere, auf seiner Seite und für den Server; auch dieses Modell lädt erst, wenn es zum ersten Mal gebraucht wird
- Benötigt ViON 2.3.14 oder neuer: Beim Hinzufügen des Plugins zu einer Kamera bleibt die Personen-Wiedererkennung dort ausgeschaltet

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

- Für die semantische Suche steht ein zweites CLIP-Modell zur Verfügung, und das Modell ist jetzt eine einzige Plugin-Einstellung statt einer Auswahl je Kamera. Nach dem Wechsel bietet die Ansicht der Aufzeichnungen an, die vorhandenen Ereignisse neu zu indexieren, damit auch ältere Aufzeichnungen durchsuchbar bleiben.
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

- Die Plugin-Beschreibung verweist Besitzer älterer Intel-Grafik unter Windows jetzt auf das Plugin OpenVino Legacy. Keine funktionalen Änderungen.

## [1.2.4]

- Verweigert eine Intel-Grafik unter Windows das Laden eines Modells, verweist das Protokoll jetzt auf das neue Plugin OpenVino Legacy. Es lädt weiterhin alle Modelle auf Grafik bis zur 10. Core-Generation, wo das reguläre Plugin stillschweigend auf den Prozessor auswich.

## [1.2.3]

- Behoben: Die Kennzeichenerkennung schlug fehl, sobald genau ein Kennzeichen im Bild war. Im Protokoll stand ein Fehler der Kennzeichenerkennung, und das Kennzeichen wurde nicht gelesen. Zwei oder mehr Kennzeichen funktionierten.

## [1.2.2]

- Die Erkennung ist rund 50-mal schneller. Das Plugin hatte Ihre Hardware auf die Verarbeitung vieler Bilder zugleich eingestellt, was sich lohnt, wenn Hunderte Bilder warten; die Erkennung schickt aber ein einzelnes Bild und wartet auf die Antwort. Auf Intel-Grafik dauerte dieses eine Bild etwa eine Sekunde statt elf Millisekunden, sodass nur ein Bild pro Sekunde ausgewertet wurde und Vorbeigehende leicht übersehen wurden. Die Einstellung ist jetzt auf eine schnelle Einzelantwort ausgelegt.
- Eine GPU bedient mehr Kameras gleichzeitig. Sie bearbeitet jetzt zwei Bilder parallel und bleibt so ausgelastet, während Bilddaten übertragen werden.

## [1.2.1]

- Ein Gerät, das ein Modell nicht ausführen kann, überflutet das Protokoll nicht mehr. Lehnt Ihr Grafiktreiber ein Modell ab, steht das jetzt in einer Zeile samt Grund im Protokoll, statt für jedes Modell einen langen Treiberbericht auszugeben. Die Erkennung läuft wie bisher auf dem nächsten Gerät weiter.
- Die Geräteliste im Protokoll enthält jetzt die Version des Grafiktreibers. Bei älteren Intel-Chips entscheidet der Treiber, ob die GPU überhaupt nutzbar ist; sie ist daher das Erste, was Sie prüfen sollten, wenn Modelle auf dem Prozessor landen.
- Ältere Intel-Grafik erhält eine zweite Chance, bevor ein Modell auf den Prozessor ausweicht: Lehnt der Grafiktreiber ein Modell ab, wird es auf demselben Gerät mit voller Genauigkeit erneut versucht.

## [1.2.0]

- Modelle werden jetzt einmal vorbereitet statt bei jedem Start. Die vorbereiteten Modelle bleiben auf dem Datenträger gespeichert, sodass ein Neustart des Plugins die aufwendige Vorbereitung für GPU und NPU überspringt, die schwächere Systeme ausbremsen konnte. Der erste Start nach einem Update oder Modellwechsel dauert weiterhin länger.
- Das Feld „Aktive Hardware“ zeigt das Gerät, auf dem die Erkennung tatsächlich läuft. Mit AUTO blieb es bisher bei der vorübergehenden CPU-Stufe stehen, die angezeigt wird, solange das eigentliche Gerät im Hintergrund noch vorbereitet wird.
- Behoben: Die Schaltfläche „Modelle neu herunterladen“ tat nichts; ein Klick führte nur zu einem Fehler im Protokoll
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.7]

- Auswahl des genauen Geräts in Systemen mit mehreren Grafikkarten. Die Liste „Gerät“ zeigt jetzt jedes erkannte Gerät einzeln (zum Beispiel GPU.0 und GPU.1), sodass die Erkennung auf einer bestimmten Karte laufen kann statt auf der, die OpenVINO auswählt.

## [1.1.6]

- Behoben: eine Neustartschleife auf Rechnern mit Intel NPU. Das Laden des CLIP-Modells beendete das Plugin direkt nach dem Start, immer wieder
- Gesichtswiedererkennung, Kennzeichenlesen und CLIP weichen nicht mehr auf den Prozessor aus: NPU und GPU können diese Modelle jetzt wie die Modelle der Objekterkennung ausführen

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

- Ein Modell, das sich nicht laden lässt, wird jetzt im Protokoll gemeldet statt stillschweigend übergangen und bei der nächsten Anfrage erneut geladen
- Schlägt das Laden eines einzelnen Modells fehl, werden die übrigen trotzdem geladen
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
