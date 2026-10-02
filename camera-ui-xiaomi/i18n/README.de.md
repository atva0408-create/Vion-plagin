# Xiaomi

Verbindet Kameras von Xiaomi Mi Home mit ViON. Sie melden sich mit Ihrem Mi-Konto an, das Plugin findet die Kameras des Kontos und Sie fügen die gewünschten hinzu. Das Video geht von der Kamera über Ihr lokales Netzwerk zum ViON-Server; die Cloud von Mi Home gibt nur die Schlüssel für jede Verbindung aus.

## Funktionen

- Meldet sich bei Ihrem Mi-Konto an, auch mit der Bildprüfung und dem Bestätigungscode, falls Xiaomi danach fragt
- Findet die Kameras des Kontos in allen Regionen von Mi Home und bietet sie zum Hinzufügen an
- Zeigt das Livebild jeder Kamera, mit Ton, wenn die Kamera welchen hat
- Speichert ein Anmeldetoken statt Ihres Passworts, damit sich das Plugin nach einem Neustart selbst wieder anmeldet

## Voraussetzungen

- Kameras im selben lokalen Netzwerk wie der ViON-Server
- Eine Internetverbindung: Jede Verbindung zu einer Kamera fragt die Cloud von Mi Home nach ihren Schlüsseln
- Konto und Passwort der App Mi Home, in der die Kameras sind
- Kameras mit dem gemeinsamen Kameraprotokoll von Xiaomi. Die meisten Modelle seit 2020 nutzen es; einige ältere Modelle werden nicht unterstützt

## Einstellungen

- **Mi-Konto** und **Passwort**: E-Mail, Telefonnummer oder Mi-ID und Passwort Ihres Kontos bei Mi Home. Das Passwort wird nur für die Anmeldung verwendet und nicht gespeichert
- **Anmelden**: meldet sich an und findet die Kameras. Fragt Xiaomi nach den Zeichen eines Bildes oder nach einem Code, der an Ihr Telefon oder Ihre E-Mail-Adresse ging, öffnet sich ein Fenster dafür
- **Angemeldetes Konto**: die ID des Kontos, bei dem das Plugin angemeldet ist
- **Abmelden**: vergisst die Anmeldung. Hinzugefügte Kameras bleiben und zeigen nach der nächsten Anmeldung wieder Video
- **Bildqualität**: Standard, Hoch, Niedrig oder Maximal. Maximal passt zu neueren Modellen, bei älteren kann sie das Bild stören

## Gut zu wissen

- Xiaomi bietet keine offizielle Schnittstelle für andere Systeme. Das Plugin meldet sich so an wie die App Mi Home; eine Änderung auf Seiten von Xiaomi kann ein Update des Plugins erfordern
- Bei Kameras mit zwei Objektiven wird das erste Objektiv gezeigt
- Eine Kamera, die im Netzwerk eine neue Adresse bekommt, wird innerhalb weniger Minuten wiedergefunden
