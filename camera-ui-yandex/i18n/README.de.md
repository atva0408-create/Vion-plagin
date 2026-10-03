# Yandex Smart Home

Verbindet ViON mit dem Yandex Smart Home und den Alice-Stationen. Sensoren und Relais des Hubs in einer Yandex-Station werden zu Sensoren von ViON, Szenarien des Smart Home laufen aus Automationen von ViON, Stationen sprechen Benachrichtigungen laut aus, und Kameras des Smart Home erscheinen in ViON.

## Funktionen

- **Sensoren**: Bewegung, Türen und Fenster, Wasserlecks, Rauch, Gas, Vibration, Taster, Temperatur, Luftfeuchtigkeit, Helligkeit und CO₂ des Smart Home werden zu Sensoren von ViON. Sie können Aufnahme und Erkennung an den Kameras sowie Automationen auslösen
- **Steuerung**: Relais, Steckdosen, Schalter und Lampen des Smart Home werden zu Schaltern und Lampen von ViON, Automationen schalten sie ein und aus
- **Szenarien**: jedes Szenario des Smart Home wird als Schalter angeboten. Einschalten startet das Szenario, aus der Oberfläche oder aus einer Automation
- **Sprache der Stationen**: jede Station ist ein Benachrichtigungsziel. Eine für sie gewählte Benachrichtigung wird laut gesprochen: „Bewegung. Hofkamera“
- **Assistent**: der Assistent von ViON kann einen Satz auf einer Station sagen, Alice einen Befehl geben, ein Szenario starten und den Zustand der Geräte lesen
- **Kameras**: Kameras des Smart Home werden unter Kameras angeboten und zeigen ihr Livebild

## Zwei Arten der Anmeldung

Das Plugin nutzt eine davon oder beide zusammen.

**Offizielle API des Smart Home.** Die API, die Yandex den Besitzern eines Smart Home anbietet. Sie liest Geräte und Szenarien und sendet Befehle. Sie hat kein Push: das Plugin fragt sie in Abständen ab (standardmäßig 10 Sekunden). Sie brauchen eine App in Yandex ID mit den Rechten iot:view und iot:control:

1. Legen Sie die App auf der Seite von Yandex ID an (oauth.yandex.ru): Plattform „Webdienste“, Rechte „Liste der Smart-Home-Geräte ansehen“ und „Smart-Home-Geräte steuern“
2. Tragen Sie **App-ID** und **App-Secret** in den Einstellungen des Plugins ein und klicken Sie auf **Mit Yandex ID anmelden**
3. Öffnen Sie ya.ru/device auf einem Telefon oder Computer, geben Sie den Code aus dem Fenster ein und klicken Sie dann auf die Schaltfläche im Fenster

Ohne Secret zeigt das Fenster stattdessen eine Seite von Yandex ID: Zugriff erlauben, Token kopieren und in das Fenster einfügen.

**Yandex-App (QR-Code).** Das Plugin meldet sich so an wie die Apps von Yandex. Diese Anmeldung braucht die Sprache der Stationen, und mit ihr ändern sich die Sensoren sofort:

1. Klicken Sie auf **Mit QR-Code anmelden**
2. Scannen Sie den Code mit der Yandex-App (oder öffnen Sie den Link auf dem Telefon, das bei Yandex angemeldet ist) und bestätigen Sie die Anmeldung
3. Klicken Sie auf die Schaltfläche im Fenster

Wenn Sie bereits ein x_token des Kontos haben, können Sie es stattdessen in das Feld **x_token** einfügen.

## Einstellungen

- **Geräte lesen über**: Automatisch nimmt die offizielle API, wenn sie angemeldet ist, sonst die Yandex-App
- **Abfrageintervall**: wie oft die offizielle API gelesen wird
- **Szenarien anbieten**: Szenarien werden als Schalter angeboten
- **Sprache der Stationen**: Lokal geht direkt an die Station im Heimnetz, beliebige Länge. Cloud geht über ein Szenario des Kontos, funktioniert überall, bis 100 Zeichen. Automatisch versucht zuerst lokal
- **Adressen der Stationen**: nur wenn eine Station im Netz nicht gefunden wird, als `Küche = 192.168.1.20`
- **Auf einer Station sagen**: prüft die Sprache mit einem Satz Ihrer Wahl
- **Abmelden**: vergisst beide Anmeldungen. Übernommene Sensoren und Kameras bleiben

## Sensoren, Kameras und Stationen hinzufügen

1. Melden Sie sich wie oben an
2. Öffnen Sie **Sensoren** in ViON: die Geräte des Smart Home werden mit ihren Räumen zur Übernahme angeboten
3. Öffnen Sie **Kameras**: Kameras des Smart Home stehen unter **Gefunden**
4. In den Benachrichtigungseinstellungen von ViON sind die Stationen als Ziele aufgeführt. Wählen Sie die, die sprechen sollen

## Gut zu wissen

- Nur Geräte Ihrer eigenen Häuser werden gelesen; mit Ihnen geteilte Häuser nicht
- Die Sprache und die QR-Anmeldung sind keine offizielle Schnittstelle von Yandex. Eine Änderung auf Seiten von Yandex kann ein Update des Plugins erfordern. Für die Sprache über die Cloud hält das Plugin pro Station ein Szenario mit dem Namen „ViON“ und der Kennung der Station; löschen Sie es nicht
- Das Mikrofon einer Station steht anderen Systemen nicht zur Verfügung: Alice hört nur auf Yandex. Um per Stimme mit ViON zu sprechen, nutzen Sie den ViON-Skill für Alice in der ViON-Cloud
- Das Video einer Kamera des Smart Home kommt aus der Cloud von Yandex
