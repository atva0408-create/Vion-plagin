## [0.24.5]

- Das Fahrrad eines Store-Moduls ist in den Episoden eine eigene Art, betitelt «Велосипед»: es wurde zu «Транспорт» gezählt, und ein Radfahrer am Tor, ein Auto an der Tür und wieder der Radfahrer wurden ein Besuch

## [0.24.4]

- Die Ereigniswerkzeuge des Assistenten kennen die Klasse eines heute installierten Moduls: der Server nennt die Klassen der Module beim Aufruf, und eine ohne Ereignis wurde als «Unknown label» abgelehnt (vom Modell als «kein solches Modul» gelesen)
- «Sonstiges» in den Ereignisfiltern findet nicht mehr die Typen, die die Filterleiste mit eigenen Chips nennt (das Fahrrad eines Store-Moduls): der Client nennt sie (`otherExcept`)

## [0.24.3]

- Ein Export über einen Codecwechsel (eine Kamera im gewählten Zeitraum von H.264 auf H.265 umgestellt) spielt jetzt ganz: die Dateien wurden Byte für Byte verbunden und die H.265-Hälfte lag in der H.264-Spur, im Testclip wurden 199 von 400 Bildern dekodiert, der Rest stand still. Ein Clip aus mehreren Codecs wird jetzt zu H.264, seine Abschnitte nacheinander gelesen, in der Größe der ersten Datei, mit Ton, wenn alle Teile welchen haben
- Die Dateien des Exportdialogs können als H.264 kommen (`h264` von nvrExportBatch): ein H.265-MP4 öffnet sich im Windows-Player ohne kostenpflichtige Erweiterung nicht. Die Schätzung meldet `h265`, wenn die Auswahl H.265 enthält, damit der Dialog es anbietet

## [0.24.2]

- Eine Wiedergabe, deren Client weg ist, endet und schließt ihre Aufnahme: das RPC meldet dem Plugin nie, dass ein Browser gegangen ist (ein geschlossener Tab, eine beendete App, ein Netzausfall), und die Wiedergabe hielt Datei und Sitzung bis zum Neustart des NVR offen (auf dem Testrechner noch 25 Minuten nach dem Schließen des Tabs). Ein Client, der 5 Minuten nichts abholt, beendet seine Wiedergabe; ein pausierter Player behält sie

## [0.24.1]

- Eine zu H.264 gemachte Aufnahme, die ihr Client beendet (ein Sprung, ein Spulen, das weiterging, eine Wiedergabe, die mit ihrem Tab geschlossen wurde), beendet ihr ffmpeg mit. Der Prozess blieb für immer hängen, einer für jeden Sprung eines Browsers ohne H.265 (auf dem Testrechner war einer Minuten nach dem Schließen des Tabs noch da)

## [0.24.0]

- Das Archiv einer H.265-Kamera behält nur ihr eigenes H.265. Ein Browser ohne H.265 bekommt die Aufnahmen beim Ansehen zu H.264 gemacht: Wiedergabe, Spulen, die Bilder der Spur, die Vorschau beim Überfahren und der Export eines Abschnitts, erfragt mit der Rolle `h264` (getNvrFeatures `h264`; `low` ist die leichteste Aufnahme, wie sie ist). Die H.264-Kopie, die ViON aus dem Stream einer solchen Kamera macht (eine Quelle, die der Server als `copyOf` meldet), wird nicht mehr aufgezeichnet, wenn das Original aufgezeichnet wird: auf dem Testrechner belegte sie 20,8 GB am Tag neben 5,7 GB eigenem H.265 der Kamera. Die früher aufgezeichnete Kopie spielt für ihre Zeit, und eine Wiedergabe geht dort, wo sie endet, mit dem Original weiter
- Gemacht von einem Hardware-Encoder, wo einer auf dem Rechner arbeitet (NVENC, VA-API, Quick Sync, VideoToolbox; geprüft durch eine Probekodierung mit dem ffmpeg des Hosts), sonst von libx264, und von libx264, wo der Hardware-Encoder versagt. Höchstens die Hälfte der Kerne des Rechners zugleich, mit niedrigerer Priorität als Aufnahme und Analyse, nur so schnell wie angesehen; ein Client, der 30 s kein Bild nimmt, gibt seinen Platz frei, eine Wiedergabe behält einen von Datei zu Datei, Spulen, ein Streifen der Spur oder eine Vorschau warten höchstens 10 s auf einen
- Die Bilder vor der gefragten Zeit werden dekodiert, nicht kodiert: ein Sprung beginnt mit dem Bild der Zeit, feines Spulen und ein genaues Bild der Spur sind dieses Bild allein; mehr als 300 Bilder von jedem Schlüsselbild entfernt das nähere Schlüsselbild, wie die Aufnahme ohne Umwandlung es gibt. Die Zeiten sind die der Aufnahme: an jedem Schlüsselbild des Index, mit Sprüngen der Kamerauhr und dem Überlauf des 33-Bit-PTS, auch mit B-Frames. Die Datei, die noch geschrieben wird, gibt ihr erstes Bild sofort, nicht nach einer Minute
- Ein Export übergeht einen Stream, der innerhalb des Abschnitts beginnt oder endet oder mehr als ein Zehntel davon vermisst, wo ein anderer Stream das abdeckt: die alte Kopie, die endete, einen später zur Aufnahme hinzugefügten Stream. Eine Lücke durch ein Wiederverbinden ändert nichts

## [0.23.0]

- Ein auf einem Bild des Archivs markierter Gegenstand wird über seinen Umriss verfolgt: wann er verschwand und wer ihn wegtrug (das Werkzeug des Assistenten `marked_thing`, «Кто унёс?» im Archiv). Eine einmalige Frage, Antwort in Minuten, nie im Hintergrund. Den Umriss liefert ONNX oder OpenVINO 1.7.4 (ONNX Legacy 1.5.5, OpenVINO Legacy 1.5.4), die zu prüfenden Momente die Geschichte des Ortes. Verschwunden zählt nur, wenn er 5 s später auch fehlt und niemand aus den Ereignisspuren über dem Ort steht (sonst noch 15 und 45 s später); der Moment wird auf eine Sekunde bestimmt. Vom letzten Bild mit ihm verfolgen 2 Bilder pro Sekunde bis zu 20 s den Gegenstand, auch in den Händen der verfolgten Personen in der Nähe; genannt wird, in wessen Rahmen er am häufigsten gesehen wurde, sonst niemand (ein Passant neben dem Ort wird nie für einen Gegenstand genannt, den niemand tragen sah). Eine Drehung der Kamera beendet die Suche («da bis zur Drehung»)
- Er ist da, wenn der Umriss seines Rahmens (10 % breiter) oder seiner Mitte den markierten zu mindestens 0,4 überdeckt, höchstens ×2,5 in der Größe abweicht und Muster und Farbton gleich sind (Farbe ohne Helligkeit: eine rote Tasse in der Dämmerung, 30 % dunkler, ist dieselbe). Nachts und bei dunklen Gegenständen nur das Muster. Mit dem echten Modell wurde ein Gegenstand auf dem Bild, auf dem er markiert wurde, 15 von 15 Mal gefunden, ein leerer Tisch war jedes Mal verschwunden, warmes Lampenlicht und 30 % weniger Licht ließen ihn da. Ein markierter leerer Ort heißt nicht umrissen
- Eine Frage hält sich an 8 Minuten ab dem Moment, an dem sie gestellt wird, samt Warten in der Warteschlange und erstem Laden des Modells, und an 120 Bilder; danach ist die Antwort das bis dahin Gefundene (`cut`), nie «noch da». Fragen zu einem Gegenstand, einem Ort und `object_gone` laufen nacheinander

