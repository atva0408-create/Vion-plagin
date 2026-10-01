## [1.2.27]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [1.2.26]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.25]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.24]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.23]

- Eine per IP-Adresse hinzugefügte Kamera bleibt nach einer Störung nicht mehr auf der langsamen UID-Verbindung hängen. War die direkte Verbindung einmal fehlgeschlagen, wechselte die Kamera auf ihre UID und nutzte sie stundenlang weiter, mit ruckelndem Video und verlorenen Bildern. Beim erneuten Verbinden versucht sie jetzt wieder die direkte Verbindung, höchstens alle fünf Minuten

## [1.2.22]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.21]

- Das Umstellen einer Kamera zwischen H.264 und H.265 lässt das Plugin nicht mehr abstürzen. Der Stream stellt sich jetzt im laufenden Betrieb auf das neue Videoformat ein

## [1.2.20]

- Kleinere Fehlerbehebungen

## [1.2.19]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.18]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.17]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.16]

- Das Hinzufügen einer Akkukamera, die langsam aufwacht, bricht nicht mehr mittendrin ab. Das Hinzufügen ließ genau so viel Zeit, wie das Aufwachen braucht, und konnte deshalb einen Moment vor der Antwort der Kamera aufgeben

## [1.2.15]

- Reine Akkukameras lassen sich jetzt allein per IP-Adresse hinzufügen. Der Rückgriff auf die UID-Verbindung setzte voraus, dass die UID bekannt ist, was nicht der Fall ist, wenn eine Kamera von Hand eingetragen wird; die Kamera wird jetzt auf demselben Weg wie von der Reolink-App nach ihrer UID gefragt, und die Antwort wird mit der Kamera gespeichert
- Das Aufwecken einer schlafenden Kamera bekommt die Zeit, die es braucht. Eine Akkukamera antwortet erst nach etwa zehn Sekunden wiederholter Versuche, und der Verbindungsversuch gab kurz davor auf

## [1.2.14]

- Reine Akkukameras lassen sich wieder hinzufügen. Eine schlafende Kamera nimmt keine direkten Verbindungen an, sodass das Hinzufügen mit „connection refused“ scheiterte, obwohl die Reolink-App sie erreichte. Das Plugin weicht jetzt auf die UID-Verbindung der Kamera aus

## [1.2.13]

- Akkukameras und Türklingeln sind nicht mehr innerhalb eines Tages leer. Das Plugin hielt rund um die Uhr eine Verbindung zur Kamera offen, und genau das hindert ein Akkumodell am Schlafen. Es nennt der Kamera jetzt eine Adresse für ihre Meldungen und gibt die Verbindung frei; Bewegung, Klingeln und Akkustand kommen von selbst an. Kameras, deren Firmware nicht auf diesem Weg melden kann, sagen das im Protokoll und behalten das alte Verhalten
- Die Verbindung zu einer Akkukamera wird erst getrennt, wenn die Kamera ViON tatsächlich mit einer eigenen Meldung erreicht hat. Gelingt ihr das nicht, bleibt die Verbindung bestehen und das Protokoll sagt es, damit eine Kamera in einer ungewöhnlichen Netzwerkumgebung nie verstummt
- Neue Kameraeinstellung „Dauerhafte Stromversorgung“ für Akkumodelle. Eine Türklingel am Klingeltransformator hat keinen Grund zu schlafen, sie hält deshalb die Verbindung wie eine Netzkamera und reagiert schneller. Die Einstellung wirkt sofort
- Eine deaktivierte Kamera ist jetzt wirklich deaktiviert. Das Deaktivieren stoppte nur Aufzeichnung und Übertragung, das Plugin blieb aber an der Kamera angemeldet und fragte sie weiter nach Ereignissen. Aktivieren und Deaktivieren wirken sofort

## [1.2.12]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.11]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.10]

- Fehlerbehebungen und Verbesserungen

## [1.2.9]

- Bewegungs- und KI-Erkennungen von Kameras, deren Firmware die Ereignisse anders verpackt, werden wieder erkannt. Manche Modelle verpacken sie in eine Liste, die das Plugin nicht kannte, und jede Erkennung dieser Kameras ging verloren
- Eine Kamera, die ihre Erkennungen für einen anderen Kanal meldet als den, unter dem sie hinzugefügt wurde, sagt das jetzt im Protokoll, statt wie eine Kamera auszusehen, die nie etwas erkennt

