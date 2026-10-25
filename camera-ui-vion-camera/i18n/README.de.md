# VION Camera

Das Plugin der VION-Smartkamera. Die Kamera meldet sich selbst im Netzwerk an («_vion-camera._tcp») und erscheint daher unter **Kameras → Gefunden**; ein Klick fügt sie hinzu. Beim Hinzufügen koppelt sich die Kamera mit diesem VION: sie gibt VION ein Token und das Passwort ihrer RTSP-Streams und antwortet keinem anderen VION, bis sie hier entfernt oder mit ihrer Taste zurückgesetzt wird.

- **Streams.** Der Hauptstream (H.265 auf den Kameraplatinen, die es kodieren) für die Aufnahme und die Vollansicht, der Nebenstream (H.264, klein) für die Mehrfachansicht und das Telefon.
- **Nicht von selbst gefunden?** Tragen Sie ihre Adresse in den Plugin-Einstellungen ein, z. B. `192.168.1.60`.
- **Zustand.** VION prüft jede Kamera alle 30 s und meldet einmal, wenn eine nicht mehr antwortet oder ihr Bild verliert, und einmal, wenn sie wieder da ist.

Objekterkennung auf der Kamera selbst folgt in den nächsten Versionen.