## [0.22.12]

- Eine Daueraufnahme behält die erste Bildgruppe jeder Verbindung: die Datei begann mit dem zweiten Schlüsselbild (der Codec wird am ersten erkannt, wenn es vollständig ist), und nach jedem Neustart gingen ein bis zwei Sekunden verloren, bei einer Kamera mit seltenen Schlüsselbildern bis zu 50 s
- Ältere Dateien, die nach einer Lücke im Video noch Bilder haben, enden vor der Lücke: eine Datei von 155 Minuten auf dem Prüfstand hatte 14 s Video und ein paar Bilder 2,5 Stunden später, und die Lücke erschien als aufgenommen. Das einmalige Beenden älterer Dateien läuft noch einmal
- Die neuesten Sekunden des Archivs werden aus der Datei gelesen, die gerade geschrieben wird: Schieberegler und Spur fanden für die letzten Sekunden nichts, obwohl die Datei sie hatte

## [0.22.11]

- Eine Aufnahmedatei wird geschnitten, wo ihr Video aufhört: Video, das 20 s ausbleibt, beendet seine Datei mit dem letzten Bild, und was danach kommt, ist eine eigene Datei. Eine Kamera, die bei offener Verbindung kein Video mehr schickt, wird nicht mehr als aufnehmend gezeigt, und die Stunden bis zu ihrer Rückkehr sind eine Lücke in der Zeitleiste (eine Datei von 155 Minuten auf dem Prüfstand hatte 14 s Video am Anfang und ein paar Bilder am Ende). Video, das wartete, während die Aufnahme beschäftigt war, behält seine Zeiten und ist keine Lücke
- Die Ausschnitte der Suche, wann ein Ding verschwand, halten ihre Zeiten (sie lagen bis zu einer halben Sekunde vor ihren Bildern, und ein Abschnitt, der kurz nach einem Schlüsselbild endete, las die ganze Datei oder scheiterte); fern von einem Schlüsselbild ist ein Bild das Schlüsselbild danach innerhalb von 30 s oder keines, nicht eines einer anderen Minute
- Das einmalige Beenden älterer Dateien geht über eine unlesbare Datei hinweg, und eine Datei, die geschrieben wird, wird nie mit einem Bereich gelöscht

## [0.22.10]

- Eine Aufnahmedatei endet mit ihrem letzten Bild, nicht beim Schließen: ein Stream, der bei offener Verbindung stehen blieb, hielt eine Datei von wenigen Sekunden offen, und ihre Zeile sagte, die ganze Zeit sei aufgenommen (eine Xiaomi auf dem Prüfstand: 42 und 155 Minuten über Dateien von 6 und 14 s). Die Zeitleiste zeigte diese Minuten als aufgenommen, und jedes Bild von dort las nichts. Von älteren Versionen so geschlossene Dateien enden nach dem ersten Start mit ihrem letzten Bild (einmal gelesen, nur Dateien, die mehr als eine Minute nach ihrem letzten Schlüsselbild enden)
- Das Bild eines Zeitpunkts ist das Bild dieses Zeitpunkts: die Suche, wann ein Ding verschwand, und die Geschichte eines Ortes lasen das Bild des nächsten Schlüsselbilds (1-2 s zu spät bei jeder Kamera, Minuten zu spät oder nichts bei einer Kamera mit seltenen Schlüsselbildern). Das genaue Bild des Archivs und einer Spur hörte mehr als 300 Bilder nach seinem Schlüsselbild vor dem Zeitpunkt auf und gab das zuletzt gelesene; jetzt kommt das nächste Schlüsselbild der Datei mit seiner eigenen Zeit

## [0.22.9]

- Die Datenbank der Aufnahme hält eine Größe ein: die Spuren der Erkennungen waren der größte Teil (744 Tausend Zeilen, 1,2 von 1,41 GB auf dem Prüfstand), und die der Ereignisse, deren Video noch da ist, wurden nie gelöscht. Über «Предел базы событий, ГБ» (Speicher, 1 GB ohne Einstellung; 0: ohne Grenze) löscht die Aufbewahrung die Spuren der ältesten Ereignisse, höchstens 200 alle fünf Minuten; Ereignisse und Aufnahmen bleiben. Die Datei schrumpft nicht, ihre freien Seiten werden wieder belegt und sie wächst nicht mehr

## [0.22.8]

- Eine Kamera, die nicht antwortet, wird einmal gemeldet, nicht jede Minute: die Aufnahme einer unerreichbaren Kamera schrieb die ganze Nacht jede Minute «stream ended (HTTP 500); retrying in 60s» (177 Warnungen pro Nacht, jede ein Ereignis des Systempanels). Ihr erstes Ende wird wie bisher gemeldet, dann einmal, dass die Kamera seit dann nicht antwortet und still jede Minute versucht wird, und dass sie wieder antwortet, wenn sie es tut. Eine zurückgekehrte Kamera nimmt wie bisher innerhalb einer Minute auf

## [0.22.7]

- Der Suchindex hält die Aufnahme nicht mehr alle zwei Minuten an: seine Suche nach Ereignissen ohne Bildvektor ging über die Vektoren nach ihrem Modell und las für jedes Ereignis jeden Vektor (12,5 s bei den 4 097 Ereignissen des Prüfstands mit warmem Cache, Minuten auf seiner kalten Platte nach einem Start, die Nachrichten aller Kameras liefen derweil in die Zeitüberschreitung). Zwei Indizes beantworten sie allein: 25,8 s → 2,5 ms bei einer Datenbank dieser Größe (einmal beim Start gebaut, wenige Sekunden)

## [0.22.6]

- Keine Minute angehaltener Aufnahme nach einem Start mehr: der erste Durchgang der Aufbewahrung las jedes Ereignis jeder Kamera, das älter als ihr ältestes Video ist, erneut (sein Fortschritt lag nur im Speicher), und ein Ereignis einer Kamera, die zu seinem Beginn nicht aufnahm, sah bei jeder Nachricht alle früheren Dateien der Kamera mit ihren Keyframes durch. Auf der HDD des Prüfstands, kalt nach einem Neustart und beschäftigt mit dem Laden der Engines, stand der einzige Thread der Aufnahme bis zu einer Minute, und 35 Nachrichten eines Ereignisses liefen in die Zeitüberschreitung. Der Fortschritt liegt in der Datenbank, und ein Index der Zeitspannen der Dateien beantwortet die Frage allein (einmal gebaut, etwa 3 s für 12 783 Dateien)

## [0.22.5]

- Die Engine der Suche in Bildern lässt sich wählen: Einstellungen des NVR → KI → «Движок поиска по картинкам» listet die Erkennungs-Engines mit CLIP auf diesem Server (ONNX Legacy auf der Grafikkarte, OpenVINO auf dem Prozessor…). Die gewählte wird zuerst gefragt; ist sie nicht da, sucht die Suche wie bisher, und die Einstellung sagt, dass sie nicht installiert ist. «Автоматически» ist die erste, die antwortet, wie bisher

## [0.22.4]

