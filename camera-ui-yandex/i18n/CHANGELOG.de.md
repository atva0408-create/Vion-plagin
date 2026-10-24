## [0.2.6]

- Der Name wird VION geschrieben
- Das früher angelegte Szenario einer Station gilt weiter als das des Plugins (wird nicht als Schalter angeboten), bis die nächste Ansage ihm den neuen Namen gibt

## [0.2.5]

- Ein kurzer Ausfall von Yandex Passport beim Erneuern der Sitzung der App löscht die Anmeldung als Yandex-App nicht mehr: nur ein von Yandex abgelehnter Token oder ein abgelehntes Konto verlangt eine neue Anmeldung, ein Ausfall wird beim nächsten Lesen erneut versucht
- Ein einzelnes fehlgeschlagenes Lesen der offiziellen API (ein DNS-Aussetzer) macht nicht mehr alle Sensoren unerreichbar: das tun drei Fehlschläge in Folge, und das erste gelungene Lesen bringt sie zurück

## [0.2.4]

- Zwei Texte im Abstand weniger Sekunden an eine Station, deren gehaltene Verbindung tot ist, öffnen keine zwei neuen Verbindungen mehr, von denen eine für immer offen blieb; Abmelden oder geänderte Einstellungen während der Prüfung der Verbindung schicken nichts mehr
- Mit der Stimme nur im Heimnetz wird eine Station, die einen Text nicht bestätigte, bei der nächsten Benachrichtigung wieder versucht statt 3 Minuten abgewiesen

## [0.2.3]

- VION erfährt, ob jede Station eine Benachrichtigung gesprochen hat: eine ausgeschaltete, nicht verbundene, nicht angemeldete oder eine, für die Yandex nicht antwortete, wird zurückgemeldet, und VION 2.6.5 schickt die Benachrichtigung anders (eine Zonenregel an Telegram). Bisher galt eine stumme Station als eine, die gesprochen hat
- Eine Station, die Yandex als offline führt, wird nicht gefragt: bis zum Fehler vergingen 5 s im Heimnetz und 15 s über die Cloud
- Ein Text, den die Station im Heimnetz bekam und nicht bestätigte, wird nicht noch einmal über die Cloud gesagt: die Station konnte ihn zweimal sagen
- Eine Station, die einen Text nicht bestätigte, wird 3 Minuten lang nicht im Heimnetz gefragt: die nächsten Benachrichtigungen gehen über die Cloud, die meldet, ob sie gesprochen hat
- Eine Verbindung zur Station von früher wird zuerst mit einem Ping geprüft: eine tote (Station neu gestartet, WLAN weg) verschluckt nicht mehr jede Benachrichtigung, bis sie schließt
- Eine Station, die in einer über eine Minute alten Liste offline ist, wird vor einer Absage neu nachgeschlagen
- Ein Netzwerkfehler, bevor das Cloud-Szenario lief («fetch failed: other side closed»), wird einmal nach 2 s wiederholt; nach der Bitte um den Start nie
- Der Assistent von VION sieht, ob eine Station verbunden ist

## [0.2.2]

- Eine Station spricht Benachrichtigungen wieder. Über das Heimnetz: eine Station, die zuerst ihre Link-Local-Adresse (169.254.x.x) nennt, wird über ihre Heimnetzadresse erreicht, an der Link-Local-Adresse lief die Wartezeit ab. Über die Cloud: das Token des Smart Home wird von yandex.ru/iot gelesen, yandex.ru/quasar legt ohne Antwort auf

## [0.2.1]

- Der Assistent: Ein Satz auf einer Station, ein Befehl an Alice und ein Szenario des Smart Home sind Sache des Admins und brauchen eine Bestätigung im Chat, sodass weder ein Benutzer noch ein Zeitplan noch Alice eine Station etwas sagen lassen kann

## [0.2.0]

- Klimaanlagen, Fernseher und IR-Fernbedienungen: Modus, Temperatur und Lüfter einer Klimaanlage, Lautstärke, Kanal, Eingang und Stummschaltung eines Fernsehers und die angelernten Tasten einer IR-Fernbedienung stehen in den Einstellungen ihres Schalters in VION. Eine Fernbedienung nur aus Tasten wird ein eigener Schalter, der sie enthält
- Die Anmeldung als Yandex-App per Link im Browser: Eine Schaltfläche neben dem Link öffnet die Seite von Yandex, auf der die Anmeldung bestätigt wird, sodass ein bei Yandex angemeldeter Browser kein Telefon braucht. Der QR-Code für das Telefon bleibt, kleiner, und das Fenster erklärt beide Wege. Braucht VION 2.3.4

## [0.1.0]

- Erste Version: Sensoren, Relais, Lampen und Szenarien des Yandex Smart Home in VION, Anmeldung an der offiziellen API und per QR-Code, die von Ihnen eingeschalteten Stationen sprechen Benachrichtigungen, Assistenten-Werkzeuge, Kameras des Smart Home
