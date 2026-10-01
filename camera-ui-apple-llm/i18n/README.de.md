# Apple LLM

Stellt dem ViON-Assistenten das Sprachmodell zur Verfügung, das in Ihrem Mac eingebaut ist. Das Modell antwortet auf dem Mac, auf dem das Plugin läuft: Es wird kein Schlüssel benötigt, und nichts wird an eine Cloud gesendet.

## Funktionen

- Fügt das integrierte Apple-Modell zu den Modellen hinzu, die Sie in den Einstellungen des Assistenten wählen können.
- Der Assistent kann über dieses Modell auf Ereignisse, Kameras und Sensoren zugreifen.
- Die Antwort erscheint Wort für Wort, und eine abgebrochene Frage stoppt das Modell sofort.
- Unter macOS 27 sieht sich das Modell auch die Bilder der Ereignisse an.
- Alles bleibt auf dem Mac: kein Konto, kein Schlüssel, keine Cloud.

## Voraussetzungen

- Ein Mac mit Apple Silicon und macOS 26 oder neuer, auf dem ViON läuft.
- Apple Intelligence ist in den Systemeinstellungen des Mac eingeschaltet. Solange macOS das Modell noch lädt, bietet ViON es noch nicht an.
- macOS 27, wenn das Modell Bilder sehen soll.

## Einstellungen

- „Strukturierte Antworten anfordern“: Apple verweigert einfache Textantworten zu Personen an Türen, Toren und Fenstern. Mit dieser Einstellung beantwortet das Modell solche Fragen.
- „Gelockerter Sicherheitsfilter“: Das Modell lehnt alltägliche Kameraszenen seltener ab.
- „Kontextfenster (Token)“: Erhöhen Sie den Wert nach einem Systemupdate mit größerem Fenster.
- „Modell darf Werkzeuge nutzen“: Ausgeschaltet führt das Modell nur das Gespräch und kann nicht auf Ereignisse, Kameras und Sensoren zugreifen.
- „Bilder an das Modell senden“: funktioniert nur unter macOS 27.