- Der Beschreiber der Ereignisse beschreibt auch ein Ereignis der Klasse eines Moduls (das Fahrrad eines Moduls aus dem Store: dem Modell wurden nur Person, Fahrzeug und Tier angeboten), und ihm wird gesagt, was die Module antworteten («Ответы модулей: играет в компьютер: нет, да; поза: сидит»), als Hinweis neben den Bildern
- Episoden: eine Klasse eines Moduls ist eine eigene Art, über Kameras mit derselben Klasse verbunden und nicht mit einer Person, und benennt die Episode («Самокат: Въезд → Входная дверь»; es war «Движение» ohne Verbindung); was Module in ihren Ereignissen mit ja beantworteten, steht in der Beschreibung
- Mit ViON 2.6.1 benennt eine nur mit «нет» beantwortete Frage kein Ereignis: beim ersten Start nimmt das Plugin eine solche Frage einmal, stückweise, aus den Typen der früher aufgezeichneten Ereignisse (der Filter nach Typ, die Suche und die Zählungen fanden das Kind, das nicht spielt)

## [0.22.3]

- Der Weg einer Person: ein Wechsel zwischen Kameras braucht bei der breitesten Genauigkeit eine Ähnlichkeit von mindestens 0,2 (die Schwelle sank auf 0,1, wo die ähnlichste Person einer anderen Kamera Minuten später fast jeder ist: auf dem Prüfstand passierten 75 % derselben Minuten anderer Tage 0,1, 42 % passieren 0,2). Die Wechsel behalten eine eigene Schwelle unter der für die Aufenthalte verlangten, von ihr verschoben: zwischen Kameras ist Re-ID schwach (0,6 passieren 8 % der Wechsel auf dem Prüfstand)
- Die Spuren der Erkennungen hinter dem ältesten Video werden gelöscht, indem nur die Ereignisse seit dem letzten Durchgang gelesen werden, über einen Index (alle fünf Minuten las jeder Durchgang alle alten Ereignisse jeder Kamera)

## [0.22.2]

- Die Privatzonen einer Kamera sind in jedem Bild ihrer Aufnahme schwarz, das «was aus einer Stelle wurde» und «wann ein Gegenstand verschwand» lesen und dem Assistenten zeigen: die Aufnahme ist das Rohvideo der Kamera, und diese Bilder gingen mit dem, was die Zonen verbergen, an das Modell
- Was aus einer Stelle wurde: ein Gegenstand, der beim Wechsel zwischen Tag und Nacht weggenommen (oder gebracht) wurde, wird zwischen den zwei nächsten Bildern bei gleichem Licht um die Nacht genannt, statt Stunden später beim nächsten Lichtwechsel als genau; der Verlauf nennt ihn auch
- Wann ein Gegenstand verschwand: die einbrechende Nacht gilt nicht mehr als gedrehte Kamera (ein Nacht- und ein Tagbild desselben Raums unterscheiden sich wie bei einer Drehung), wodurch nur vor der Dämmerung gesucht wurde; eine Kamera, die in der ersten Minute nach dem ersten Sehen gedreht wurde, ergibt «bis zur Drehung da», nicht «nichts aufgenommen»
- Ein Blick auf ein Schlüsselbild einer Kamera mit 50 oder 60 Bildern/s liest dieses Bild, nicht das nächste (Änderungen wurden ein Schlüsselbild zu früh datiert, das letzte Schlüsselbild jeder Datei las nichts)
- Für eine Änderung direkt nach dem markierten Moment wird keine Aufnahmepause genannt; ein Bild, das nicht erstellt werden kann (Datei inzwischen gelöscht), kostet nicht mehr die ganze Antwort; eine kurze Suche nennt ihren Schritt in Sekunden
- Ein hängendes Dekodieren wird nach zwei Minuten beendet: es hielt alle späteren Suchen auf

## [0.22.1]

- Die Spur der Erkennungen geht mit dem Video, auf das sie gezeichnet wird: der Speicherschutz und das Kontingent löschen das älteste Video lange bevor Ereignisse nach ihren Tagen gehen, und die Spur jedes Ereignisses blieb bis dahin (969 MB einer 1,4-GB-Datenbank auf dem Prüfstand, eine Woche älter als ihr Video). Die Aufbewahrung löscht nach und nach die Spuren von Ereignissen einer Kamera, die älter sind als ihr ältestes verbliebenes Video; die Ereignisse bleiben
- Wann ein Gegenstand verschwand: eine gedrehte PTZ-Kamera gilt nicht mehr als sein Verschwinden (die Stelle ist danach woanders im Bild). Die Drehung wird genannt, gesucht wird nur davor
- Der Beschreiber der Ereignisse bekommt kein leeres Bild: eine leere Kartendatei ging als leeres Bild an das Modell

## [0.22.0]

- Was aus einer Stelle wurde, die auf einem Bild der Aufzeichnung markiert ist: mit ViON 2.4.5 die Aufnahme einer Kamera anhalten, eine Stelle umrahmen und fragen, wo das hin ist, was dort lag, wann es kam oder was dort eine Weile lang war. Beobachtet wird die Stelle, nicht der Gegenstand, daher geht alles, auch was die Suche im Bild nicht kennt: ihr Aussehen auf Schlüsselbildern (nur diese werden dekodiert, 0,15–0,2 s pro Bild) wird mit dem markierten Moment verglichen, und jede Änderung wird auf benachbarte Schlüsselbilder (1–3 s) eingegrenzt, samt der Zeit, in der jemand davor stand. Der Rest des Bildes zeigt eine gedrehte Kamera (dort endet die Suche) und Nachtbilder (nur mit Nachtbildern verglichen). Der Assistent nennt die Momente in der Uhrzeit der Person mit den Bildern davor und danach, den Ereignissen daneben und Knöpfen, die die Aufnahme dort angehalten öffnen; höchstens eine Woche pro Frage

## [0.21.1]

- Wann ein Gegenstand verschwand: die letzten Minuten werden damit verglichen, wie die Stelle im Stream selbst aussah (das verkleinerte ganze Bild weicht etwas davon ab, und bei einer echten Kamera galt nichts als gleich); ein Gegenstand, der sich bewegt, solange er da ist (eine Person am Schreibtisch), wird zwischen zwei Momenten etwa eine Minute auseinander genannt

## [0.21.0]

- Wann ein Gegenstand, der im Bild einer Kamera lag, verschwand: fragen Sie den Assistenten «на камере в прихожей лежал телефон — когда он исчез». Die Suche im Bild findet den Gegenstand dort, wo er in der Aufzeichnung lag, die Aufzeichnung wird halbiert und die letzten Minuten zweimal pro Sekunde damit verglichen, wie die Stelle aussah; die Antwort nennt den letzten Moment, in dem er zu sehen war, und den ersten ohne ihn (auf etwa eine Sekunde), die Ereignisse daneben (wer dort war) und zwei Bilder der Stelle, davor und danach, die der Assistent ansieht, bevor er antwortet. Eine Person, die eine Weile davor stand, und eine Suche, die ihn einmal verfehlt, gelten nicht als sein Verschwinden; eine Pause der Aufzeichnung wird genannt. Braucht die Suche im Bild von ONNX oder OpenVINO 1.7.0; dauert bis zu einigen Minuten

## [0.20.1]

- Der Assistent findet die Einstellungen der Aufzeichnung: person_route nennt die Einstellungen der Wechsel und dass der Assistent sie ändern kann; mit ViON 2.4.4 setzt er einen Wert nur so, wie sein Feld ihn nimmt, und zeigt jede Einstellung vor der Bestätigung mit ihrem Titel, von was zu was

