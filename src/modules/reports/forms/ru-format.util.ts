import { Prisma } from '../../../generated/prisma/client.js';

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** `17.09.2026` — the date format every 1C form uses. */
export function ruDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/** `17 сентября 2026 г.` — used in the sentence form of a reconciliation act. */
export function ruLongDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()} г.`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

const ONES_MALE = [
  '',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
];
const ONES_FEMALE = ['', 'одна', 'две', ...ONES_MALE.slice(3)];
const TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];
const TENS = [
  '',
  '',
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто',
];
const HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
];

/** Russian plural form: [1 сум, 2 сума, 5 сумов]. */
function plural(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 19) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function triplet(n: number, female: boolean): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest <= 19) {
    words.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    if (tens) words.push(TENS[tens]);
    if (ones) words.push((female ? ONES_FEMALE : ONES_MALE)[ones]);
  }
  return words;
}

const SCALES: Array<{ forms: [string, string, string]; female: boolean }> = [
  { forms: ['', '', ''], female: false },
  { forms: ['тысяча', 'тысячи', 'тысяч'], female: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], female: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], female: false },
  { forms: ['триллион', 'триллиона', 'триллионов'], female: false },
];

function integerInWords(value: bigint): string {
  if (value === 0n) return 'ноль';
  const words: string[] = [];
  let remaining = value;
  const groups: number[] = [];
  while (remaining > 0n) {
    groups.push(Number(remaining % 1000n));
    remaining /= 1000n;
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group === 0) continue;
    const scale = SCALES[i];
    if (!scale) throw new RangeError('Amount is too large to spell out');
    words.push(...triplet(group, scale.female));
    if (i > 0) words.push(plural(group, scale.forms));
  }
  return words.join(' ');
}

/**
 * `42479840.43` → `Сорок два миллиона четыреста семьдесят девять тысяч
 * восемьсот сорок сум 43 тийина` — the amount-in-words line of a
 * reconciliation act. Works on the exact decimal, never a float.
 */
export function amountInWords(amount: Prisma.Decimal): string {
  const fixed = amount.abs().toFixed(2);
  const [whole, fraction] = fixed.split('.');
  const words = integerInWords(BigInt(whole));
  const capitalised = words.charAt(0).toUpperCase() + words.slice(1);
  const wholeNumber = Number(BigInt(whole) % 100n);
  return `${capitalised} ${plural(wholeNumber, ['сум', 'сума', 'сумов'])} ${fraction} тийин`;
}
