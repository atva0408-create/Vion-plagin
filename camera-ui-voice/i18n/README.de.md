# VOICE

Die Stimme von ViON: Sie spricht über den Lautsprecher einer Kamera und hört über ihr Mikrofon. Sprache wird auf Ihrem Server erzeugt und erkannt; kein Ton verlässt ihn.

## Was es kann

- **Bildschirmzeit.** Die Kamera sieht ein Kind am Computer, VOICE zählt die Zeit. Kommt eine Pause oder die Schlafenszeit, sagt VOICE es freundlich und mit Namen. Bleibt das Kind sitzen, wiederholt es bestimmter und benachrichtigt dann die Eltern mit einem Standbild. Das Kind kann nach einem Satz von VOICE fragen „Wie lange dauert meine Pause noch?“ oder jederzeit «ViON» rufen (vorerst auf Russisch) und hört die Minuten, die nach dem Plan bleiben.
- **Wer ist an der Tür.** Eine Türkamera sieht eine Person, und VOICE sagt in den Räumen, wer gekommen ist: „Papa ist da“, „Ein Fremder ist an der Tür“ oder, mit einem Modell, das Bilder sieht, „Ein Kurier mit einem Paket ist an der Tür“.
- **Sagen.** Jeder Satz über einen Kameralautsprecher: aus dem Assistenten-Chat („sag Artem, dass das Essen fertig ist“), aus einer Automation, von einer anderen Erweiterung über eine Benachrichtigung.

## Das Kind kann VOICE nicht überreden

Der Assistent, der dem Kind antwortet, hat keinen Zugriff auf die Einstellungen. Zeiten und Zahlen in seiner Antwort müssen aus dem Plan kommen; eine Antwort mit etwas anderem wird durch einen fertigen Satz ersetzt. Bittet das Kind um mehr Zeit, gibt VOICE die Bitte an die Eltern weiter; nur ein Elternteil kann mehr Zeit geben.

## Was Sie brauchen

- Eine Kamera mit Lautsprecher und Sprechkanal im Stream. VOICE zeigt bei jeder Kamera, ob es darüber sprechen kann und warum nicht. Kameras ohne Lautsprecher erscheinen nicht unter den Lautsprechern.
- Für Sätze und Antworten des Assistenten: Erlauben Sie VOICE unter Einstellungen, Assistent. Ohne das nutzt VOICE fertige Sätze.
- Die Sprachmodelle werden vom ViON-Modellserver geladen, wenn VOICE zum ersten Mal spricht oder zuhört: etwa 60 MB pro Sprache für die Stimme, 21 MB für die russische Erkennung, 94 MB für die englische und deutsche Erkennung.

## Einrichten

Alles lässt sich in den Einstellungen oder mit Worten im Assistenten-Chat einrichten; beides ändert dieselben Einstellungen.

**An der Kamera** (Kamera, Reiter Plugins, VOICE):

- Ob VOICE über diese Kamera sprechen kann.
- Bildschirmzeit: ein Eintrag pro Kind. Name des Kindes und Zone des Computers, Pause alle so viele Minuten und wie lange, Tageslimit und Schlafenszeit an Schul- und Wochenendabenden. Felder mit „Mehr“ sind für Sonderfälle und können bleiben, wie sie sind.
- Was gerade geschieht, und die Knöpfe „Mehr Zeit geben“, „Einen Satz sagen“ und „Testsatz sagen“.

**Auf der Seite der Erweiterung:** Sprache und Sprechgeschwindigkeit, wie lange auf eine Antwort gewartet wird, Ruhezeit, die Regeln „Wer ist an der Tür“ und wie Personen angesagt werden, die Lautsprecher für Benachrichtigungen, der Zustand des Assistenten.

**Mit Worten:** zum Beispiel „Artem spielt im Kinderzimmer am Computer, Kamera Xiaomi. Pause alle 45 Minuten für 10, ins Bett an Wochentagen um 21:30, am Wochenende um 22:30“. Der Assistent zeigt eine Karte mit den Werten und ändert erst nach Bestätigung.

## Automationen

Eine Kamera mit Lautsprecher ist ein Benachrichtigungsgerät „<Kamera> (VOICE)“. Schalten Sie sie unter „Lautsprecher für Benachrichtigungen“ ein und wählen Sie in einer Automation die Aktion „Benachrichtigung“ und diesen Lautsprecher. VOICE spricht nur Benachrichtigungen, die an den Lautsprecher gehen, nie die anderen.

## Gut zu wissen

- Das Mikrofon öffnet sich nur für wenige Sekunden nach einem Satz von VOICE und schließt sich wieder; der Ton wird nicht gespeichert. Ist für ein Kind „Antworten, wenn gerufen“ an, bleibt das Mikrofon dieser Kamera offen, solange das Szenario läuft: jeder kurze Satz wird auf dem Server erkannt, um «ViON» zu finden, ein Satz ohne ihn wird sofort verworfen, nichts wird aufgenommen. Der Zustand der Kamera zeigt, wann sie zuhört. Der Text der Frage des Kindes geht an den Assistenten: Läuft sein Modell in der Cloud, geht der Text dorthin.
- Eine Kamera sagt höchstens 6 Sätze pro Minute (Einstellung); weitere werden nicht gesprochen.
- Ein still sitzendes Kind kann aus den Erkennungsereignissen fallen. VOICE liest alle 5 Sekunden den Objektsensor der Kamera, still sitzende Personen eingeschlossen.