## [0.20.0]

- Der Weg einer Person folgt der gewählten Genauigkeit: der Regler «Genauer» der Aufnahmeseite machte nur die Aufenthalte strenger, die Wechsel zwischen Kameras blieben bei 0,35, was er auch zeigte. Die Schwelle eines Wechsels verschiebt sich jetzt mit dem Regler um so viel wie die der Aufenthalte (0,475 ganz oben, 0,275 nahe unten); person_route des Assistenten nimmt dieselbe Genauigkeit (`precision`)
- Die Wechsel werden in den Einstellungen des NVR eingestellt (Personen): welche Ähnlichkeit ein Wechsel bei mittlerer Genauigkeit braucht (0,35), wie viele Minuten nach oder vor einem Aufenthalt die Person auf einer anderen Kamera gesucht wird (3), wie viele Wechsel hintereinander höchstens (6; 0 für einen Weg nur nach Ähnlichkeit)

## [0.19.1]

- Die Aufzeichnung beendet ihren Prozess nicht mehr, wenn die Suche im Bild scheitert (der Bus antwortet nicht in 30 s, NATS verbindet neu, ein Stopp): der Fehler gehört der Anfrage und wird der Seite gesagt; die Aufzeichnung läuft weiter
- Ein Start hält die Aufzeichnung nicht mehr ~50 s an: die Aufbewahrung las jede Segmentzeile, um die alten zu finden (eine 1,37-GB-Datenbank auf der HDD des Prüfstands), jetzt nur die alten; laufende Ereignisse werden über einen Index gefunden, statt jede Minute alle Ereignisse zu lesen
- Die Suche nach Beschreibung findet ihr Bestes wieder: der kompakte Index von 0.19.0 hielt die Vorzeichen jedes Vektors, zu grob für die Text-Bild-Werte von CLIP (unter 300 000 Bildern blieben 34 der 50 besten); jetzt hält er int8-Vektoren (≈210 MB für 400 000), auf wenige Tausendstel des Kosinus bewertet, alle 8192 Vektoren kommt die Aufzeichnung an die Reihe
- Eine auf Kameras oder Tage eingegrenzte Suche nimmt das Beste dieser Kameras und Tage (sie nahm die besten 2000 von allen und verwarf den Rest: eine Kamera mit schwächeren Treffern bekam wenige oder keine); der Weg einer Person liest seine kurzen Fenster wieder aus der Tabelle (50 ms bei 400 000 Vektoren statt 493)
- Nach einer Neuindizierung mit einem anderen Modell (CLIP → SigLIP) verlässt ein ersetzter Vektor den Index seines Modells (er nahm den Platz eines Kandidaten ein und konnte eine CLIP-Anfrage mit einem Ereignis ohne CLIP-Vektor beantworten); Personendaten, die gelöscht werden, während der Index beim Start gelesen wird, lassen das danach Erfasste nicht mehr bis zu einem Neustart unauffindbar
- Suche im Bild: die zuletzt eingegebene Anfrage wird zuerst angesehen (die Bilder der vorigen halten sie nicht mehr auf), eine Anfrage, nach der 30 s niemand fragt, wird verworfen, und ein Fehler wird nur der Suche gesagt, die auf ihn wartet (nicht denselben Wörtern am nächsten Tag); eine leere Bilddatei ist kein Bild, das nächste Bild des Ereignisses wird angesehen; eine während der Aufzeichnung aktualisierte Engine wird ohne Neustart gefunden, und eine ohne Finder wird so benannt, nicht als Fehler. Unlesbare Bilder brauchen ONNX/OpenVINO 1.7.1 (Legacy 1.5.1)
- Der Assistent: person_route ist den Administratoren vorbehalten, wie die Personensuche; der Weg einer gleich gekleideten Menge sagt, dass er gekürzt ist, und gibt die 50 Aufenthalte, die dem Moment am nächsten sind (er gab 400–500, 40 KB); attribute_time zählt mehrere Personen in einem Aufenthalt einmal (zwei Liegende und ein stehender Erwachsener ergaben 100 Minuten aus einer Stunde) und liest die Fragen und ihre Antworten in einem Durchgang (2,9 s → 1,4 s bei 60 000 Ereignissen); line_counts kennt ein Label mit Großbuchstaben («Самокат») und sagt, wie viele drinnen sind, nach Kamera, Linie und Klasse (es summierte alle Linien: eine Person durch Tor und Tür zählte doppelt); ein Tag, dessen Mitternacht die Uhr überspringt (Chile, Kuba), beginnt nach dem Sprung

## [0.19.0]

- Die Suchen im Archiv — nach Beschreibung und nach Personen — halten ihre Vektoren in einem kompakten Index: bei 400 000 Vektoren belegte die Aufzeichnung 2,3 GB und stand bei der ersten Suche 10 s still; jetzt etwa 170 MB, beim Start im Hintergrund portionsweise gelesen (die Aufzeichnung wird höchstens 0,1 s angehalten). Eine Suche nach Beschreibung dauert etwa 70 ms statt einer halben Sekunde, eine Personensuche über 90 Tage etwa 50 ms statt 3,5–6 s (gemessen auf einem PC, spec/bench-vectors.ts)
- Der Weg einer Person geht von Kamera zu Kamera: vom Ende eines Aufenthalts zum besten Moment einer anderen Kamera innerhalb von drei Minuten, auch wenn Re-ID allein nicht sicher ist (ab 0,35 statt 0,525), und von dort weiter danach, wie die Person auf dieser Kamera aussieht. Zwischen Kameras ist Re-ID schwach — anderes Licht, anderer Winkel —, aber wer eine Minute später in der nächsten Kamera erscheint, ist einer von wenigen. Auf dem Prüfstand (Tür und Aufzug, 73 Durchgänge) findet der Weg jetzt 56 % der Durchgänge statt 23 % und verbindet in 3 % der Fenster mit anderen Leuten eine fremde Person (9 von 296). Eine Kette endet nach sechs Sprüngen; die Aufnahmeseite zeichnet solche Aufenthalte gestrichelt, der Assistent nennt sie (`hop`)
- Suche im Bild: Für die von der Beschreibungssuche gefundenen Ereignisse fragt die Aufnahmeseite, wo im Bild das Gesuchte ist, und der Sucher des ONNX-Plugins (1.7.0: die Anfrage ins Englische übersetzt, OWL-ViT rahmt das Ding ein) antwortet mit Rahmen und einem Ausschnitt des Funds (findInEvents). Ein Aufruf antwortet sofort mit den gemachten Funden und den Ereignissen, die noch angesehen werden, nach denen erneut gefragt wird (ein Aufruf endet nach 30 s, der Sucher lädt länger); die Bilder gehen einzeln an den Sucher, bis zu einem Dutzend Ereignisse pro Aufruf, die Funde der letzten Anfragen werden behalten; ein Fehler wird dem nächsten Aufruf gemeldet
- Die Suche nach Beschreibung und die Suche im Bild geben den Engines die Sprache der Plattform mit (`language` in searchEventsByTextQuery, searchEventsByText, findInEvents; die Suche des Assistenten in der Sprache des Gesprächs): ONNX und OpenVINO 1.7.0 übersetzen die Anfrage für ihre nur englischen Modelle ins Englische — aus dem Russischen immer, wenn sie Kyrillisch enthält, sonst aus dieser Sprache