## [1.2.8]

- PTZ-Kameras zeigen ihre gespeicherten Positionen. Die Presets, die Sie in der Reolink-App eingerichtet haben, erscheinen in der PTZ-Steuerung und lassen sich mit einem Klick anfahren; die Liste wird jede Minute neu gelesen, sodass umbenannte oder neue Presets von selbst erscheinen
- Kameras werden in einem wackeligen Netzwerk nicht mehr als offline angezeigt. Eine ausgelastete Kamera beantwortet die Verbindungsprüfung spät, weil ihre Antwort hinter dem Video wartet, und das wurde als ausgefallene Kamera gewertet. Video, das über die Verbindung ankommt, gilt jetzt als Beweis, dass die Kamera da ist, und eine Kamera bekommt 30 Sekunden, um zurückzukommen, bevor sie als offline gemeldet wird
- Ein stockender Stream reißt nicht mehr die ganze Kamera mit. Ein Stream, der verstummt, wird von selbst neu gestartet, Ereignisse und die anderen Streams laufen weiter
- Eine Kamera, die ihr Video nicht rechtzeitig liefern kann, lässt das Livebild nicht mehr Sekunden in der Vergangenheit hängen. Der Stream überspringt die alten Bilder und läuft beim nächsten Vollbild weiter, sodass das Livebild live bleibt. Die neue Kameraeinstellung „Zum Livebild aufholen“ legt fest, wie viele Sekunden das Bild zurückliegen darf, bevor das geschieht, und wirkt sofort; übersprungene Sekunden fehlen auch in Aufzeichnungen, stellen Sie also 0 ein, um jedes Bild zu behalten und die Verzögerung in Kauf zu nehmen

## [1.2.7]

- Livestreams laufen jetzt nahezu in Echtzeit. Jeder Stream wurde bisher eine feste Zeit zurückgehalten, bevor er das Plugin verließ; diese Verzögerung ist weg, und Bilder werden in dem Moment weitergegeben, in dem die Kamera sie sendet
- Ein Aussetzer in der Uhr der Kamera führt nicht mehr zu einem eingefrorenen Bild oder einem Sprung; der Stream behält sein gleichmäßiges Tempo und der Ton bleibt synchron
- Kameras mit zwei Objektiven (TrackMix, RLC-81MA) können ihr Teleobjektiv übertragen. Fügen Sie die Kamera hinzu, und das Teleobjektiv erscheint in der Liste der entdeckten Kameras als eigene Kamera, Benutzername und Passwort sind bereits eingetragen

## [1.2.5]

- Keine beschädigten Videobilder mehr, wenn das System kurzzeitig überlastet ist. Ein verlorenes Stück des Kamerastreams wurde mit falschen Daten überbrückt und konnte sich als Bildstörung zeigen; der Stream startet jetzt stattdessen sauber neu
- Kommt das System unter Last mit dem Video nicht mehr nach, pausiert das Bild jetzt kurz und läuft beim nächsten Vollbild weiter, statt zufällige Bilder zu verwerfen, die bei jedem Betrachter ein kaputtes Bild hinterließen. Der Ton läuft während der Pause weiter

## [1.2.4]

- Das Plugin hört so lange auf Ereignisse, wie die Verbindung besteht. Bisher wurde das Zuhören alle fünf Minuten beendet und neu aufgebaut, und eine Erkennung, die in diesen Moment fiel, ging verloren

## [1.2.3]

- Kameras an einem NVR oder Home Hub bekommen ihre Ereignisse wieder. Die Anforderung der Ereignisse wurde für den falschen Kanal gesendet, sodass die Kamera sie annahm und dann nie Bewegung oder KI-Erkennungen meldete
- Eine Kamera, die nach dieser Anforderung stumm bleibt, wird jetzt alle 30 Sekunden statt alle 5 Minuten erneut gefragt, und das Protokoll sagt es, wenn sie nie antwortet

## [1.2.2]

- Türklingeln melden wieder einen verweilenden Besucher. Manche Modelle beschreiben die Zone, ohne zu sagen, was sie gesehen haben, und diese Ereignisse wurden verworfen, statt als Bewegung zu zählen

## [1.2.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.2.0]

- Kompatibilitätsupdate für die aktuelle ViON-Version
- Erfordert ViON 2.0.23 oder neuer

## [1.1.5]

