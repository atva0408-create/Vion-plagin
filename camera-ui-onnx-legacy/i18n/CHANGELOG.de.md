## [1.5.11]

- Der Name wird VION geschrieben

## [1.5.10]

- Eine Modelldatei, die als Webseite ankam (die Anmeldeseite eines Hotel- oder Zug-WLANs) oder unvollständig war, wird nicht mehr gespeichert, und eine früher gespeicherte wird neu geladen: das Modell ließ sich bei jedem Start nicht laden
- Eine nicht mehr ausgegebene Klassifikator-Version (eine neuere Version derselben Frage) wird entladen, statt mit jeder neuen Version im Speicher zu bleiben

## [1.5.9]

- Eine Frage eines Moduls zu einer Klasse, die ein anderes Modul hinzufügt (das Fahrrad eines Store-Moduls), läuft auf deren Boxen: nur Personen-, Fahrzeug- und Tier-Boxen gingen an den Klassifikator, und die eigene Schreibweise einer Klasse beim Detektor («Bicycle») passte nicht zur Frage

## [1.5.8]

- Erkennungen auf der GPU gehen nicht mehr schief und verlieren die GPU nicht mehr, wenn zwei Aufrufe eines Modells gleichzeitig laufen: jeder Aufruf nahm einen eigenen CUDA-Stream, und die Puffer des einen wurden vom anderen benutzt — Rahmen um Hunderte Pixel daneben und am Ende «CUDA failure 700/716» in einer Conv (dreimal an einem Tag auf dem Testrechner). Alle Aufrufe eines Modells laufen jetzt auf einem Stream: 0 falsche Antworten bei 34.000 Aufrufen, so schnell wie zuvor

## [1.5.7]

- Eine für den Prozess verlorene GPU nennt das Modell des fehlgeschlagenen Aufrufs und wie viele Aufrufe gerade liefen («на модели yolo-v9-s-320, вызовов одновременно: 2»): zwei Ausfälle auf dem Testrechner an einem Tag sagten nicht, woran sie geschahen

## [1.5.6]

- Eine für den Prozess verlorene GPU startet das Plugin neu: nach einem CUDA-Fehler (NVIDIA Xid 31, «CUDA failure 700: an illegal memory access») schlug jeder Modellaufruf gleich fehl, bis zum Neustart von Hand — auf dem Testrechner 3,5 Stunden ohne Erkennung und ohne Suchindex. Der erste Aufruf, der die GPU verliert (CUDA-Fehler 700, 714–719), sagt das nun und beendet den Prozess, den der Server neu startet. Eine GPU, die 3-mal in einer Stunde versagt, schickt die Modelle auf die CPU, statt das Plugin endlos neu zu starten
- Ein Modell, für das der GPU-Speicher nicht reicht, wird als solches gemeldet (pro Modell), nicht als fehlende CUDA-Bibliotheken

## [1.5.5]

- Der Umriss eines auf einem Bild markierten Gegenstands für die Frage von VION NVR 0.23.0 «wann ist er verschwunden, wer hat ihn weggetragen» (`outlineMarked`): SAM 2.1 Hiera tiny (155 MB vom Modellspiegel) umreißt, was ein Rahmen oder ein Punkt auf einem Bild zeigt. Es lädt mit der ersten Frage und verlässt den Speicher nach fünf Minuten ohne Frage. Immer auf dem Prozessor, unabhängig vom Gerät des Plugins: ein Viertel der Kerne (mindestens zwei), ein Bild nach dem anderen, 3-5 s pro Bild auf dem Prüfstand, etwa 0,6 GB solange geladen. Während es lädt, sagt die Antwort das; ein unlesbares Bild bekommt keinen Umriss, die anderen werden umrissen. Nie im Hintergrund

## [1.5.4]

- Beim Start schreibt das Plugin nicht mehr «Не удалось предзагрузить модели CLIP:» ohne Fortsetzung: ein Fehler des Übersetzers der Suchwörter wird als eigener gemeldet, und ein Fehler ohne Text wird nach seiner Art benannt

## [1.5.3]

- «Objekt umranden» findet eine auf dem Bett liegende Person: die Probeerkennung nimmt die angefragte Schwelle (die Umrandung fragt 0,25 an und zeigt bei jedem den Prozentwert); andere Proben behalten die Schwelle des Plugins