## [0.18.0]

- Eine Frage eines Moduls, die es mit eigenen Wörtern beantwortet — die Körperhaltung: стоит, сидит, лежит —, wird mit einem davon gestellt: „поза: лежит“ oder nur „лежит“. Der Assistent findet die Ereignisse, in denen jemand lag (query_events, event_stats), rechnet zusammen, wie lange jemand an einem Tag lag (attribute_time), und zählt die Haltungen in der Tageszusammenfassung; die anderen Wörter der Frage sind ihr „nein“ (steht oder sitzt: liegt nicht). Die Liste der Fragen nennt eine solche Frage mit ihren Wörtern
- Wie lange ein Modul antwortete, zählt die Zeit jeder Antwort, wenn ViON sie mitgibt (dieselbe Antwort am Stück innerhalb eines Aufenthalts: zehn Minuten gestanden, dann fünfzig gelegen), nicht den ganzen Aufenthalt; frühere Ereignisse zählen weiter ihr ganzes Segment

## [0.17.0]

- Wohin eine Person ging, Kamera für Kamera: aus einem Moment der Personensuche zeigt die Aufnahmenseite den Weg („Weg“) — die Aufenthalte der Person auf jeder Kamera mit Personen-Wiedererkennung, der Reihe nach, eine halbe Stunde davor und danach, jeweils mit ihrem Moment; der Assistent beantwortet «wohin ging er dann» mit demselben Weg (person_route). Re-ID vergleicht Kleidung und Statur, ein Aufenthalt kann also jemand ähnlich Gekleidetes sein; die Kameras, die niemanden sahen, werden genannt
- Die Aufzeichnung behält, wie viele Personen und Fahrzeuge jede auf einer Kamera gezeichnete Linie überqueren, hinein oder hinaus, wenn die Linie eine Eingangsseite hat (ab der ViON-Version, die jede Überquerung einmal meldet): Der Assistent zählt sie über die Zeit für Diagramme – pro Stunde, Tag oder Woche oder die Stunden eines Tages im Schnitt –, zusammen oder getrennt nach Linie, hinein und hinaus (mit der Zahl drinnen: hinein minus hinaus), Richtung, Objekt oder Kamera (line_counts). Die Zählungen bleiben 400 Tage, unabhängig von der Aufbewahrung der Aufnahmen: dieser Monat lässt sich mit demselben Monat des Vorjahres vergleichen. Die Modulseite von ViON zeigt die Zählungen jeder Linie der letzten 24 Stunden (lineTotals)

## [0.16.0]

- Der Assistent zählt Ereignisse über die Zeit für Diagramme: pro Stunde, Tag oder Woche eines Zeitraums bis 92 Tage oder zusammengefasst in die Stunden eines Tages und die Tage einer Woche (als Summe oder im Schnitt pro Tag, mit der Zahl der Tage je Abschnitt), wie viele begannen oder wie viele Minuten sie dauerten, zusammen oder getrennt nach Kamera, Label oder Antwort eines Moduls (event_stats). Die Reihen heißen in der Sprache der Person und haben einen Wert pro Abschnitt: keinen für eine Stunde, die noch kommt, oder für Tage, bis zu denen ein sehr voller Zeitraum nicht gelesen wurde, nie eine Null. Die Stunden des Tages sind die der Uhr, auch an Tagen der Zeitumstellung. Zwischen den Seiten lässt das Lesen der Aufnahme den Vortritt
- attribute_time nimmt einen Monat: «wie lange hat er diesen Monat gespielt» pro Tag; über eine Woche gibt es die Summen jedes Tages statt jeder Strecke und liest beliebig viele Ereignisse: ein Tag, den das Lesen nicht erreichte, ist unbekannt, kein Tag ohne Spiel

## [0.15.0]

- Der Assistent liest, was trainierte Module antworten ("играет в компьютер: да/нет"): er findet Ereignisse nach der Antwort, zählt sie in der Tageszusammenfassung und rechnet zusammen, wie lange am Tag die Antwort "ja" war, mit den Pausen dazwischen (attribute_time). Die Zeit ist ungefähr: ein Modul antwortet nur auf den Bildern, die der Detektor ansieht, daher werden Momente unter 10 Minuten Abstand zusammengefasst, außer das Modul sagte dazwischen zweimal oder öfter über 3 Minuten "nein". Jede Kamera hat ihre eigene Zählung (zwei Kinder werden nicht addiert), und ein Ereignis, das seit vor Mitternacht läuft, zählt am gefragten Tag
- Die Ereignissuche des Assistenten nimmt jedes Objekt, das ein Modul erkennt, nicht nur die eingebauten; ein Label, das kein Ereignis hatte, wird genannt statt nichts zu finden, eine Frage auch über einen Teil, und mit Label und Frage müssen beide gelten
- Ein Ereignis, das noch läuft, gehört zu einem Zeitraum, der nach seinem Beginn anfing: «heute» zeigte das Kind am Computer seit 23:30 nicht. Ein Ereignis, das der Server verlor (ein abgestürzter Bildverarbeiter, ein «Ende», das nie kam), wird nach 10 Minuten bei seiner letzten Aktualisierung beendet, nicht erst beim nächsten Start der Aufnahme; schickt der Server es weiter, läuft es ohne das damals geschriebene Ende weiter

## [0.14.0]

- Andere Erweiterungen können ein eigenes Ereignis mit eigenen Worten in die Aufnahmen legen: VOICE legt «Сыночка за компьютером во время сна» mit den übergangenen Erinnerungen an. Das Ereignis wird wie eine Erkennung aufgenommen (eine Kamera, die nach Ereignissen aufnimmt, beginnt die Aufnahme), schließt sich selbst, wird über seine Worte gefunden und von den KI-Beschreibungen nicht angefasst

## [0.13.1]

- Mit eingeschaltetem „Ton aufzeichnen“ zeichnen Kameras, deren Ton und Video über go2rtc kommen (Xiaomi), wieder auf: ffmpeg kopierte ihr HEVC aus RTSP ohne Zeitstempel und brach sofort ab, sodass der Hauptstream gar nicht aufgezeichnet wurde. Das Video wird jetzt aus dem MPEG-TS von go2rtc kopiert und der Ton daneben hinzugefügt; eine Kamera ohne Ton wird aus dem MPEG-TS aufgezeichnet wie ohne diese Einstellung

## [0.13.0]

