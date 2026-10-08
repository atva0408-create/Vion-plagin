## [1.3.1]

- Das Speichern und Löschen eines Presets über den Assistenten funktioniert bei einer Kamera, deren Presets mit Ziffern benannt sind („1“, „2“): Der Name wurde als Zahl gelesen, und jedes Speichern und Löschen bei dieser Kamera schlug fehl

## [1.3.0]

- Der ViON-Assistent liest die Presets einer PTZ-Kamera, speichert die aktuelle Position als Preset oder löscht eines und startet eine ONVIF-Kamera neu, die nicht mehr antwortet; jede Änderung wird im Chat bestätigt und ist nur Administratoren erlaubt

## [1.2.8]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.2.7]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.6]

- Eine Kamera, die beim Start von ViON nicht erreichbar war, kommt jetzt von selbst zurück
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.5]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.3]

- Das Anfahren eines PTZ-Presets funktioniert wieder. Die meisten Kameras speichern ein Preset unter einer anderen Kennung als dem angezeigten Namen, und das Plugin schickte den Namen, sodass die Kamera antwortete, das Preset existiere nicht
- Presets, die Sie in der App der Kamera anlegen oder umbenennen, erscheinen innerhalb einer Minute. Bisher wurde die Liste einmal beim Start gelesen, und ein neues Preset brauchte einen Neustart des Plugins

## [1.2.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.0]

- Kurze Bewegungsimpulse von thingino-Kameras gehen nicht mehr verloren. Diese Kameras melden bei jeder Abfrage nur den letzten Bewegungszustand, und das Plugin legte zwischen zwei Abfragen genau in dem Moment eine Pause ein, in dem eine einsekündige Bewegung beginnen und enden konnte, sodass die meisten Auslöser verloren gingen. Solange etwas passiert, fragt das Plugin jetzt ohne Pausen ab
- Tapo-Kameras fluten das Protokoll nicht mehr mit „other side closed“ und verlieren ihr Ereignisabonnement nicht mehr alle zwei Minuten. Ihre Firmware bricht eine Ereignisabfrage ab, die sie nicht innerhalb von etwa 10 Sekunden beantwortet hat; in diesem Fall wechselt das Plugin jetzt zu kürzeren Abfragen, die die Kamera rechtzeitig beantwortet
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.11]

- Bewegungsereignisse von thingino-Kameras kommen jetzt zuverlässig an. Ihre Firmware (vor 02/2026) schickt eine fehlerhafte Antwort auf die Frage, welche Ereignisarten sie unterstützt, und das Plugin gab die Ereignisse ganz auf, statt trotzdem zuzuhören

## [1.1.10]

- Bereits hinzugefügte Kameras tauchen nicht mehr nach einer Weile unter „Entdeckt“ auf, manchmal doppelt mit derselben Adresse. Manche Kameras melden nach einem Neustart eine neue Identität; die Suche erkennt sie jetzt an ihrer Adresse, statt sie erneut aufzulisten

## [1.1.9]

- Weniger überflüssige Meldungen im Protokoll

## [1.1.8]

- Kameras hören nicht mehr auf zu reagieren, nachdem die Verbindung im laufenden Betrieb abgerissen ist. Eine fehlgeschlagene Ereignisabfrage („other side closed“ oder ein HTTP-Fehler mit Status 400) wurde ohne Pause wiederholt und überflutete die Kamera, bis sie überhaupt keine ONVIF-Anfragen mehr beantwortete, auch nicht die Kamerasuche und PTZ. Fehlgeschlagene Abfragen werden jetzt mit wachsenden Pausen wiederholt, und eine abgerissene Verbindung verwirft kein noch gültiges Ereignisabonnement mehr
- PTZ-Statusabfragen stauen sich nicht mehr, solange die Kamera nicht reagiert; sie pausieren mit wachsenden Abständen, bis die Kamera wieder antwortet
- Weniger überflüssige Meldungen im Protokoll: Ein wiederholter Ereignisfehler wird einmal protokolliert, statt das Kameraprotokoll zu fluten, gefolgt von einer Zeile „recovered“, sobald die Ereignisse wieder funktionieren, und die Liste der Kamerafähigkeiten beim Verbinden ist jetzt eine kurze Zusammenfassung

## [1.1.7]

- Interne Verbesserungen

## [1.1.6]

- Übrig gebliebene Diagnosemeldungen aus dem Protokoll entfernt

## [1.1.5]

- Sensoren zeigen ihre Details jetzt in den Sensoreinstellungen: Ereignissensoren listen die Ereignisthemen der Kamera auf, die sie speisen, der PTZ-Sensor zeigt die Achsen, die unterstützten Bewegungsbefehle und die auf der Kamera gefundenen Presets
- Fehlerbehebungen und Verbesserungen
- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.3]

- Geräteadressen ohne vorangestelltes Protokoll (`192.168.1.100` oder `192.168.1.100:8080`) werden angenommen, statt mit „Invalid URL“ zu scheitern; ist eine gespeicherte Adresse wirklich fehlerhaft, nennt das Protokoll jetzt diese Adresse

## [1.1.2]

- Bewegungs- und Erkennungsereignisse kommen jetzt auch von Kameras an, die für ihr Ereignisabonnement eine interne oder falsche Adresse melden. Das Plugin verwendet immer die Adresse und den Port, die Sie eingetragen haben
- Mehr Einzelheiten zu eingehenden ONVIF-Ereignissen im Protokoll (Ereignisthema, erkannter Bewegungszustand, verworfene Ereignisse). Stellen Sie die Protokollstufe der Kamera auf Debug, um zu verfolgen, wie Ereignisse ankommen

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

- Erste Veröffentlichung
