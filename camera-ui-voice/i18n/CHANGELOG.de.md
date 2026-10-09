## [0.4.0]

- Macht das Kind nach drei Erinnerungen weiter, öffnet die Mitteilung an die Eltern ein Ereignis in den Aufnahmen der Kamera (mit den übergangenen Erinnerungen, ab der ersten); ein Clip folgt ein paar Minuten später in derselben Mitteilung, ohne Ton. Braucht ViON NVR 0.14.0; ohne ihn kommt die Mitteilung wie bisher
- Die Mitteilung geht sicher, sobald VOICE dem Kind gesagt hat «Ich habe deinen Eltern Bescheid gegeben», auch wenn das Kind gleich danach weggeht; jede Mitteilung steht im Protokoll, gesendet oder nicht und warum
- Schlafenszeit und Tageslimit fangen ihre Erinnerungen nicht mehr von vorn an, wenn das Kind weniger als 15 Minuten nicht zu sehen ist

## [0.3.0]

- VOICE beim Namen rufen: Ist für ein Kind „Antworten, wenn gerufen“ an, sagt es jederzeit «ViON» und eine Frage, und VOICE antwortet. Das Mikrofon der Kamera bleibt dafür offen; die Sprache wird auf dem Server erkannt, nichts wird gespeichert, und was das Kind beim Rufen sagt, geht nicht an den Assistenten. Ein Wort, das nur wie der Name klingt („Leon“ in einem Spiel), ruft nur zusammen mit einer Frage nach der Zeit. Mit mehreren Kindern an der Kamera wird jedes am Computer beantwortet. Vorerst nur auf Russisch; standardmäßig aus
- Antworten in Minuten: „noch 5 Minuten Pause“, „du kannst spielen, noch 20 Minuten bis zur Pause“, „weniger als eine Minute“; zu früh zurück, dieselben Minuten wie in der Erinnerung; ist die Pause am Computer fällig, die ganze Pause. Der nächste Morgen bleibt eine Uhrzeit („morgen um 07:30“)
- Die Pause wird zusammengezählt: zu früh zurück und wieder weg, nimmt das Kind nur noch den Rest; Erinnerung, Zustand und Antwort nennen, was bleibt
- Behoben: nach dem Tageslimit sagte VOICE in Moskau „morgen um 03:00“ (Mitternacht UTC) statt 00:00

## [0.2.1]

- Ausstehende Sätze, Erinnerungen und Zuhören werden beim Entfernen einer Kamera, Deaktivieren eines Szenarios, Gewähren zusätzlicher Zeit und Beenden von VOICE abgebrochen. Verspätete Antworten öffnen die Kamera nicht erneut.
- Gleichmäßiger RTP-Versand nach Timer-Verzögerungen, Schließen fehlerhafter und noch startender Audiokanäle, begrenzte Warteschlange.
- Fehlerbehandlung für Sprachaktivität und Assistenten, Prüfung von Satzlänge, Zeitverlängerungen und gespeichertem Zustand. Einheitliche Endzeit einer unterbrochenen Pause in Erinnerungen und Antworten.

## [0.2.0]

- Mit installierter Gegensprechanlage: ein Klingeln an einer Türstation wird auf den Lautsprechern für Benachrichtigungen angesagt („Klingeln: Tor“), über die Warteschlange, die Grenzen und die Ruhezeiten von VOICE
- Die Kameras der Türstationen sind keine Lautsprecher von VOICE mehr: dort spricht der Tür-Agent

## [0.1.1]

- Sprach-Engine, Lautsprecher, Zuhören und das Laden der Modelle liegen jetzt im gemeinsamen Paket `packages/vion-speech`, das auch die Gegensprechanlage nutzt. An dem, was VOICE tut, ändert sich nichts

## [0.1.0]

- Erste Version: Bildschirmzeit mit Pausen, Tageslimit und Schlafenszeit, Antworten auf Fragen des Kindes, „Wer ist an der Tür“, Sätze aus dem Chat, aus Automationen und Benachrichtigungen. Sprache wird auf dem Server erzeugt und erkannt. Einrichtung an der Kamera, auf der Seite der Erweiterung oder mit Worten im Assistenten-Chat
