## [0.1.1]

- Die Bildprüfung wird angezeigt, egal in welcher Form Xiaomi sie sendet, und ein vertippter Code wird im selben Fenster neu eingegeben, ohne neuen Code
- Kameras, die ViON noch nicht abspielen kann (MTP und Agora), werden nicht angeboten: die Anmeldung nennt sie und den Grund
- Die Abmeldung entfernt die Kameras des Kontos und die gespeicherte Anmeldung, auch während eine Anmeldung oder das Lesen der Kameraliste noch läuft
- Eine Anmeldung, die Xiaomi abgelehnt hat, wird nicht immer wieder versucht: das Protokoll bittet einmal um eine neue Anmeldung
- Eine Anmeldung, die länger als 10 Minuten auf den Code wartet, wird abgebrochen, und das Passwort wird mit ihr vergessen
- Fehler im Protokoll und in Meldungen nennen ihre Ursache

## [0.1.0]

- Erste Version: Anmeldung beim Mi-Konto mit Bildprüfung und Bestätigungscode, Kameras aller Regionen von Mi Home, Livebild über das lokale Netzwerk