## [1.5.2]

- Suche im Bild auf Russisch und Deutsch: der Übersetzer der Anfrage braucht sentencepiece und protobuf, die dieses Plugin nicht installierte (nur ONNX): bei jedem Start stand «Не удалось предзагрузить модели CLIP» ohne Grund im Protokoll, und eine Suche über ONNX Legacy scheiterte mit «MarianTokenizer requires the SentencePiece library»

## [1.5.1]

- Suche im Bild: ein Bild, das sich nicht lesen lässt (eine bei voller Platte oder beim Stopp abgeschnittene Karte, eine leere Datei), hat keine Rahmen, die anderen werden angesehen; es ließ den ganzen Aufruf scheitern, und VION NVR beendete die Suche in allen gefundenen Ereignissen

## [1.5.0]

- Die Suche nach Beschreibung versteht die Sprache der Plattform: CLIP ViT-B/32, das Standardmodell, kennt nur Englisch, und eine russische Anfrage fand nichts. Eine Anfrage wird von opus-mt (≈110 MB, 0,2–0,3 s pro Anfrage) ins Englische übersetzt: aus dem Russischen immer, wenn sie Kyrillisch enthält, gleich welche Sprache die Plattform spricht, sonst aus der Sprache der Plattform, von der die Suche kommt (Deutsch); das mehrsprachige SigLIP erhält die Anfrage unverändert. Der russische Übersetzer wird bei englischem CLIP beim Start geladen, ein anderer beim ersten Bedarf (solange er lädt, wird nach dem Eingegebenen gesucht, höchstens 15 s gewartet). Für die Sprache der Plattform wird VION NVR 0.19.0 benötigt
- Suche im Bild: Die Aufnahmen von VION fragen, wo im Bild jedes per Beschreibung gefundenen Ereignisses das Gesuchte ist („красная сумка“, „человек с велосипедом“), und zeigen den Fund. Die Anfrage wird ebenso ins Englische übersetzt, OWL-ViT B/32 rahmt das Ding ein, ein Fund kommt mit seinem Ausschnitt. Das Modell (≈600 MB) wird bei der ersten Anfrage im Hintergrund heruntergeladen und geladen — währenddessen sagt die Antwort, dass es lädt, ein fehlgeschlagenes Laden wird der nächsten Anfrage gemeldet — und nach fünf Minuten ohne Suche aus dem Speicher entfernt; ein Bild dauert auf einem Prozessor 1–4 s. Benötigt VION NVR 0.19.0
## [1.4.0]

- Körperhaltung: Mit „Поза людей“ meldet der Merkmalssensor („VION: признаки“) für jede Person im Bild, ob sie steht, sitzt oder liegt, und das Ereignis erhält es als Merkmal „поза“ („поза: лежит“). Einschalten in VION: Erweiterungen → Module → „Körperhaltung“ oder in den Einstellungen des Merkmalssensors der Kamera. Das Modell (RTMPose-t) wird mit der ersten Person geladen, die eine solche Kamera sieht, nicht beim Start. Ist zu wenig von einer Person zu sehen oder ist sie vorgebeugt, wird keine Haltung genannt.
- Ein Haltungsmodell, das lädt, aber an den Ausschnitten scheitert, wird entladen und VION als nicht funktionierend mit Grund gemeldet, nach zehn Minuten erneut geladen; es sieht nicht mehr aus, als würde es analysieren
- Benötigt VION 2.4.2 oder neuer: ältere VION-Versionen behielten pro Person eine Antwort je Bild und Aufenthalt, die Haltung hätte die Antworten der trainierten Fragen verdrängt und einen Haltungswechsel verloren
- Über eine Person, die der Bildrand abschneidet (VION 2.4.2 meldet das), wird nur «steht» oder nichts gesagt, nie «sitzt» oder «liegt»: die verdeckten Beine erfindet das Modell; auf dem Prüfstand betrafen 5 der 6 falschen Antworten eines Morgens solche Personen

## [1.3.2]

- Das Plugin meldet VION, warum das Modell eines Sensors noch nicht geladen ist: Es wartet auf den ersten Einsatz (Personen-Wiedererkennung auf die erste Person im Bild) oder es wurde nicht geladen, mit Grund. VION zeigt das Erste als „Verbunden“ und nur das Zweite als „Funktioniert nicht“.
- Eine Modulversion, zu der zurückgekehrt wurde, oder eine korrigierte wird sofort geladen, auch für eine Kamera, die auf das Standardmodell ausgewichen ist, nicht erst mit dem nächsten Bild mit Bewegung.