- Ähnlich aussehende Personen lassen sich suchen, zusammen mit der Personensuche von ViON und ML-Plugins mit Personen-Wiedererkennung: Der Rekorder merkt sich, wie Kleidung und Statur jeder Person aussehen, die eine Kamera mit zugewiesener Personen-Wiedererkennung gesehen hat, und findet die Momente mit ähnlich aussehenden Personen, ausgehend von einem aufgezeichneten Moment oder einem Bild, auf dem eine Person zu sehen ist. Re-ID beschreibt Kleidung und Statur, nicht die Identität, daher bleibt die Suche bei wenigen Tagen um den Moment. Suchen können nur die Administratoren des Servers
- Die Daten der Personensuche werden standardmäßig 7 Tage aufbewahrt (Einstellungen → Personensuche) und lassen sich auf einmal löschen; sie werden mit ihrem Ereignis gelöscht, auch bei Favoriten. Die Personenvektoren gelangen weder in die gespeicherten Ereignisse noch in die Oberfläche
- Die Suche nach Beschreibung auf der Aufnahmenseite findet auch ältere Ereignisse, zusammen mit der seitenweisen Suche von ViON: Die Seite suchte Treffer nur unter den bereits geladenen Ereignissen, ein Treffer älter als die geladenen Seiten wurde nie gezeigt. Jetzt wendet der Rekorder die Filter der Seite an (Kameras, Zeit, Bewertung, Favoriten und die übrigen Bedingungen) und liefert die Treffer seitenweise
- Ein Link auf eine ältere Episode öffnet sie: Der Rekorder liefert eine Episode anhand ihrer Kennung
- H.265-Kameras, deren Stream go2rtc mit einem H.264-Zugriffseinheitstrenner beginnt (Xiaomi), werden aufgezeichnet: der Rekorder hielt den Trenner für den Beginn eines Bildes und sah nie ein Schlüsselbild

## [0.12.2]

- Beim Benennen eines Gesichts über den Assistenten zählt eine Person, die in einem Ereignis zweimal zu sehen ist, einmal: Wen die Kamera verloren und wiedergefunden hatte, bot er als „2 Gesichter: unbekannt, unbekannt“ an. Gesichter mit demselben bekannten Namen oder aus derselben Gruppe unbekannter Gesichter sind eine Person und erhalten alle den Namen; unbekannte Gesichter, die nichts unterscheidet, werden weiterhin zur Auswahl gestellt, mit dem Hinweis, dass es dieselbe Person sein kann
- Die Aufzeichnungsprüfung des Assistenten nennt den Zustand einer Kamera jetzt getrennt vom gefragten Zeitraum: Eine Kamera, die den ganzen Tag aufgezeichnet hat und erst jetzt über dem Tarif liegt oder pausiert ist, wurde zugleich als „zu 100 % aufgezeichnet“ und „nicht aufgezeichnet“ gemeldet

## [0.12.1]

- Eine Uhrzeit ohne Zeitzone, die der Assistent nennt („lösche die Aufnahmen von 2 bis 3“), ist die Zeit der fragenden Person, nicht die des Servers: Auf einem Server in UTC wurde 5 bis 6 Uhr Moskauer Zeit gelöscht
- Die Speicherprognose des Assistenten berücksichtigt Kameras, die bei Ereignissen aufzeichnen, nach dem, was sie pro Tag geschrieben haben: Sie fehlten, und die Prognose versprach mehr Tage, als der Speicher hält
- Eine manuelle Aufnahme über den Assistenten bei einer Kamera, die durchgehend aufzeichnen soll, aber über dem Tarif liegt oder pausiert ist, sagt das, statt „sie zeichnet ohnehin durchgehend auf“
- Die Liste der Gesichter über den Assistenten ist Administratoren vorbehalten, wie die Seite „Gesichter“

## [0.12.0]

- Der Assistent beantwortet Fragen zur Aufzeichnung selbst, zusammen mit dem Assistenten-Update von ViON: ob Kameras über einen Zeitraum aufgezeichnet haben (Anteil der Aufzeichnung, Lücken länger als eine Minute und ihre Ursache, wenn der Rekorder eine vermerkt hat) und wie viele Tage der Speicher beim aktuellen Datenstrom reicht oder dass die Aufbewahrungsdauer das Archiv früher begrenzt
- Der Assistent listet bekannte und unbekannte Gesichter und benennt nach einer Bestätigung im Chat durch einen Administrator ein Gesicht eines Ereignisses („das ist Mascha“), korrigiert einen falschen Namen, blendet eine Gruppe unbekannter Gesichter aus oder vergisst eine Person. Die Bestätigungskarte zeigt das Gesicht
- Der Assistent startet und stoppt eine manuelle Aufnahme und löscht die Aufnahmen einer Kamera in einem Zeitraum von bis zu 24 Stunden, beides für Administratoren und nach Bestätigung. Ein Zeitraum mit Favoriten wird abgelehnt, solange der Nutzer nicht ausdrücklich sagt, dass auch sie gelöscht werden; die Karte zeigt, wie viel gelöscht wird und dass es nicht rückgängig zu machen ist

## [0.11.3]

- Die Vorschau eines Ereignisses beim Überfahren findet das Ereignis dort, wo es aufgezeichnet ist: ein erst ab der Mitte aufgezeichnetes Ereignis oder eines von einer Kamera, die selten ein Schlüsselbild sendet, zeigte „keine Vorschau“; der Ausschnitt beginnt jetzt dort, wo die Aufzeichnung des Ereignisses beginnt, und am nächsten Schlüsselbild, wenn das vorherige weiter zurückliegt, als der Ausschnitt lang ist

## [0.11.2]

- Beim Überfahren eines Ereignisses auf der Startseite läuft ein kurzer Bewegungsausschnitt, zusammen mit den neuen Ereigniskarten von ViON: bis zu 4 Sekunden aufeinanderfolgender Bilder ab dem Schlüsselbild vor dem Ereignis statt einiger Schlüsselbilder

## [0.11.1]

- Die Neuindizierung der Suche zählt nur ihre eigene Arbeit: Ereignisse, die ihren Vektor schon hatten, erschienen als Fehler („3 von 3, 2 fehlgeschlagen“), und ein aktueller Suchindex wurde nie so genannt
- Ein geänderter Tarif von ViON Cloud erreicht die Aufnahme sofort, zusammen mit ViON 2.3.4: Die Cloud sagt es dem Server, der Server der Aufnahme. Ein Tarif mit mehr Kameras startet deren Aufnahme gleich, früher dauerte das bis zu einer Stunde

## [0.11.0]

- Weniger falsche Namen bei Gesichtern, zusammen mit ViON 2.3.0. Ein Gesicht, das zwei bekannten Personen etwa gleich ähnlich sieht, wird keiner von beiden mehr zugeordnet, und zu einem Gesicht, das niemand sicher ist, nennt der Rekorder die ähnlichste Person, was die Ereignisverfolgung des Servers zeigt

## [0.10.6]

- Ein Archiv, dessen Ereignisse noch nicht in der Suche sind, wird schnell aufgeholt. In 0.10.5 wurde die nächste Portion Ereignisse nur alle zwei Minuten genommen statt 20 Sekunden nach der vorherigen, sodass ein Archiv mit Tausenden Ereignissen erst nach Stunden durchsuchbar war

## [0.10.5]

- Die Suche nach Beschreibung findet jedes Ereignis von selbst. Ereignisse nur mit Bewegung, ohne erkanntes Objekt, kamen erst nach einer von Hand gestarteten Neuindizierung in die Suche, sodass sich die meisten Ereignisse eines Tages nicht finden ließen. Ihre Bilder werden jetzt automatisch in die Suche aufgenommen, die neuesten zuerst, und ein nie indiziertes Archiv wird dahinter aufgefüllt
- Wenn die Suche keine Ereignisse aufnehmen kann oder eine von Hand gestartete Neuindizierung abbricht, steht der Grund im Protokoll

## [0.10.4]

