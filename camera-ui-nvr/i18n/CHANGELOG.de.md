## [0.10.5]

- Die Suche nach Beschreibung findet jedes Ereignis von selbst. Ereignisse nur mit Bewegung, ohne erkanntes Objekt, kamen erst nach einer von Hand gestarteten Neuindizierung in die Suche, sodass sich die meisten Ereignisse eines Tages nicht finden ließen. Ihre Bilder werden jetzt automatisch in die Suche aufgenommen, die neuesten zuerst, und ein nie indiziertes Archiv wird dahinter aufgefüllt
- Wenn die Suche keine Ereignisse aufnehmen kann oder eine von Hand gestartete Neuindizierung abbricht, steht der Grund im Protokoll

## [0.10.4]

- Ein Archiv, das auf eine andere Festplatte oder in einen anderen Ordner verschoben wurde, wird wieder abgespielt, und das Aufräumen entfernt seine Dateien, nicht nur deren Einträge. Neue Aufzeichnungen werden relativ zum Archivordner gespeichert, vorhandene werden dort gefunden, wo das Archiv jetzt liegt
- Aufzeichnungen behalten ihre Zeit, wenn der Server mehrere Sekunden beschäftigt ist. Zuvor war das Video nach einer solchen Verzögerung um deren Dauer verschoben
- Der Aufzeichnungskalender, die Daten der Speicherseite und die Namen exportierter Dateien folgen der Zeitzone des Betrachters, nicht der des Servers
- Ein Zeitraffer eines Bereichs, der mitten in einer Aufzeichnung beginnt, war eine leere Datei. Jetzt zeigt er den gewählten Bereich und meldet seine tatsächliche Länge
- Der Exportdialog sagt vor dem Start, wenn der Export für ein ZIP-Archiv zu groß ist. Ein fehlgeschlagener Export hinterlässt keine unfertige Datei, und die leeren Ordner abgelaufener Exporte werden entfernt
- Die Wiedergabe läuft dem Player nach Pause, Fortsetzen, Tempowechsel oder Lücken im Archiv nicht mehr immer weiter voraus
- Eine manuelle Aufzeichnung wird als pausiert angezeigt, solange die Aufzeichnung wegen fehlenden Speicherplatzes pausiert, und läuft weiter, sobald wieder Platz ist
- Die Speicherseite zeigt „aus“ für eine Kamera, deren Aufzeichnung ausgeschaltet ist
- Ein Ereignis lässt sich über seine Kennung öffnen, sodass die Momente der Tageszusammenfassung des Assistenten ihre Aufzeichnung öffnen
- Die Seite der Aufzeichnungen öffnet sich bei einem großen Archiv deutlich schneller

## [0.10.3]

- Kameras, die vor jedem Schlüsselbild einen langen Header senden (viele Modelle von Hikvision und Dahua, H.265-Streams), werden aufgezeichnet. Eine solche Kamera konnte gar nichts aufzeichnen, während das Protokoll unauffällig aussah. Das Protokoll meldet jetzt, wenn eine Kamera Video ohne Schlüsselbilder sendet
- Eine volle oder fehlerhafte Festplatte stoppt nicht mehr die Aufzeichnung aller Kameras auf einmal: Die Aufzeichnung läuft weiter, und der Index des Archivs holt auf
- Ein exportierter Clip, der über eine Pause in der Aufzeichnung läuft, endet dort, wo es verlangt wurde, und meldet seine tatsächliche Länge. Pausen von mehr als 2 Sekunden kommen nicht in den Clip
- Ein Export, der für eine ZIP-Datei zu groß ist, wird sofort mit Begründung abgelehnt, und ein fehlgeschlagener Export hinterlässt keine Dateien auf der Archivfestplatte
- „Aufzeichnen“ wird mit einer Erklärung abgelehnt, solange die Aufzeichnung wegen fehlenden Speicherplatzes pausiert
- Eine Kamera, die zwei Streams aufzeichnet, springt nicht mehr auf „zeichnet nicht auf“, wenn sich einer von ihnen neu verbindet
- Kameras im Modus „Auf Anfrage“ werden in der Speicherstatistik mit diesem Modus angezeigt
- Die Ansicht „Episoden“ zeigt die tatsächliche Anzahl der Episoden
- Ereignisse, die im selben Augenblick auf mehreren Kameras stattfanden, werden beim Nachladen der Liste nicht mehr übersprungen
- Die Einstellung „Länge einer Aufzeichnungsdatei“ wirkt sofort
- KI-Beschreibungen: Das Stundenlimit verbrauchen nur Ereignisse, die tatsächlich an das Modell gesendet wurden
- Das Aufräumen eines großen Archivs nach dem Größenlimit ist deutlich schneller