## [1.3.1]

- Bei einem fehlgeschlagenen Modul-Update bleibt der funktionierende Detektor aktiv. Parallele Updates erzeugen einen Ersatz, überholte Ladevorgänge werden verworfen und die Eingangsgröße der Kamera wird nach dem Wechsel aktualisiert.
- Ein nach dem Stoppen oder Providerwechsel abgeschlossener Ladevorgang aktiviert die alte Sitzung nicht erneut.
- Das Plugin meldet VION, welche Version eines Moduls es geladen hat und welche nicht: Die Modulkarte nennt eine Version, die nicht geladen wurde, und ein Update behält die Version, die funktioniert hat, für den Weg zurück. Eine Kamera, deren Modulversion nach einem Neustart nicht lädt, arbeitet mit dem Standardmodell, bis das Modul geladen ist. Ein Update oder eine Rückkehr des Moduls wird sofort geladen, ohne die zehnminütige Pause nach einem fehlgeschlagenen Laden.

## [1.3.0]

- Ähnlich aussehende Personen lassen sich über Kameras hinweg finden, zusammen mit VION NVR 0.12.0: Wählen Sie dieses Plugin in den Einstellungen der Kamera → Plugins → Sensor-Typen → „Personen-Wiedererkennung“. Es merkt sich, wie Kleidung und Statur einer Person aussehen, nicht wer sie ist. Das Modell lädt mit der ersten Person, die eine solche Kamera sieht, nicht beim Start
- Die Suche nach Bild findet zuerst die größte Person auf dem Bild und schneidet sie aus, so wie der Server die Personen aus den Bildern schneidet
- Segmentierung: Das Plugin umreißt Personen, Fahrzeuge und Tiere, auf seiner Seite und für den Server; auch dieses Modell lädt erst, wenn es zum ersten Mal gebraucht wird
- Benötigt VION 2.4.0 oder neuer: Beim Hinzufügen des Plugins zu einer Kamera bleibt die Personen-Wiedererkennung dort ausgeschaltet

## [1.2.21]

- Eine nicht mehr ausgelieferte Modulversion wird entladen, und ein aktualisiertes Modul aus dem Store wird neu geladen: beides brach seit 1.4.4 mit einem Fehler ab

## [1.2.20]

- Trainingsmodule aus der VION Cloud: Der Detektor eines Objektmoduls (zum Beispiel „Fahrrad“) läuft neben dem Detektor der Kamera auf den Kameras, für die das Modul in VION eingeschaltet ist, und die Klassifikatoren der Fragemodule laufen nur auf ihren Kameras; eine nicht mehr ausgelieferte Modulversion wird entladen

## [1.2.19]

- Detektormodule aus dem VION-Store: ein im Store unter „Module“ installiertes Modul erscheint unter den Objektmodellen dieses Plugins und wird wie diese verwendet; ein aktualisiertes Modul wird neu geladen

## [1.2.18]

- Die Objekterkennung bekommt Bilder in der Größe, die das gewählte Modell erwartet: Sie bekam 320×320 unabhängig vom Modell, und ein Modellwechsel konnte den Detektor doppelt stoppen und starten

## [1.2.17]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.2.16]

- Kompatibilitätsupdate für die aktuelle VION-Version

## [1.2.15]

- Erfordert VION 2.2.5 oder neuer
- **Wählen Sie nach dem Update dieses Plugin für die Gesichtswiedererkennung jeder Kamera aus** (Kameraeinstellungen, „Plugins“, „Erkennungen“). Bis dahin werden Gesichter erkannt, aber nicht benannt. Seine neuen Gesichtsmodelle lädt das Plugin beim ersten Start herunter.
- **Die Gesichtswiedererkennung ist jetzt ein eigener Sensor und richtet das Gesicht vor dem Wiedererkennen aus.** Sie erkennt deutlich mehr Personen wieder, und ein Gesicht von der Seite oder steil von oben erhält keinen Namen statt eines falschen. Das Wiedererkennungsmodell wird einmal für das ganze Plugin festgelegt; die gespeicherten Bilder der Personen verarbeitet VION von selbst neu.
- Kompatibilitätsupdate für die aktuelle VION-Version

