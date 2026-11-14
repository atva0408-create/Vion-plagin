// The recorder's thread carries the video of every camera: each ffmpeg writes to a pipe this process reads. A read of
// the database is synchronous, and while one runs nothing is taken from the pipes. A table is therefore read a portion
// at a time, and a portion ends when its time is up, whatever the disk does: at 5000 rows a portion the vectors of the
// searches held the thread 30 s on the bench (a database three quarters free pages, on a hard disk, 2026-11-14).

/** The most rows a portion reads before it gives way to the recorder. */
export const PORTION_MAX = 5000;
/** The longest a portion holds the recorder's thread. */
export const PORTION_MS = 40;

/**
 * Reads the rows of `read(after, limit)` — those with a key over `after`, in key order — to the end, a portion at a
 * time, giving way between portions. `take` is given each row and says its key. A portion ends at its most rows or
 * when its time is up, whichever comes first: the rows are taken one by one, so a disk that turns slow in the middle
 * of a portion ends it there, and the next one asks from the row it stopped at.
 */
export async function inPortions<Row>(
  read: (after: number, limit: number) => Iterable<Row>,
  take: (row: Row) => number,
  now: () => number = () => performance.now(),
): Promise<void> {
  let after = 0;
  for (;;) {
    const started = now();
    let rows = 0;
    let inTime = true;
    // leaving the loop ends a statement read so (its iterator is returned): the next portion asks anew from `after`
    for (const row of read(after, PORTION_MAX)) {
      after = take(row);
      rows++;
      if (now() - started >= PORTION_MS) {
        inTime = false;
        break;
      }
    }
    // fewer rows than asked for, and not because the time was up: there are no more
    if (inTime && rows < PORTION_MAX) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
