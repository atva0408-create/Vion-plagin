# Xiaomi

Verbindet Kameras von Xiaomi Mi Home mit ViON. Sie melden sich mit Ihrem Mi-Konto an, das Plugin findet die Kameras des Kontos und Sie fügen die gewünschten hinzu. Das Video geht von der Kamera über Ihr lokales Netzwerk zum ViON-Server; die Cloud von Mi Home gibt nur die Schlüssel für jede Verbindung aus.

## Funktionen

- Meldet sich bei Ihrem Mi-Konto an, auch mit der Bildprüfung und dem Bestätigungscode, falls Xiaomi danach fragt
- Findet die Kameras des Kontos in allen Regionen von Mi Home und bietet sie zum Hinzufügen an
- Zeigt das Livebild jeder Kamera, mit Ton, wenn die Kamera welchen hat
- Speichert das Anmeldetoken Ihres Mi-Kontos statt des Passworts, damit sich das Plugin nach einem Neustart selbst wieder anmeldet. Das Token öffnet das ganze Mi-Konto, siehe **Gut zu wissen**

## Voraussetzungen

- Kameras im selben lokalen Netzwerk wie der ViON-Server
- Eine Internetverbindung: Jede Verbindung zu einer Kamera fragt die Cloud von Mi Home nach ihren Schlüsseln
- Konto und Passwort der App Mi Home, in der die Kameras sind
- Kameras mit dem gemeinsamen Kameraprotokoll von Xiaomi. Die meisten Modelle seit 2020 nutzen es; einige ältere Modelle werden nicht unterstützt. Kameras, die Xiaomi über MTP oder Agora verbindet, können noch nicht abgespielt werden: Sie werden nicht zum Hinzufügen angeboten, und das Fenster der Anmeldung listet sie auf

## Einstellungen

- **Mi-Konto** und **Passwort**: E-Mail, Telefonnummer oder Mi-ID und Passwort Ihres Kontos bei Mi Home. Das Passwort wird nur für die Anmeldung verwendet und nicht gespeichert
- **Anmelden**: meldet sich an und findet die Kameras. Fragt Xiaomi nach den Zeichen eines Bildes oder nach einem Code, der an Ihr Telefon oder Ihre E-Mail-Adresse ging, öffnet sich ein Fenster dafür
- **Angemeldetes Konto**: die ID des Kontos, bei dem das Plugin angemeldet ist
- **Abmelden**: vergisst die Anmeldung und löscht das Anmeldetoken aus ViON. Hinzugefügte Kameras bleiben und zeigen nach der nächsten Anmeldung wieder Video
- **Bildqualität**: Standard, Hoch, Niedrig oder Maximal. Maximal passt zu neueren Modellen, bei älteren kann sie das Bild stören

## Kameras hinzufügen

1. Öffnen Sie die Einstellungen des Plugins, geben Sie Mi-Konto und Passwort ein und klicken Sie auf **Anmelden**
2. Fragt Xiaomi nach den Zeichen eines Bildes oder nach einem Code, geben Sie sie im Fenster ein, das sich öffnet. Ein vertippter Code kann im selben Fenster erneut eingegeben werden; ein Fenster, das 10 Minuten auf eine Antwort wartet, wird abgebrochen
3. Danach zeigt das Fenster die gefundenen Kameras
4. Öffnen Sie in ViON die Seite **Kameras**: Die Kameras stehen unter **Entdeckt**. Klicken Sie eine Kamera an, prüfen Sie den Namen und bestätigen Sie

## Gut zu wissen

- Das Anmeldetoken ist ein Schlüssel zum ganzen Mi-Konto, nicht nur zu seinen Kameras: Wer es hat, kann sich ohne Passwort beim Konto anmelden. ViON speichert es in den Einstellungen des Plugins; schützen Sie den ViON-Server und seine Sicherungen daher wie das Passwort selbst. **Abmelden** löscht es aus ViON; um eine Kopie davon unbrauchbar zu machen, ändern Sie das Passwort des Mi-Kontos. Nach einer Änderung des Passworts lehnt Xiaomi das Token ab, und das Plugin bittet Sie, sich erneut anzumelden
- Xiaomi bietet keine offizielle Schnittstelle für andere Systeme. Das Plugin meldet sich so an wie die App Mi Home; eine Änderung auf Seiten von Xiaomi kann ein Update des Plugins erfordern
- Bei Kameras mit zwei Objektiven wird das erste Objektiv gezeigt
- Eine Kamera, die im Netzwerk eine neue Adresse bekommt, wird innerhalb weniger Minuten wiedergefunden