## [0.10.2]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [0.10.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [0.10.0]

- Aufzeichnung auf Anfrage. Eine Aufzeichnung lässt sich von Hand oder durch eine Automatisierung starten, während sie läuft verlängern und jederzeit stoppen: standardmäßig 5 Minuten, von 1 bis 120. Die Voraufzeichnung der Kamera landet am Anfang der Aufzeichnung. Eine Kamera im Modus „Durchgehend“ zeichnet ohnehin auf und erhält keine manuelle Aufzeichnung; eine Kamera mit ausgeschalteter Aufzeichnung oder über dem Tariflimit meldet einen Fehler
- Der Modus „Auf Anfrage“ funktioniert wieder: Die Kamera hält ihre Voraufzeichnung bereit, zeichnet aber erst nach einem manuellen Start auf. Erkennungen werden als Ereignisse gespeichert, starten aber keine Aufzeichnung. Zuvor zeichnete eine solche Kamera wie im Modus „Bei Ereignis“ auf
- Eine manuelle Aufzeichnung läuft getrennt von der Aufzeichnung durch Erkennungen: Das Stoppen von Hand bricht nicht ab, was eine Erkennung angefordert hat. Sie bleibt beim Wechsel der Streams der Kamera erhalten und endet, wenn die Aufzeichnung der Kamera ausgeschaltet oder auf „Durchgehend“ umgestellt wird. Ein Neustart des NVR beendet die manuelle Aufzeichnung

## [0.9.0]

- Episoden. Ereignisse verschiedener Kameras, die zu einem Besuch gehören, werden nach festen Regeln zu einer Episode zusammengefasst: ein Objekt derselben Art auf einer anderen Kamera spätestens 45 Sekunden später (oder gleichzeitig), dasselbe Kennzeichen oder erkannte Gesicht innerhalb von 10 Minuten. Mindestens zwei Kameras, höchstens 24 Ereignisse und 15 Minuten; Ereignisse nur mit Bewegung nehmen nicht teil. Die Oberfläche zeigt sie unter Aufnahmen → Anzeigen → Episoden
- Eine Episode erscheint in der Oberfläche, sobald die zweite Kamera hinzukommt, und wird aktualisiert, solange der Besuch andauert. Nach einem Neustart des NVR wird eine nicht abgeschlossene Episode fortgesetzt
- Der Episoden-Player zeigt Kamerablöcke: Sehen zwei Kameras das Objekt gleichzeitig, bleibt die erste die Hauptkamera, die zweite wird zum „Zweiten Winkel“
- Episoden-Verlauf: jede Verbindung mit ihrem Grund, die Beteiligten mit Art und Kennzeichen oder Gesichtern, ein Bild jedes Ereignisses. Das Mosaik der Episodenkarte enthält bis zu vier Bilder
- Download einer Episode: MP4 oder ZIP mit einem Clip je Kamerablock. Eine favorisierte Episode schützt ihre Ereignisse vor der automatischen Bereinigung. Ein gelöschtes Ereignis verlässt die Episode, der Titel wird neu gebildet; eine Episode, in der nur eine Kamera bleibt, wird gelöscht

## [0.8.0]

