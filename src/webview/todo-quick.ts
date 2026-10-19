import { TODO_DUE_PATTERN } from "../todo-model";
import { addDaysKey, dateOfKey, localDateKey } from "./todo-rows";

const MONTH_DAY = /^(\d{1,2})\/(\d{1,2})$/;
const WEEKDAYS = "日月火水木金土";
const RELATIVE_DAYS: Readonly<Record<string, number>> = { 今日: 0, today: 0, 明日: 1, tomorrow: 1 };

function monthDayKey(month: number, day: number, today: string): string | undefined {
  const year = dateOfKey(today).getFullYear();
  for (const candidate of [year, year + 1]) {
    const date = new Date(candidate, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
    const key = localDateKey(date);
    if (key >= today) return key;
  }
  return undefined;
}

function dueOf(word: string, today: string): string | undefined {
  const relative = RELATIVE_DAYS[word.toLowerCase()];
  if (relative !== undefined) return addDaysKey(today, relative);
  const weekday = word.length === 1 ? WEEKDAYS.indexOf(word) : -1;
  if (weekday >= 0) return nextWeekday(today, weekday);
  const monthDay = MONTH_DAY.exec(word);
  return monthDay ? monthDayKey(Number(monthDay[1]), Number(monthDay[2]), today) : undefined;
}

const nextWeekday = (today: string, weekday: number) => addDaysKey(today, (weekday - dateOfKey(today).getDay() + 7) % 7);

function weekdayOfWeek(today: string, weekday: number, weeksAhead: number): string {
  const monday = addDaysKey(today, -((dateOfKey(today).getDay() + 6) % 7));
  return addDaysKey(monday, (weekday + 6) % 7 + 7 * weeksAhead);
}

function thisWeekday(today: string, weekday: number): string {
  const key = weekdayOfWeek(today, weekday, 0);
  return key < today ? weekdayOfWeek(today, weekday, 1) : key;
}

function monthEnd(today: string): string {
  const date = dateOfKey(today);
  return localDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

const FRIDAY = 5;

export function todoDatePresets(today: string): { today: string; tomorrow: string; thisFriday: string; nextFriday: string; monthEnd: string } {
  return { today, tomorrow: addDaysKey(today, 1), thisFriday: thisWeekday(today, FRIDAY), nextFriday: weekdayOfWeek(today, FRIDAY, 1), monthEnd: monthEnd(today) };
}

const WEEK_WORD = /^(今週|来週)?の?([日月火水木金土])曜?日?$/;
const KANJI_MONTH_DAY = /^(\d{1,2})月(\d{1,2})日?$/;

export function parseTodoDate(text: string, today: string): string | undefined {
  const word = text.trim().replace(/(まで|に|で)$/, "");
  if (TODO_DUE_PATTERN.test(word)) return localDateKey(dateOfKey(word)) === word ? word : undefined;
  if (word === "月末") return monthEnd(today);
  const kanji = KANJI_MONTH_DAY.exec(word);
  if (kanji) return monthDayKey(Number(kanji[1]), Number(kanji[2]), today);
  const week = WEEK_WORD.exec(word);
  if (week) {
    const weekday = WEEKDAYS.indexOf(week[2]);
    return week[1] === "来週" ? weekdayOfWeek(today, weekday, 1) : week[1] === "今週" ? thisWeekday(today, weekday) : nextWeekday(today, weekday);
  }
  return dueOf(word, today);
}
