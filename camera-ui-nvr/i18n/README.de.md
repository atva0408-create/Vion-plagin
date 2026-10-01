# ViON NVR

Der Videorekorder von ViON: Er zeichnet Ihre Kameras auf und speichert das Archiv auf Ihrem eigenen Server.

## Funktionen

- Zeichnet jede Kamera durchgehend, bei Ereignis (mit den Sekunden davor und danach) oder auf Anfrage auf: Eine manuelle Aufzeichnung läuft 1 bis 120 Minuten, standardmäßig 5.
- Zeigt das Archiv auf einer Zeitleiste mit einem Kalender der aufgezeichneten Tage, Pause, Geschwindigkeit und Vorschaubildern.
- Speichert Erkennungsereignisse mit Vorschaubildern, Filtern, Favoriten und Heatmap.
- Fasst Ereignisse eines Besuchs von mehreren Kameras zu einer Episode zusammen, zum Beispiel eine Person, die vom Tor zur Tür geht.
- Exportiert einen Abschnitt als MP4, als Zeitraffer oder mehrere Kameras zugleich als ZIP-Datei.
- Kann Ereignisse vom Assistenzmodell beschreiben lassen: Sie finden sie per Text in der „KI-Suche“ und erhalten die Beschreibung als Benachrichtigung.

## Voraussetzungen

- Der ViON-Cloud-Tarif des Serverbesitzers bestimmt, wie viele Kameras aufzeichnen dürfen und wie lange das Archiv aufbewahrt wird. Ein Server ohne Verknüpfung mit ViON Cloud nutzt seine lokalen Limits.
- Für KI-Beschreibungen: ein Assistenzmodell, das Bilder versteht (Einstellungen → Assistent), und die Freigabe für ViON NVR.

## Einstellungen

- „Aufzeichnungen aufbewahren, Tage“: Ältere Videos und Ereignisse werden automatisch gelöscht; nicht länger, als der Tarif erlaubt.
- „Archivlimit, GB“ und „Minimaler freier Speicherplatz, %“: Überschreitet das Archiv das Limit oder ist weniger Speicherplatz frei, werden die ältesten Aufzeichnungen gelöscht.
- „Ton aufzeichnen“: speichert den Ton der Kameras im Archiv; standardmäßig aus.
