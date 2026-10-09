## [0.4.1]

- Loslassen, Richtungswechsel und Entfernen von PTZ verwerfen Motorbefehle, die noch auf die P2P-Anmeldung warten. Entfernte Steuerungen führen keine Befehle aus.
- UDP-Bestätigungen prüfen Kanal und Sequenz; parallele Befehle werden nacheinander gesendet. Nicht gepufferte Pakete können erneut übertragen werden. Sitzungen und Befehlspuffer werden zuverlässig begrenzt und beendet.
- Beschädigte Antworten beenden die Motorsitzung statt das Plugin. Ungültige Relay-Pakete erreichen go2rtc nicht; Verbindungsabbrüche werden an PTZ gemeldet. Ein Motorfehler stoppt das Video nicht.
- Abmelden und Entfernen der Kamera brechen auch lokale Verbindungsversuche ab. Eine gleichzeitig registrierte PTZ-Steuerung wird wieder entfernt.
- Nach einer SDK-Neuverbindung funktioniert PTZ wieder, ohne alte Befehle auszuführen. Beim Abschalten eines gehaltenen Zooms wird der Stoppbefehl gesendet.

## [0.4.0]

- CS2-Kameras in anderen Netzwerken verbinden sich über Xiaomi-P2P-Relays. Pro Kamera stehen Automatisch, Lokales Netzwerk und P2P-Fernzugriff zur Auswahl. Automatisch bevorzugt eine erreichbare lokale Kamera; der bestehende go2rtc-Player bleibt erhalten.
- Frische Schlüssel pro Verbindung, begrenzte Wiederholungen und Abbruch beim Abmelden, Entfernen einer Kamera oder Beenden des Plugins. Unbenutzte Sitzungen werden geschlossen. Fernzugriff mit `xiaomi.camera.c01a01` und HEVC 2304×1296 bei maximaler Qualität geprüft.

## [0.3.0]

- Kameras mit Zoomobjektiv zoomen aus ViON: der Zoom im Player und **Home** (ganz heraus), wenn **Schwenken, Neigen und Zoomen (PTZ)** eingeschaltet ist. Ihr Fokus wird neben dem Schalter eingestellt: **Fokus näher**, **Fokus weiter** und der Autofokus der Kamera. Das Plugin findet Zoom und Fokus in der MIoT-Beschreibung, die Xiaomi für das Modell veröffentlicht; Kameras mit festem Objektiv (Mi 360°, C200, C300) haben beides nicht und drehen sich wie bisher
- Ein gehaltener Pfeil dreht die Kamera in einer gleichmäßigen Bewegung: Der Motor bekam nur jede halbe Sekunde einen Schritt und hielt vor jedem an, sodass die Kamera ruckelte und einen Teil der Schritte ausließ. Autotrack sieht die Kamera als in Bewegung, solange ihr Motor dreht

## [0.2.0]

- Kameras mit Motor lassen sich aus ViON drehen: Schalten Sie **Schwenken und Neigen (PTZ)** für die Kamera unter **Einstellungen**, **Autotrack** ein und halten Sie dann einen Pfeil im Player gedrückt oder lassen Sie Autotrack einer Person folgen

## [0.1.1]

- Die Bildprüfung wird angezeigt, egal in welcher Form Xiaomi sie sendet, und ein vertippter Code wird im selben Fenster neu eingegeben, ohne neuen Code
- Kameras, die ViON noch nicht abspielen kann (MTP und Agora), werden nicht angeboten: die Anmeldung nennt sie und den Grund
- Die Abmeldung entfernt die Kameras des Kontos und die gespeicherte Anmeldung, auch während eine Anmeldung oder das Lesen der Kameraliste noch läuft
- Eine Anmeldung, die Xiaomi abgelehnt hat, wird nicht immer wieder versucht: das Protokoll bittet einmal um eine neue Anmeldung
- Eine Anmeldung, die länger als 10 Minuten auf den Code wartet, wird abgebrochen, und das Passwort wird mit ihr vergessen
- Fehler im Protokoll und in Meldungen nennen ihre Ursache

## [0.1.0]

- Erste Version: Anmeldung beim Mi-Konto mit Bildprüfung und Bestätigungscode, Kameras aller Regionen von Mi Home, Livebild über das lokale Netzwerk
