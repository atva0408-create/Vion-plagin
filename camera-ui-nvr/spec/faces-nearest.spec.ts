// Whom a face is given to. The server of ViON 2.3.0 asks the recorder for the nearest people instead of a plain
// match: a face that passes the bar of two people and is about as close to both is given to neither, and a face
// that is nobody for sure still says whom it came closest to. Run: npx tsx spec/faces-nearest.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FaceStore, SENSITIVITY } from '../src/faces.js';

const faces = new FaceStore(new DatabaseSync(':memory:'), mkdtempSync(join(tmpdir(), 'nvr-faces-nearest-')));
const model = 'arcface-test';
/** A face by how much it has of each of four looks. */
const face = (...parts: number[]): number[] => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];

assert.deepEqual(faces.matchNearest([face(1)], model), [null], 'nobody is known yet');

faces.enroll('Анна', model, face(1), undefined);
// a second, poorer picture of Анна: a person is as close as their closest picture
faces.enroll('Анна', model, face(0.6, 0, 0, 0.8), undefined);
faces.enroll('Борис', model, face(0, 1), undefined);

// ------------------------------------------------- a clear face is named, as match() names it
assert.deepEqual(faces.matchNearest([face(1)], model), [{ identity: 'Анна', score: 1, runnerUp: 'Борис', runnerUpScore: 0 }]);
assert.deepEqual(faces.match([face(1)], model), [{ identity: 'Анна', score: 1 }]);

// clearly closer to one of two people who both pass the bar: named
const [leaning] = faces.matchNearest([face(1, 0.75)], model);
assert.equal(leaning?.identity, 'Анна');
assert.deepEqual([leaning?.score, leaning?.runnerUp, leaning?.runnerUpScore], [0.8, 'Борис', 0.6]);

// ------------------------------------------------- about as close to two people: given to neither
const [both] = faces.matchNearest([face(1, 0.98)], model);
assert.equal(both?.identity, undefined, 'a face that looks like both is not named');
assert.deepEqual(both, { closest: 'Анна', closestScore: 0.714, runnerUp: 'Борис', runnerUpScore: 0.7 });
// the plain match gave it to one of them: this is the wrong name the change is about
assert.equal(faces.match([face(1, 0.98)], model)[0]?.identity, 'Анна');
// the margin counts only between people who both pass the bar: a second person far below it does not unname anybody
const [alone] = faces.matchNearest([face(0.46, 0.44, 0.7712)], model);
assert.deepEqual(alone, { identity: 'Анна', score: 0.46, runnerUp: 'Борис', runnerUpScore: 0.44 });
assert.ok(alone!.score! >= SENSITIVITY.balanced! && alone!.runnerUpScore! < SENSITIVITY.balanced!);

// ------------------------------------------------- nobody for sure: whom it came closest to
assert.deepEqual(faces.matchNearest([face(0.3, 0, 0.95)], model), [{ closest: 'Анна', closestScore: 0.301, runnerUp: 'Борис', runnerUpScore: 0 }]);
// the bar is the one of the chosen sensitivity
const [strict] = faces.matchNearest([face(1, 0, 1.7)], model, 'strict');
const [relaxed] = faces.matchNearest([face(1, 0, 1.7)], model, 'relaxed');
assert.deepEqual([strict?.identity, strict?.closest, relaxed?.identity], [undefined, 'Анна', 'Анна']);

// ------------------------------------------------- what cannot be compared is no answer, as before
assert.deepEqual(faces.matchNearest([face(1)], 'another-model'), [null]);
assert.deepEqual(faces.matchNearest([[], face(0, 1)], model), [null, { identity: 'Борис', score: 1, runnerUp: 'Анна', runnerUpScore: 0 }]);

console.log('faces-nearest.spec: a clear face is named, a look-alike of two is not, a stranger says whom they came closest to — ok');
