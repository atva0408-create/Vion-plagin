## [1.2.14]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.2.13]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.12]

- **Das Modell liest immer das Bild, das ihm übergeben wurde.** Das Bild konnte im Speicher überschrieben werden, bevor das Modell es las, sodass ein Objekt oder ein Gesicht übersehen oder falsch bewertet werden konnte.

## [1.2.11]

**Erfordert ViON 2.2.5 oder neuer.** Wählen Sie nach dem Update dieses Plugin für jede Kamera als „Gesichtserkennung“ aus: Kameraeinstellungen, „Plugins“, „Erkennungen“. Bis dahin werden Gesichter erkannt, aber nicht benannt. Das Plugin lädt seine neuen Gesichtsmodelle beim ersten Start herunter.
- **Die Gesichtswiedererkennung ist ein eigener Sensor und richtet das Gesicht vor dem Erkennen aus.** Sie erkennt deutlich mehr Personen, und ein Gesicht, das von der Seite oder steil von oben zu sehen ist, erhält keinen Namen statt eines falschen. Das Wiedererkennungsmodell wird einmal für das Plugin festgelegt, und ViON verarbeitet die gespeicherten Gesichtsbilder von selbst erneut.
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.10]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.9]

- Kleinere Fehlerbehebungen

## [1.2.8]

- **Kennzeichen werden wieder gelesen.** Jede Lesung wurde als unlesbar bewertet und verworfen, bevor sie zu einem Ereignis wurde, egal was die Kamera sah. Falls Sie die Kennzeichen-Lesekonfidenz in den Kameraeinstellungen gesenkt haben, um das zu umgehen, stellen Sie sie wieder zurück.

## [1.2.6]

- Die Objekterkennung richtet sich nach den Konfidenzwerten, die in den Kameraeinstellungen je Objekttyp (Person, Fahrzeug, Tier) festgelegt sind

## [1.2.5]

- Die Konfidenzschwellen sind nicht mehr in den Plugin-Einstellungen. Objekt-, Gesichts- und Kennzeichenerkennung verwenden jetzt die Werte aus den Erkennungseinstellungen der Kamera, sodass sie an einer Stelle festgelegt werden und eine Änderung sofort wirkt
- Das Plugin meldet, welches Modell es geladen hat und auf welcher Hardware es läuft, sodass ViON dies in den Kamerametriken anzeigen kann

## [1.2.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.2]

- **Das empfohlene Modell für die Gesichtserkennung wurde geändert.** Hinter der Auswahl „Standard“ steht jetzt ein stärkeres Modell: In Testaufnahmen findet es in 82 % der Bilder ein Gesicht, wo das bisherige 30 % schaffte, und es hält einen Hinterkopf nicht mehr für ein Gesicht. Ihre aktuelle Auswahl bleibt unverändert. Neue Installationen erhalten es sofort; in einer bestehenden wählen Sie „Standard“ in der Modellliste oder nutzen „Einstellungen zurücksetzen“. Eine Gesichtsprüfung benötigt dann etwa die doppelte Rechenleistung und läuft nur, wenn eine Person erkannt wurde.

## [1.2.1]

- **Eine Schaltfläche „Einstellungen zurücksetzen“ in jedem Einstellungsbereich.** Ein Klick setzt alle Werte dieses Bereichs auf die Standardwerte zurück, auch die Modelle.
- **Eine neue Auswahl „Standard“ in jeder Modellliste.** Sie folgt dem empfohlenen Modell für die jeweilige Aufgabe, sodass Plugin-Updates die Auswahl automatisch verbessern können. Wer ein bestimmtes Modell wählt, behält dieses weiterhin. Bestehende Installationen behalten ihre aktuelle Auswahl.
- **Fünf neue Modelle für die Gesichtserkennung.** Kleine und mittlere Modelle sowie 640-px-Varianten jeder Größe (t, s, m). Die 640-px-Modelle finden kleine und weit entfernte Gesichter, die das 320-px-Standardmodell übersieht, benötigen aber mehr Rechenleistung. Das Standardmodell bleibt unverändert.

## [1.2.0]

- Die Schaltfläche „Modelle neu herunterladen“ funktioniert wieder: Ein Klick darauf bewirkte nichts
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.7]

- Sie können wählen, welche Vulkan-Grafikkarte die Erkennung ausführt. Die neue Einstellung „Vulkan-Gerät“ listet die gefundenen Grafikkarten auf, sodass sich die Erkennung in Systemen mit mehreren Grafikkarten an eine bestimmte Karte binden lässt. „Automatisch“ behält das bisherige Verhalten bei.

## [1.1.6]

- Keine wiederholten Vulkan-Fehlermeldungen mehr im Protokoll auf Systemen ohne Vulkan. Ist Vulkan nicht installiert, wird die Suche nach einer Grafikkarte übersprungen, und die Erkennung läuft wie bisher auf dem Prozessor.
- Reine Software-Vulkan-Geräte zählen nicht mehr als Grafikkarten. Die Erkennung ist darauf langsamer als auf dem Prozessor allein, daher bleiben Systeme ohne echte Grafikkarte beim Prozessor.

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

- Ein Modell, das sich nicht laden lässt, wird jetzt im Protokoll gemeldet, statt stillschweigend zu scheitern, und beim nächsten Versuch neu geladen
- Schlägt beim Start das Laden eines Modells fehl, werden die übrigen Modelle trotzdem geladen
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
