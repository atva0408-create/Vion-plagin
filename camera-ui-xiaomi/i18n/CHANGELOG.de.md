## [0.3.0]

- Kameras mit Zoomobjektiv zoomen aus ViON: der Zoom im Player und **Home** (ganz heraus), wenn **Schwenken, Neigen und Zoomen (PTZ)** eingeschaltet ist. Ihr Fokus wird neben dem Schalter eingestellt: **Fokus näher**, **Fokus weiter** und der Autofokus der Kamera. Das Plugin findet Zoom und Fokus in der MIoT-Beschreibung, die Xiaomi für das Modell veröffentlicht; Kameras mit festem Objektiv (Mi 360°, C200, C300) haben beides nicht und drehen sich wie bisher

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