- WLAN-Kameras fehlen bei der Kamerasuche nicht mehr. Manche Modelle ignorieren die Suche in den ersten zehn Sekunden und tauchten deshalb nur bei jedem zweiten Versuch auf. Das Plugin sucht jetzt im Hintergrund weiter, und eine Suche ist in zwei statt zehn Sekunden fertig
- Ton und Bild teilen sich jetzt eine Uhr. Die Kamera sendet ihren Ton ohne Zeitangaben, und das Plugin startete die Uhr für den Ton bei null statt beim Bild, weshalb sich Ton und Bild in Aufzeichnungen nicht zur Deckung bringen ließen
- Gegensprechen funktioniert wieder. Die Kamera blieb stumm, weil Ihre Stimme über eine zweite Verbindung ankam, die das Plugin verwarf; beide Verbindungen erreichen jetzt die Kamera
- Der Schalter für den Scheinwerfer folgt jetzt der Kamera. Schaltet die Kamera ihr Licht selbst ein oder schalten Sie es in der Reolink-App, zeigt ViON das an, statt beim zuletzt selbst gesetzten Zustand zu bleiben
- Kameras, die auf Babyweinen hören, bekommen jetzt einen eigenen Sensor für die Geräuscherkennung, statt dass das Geräusch so erscheint, als wäre es im Bild gesehen worden. Der Sensor erscheint, sobald die Kamera zum ersten Mal tatsächlich eines meldet

## [1.1.4]

- Bei neuen Kameras ist jetzt „Vorladen“ für jeden Stream und „Hot Modus“ für Haupt- und Substream eingeschaltet, damit das Livebild ohne lange Wartezeit öffnet
- Streams werden erst gestartet, wenn tatsächlich jemand zusieht; die Verbindung zur Kamera bleibt für Ereignisse und Snapshots offen
- Fehlerbehebungen und Verbesserungen

**Bitte prüfen Sie Ihre vorhandenen Kameras.** Kameras, die vor diesem Update hinzugefügt wurden, behalten ihre alten Einstellungen. Öffnen Sie die Kamera, gehen Sie zu „Quellen“ und schalten Sie „Hot Modus“ und „Vorladen“ für Haupt- und Substream ein. Lassen Sie „Hot Modus“ bei Akkukameras aus, er würde die Kamera wach halten und den Akku leeren

## [1.1.3]

- Fehlerbehebungen und Verbesserungen

## [1.1.2]

- NVRs und Home Hubs werden beim Hinzufügen richtig erkannt. Bei Geräten mit AES-Verschlüsselung wurde die Antwort auf die Anmeldung falsch gelesen, sodass ein NVR wie eine einzelne Kamera behandelt wurde, statt seine Kanäle aufzulisten
- Erkennungen beider Objektive von Kameras mit zwei Objektiven (TrackMix, RLC-81MA) werden jetzt erkannt
- Zonenbasierte Smart-Erkennungen (Linienüberquerung, Eindringen, Verweilen) lösen jetzt Bewegungs- und Objektereignisse aus; bisher blieben Kameras stumm, die nur mit Smart-Zonen eingerichtet waren

## [1.1.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.1.0]

- Unterstützung für NVR und Home Hub: Beim Hinzufügen eines NVR wird jeder belegte Kanal als eigene Kamera aufgelistet, für jeden Kanal wird ermittelt, was er kann (KI-Erkennung, Sirene, Scheinwerfer, PTZ), und Benutzername und Passwort werden gemerkt, sind vorausgefüllt und überstehen Neustarts
- Neue Aktion „NVR vergessen“ in den Plugin-Einstellungen, um einen verbundenen NVR und seine Kanaleinträge zu entfernen
- „bad credentials“ beim Verbinden mit NVRs (zum Beispiel RLN36) behoben: Das Plugin spricht den NVR und seine Kanäle jetzt so an, wie es die offiziellen Reolink-Apps tun
- Wahl der Verschlüsselung korrigiert: Das Plugin verwendet jetzt die Art der Verschlüsselung, der die Firmware des Geräts zustimmt, statt nach der Anmeldung immer auf AES umzuschalten
- Die Kamerasuche listet nur noch Geräte auf, die die aktuelle Suche tatsächlich sieht; Kanäle eines NVR werden aufgelistet, solange ihr NVR vorhanden ist, von Hand hinzugefügte Kameras sind ausgenommen

## [1.0.3]

- Interne Verbesserungen

## [1.0.2]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [1.0.0]

- Erste Veröffentlichung