## [1.2.14]

- Kompatibilitätsupdate für die aktuelle VION-Version

## [1.2.13]

- **TensorRT ist nach einem Modell- oder Plugin-Update schneller bereit.** Die Messwerte der vorherigen Vorbereitung bleiben erhalten und werden wiederverwendet.
- Kleinere Fehlerbehebungen

## [1.2.12]

- **Lässt sich CUDA nicht laden, nennt das Protokoll jetzt das passende Docker-Image.** Dieses Plugin benötigt die CUDA-12-Bibliotheken: das VION-Image mit NVIDIA-Unterstützung (CUDA 12). Mit CUDA 13, also dem VION-Image mit NVIDIA-Unterstützung (CUDA), verwenden Sie das reguläre ONNX-Plugin.

## [1.2.11]

- **Kennzeichen werden wieder gelesen.** Jede Lesung wurde als unlesbar bewertet und verworfen, bevor sie ein Ereignis erreichte, ganz gleich, was die Kamera sah. Falls Sie die Lesekonfidenz in den Kameraeinstellungen gesenkt haben, um das zu umgehen, stellen Sie sie wieder zurück.

## [1.2.9]

- Das CLIP-Modell für die semantische Suche ist jetzt eine einzige Plugin-Einstellung statt einer Auswahl je Kamera
- Die Objekterkennung richtet sich nach den Konfidenzwerten je Typ (Person, Fahrzeug, Tier) aus den Kameraeinstellungen

## [1.2.8]

- Die Konfidenzschwellen wurden aus den Plugin-Einstellungen entfernt. Objekt-, Gesichts- und Kennzeichenerkennung verwenden jetzt die Werte aus den Erkennungseinstellungen der Kamera; sie werden also an einer Stelle festgelegt, und eine Änderung wirkt sofort.
- Das Plugin meldet, welches Modell geladen ist und auf welchem Gerät es läuft, sodass VION dies in den Metriken der Kamera anzeigen kann

## [1.2.6]

- Kompatibilitätsupdate für die aktuelle VION-Version

## [1.2.5]

- **Das empfohlene Modell für die Gesichtserkennung hat sich geändert.** Hinter der Option „Standard“ steht jetzt ein stärkeres Modell: In Testaufnahmen findet es in 82 % der Bilder ein Gesicht, in denen das bisherige 30 % schaffte, und es hält einen Hinterkopf nicht mehr für ein Gesicht. Ihre aktuelle Auswahl bleibt unverändert. Neue Installationen erhalten es sofort; in einer bestehenden wählen Sie „Standard“ in der Modellliste oder verwenden „Einstellungen zurücksetzen“. Eine Gesichtsprüfung kostet dann etwa doppelt so viel Rechenleistung und läuft nur, wenn eine Person gesehen wurde.

## [1.2.4]

- **Eine Schaltfläche „Einstellungen zurücksetzen“ in jedem Einstellungsbereich.** Ein Klick setzt alle Werte des Bereichs auf die Standardwerte zurück, einschließlich der Modelle.
- **Eine neue Auswahl „Standard“ in jeder Modellliste.** Sie folgt dem empfohlenen Modell für die jeweilige Aufgabe, sodass Plugin-Updates die Wahl automatisch verbessern können. Wer ein bestimmtes Modell wählt, legt es weiterhin fest. Bestehende Installationen behalten ihre aktuelle Auswahl.
- **Fünf neue Modelle für die Gesichtserkennung.** Kleine und mittlere Größen sowie 640-px-Varianten jeder Größe (t, s, m). Die 640-px-Modelle finden kleine und weit entfernte Gesichter, die das 320-px-Standardmodell übersieht, bei höherem Rechenaufwand. Das Standardmodell bleibt unverändert.

## [1.2.3]

- Erste Veröffentlichung. Dieselben Funktionen wie das ONNX-Plugin, aber auf CUDA 12. Das reguläre Plugin ist auf CUDA 13 umgestiegen, das NVIDIA-Grafikkarten vor der GTX 1650 (Maxwell, Pascal, Volta) nicht mehr unterstützt; mit diesem Plugin arbeiten sie weiter auf der GPU. Es ist auch für Systeme gedacht, die bei einem installierten CUDA 12 bleiben.
