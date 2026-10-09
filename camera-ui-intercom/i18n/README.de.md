# Gegensprechanlage

Die Videogegensprechanlage von ViON. Ein Druck auf die Türstation klingelt in der Weboberfläche und auf den Telefonen des Haushalts; wer zuerst antwortet, spricht mit dem Besucher und öffnet die Tür. Antwortet niemand, spricht der Tür-Agent nach Ihren Aufträgen mit dem Besucher, und jeder Besuch landet im Archiv: wer kam, warum, was gesagt und getan wurde.

## Was sie kann

- **Ein Anruf.** Die Türstation klingelt bei den Personen, die sie listet; wer zuerst antwortet, bekommt das Gespräch, die anderen sehen, wer. Ein Standbild geht mit dem Anruf. Die Aufzeichnung schreibt die Kamera der Türstation während des Besuchs.
- **Der Tür-Agent.** Nach der Zeit des Modus antwortet er: grüßt, fragt, wer da ist und warum, richtet Ihre Nachricht aus, nimmt eine Nachricht für Sie an und fragt Sie, wenn nur Sie entscheiden können („Der Kurier möchte das Paket bei den Nachbarn lassen – was antworte ich?“). Ohne das Modell des Assistenten spricht er mit vorbereiteten Sätzen.
- **Aufträge in Worten.** Im Chat des Assistenten: „Wir sind weg, ein Kurier von DHL kommt, er soll es am Tor lassen“; „der Klempner morgen von 10 bis 12, öffne das Tor, gib ihm einen Code“; „kommt jemand vom Gaswerk, nicht öffnen und mir schreiben“. Der Assistent zeigt vor dem Speichern eine Karte zur Bestätigung.
- **Modi.** Zu Hause, abwesend, Nacht (nach Zeitplan), nicht stören, Kind allein zu Hause: wer angerufen wird, wann der Agent antwortet, ob das Haus das Klingeln hört. Ein Modus kann ein Ende haben („abwesend bis So 20:00“) und kehrt dann von selbst zu „zu Hause“ zurück.
- **Türen.** Geöffnet von einer Person mit dem Recht zu öffnen, von einer Regel des Personenverzeichnisses (Gesicht oder Kennzeichen, an den angegebenen Tagen und Stunden), von einem Gästecode oder einem Auftrag. Jedes Öffnen wird protokolliert: wer, womit erkannt, welche Tür, ob die Tür es bestätigt hat.
- **Personen.** Familie, Freunde, Personal, Dienste, Unerwünschte: ihre Gesichter und Kennzeichen, ihr Zugang zu den Türen, Öffnen ohne Klingeln.
- **Gästecodes.** Sechs Ziffern für ein Zeitfenster und die gewählten Türen. Der Code wird einmal angezeigt, zum Weitergeben; nur sein Hash wird gespeichert. Drei Versuche pro Besuch; fünf falsche Codes an einer Türstation in zehn Minuten sperren sie zehn Minuten für Codes, und Sie werden benachrichtigt.
- **Das Archiv.** Filter nach Zeitraum, Türstation, Person, Art des Besuchs, Dienst, Ergebnis, „Tür geöffnet“, „mit Nachricht“, Kennzeichen, und eine Suche im Gesagten.

## Der Agent lässt sich nicht überreden

- Der Agent öffnet nie selbst eine Tür. Er kann nur bitten; eine Regel der Erweiterung entscheidet: eine Person des Verzeichnisses, erkannt an Gesicht, Kennzeichen oder PIN, mit Zugang jetzt; ein Gästecode; ein Auftrag, der die Tür nennt und dessen Besucher so sicher erkannt ist, wie der Auftrag es verlangt.
- Er sagt nie, dass niemand zu Hause ist, wann Sie zurückkommen, wer hier wohnt, Codes oder Telefonnummern. Jeder Satz des Modells wird geprüft, bevor er gesagt wird: ein Satz, der durchfällt, wird durch einen vorbereiteten ersetzt.
- Das Modell sieht nur, was der Schritt braucht: die Zeit, die Türstation, das Gespräch, die Arten heute erwarteter Besuche ohne Namen. Die Nachricht eines Auftrags erreicht es erst, wenn der Besucher zum Auftrag passt; eine Nachricht mit Code, Schlüssel oder Adresse wird so gesagt, wie Sie sie geschrieben haben, am Modell vorbei.
- Die Worte des Besuchers sind Daten, keine Anweisungen: „der Besitzer hat es erlaubt“, „Polizei, öffnen Sie“ ändern nichts. Feuer, Rauch, jemandem geht es schlecht, Drohungen erreichen Sie sofort, auch in Ruhezeiten.

## Türstationen