- Ein Archiv, das auf eine andere Festplatte oder in einen anderen Ordner verschoben wurde, wird wieder abgespielt, und das Aufräumen entfernt seine Dateien, nicht nur deren Einträge. Neue Aufzeichnungen werden relativ zum Archivordner gespeichert, vorhandene werden dort gefunden, wo das Archiv jetzt liegt
- Aufzeichnungen behalten ihre Zeit, wenn der Server mehrere Sekunden beschäftigt ist. Zuvor war das Video nach einer solchen Verzögerung um deren Dauer verschoben
- Der Aufzeichnungskalender, die Daten der Speicherseite und die Namen exportierter Dateien folgen der Zeitzone des Betrachters, nicht der des Servers
- Ein Zeitraffer eines Bereichs, der mitten in einer Aufzeichnung beginnt, war eine leere Datei. Jetzt zeigt er den gewählten Bereich und meldet seine tatsächliche Länge
- Der Exportdialog sagt vor dem Start, wenn der Export für ein ZIP-Archiv zu groß ist. Ein fehlgeschlagener Export hinterlässt keine unfertige Datei, und die leeren Ordner abgelaufener Exporte werden entfernt
- Die Wiedergabe läuft dem Player nach Pause, Fortsetzen, Tempowechsel oder Lücken im Archiv nicht mehr immer weiter voraus
- Eine manuelle Aufzeichnung wird als pausiert angezeigt, solange die Aufzeichnung wegen fehlenden Speicherplatzes pausiert, und läuft weiter, sobald wieder Platz ist
- Die Speicherseite zeigt „aus“ für eine Kamera, deren Aufzeichnung ausgeschaltet ist
- Ein Ereignis lässt sich über seine Kennung öffnen, sodass die Momente der Tageszusammenfassung des Assistenten ihre Aufzeichnung öffnen
- Die Seite der Aufzeichnungen öffnet sich bei einem großen Archiv deutlich schneller

## [0.10.3]

- Kameras, die vor jedem Schlüsselbild einen langen Header senden (viele Modelle von Hikvision und Dahua, H.265-Streams), werden aufgezeichnet. Eine solche Kamera konnte gar nichts aufzeichnen, während das Protokoll unauffällig aussah. Das Protokoll meldet jetzt, wenn eine Kamera Video ohne Schlüsselbilder sendet
- Eine volle oder fehlerhafte Festplatte stoppt nicht mehr die Aufzeichnung aller Kameras auf einmal: Die Aufzeichnung läuft weiter, und der Index des Archivs holt auf
- Ein exportierter Clip, der über eine Pause in der Aufzeichnung läuft, endet dort, wo es verlangt wurde, und meldet seine tatsächliche Länge. Pausen von mehr als 2 Sekunden kommen nicht in den Clip
- Ein Export, der für eine ZIP-Datei zu groß ist, wird sofort mit Begründung abgelehnt, und ein fehlgeschlagener Export hinterlässt keine Dateien auf der Archivfestplatte
- „Aufzeichnen“ wird mit einer Erklärung abgelehnt, solange die Aufzeichnung wegen fehlenden Speicherplatzes pausiert
- Eine Kamera, die zwei Streams aufzeichnet, springt nicht mehr auf „zeichnet nicht auf“, wenn sich einer von ihnen neu verbindet
- Kameras im Modus „Auf Anfrage“ werden in der Speicherstatistik mit diesem Modus angezeigt
- Die Ansicht „Episoden“ zeigt die tatsächliche Anzahl der Episoden
- Ereignisse, die im selben Augenblick auf mehreren Kameras stattfanden, werden beim Nachladen der Liste nicht mehr übersprungen
- Die Einstellung „Länge einer Aufzeichnungsdatei“ wirkt sofort
- KI-Beschreibungen: Das Stundenlimit verbrauchen nur Ereignisse, die tatsächlich an das Modell gesendet wurden
- Das Aufräumen eines großen Archivs nach dem Größenlimit ist deutlich schneller

## [0.10.2]

- Beschreibung, Einstellungen und Änderungsliste des Plugins sind jetzt auf Deutsch, Englisch und Russisch verfügbar und folgen der Sprache der Oberfläche

## [0.10.1]

- Kompatibilitätsupdate für die aktuelle ViON-Version

## [0.10.0]

- Aufzeichnung auf Anfrage. Eine Aufzeichnung lässt sich von Hand oder durch eine Automatisierung starten, während sie läuft verlängern und jederzeit stoppen: standardmäßig 5 Minuten, von 1 bis 120. Die Voraufzeichnung der Kamera landet am Anfang der Aufzeichnung. Eine Kamera im Modus „Durchgehend“ zeichnet ohnehin auf und erhält keine manuelle Aufzeichnung; eine Kamera mit ausgeschalteter Aufzeichnung oder über dem Tariflimit meldet einen Fehler
- Der Modus „Auf Anfrage“ funktioniert wieder: Die Kamera hält ihre Voraufzeichnung bereit, zeichnet aber erst nach einem manuellen Start auf. Erkennungen werden als Ereignisse gespeichert, starten aber keine Aufzeichnung. Zuvor zeichnete eine solche Kamera wie im Modus „Bei Ereignis“ auf
- Eine manuelle Aufzeichnung läuft getrennt von der Aufzeichnung durch Erkennungen: Das Stoppen von Hand bricht nicht ab, was eine Erkennung angefordert hat. Sie bleibt beim Wechsel der Streams der Kamera erhalten und endet, wenn die Aufzeichnung der Kamera ausgeschaltet oder auf „Durchgehend“ umgestellt wird. Ein Neustart des NVR beendet die manuelle Aufzeichnung

## [0.9.0]

- Episoden. Ereignisse verschiedener Kameras, die zu einem Besuch gehören, werden nach festen Regeln zu einer Episode zusammengefasst: ein Objekt derselben Art auf einer anderen Kamera spätestens 45 Sekunden später (oder gleichzeitig), dasselbe Kennzeichen oder erkannte Gesicht innerhalb von 10 Minuten. Mindestens zwei Kameras, höchstens 24 Ereignisse und 15 Minuten; Ereignisse nur mit Bewegung nehmen nicht teil. Die Oberfläche zeigt sie unter Aufnahmen → Anzeigen → Episoden
- Eine Episode erscheint in der Oberfläche, sobald die zweite Kamera hinzukommt, und wird aktualisiert, solange der Besuch andauert. Nach einem Neustart des NVR wird eine nicht abgeschlossene Episode fortgesetzt
- Der Episoden-Player zeigt Kamerablöcke: Sehen zwei Kameras das Objekt gleichzeitig, bleibt die erste die Hauptkamera, die zweite wird zum „Zweiten Winkel“
- Episoden-Verlauf: jede Verbindung mit ihrem Grund, die Beteiligten mit Art und Kennzeichen oder Gesichtern, ein Bild jedes Ereignisses. Das Mosaik der Episodenkarte enthält bis zu vier Bilder
- Download einer Episode: MP4 oder ZIP mit einem Clip je Kamerablock. Eine favorisierte Episode schützt ihre Ereignisse vor der automatischen Bereinigung. Ein gelöschtes Ereignis verlässt die Episode, der Titel wird neu gebildet; eine Episode, in der nur eine Kamera bleibt, wird gelöscht

## [0.8.0]

- Ton im Archiv. Neue Einstellung „Ton aufzeichnen“ (standardmäßig aus): Der Ton der Kamera (meist G.711) wird bei der Aufzeichnung in AAC umgewandelt; eine Kamera ohne Mikrofon zeichnet weiterhin Video auf. Zuvor wurde der Ton bei der Aufzeichnung verworfen
- Bei der Wiedergabe ist der Ton von Aufzeichnungen zu hören, die ihn enthalten. Ansichten nur mit Video (die Kamerawand) erhalten keinen Ton
- Der Export behält den Ton im MP4 (AAC); bei Aufzeichnungen ohne Ton bleibt die Datei ohne Ton. Im Zeitraffer gibt es keinen Ton
- Bestehende Archive werden von selbst angepasst; ältere Aufzeichnungen werden als Aufzeichnungen ohne Ton gelesen

