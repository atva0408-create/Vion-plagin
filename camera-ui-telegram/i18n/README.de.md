# Telegram

Sendet ViON-Benachrichtigungen über Ihren eigenen Bot in Telegram-Chats: Bild und Text eines Ereignisses, Meldungen der Zonenregeln — alles, was ein Telefon bekommt.

## Was es tut

- Jeder ViON-Benutzer verbindet seinen eigenen Chat (oder eine Gruppe) über einen einmaligen Link; der Chat erhält die Benachrichtigungen dieses Benutzers.
- Ruhezeiten, Stummschaltung und der Kamerazugriff gelten wie für ein Telefon.
- Eine Benachrichtigung mit Bild kommt als Bild mit Text; stille Benachrichtigungen ohne Ton.
- Ein Chat, der den Bot blockiert, wird abgeschaltet; `/stop` im Chat schaltet ihn ab.
- Der Bot holt seine Nachrichten selbst ab: aus dem Internet muss nichts ViON erreichen.

## Einrichtung

1. Öffnen Sie in Telegram @BotFather, senden Sie `/newbot` und folgen Sie den Schritten. Kopieren Sie das Token.
2. Fügen Sie das Token in den Plugin-Einstellungen unter «Bot-Token» ein.
3. Jeder Benutzer: ViON → Einstellungen → Benachrichtigungen → «Telegram verbinden», Link öffnen und Start drücken.

## Einstellungen

- **Bot-Token** — von @BotFather.
- **Bot-API-Adresse** — leer für api.telegram.org; ein eigener Bot-API-Server oder ein Proxy, zum Beispiel wo Telegram gesperrt ist.
- **ViON-Adresse für die Schaltfläche** — wenn gesetzt, hat eine Nachricht eine Schaltfläche, die den Moment in ViON öffnet.