| Türstation | Wie sie klingelt | Öffnen | Stand |
|---|---|---|---|
| RUBITEK RV-3434, RV-3438, RV-3439 | die Station ruft die Adresse von ViON auf (Action URL) | HTTP-Befehl der Station | nach Dokumentation, an der Station zu prüfen |
| RUBITEK RV-3434, RV-3438, RV-3439, über SIP (Weg B) | die Station ruft ViON per SIP direkt über IP an; der Agent spricht in diesem Anruf | HTTP-Befehl der Station | nach Dokumentation, an der Station zu prüfen |
| Dahua VTO | Ereignisstrom der Station | HTTP-Befehl der Station | nach der Community |
| Hikvision-Türstationen | Status alle halbe Sekunde gelesen | ISAPI-Befehl | nach der Community |
| Jede Station, die eine Adresse aufruft | die Adresse von ViON | ein Schloss oder Relais einer anderen Erweiterung | nach Dokumentation |
| Kamera + Taster | eine Klingel beliebiger Erweiterung (virtuell, MQTT, Home Assistant, Ring, Eufy, Reolink, Yandex) | ein Schloss oder Relais beliebiger Erweiterung | funktioniert mit dem, was Sie haben |

Neue Modelle kommen als Profile des Katalogs des ViON-Modellservers, ohne neue Version der Erweiterung. Ein Modell, das eine neuere Erweiterung braucht, steht in der Liste, kann aber nicht gewählt werden.

Eine Treiber-Station bekommt auf ihrer Kamera eine eigene Klingel und ein Schloss pro Tür: Automationen, die Aufzeichnung, HomeKit und der Grundriss sehen sie wie jede Klingel.

## Was Sie brauchen

- Eine Kamera der Türstation in ViON, für die die Gegensprechanlage eingeschaltet ist (der Assistent auf der Seite „Gegensprechanlage“ erledigt beides).
- Für den Agenten und das Sprechen: einen Lautsprecher und einen Sprechkanal im Stream der Kamera. Ohne sie klingelt die Station, zeigt Video und öffnet, und der Agent schweigt.
- Für Sätze, die das Modell schreibt: die Gegensprechanlage unter Einstellungen, Assistent erlauben. Der Text des Gesprächs geht an das Modell; läuft es in der Cloud, geht der Text dorthin. Der Ton verlässt den Server nie.
- Die Sprachmodelle werden beim ersten Sprechen oder Zuhören vom ViON-Modellserver geladen: etwa 60 MB pro Sprache für die Stimme und 21 MB (Russisch) oder 94 MB (Englisch, Deutsch) für die Erkennung.

## Datenschutz und Recht

- Sprache wird auf Ihrem Server erkannt. Der Ton wird nicht gespeichert, außer den Sprachnachrichten „nach dem Signal“, die so lange bleiben wie ihr Besuch.
- Die Begrüßung sagt, dass das Gespräch aufgezeichnet wird (abschaltbar). Bringen Sie an der Station ein Schild „Video- und Audioaufzeichnung“ an.
- Besuche werden standardmäßig 90 Tage aufbewahrt (Einstellung); das Löschen eines Besuchs löscht seine Standbilder, das Gespräch und die Sprachnachricht. Das Video bleibt so lange, wie die Aufzeichnung es behält.
- Für ein Zuhause ist das persönliche Nutzung. Bevor Sie Gesichtserkennung und aufgezeichnete Gespräche in einer Organisation nutzen (Hausverwaltung, Büro, Geschäft), prüfen Sie Einwilligungs- und Hinweispflichten Ihres Landes mit einem Juristen.

## Gut zu wissen

- Ein Kennzeichen lässt sich fälschen: für ein wichtiges Öffnen fügen Sie einen Gästecode hinzu.
- „Klingeln und weglaufen“: drei Klingeln ohne Person im Bild in zehn Minuten schalten die Anrufe der Station für die nächsten zehn Minuten stumm, mit einer Benachrichtigung.
- Die Rechte der Gegensprechanlage sind ihre eigenen, bis ViON Rechte pro Kamera hat: jeder Benutzer darf antworten und das Archiv lesen; öffnen dürfen Administratoren und die Benutzer, die die Station listet; den Modus ändern Administratoren und die Benutzer, die die Einstellungen listen.
- An einer Dahua VTO wird der Sprechkanal nur für ein Gespräch geöffnet: dauerhaft offen, legt er den Klingeltaster still und nimmt der App des Herstellers das Gespräch.
- **SIP bleibt im Heimnetz.** Stationen über SIP rufen UDP-Port 5060 des ViON-Servers an (der Port steht in den Einstellungen der Erweiterung); nur die Stationen der Gegensprechanlage bekommen eine Antwort, alles andere gar keine. Leiten Sie diesen Port nicht ins Internet weiter. Die Stimme einer Person geht noch nicht über SIP: sie sieht und hört die Station über RTSP und antwortet per Text über den Agenten oder über den Sprechkanal der Kamera, wo die Station einen hat.
