/**
 * Services people name at the door, with the ways they are said and heard ("Озон", "Ozon", "озон доставка"), so an
 * instruction about "курьер Озона" matches a visitor who says "я с Ozon". The recognizer writes what it hears: the
 * forms include the usual mishearings.
 */
import type { Category } from './types.js';

export interface Company {
  name: string;
  category: Category;
  forms: string[];
}

export const COMPANIES: Company[] = [
  { name: 'Ozon', category: 'delivery', forms: ['озон', 'ozon', 'азон'] },
  { name: 'Wildberries', category: 'delivery', forms: ['wildberries', 'вайлдберриз', 'вайлдберис', 'валдберис', 'вайлдбериз', 'вб', 'wb'] },
  { name: 'Яндекс Маркет', category: 'delivery', forms: ['яндекс маркет', 'маркет', 'yandex market'] },
  { name: 'СДЭК', category: 'delivery', forms: ['сдэк', 'сдек', 'cdek', 'сидек'] },
  { name: 'Почта России', category: 'delivery', forms: ['почта россии', 'почта', 'почтальон', 'заказное письмо'] },
  { name: 'Boxberry', category: 'delivery', forms: ['boxberry', 'боксберри', 'боксбери'] },
  { name: 'DPD', category: 'delivery', forms: ['dpd', 'дпд', 'ди пи ди'] },
  { name: 'DHL', category: 'delivery', forms: ['dhl', 'дхл', 'ди эйч эл'] },
  { name: 'Самокат', category: 'food', forms: ['самокат', 'samokat'] },
  { name: 'Яндекс Еда', category: 'food', forms: ['яндекс еда', 'яндекс еды', 'yandex eda'] },
  { name: 'Яндекс Лавка', category: 'food', forms: ['лавка', 'яндекс лавка'] },
  { name: 'Купер', category: 'food', forms: ['купер', 'сбермаркет', 'kuper'] },
  { name: 'ВкусВилл', category: 'food', forms: ['вкусвилл', 'вкус вилл'] },
  { name: 'Delivery Club', category: 'food', forms: ['delivery club', 'деливери клаб', 'деливери'] },
  { name: 'Пятёрочка', category: 'food', forms: ['пятёрочка', 'пятерочка'] },
  { name: 'Перекрёсток', category: 'food', forms: ['перекрёсток', 'перекресток'] },
  { name: 'Яндекс Такси', category: 'taxi', forms: ['яндекс такси', 'такси', 'taxi', 'uber', 'убер', 'ситимобил'] },
  { name: 'Управляющая компания', category: 'service', forms: ['управляющая компания', 'управляющей компании', 'ук', 'жэк', 'тсж'] },
  { name: 'Газовая служба', category: 'service', forms: ['газовая служба', 'газовой службы', 'горгаз', 'газовщик', 'проверка газа', 'газ'] },
  { name: 'Водоканал', category: 'service', forms: ['водоканал', 'водоканала', 'счётчики воды', 'счетчики воды'] },
  { name: 'Энергосбыт', category: 'service', forms: ['энергосбыт', 'мосэнерго', 'электрик', 'счётчик света', 'счетчик света'] },
  { name: 'Интернет-провайдер', category: 'service', forms: ['ростелеком', 'дом ру', 'дом.ру', 'билайн', 'мтс', 'мегафон', 'провайдер', 'интернет'] },
  { name: 'Полиция', category: 'official', forms: ['полиция', 'полиции', 'участковый', 'police', 'polizei'] },
  { name: 'Приставы', category: 'official', forms: ['пристав', 'приставы', 'фссп'] },
  { name: 'Военкомат', category: 'official', forms: ['военкомат', 'повестка'] },
];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The company a phrase names, by the longest form found as whole words. */
export function findCompany(text: string | null | undefined): Company | undefined {
  if (!text) return undefined;
  const heard = ` ${normalize(text)} `;
  let found: Company | undefined;
  let length = 0;
  for (const company of COMPANIES) {
    for (const form of company.forms) {
      const wanted = normalize(form);
      if (wanted.length > length && heard.includes(` ${wanted} `)) {
        found = company;
        length = wanted.length;
      }
    }
  }
  return found;
}

/** Whether two names of a service are the same service ("Озон" and "Ozon"; unknown names compared as written). */
export function sameCompany(a: string, b: string): boolean {
  const ca = findCompany(a);
  const cb = findCompany(b);
  if (ca || cb) return ca?.name === cb?.name;
  return normalize(a) === normalize(b);
}
