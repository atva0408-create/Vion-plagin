# SMTP

Macht aus der E-Mail, die eine Kamera bei Bewegung versendet, ein Bewegungsereignis in ViON. Das Plugin betreibt einen kleinen Mailserver, an den die Kamera ihre Benachrichtigungen sendet.

## Funktionen

- Empfängt die Benachrichtigungs-E-Mails Ihrer Kameras direkt auf dem ViON-Server, ohne externen Maildienst
- Gibt jeder Kamera einen Bewegungssensor mit eigener E-Mail-Adresse; eine Nachricht an diese Adresse meldet Bewegung
- Kann nur E-Mails mit einem bestimmten Text als Bewegung werten
- Kann die Bewegung beenden, wenn eine Nachricht mit einem anderen Text eintrifft
- Akzeptiert von der Kamera beliebige Benutzernamen und Passwörter, es muss also kein Postfach angelegt werden

## Voraussetzungen

- Eine Kamera, die bei erkannter Bewegung eine E-Mail versenden kann
- In den E-Mail-Einstellungen der Kamera: die Adresse des ViON-Servers als Mailserver (SMTP), der in diesem Plugin eingestellte Port und als Empfänger die Adresse, die Sie für diese Kamera in ViON eingetragen haben

## Einstellungen

Plugin:

- **Port**: der Port, auf dem der Mailserver E-Mails annimmt, standardmäßig 25
- **TLS deaktivieren**: einschalten für Kameras, die keine verschlüsselte Verbindung (STARTTLS) unterstützen

Bewegungssensor jeder Kamera:

- **E-Mail-Adresse**: die Empfängeradresse, die für diese Kamera steht; Name und Domain sind frei wählbar
- **Text für Bewegungsbeginn**: Text, den der Nachrichtentext enthalten muss, damit Bewegung gemeldet wird. Leer lassen, um bei jeder E-Mail auszulösen
- **Text für Bewegungsende**: Text im Nachrichtentext, der die Bewegung beendet