- Ton im Archiv. Neue Einstellung „Ton aufzeichnen“ (standardmäßig aus): Der Ton der Kamera (meist G.711) wird bei der Aufzeichnung in AAC umgewandelt; eine Kamera ohne Mikrofon zeichnet weiterhin Video auf. Zuvor wurde der Ton bei der Aufzeichnung verworfen
- Bei der Wiedergabe ist der Ton von Aufzeichnungen zu hören, die ihn enthalten. Ansichten nur mit Video (die Kamerawand) erhalten keinen Ton
- Der Export behält den Ton im MP4 (AAC); bei Aufzeichnungen ohne Ton bleibt die Datei ohne Ton. Im Zeitraffer gibt es keinen Ton
- Bestehende Archive werden von selbst angepasst; ältere Aufzeichnungen werden als Aufzeichnungen ohne Ton gelesen

## [0.7.0]

- Werkzeuge für den Assistenten. Der ViON-Assistent erhält das Archiv nur zum Lesen: Ereignisse eines Zeitraums, gefiltert nach Kamera, Objekt, Kennzeichen oder erkanntem Gesicht; eine Zusammenfassung eines oder mehrerer Tage in der Zeitzone des Benutzers mit den wichtigsten Ereignissen in zeitlicher Reihenfolge; Suche nach Beschreibung; die gelesenen Kennzeichen; das Bild eines Ereignisses. Zuvor konnte der Assistent keinen Tag zusammenfassen, kein Ereignis finden und keine Kennzeichen auflisten
- Kennzeichen werden ohne Leerzeichen, Bindestriche und Groß-/Kleinschreibung verglichen („К 178 УС 77“ und „к178ус77“ sind dasselbe Kennzeichen); ein nicht erkanntes Gesicht wird nicht als Person ausgegeben

## [0.6.0]

- Die Filter der Aufnahmen funktionieren: „Auslöser“ (einschließlich Geräuschlabels), „Attribute“ (Gesicht, Kennzeichen), „Sonstige“ und die Schalter „UND/ODER“ zwischen den Gruppen; „UND“ bindet stärker als „ODER“. Die Konfidenzschwelle verwirft keine Ereignisse ohne bewertete Erkennungen mehr (Sensoren, Türklingel). Ein selektiver Filter findet auch Ereignisse jenseits der letzten paar hundert Aufnahmen
- Die Ereignisstatistik zählt tatsächlich bis zu 5000 Ereignisse und die Zahl der Segmente
- Erkennungsverlauf: Die Schritte einer Erkennung werden mit dem Ereignis gespeichert (und mit ihm gelöscht) und seitenweise angezeigt, mit Bildern aus der Aufzeichnung zu diesen Zeitpunkten (den zeitlich nächsten)
- Der Export berücksichtigt „Qualität“: „Beste Qualität“ nimmt den Stream mit der höchsten Auflösung, „Kleinste Dateien“ den mit der niedrigsten (von den im gewählten Abschnitt aufgezeichneten)
- Der Aufzeichnungsmodus „Auf Anfrage“ ließ sich nicht starten und zeichnete nichts auf: Solche Kameras zeichnen jetzt „bei Ereignis“ auf
- Die Oberfläche erfährt, was der Rekorder unterstützt (Episoden: noch nicht, Exportqualität: ja), und bietet nichts darüber hinaus an

## [0.5.2]

