// Echo, numbers an LLM phrase may not name, digits said as words. Run: npx tsx spec/text.spec.ts
import assert from 'node:assert/strict';

import { foreignNumber, isEcho, spokenDigits } from '../src/text.js';
import { runTests, test } from './helpers.js';

test('echo: a run of three words of the phrase is the phrase coming back; shared words or two in a row are the person', () => {
  assert.equal(isEcho('Больше времени дают только родители', 'Артём, больше времени дают только родители, я им передам.'), true);
  assert.equal(isEcho('когда можно играть', 'Артём, на сегодня хватит. Выключи компьютер, играть можно будет завтра в 08:30.'), false);
  assert.equal(isEcho('ещё десять минут', 'Сделай перерыв на десять минут, глазам нужен отдых.'), false);
  assert.equal(isEcho('Озон доставка', 'Здравствуйте! Разговор записывается. Вы к кому?'), false);
  assert.equal(isEcho('разговор записывается вы к кому', 'Здравствуйте! Разговор записывается. Вы к кому?'), true);
  assert.equal(isEcho('что угодно', undefined), false);
});

test('numbers: a time or a number the facts do not have is found; the allowed ones pass', () => {
  const allowed = { times: new Set(['15:00']), numbers: new Set([12, 15]) };
  assert.equal(foreignNumber('Ключ у соседки в 12-й квартире, приходите к 15:00.', allowed, 'ru'), undefined);
  assert.equal(foreignNumber('Хозяева вернутся в 18:30.', allowed, 'ru'), '18:30');
  assert.equal(foreignNumber('Подождите 5 минут.', allowed, 'ru'), '5');
  assert.equal(foreignNumber('Вернутся через два часа.', allowed, 'ru'), 'два');
  assert.equal(foreignNumber('Одну секунду, уточняю.', allowed, 'ru', false), undefined, 'number words off for door phrases');
  assert.equal(foreignNumber('Одну секунду, уточняю.', allowed, 'ru'), 'одну');
});

test('spoken digits: groups as people say them, in ru/en/de, digits and noise around them', () => {
  assert.equal(spokenDigits('четыреста восемьдесят два девятьсот пятнадцать', 'ru'), '482915');
  assert.equal(spokenDigits('четыре восемь два девять один пять', 'ru'), '482915');
  assert.equal(spokenDigits('код 482 915', 'ru'), '482915');
  assert.equal(spokenDigits('ноль семь двадцать пять', 'ru'), '0725');
  assert.equal(spokenDigits('сто пять', 'ru'), '105');
  assert.equal(spokenDigits('пятнадцать два', 'ru'), '152');
  assert.equal(spokenDigits('здравствуйте, я из Озона', 'ru'), undefined);
  assert.equal(spokenDigits('four eight two nine one five', 'en'), '482915');
  assert.equal(spokenDigits('four hundred eighty two nine hundred fifteen', 'en'), '482915');
  assert.equal(spokenDigits('oh seven', 'en'), '07');
  assert.equal(spokenDigits('vierhundertzweiundachtzig neunhundertfünfzehn', 'de'), '482915');
  assert.equal(spokenDigits('vier acht zwei neun eins fünf', 'de'), '482915');
});

void runTests();