## [0.7.0]

- Werkzeuge für den Assistenten. Der ViON-Assistent erhält das Archiv nur zum Lesen: Ereignisse eines Zeitraums, gefiltert nach Kamera, Objekt, Kennzeichen oder erkanntem Gesicht; eine Zusammenfassung eines oder mehrerer Tage in der Zeitzone des Benutzers mit den wichtigsten Ereignissen in zeitlicher Reihenfolge; Suche nach Beschreibung; die gelesenen Kennzeichen; das Bild eines Ereignisses. Zuvor konnte der Assistent keinen Tag zusammenfassen, kein Ereignis finden und keine Kennzeichen auflisten
- Kennzeichen werden ohne Leerzeichen, Bindestriche und Groß-/Kleinschreibung verglichen („К 178 УС 77“ und „к178ус77“ sind dasselbe Kennzeichen); ein nicht erkanntes Gesicht wird nicht als Person ausgegeben

## [0.6.0]

- Die Filter der Aufnahmen funktionieren: „Auslöser“ (einschließlich Geräuschlabels), „Attribute“ (Gesicht, Kennzeichen), „Sonstige“ und die Schalter „UND/ODER“ zwischen den Gruppen; „UND“ bindet stärker als „ODER“. Die Konfidenzschwelle verwirft keine Ereignisse ohne bewertete Erkennungen mehr (Sensoren, Türklingel). Ein selektiver Filter findet auch Ereignisse jenseits der letzten paar hundert Aufnahmen
- Die Ereignisstatistik zählt tatsächlich bis zu 5000 Ereignisse und die Zahl der Segmente
- Erkennungsverlauf: Die Schritte einer Erkennung werden mit dem Ereignis gespeichert (und mit ihm gelöscht) und seitenweise angezeigt, mit Bildern aus der Aufzeichnung zu diesen Zeitpunkten (den zeitlich nächsten)
- Der Export berücksichtigt „Qualität“: „Beste Qualität“ nimmt den Stream mit der höchsten Auflösung, „Kleinste Dateien“ den mit der niedrigsten (von den im gewählten Abschnitt aufgezeichneten)
- Der Aufzeichnungsmodus „Auf Anfrage“ ließ sich nicht starten und zeichnete nichts auf: Solche Kameras zeichnen jetzt „bei Ereignis“ auf
- Die Oberfläche erfährt, was der Rekorder unterstützt (Episoden: noch nicht, Exportqualität: ja), und bietet nichts darüber hinaus an

## [0.5.2]

- Die Wiedergabe am Live-Rand bricht beim Wechsel der Aufzeichnungsdatei nicht mehr ab: Die neue Datei ist sofort abspielbar statt erst nach 4 Sekunden
- Aktualisierungen eines Ereignisses werden der Reihe nach verarbeitet: Das Ende eines Ereignisses wird nicht mehr von einer verspäteten Aktualisierung mit Bildern überschrieben (Ereignisse bleiben nicht „aktiv“ hängen)
- Modus „Bei Ereignis“: Die Voraufzeichnung einer neuen Datei wiederholt keine Bilder der vorherigen
- Ein Schreibfehler auf dem Datenträger (kein Platz, Defekt) stoppt das Plugin nicht mehr: Die Datei wird geschlossen, die Aufzeichnung läuft mit dem nächsten Vollbild weiter
- Nach der erneuten Verbindung einer Kamera mit anderem Videoformat oder anderer Auflösung läuft die Aufzeichnung weiter (zuvor stoppte sie bis zum Neustart)
- Die Ereignisstatistik zählt bis zu 5000 Ereignisse (zuvor wurde bei 500 abgeschnitten)
- Archivbereinigung: Lässt sich eine Aufzeichnungsdatei nicht löschen, bleibt sie verzeichnet und die Bereinigung versucht es erneut, statt eine Datei zurückzulassen, von der niemand weiß

## [0.5.1]

- Die Wiedergabe eines Ereignisses, das kurz vor der Aufzeichnung begann (die Kamera verband sich noch, langer Abstand zwischen Vollbildern), beginnt mit dem ersten aufgezeichneten Bild statt mit „Keine Aufnahmen“
- Eine Aufzeichnungsdatei, die die Archivbereinigung während des Ansehens entfernt, wird übersprungen und beendet die Wiedergabe nicht mehr mit einem Fehler

## [0.5.0]

- KI-Ereignisbeschreibungen (Einstellung „KI-Ereignisbeschreibungen“): Nach einem Ereignis mit Person, Fahrzeug oder Tier beschreibt das Assistenzmodell anhand der Bilder des Ereignisses, was passiert ist. Funktioniert mit jedem Assistenzmodell von ViON, das Bilder versteht (OpenAI-kompatibles Gateway, Ollama, OpenRouter und andere); es gibt ein Limit für Beschreibungen pro Stunde
- Kombinierte KI-Suche: nach dem Inhalt der Bilder (CLIP/SigLIP) und nach dem Text der Beschreibungen, einschließlich russischer Wortformen
- Smarte Benachrichtigungen: Die Beschreibung kommt als Benachrichtigung („Eingang: Kurier hat ein Paket abgelegt“)
- Ein Ereignis lässt sich auf Anfrage beschreiben

## [0.4.0]

- Suche in Ereignissen nach Bedeutung: Die Bilder erkannter Objekte werden indexiert, eine Textanfrage wird mithilfe des CLIP-Plugins (ONNX, OpenVINO, CoreML) damit abgeglichen; ältere Ereignisse lassen sich anhand ihrer Bilder neu indexieren
- Gesichter: eine Datenbank bekannter Personen (mehrere Fotos pro Person), Abgleich bei der Erkennung, unbekannte Gesichter mit Gruppierung ähnlicher, Ignorieren von Gesichtern, das Korrigieren eines Namens im Ereignis trainiert das System, erneuter Abgleich
- Die Suchdaten werden getrennt gespeichert und nicht mehr zusammen mit den Ereignissen an die Oberfläche gesendet
- Vorschaubilder von Gesichtern und Kennzeichen werden angezeigt (zuvor fehlten sie)

## [0.3.0]

- Die Aufzeichnungseinstellungen zeigen den Tarif, seine Limits und die Kameras, die die Aufzeichnungsplätze belegen
- Ereignisse, die nach einem Neustart aktiv geblieben sind, werden beim Start geschlossen
- In den ViON-Server integriert: wird zusammen mit ihm installiert und aktualisiert

## [0.2.0]

- Limits des ViON-Cloud-Tarifs: Anzahl der Kameras mit Aufzeichnung und maximale Archivdauer (ein Server ohne Cloud nutzt lokale Limits)
- Der Tarif wird in den Aufzeichnungseinstellungen angezeigt

## [0.1.0]

- Erste Version von ViON NVR: durchgehende Aufzeichnung und Aufzeichnung bei Ereignis, Zeitleiste, Wiedergabe, Ereignisse, MP4/ZIP-Export, Aufbewahrungsdauer und Speicherlimits