- Die Wiedergabe am Live-Rand bricht beim Wechsel der Aufzeichnungsdatei nicht mehr ab: Die neue Datei ist sofort abspielbar statt erst nach 4 Sekunden
- Aktualisierungen eines Ereignisses werden der Reihe nach verarbeitet: Das Ende eines Ereignisses wird nicht mehr von einer verspäteten Aktualisierung mit Bildern überschrieben (Ereignisse bleiben nicht „aktiv“ hängen)
- Modus „Bei Ereignis“: Die Voraufzeichnung einer neuen Datei wiederholt keine Bilder der vorherigen
- Ein Schreibfehler auf dem Datenträger (kein Platz, Defekt) stoppt das Plugin nicht mehr: Die Datei wird geschlossen, die Aufzeichnung läuft mit dem nächsten Vollbild weiter
- Nach der erneuten Verbindung einer Kamera mit anderem Videoformat oder anderer Auflösung läuft die Aufzeichnung weiter (zuvor stoppte sie bis zum Neustart)
- Die Ereignisstatistik zählt bis zu 5000 Ereignisse (zuvor wurde bei 500 abgeschnitten)
- Archivbereinigung: Lässt sich eine Aufzeichnungsdatei nicht löschen, bleibt sie verzeichnet und die Bereinigung versucht es erneut, statt eine Datei zurückzulassen, von der niemand weiß

## [0.5.1]

- Die Wiedergabe eines Ereignisses, das kurz vor der Aufzeichnung begann (die Kamera verband sich noch, langer Abstand zwischen Vollbildern), beginnt mit dem ersten aufgezeichneten Bild statt mit „Keine Aufnahmen“
- Eine Aufzeichnungsdatei, die die Archivbereinigung während des Ansehens entfernt, wird übersprungen und beendet die Wiedergabe nicht mehr mit einem Fehler

## [0.5.0]

- KI-Ereignisbeschreibungen (Einstellung „KI-Ereignisbeschreibungen“): Nach einem Ereignis mit Person, Fahrzeug oder Tier beschreibt das Assistenzmodell anhand der Bilder des Ereignisses, was passiert ist. Funktioniert mit jedem Assistenzmodell von ViON, das Bilder versteht (OpenAI-kompatibles Gateway, Ollama, OpenRouter und andere); es gibt ein Limit für Beschreibungen pro Stunde
- Kombinierte KI-Suche: nach dem Inhalt der Bilder (CLIP/SigLIP) und nach dem Text der Beschreibungen, einschließlich russischer Wortformen
- Smarte Benachrichtigungen: Die Beschreibung kommt als Benachrichtigung („Eingang: Kurier hat ein Paket abgelegt“)
- Ein Ereignis lässt sich auf Anfrage beschreiben

## [0.4.0]

- Suche in Ereignissen nach Bedeutung: Die Bilder erkannter Objekte werden indexiert, eine Textanfrage wird mithilfe des CLIP-Plugins (ONNX, OpenVINO, CoreML) damit abgeglichen; ältere Ereignisse lassen sich anhand ihrer Bilder neu indexieren
- Gesichter: eine Datenbank bekannter Personen (mehrere Fotos pro Person), Abgleich bei der Erkennung, unbekannte Gesichter mit Gruppierung ähnlicher, Ignorieren von Gesichtern, das Korrigieren eines Namens im Ereignis trainiert das System, erneuter Abgleich
- Die Suchdaten werden getrennt gespeichert und nicht mehr zusammen mit den Ereignissen an die Oberfläche gesendet
- Vorschaubilder von Gesichtern und Kennzeichen werden angezeigt (zuvor fehlten sie)

## [0.3.0]

- Die Aufzeichnungseinstellungen zeigen den Tarif, seine Limits und die Kameras, die die Aufzeichnungsplätze belegen
- Ereignisse, die nach einem Neustart aktiv geblieben sind, werden beim Start geschlossen
- In den ViON-Server integriert: wird zusammen mit ihm installiert und aktualisiert

## [0.2.0]

- Limits des ViON-Cloud-Tarifs: Anzahl der Kameras mit Aufzeichnung und maximale Archivdauer (ein Server ohne Cloud nutzt lokale Limits)
- Der Tarif wird in den Aufzeichnungseinstellungen angezeigt

## [0.1.0]

- Erste Version von ViON NVR: durchgehende Aufzeichnung und Aufzeichnung bei Ereignis, Zeitleiste, Wiedergabe, Ereignisse, MP4/ZIP-Export, Aufbewahrungsdauer und Speicherlimits
