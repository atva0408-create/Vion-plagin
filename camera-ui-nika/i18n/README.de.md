# NIKA

Verbindet VION mit NIKA, der Sprachassistentin des Hauses. NIKA sagt, was VION mitzuteilen hat, zum Beispiel dass ein Kind den Computer zur Pause nicht verlassen hat, und ein Elternteil kann ihr sagen «gib ihm noch eine Stunde».

## Was es tut

- Findet jede NIKA im Heimnetz von selbst. Zum Verbinden sagt NIKA einen Code aus 6 Ziffern, und Sie geben ihn in VION ein. Danach finden sie einander wieder, wenn sich eine Adresse ändert oder ein Gerät neu startet.
- NIKA sagt die Benachrichtigungen von VION, wie ein Lautsprecher: die Hinweise der Bildschirmzeit von VOICE, Zonenregeln, Ereignisse. Welche Benachrichtigungen zu ihr gehen, wird unter Einstellungen → Benachrichtigungen eingestellt, wie für jedes Gerät.
- NIKA kann VION nach der Bildschirmzeit fragen («wie lange hat er heute gespielt», «wann ist Pause») und mehr Zeit geben, wenn ein Erwachsener es ihr sagt: noch N Minuten, ohne die nächste Pause oder «bis 23:00».
- Zeit wird nur mit der Erlaubnis eines Elternteils gegeben. Eine Stimme beweist nicht, wer spricht. NIKA fragt, die Eltern erhalten eine Benachrichtigung und antworten auf dieser Seite oder im Chat des Assistenten, und NIKA sagt im Raum, was daraus wurde. Eine Anfrage ohne Antwort nach 10 Minuten wird abgelehnt. Wenn Sie wollen, wird die Zeit sofort gegeben, und die Eltern erfahren, was gegeben wurde.
- Das Journal auf dieser Seite hält fest, worum NIKA gebeten wurde und was daraus wurde.
- Der Assistent von VION kann dasselbe in Worten: NIKA verbinden oder trennen, die Einstellungen ändern, eine Anfrage beantworten, NIKA einen Satz sagen lassen.

## Einrichten

1. NIKA und VION müssen im selben Heimnetz sein. Läuft VION in einem Container, braucht es das Netz seines Hosts.
2. Plugins → NIKA → «NIKA verbinden». Wählen Sie sie in der Liste oder geben Sie ihre Adresse an, wenn sie nicht gefunden wird.
3. NIKA sagt einen Code. Geben Sie ihn innerhalb von 5 Minuten ein.
4. Zum Prüfen «Satz über NIKA sagen» verwenden.

Für die Bildschirmzeit braucht es die Erweiterung VOICE mit einem Bildschirmzeit-Szenario des Kindes.

## Einstellungen

- **Erlaubnisse per Stimme**: ein Elternteil bestätigt (Standard), oder die Zeit wird sofort gegeben und die Eltern werden informiert.
- **Was NIKA von VION erbitten darf**: die Befehle, die NIKA beim Verbinden erfährt. Einen nicht angehakten kann sie nicht erbitten.
- **Anfragen, die auf ein Elternteil warten**, **Anfrage beantworten**: worum NIKA gebeten wurde und die Antwort darauf.
- **Journal**: die letzten Anfragen und was daraus wurde.
- **NIKA trennen**: VION und NIKA vergessen einander.

## Wie die Verbindung geschützt ist

Der Code, den NIKA ausspricht, zeigt, dass das zu verbindende VION der Person neben ihr gehört. Danach beweist bei jeder Verbindung jede Seite, dass sie den Schlüssel hat, ohne den Schlüssel selbst zu senden. Ein Gerät, das sich nur als NIKA ausgibt, wird abgelehnt. Jede Nachricht ist signiert, sodass unterwegs keine geändert, wiederholt oder hinzugefügt werden kann. Die Nachrichten sind nicht verschlüsselt: im Heimnetz können sie gelesen, aber nicht geändert werden.
