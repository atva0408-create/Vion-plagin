## [2.0.6]

- Das Live-Bild friert seltener ein. Ein unterwegs verlorenes oder zwischen zwei Netzwerkpaketen geteiltes Bild hielt das Bild bis zum nächsten vollständigen Bild an
- Kameras hinter einer HomeBase 3 streamen weiter. Nach einer Weile schlug jedes neue Live-Bild fehl, bis die Verbindung neu aufgebaut wurde
- Kameras hinter einer HomeBase 2 zeigen das Bild ihres letzten Ereignisses, und ein Ereignis, das vor seinem Bild ankommt, bekommt trotzdem eines
- Die Sirene einer HomeBase 3 lässt sich auslösen
- Eine Verbindung zu einer verstummten Kamera wird bemerkt und neu aufgebaut. Das Live-Bild bleibt nicht mehr daran hängen
- Mit aktiviertem Debug-Log erscheint jede Eufy-Benachrichtigung im Log, sodass eine fehlende Erkennung nachverfolgt werden kann

## [2.0.5]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [2.0.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [2.0.3]

- Die HomeBase T9000 wird als HomeBase erkannt. Bisher erschien sie als Kamera, ohne Sicherheitsmodus, und die Kameras dahinter fanden ihre HomeBase nicht

## [2.0.2]

- **Melden Sie sich einmal neu an.** Das Update behebt eine Anmeldung, die Eufy ablehnte, und die gespeicherte Anmeldung enthält nicht, was dafür nötig ist. Möglicherweise wird ein Bestätigungscode verlangt. Öffnen Sie die Einstellungen des Eufy-Plugins und melden Sie sich erneut an
- Snapshots aus einem Ereignis brauchen nur noch einen Bruchteil des bisherigen Speichers
- Der Sicherheitsmodus einer Kamera ohne HomeBase, etwa der Indoor Cam Pan & Tilt, lässt sich wieder ändern. Die Änderung blieb hängen und erreichte die Kamera nie
- Mehr Eufy-Smart-Locks zeigen an, ob sie verriegelt sind, und der Zustand folgt, wenn das Schloss benutzt wird
- Keine Lichtsteuerung bei Kameras, die kein Licht haben. Eine Akku-Türklingel meldet eine Scheinwerfer-Einstellung, ohne eine Lampe zu haben, sodass ViON einen Lichtschalter zeigte, der jeden Druck mit einem Fehler beantwortete. Kameras, deren Scheinwerfer dieses Plugin nicht schalten kann, bieten keinen mehr an

## [2.0.1]

- Kameras mit Netzteil, etwa die Floodlight Cam und die Indoor Cam, zeigen keinen Akku mehr, der bei 100 % festhängt
- Kameras hinter einer HomeBase übertragen gleichzeitig, ohne sich abzuwechseln, und ein Snapshot hält das Livebild nicht mehr auf
- Die Wired Doorbell 2K wird als Türklingel erkannt

## [2.0.0]

- **Von Grund auf neu gebaut.** Das Plugin verbindet sich jetzt auf demselben Weg mit Eufy und den Kameras wie die aktuelle Eufy-App. Melden Sie sich einmal in den Plugin-Einstellungen neu an, möglicherweise wird ein Bestätigungscode verlangt. Erfordert ViON 2.2.3 oder neuer
- **Eufy-Sensoren kommen zu ViON.** Tür- und Fenstersensoren, Bewegungsmelder, Schlösser, Wasser-, Rauch- und CO-Melder sowie Sicherheitsmodus und Sirene einer HomeBase erscheinen auf der Seite „Sensoren“ zum Hinzufügen
- **Kamerasteuerung.** Scheinwerfer mit Helligkeit, Sirene, Schwenken und Neigen mit Presets, das Ein- und Ausschalten der Kamera und der Sicherheitsmodus von Kameras ohne HomeBase erscheinen als Bedienelemente, sofern die Kamera sie unterstützt
- **Mehr Erkennungen.** Unbekannte Personen, Haustiere, Geräusche und Weinen kommen als Erkennungen zu Bewegung, Personen und Fahrzeugen hinzu
- **Livebild.** Ein neuer Betrachter startet beim letzten Vollbild, und zwei Kameras hinter einer HomeBase können gleichzeitig übertragen
- **Snapshots aus dem letzten Ereignis.** Das Bild der letzten Eufy-Benachrichtigung wird verwendet, ohne eine Akkukamera zu wecken; ein frisches Bild wird nur auf Anforderung aufgenommen
- Der Stream-Modus wird je Kamera eingestellt: P2P für jede Kamera, RTSP dort, wo die Kamera oder HomeBase es anbietet. Die Einstellungen für Home-Name, Gerätename und „nur lokal“ gibt es nicht mehr

## [1.2.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.3]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.0]

- Das Feld für die Livebild-Dauer ändert sich jetzt in Schritten von 10 Sekunden
- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.5]

- Interne Verbesserungen

## [1.1.4]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.3]

- Fehlerbehebungen und Verbesserungen

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

- Erste Veröffentlichung
