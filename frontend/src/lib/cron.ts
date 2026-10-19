/**
 * Checks the Schedule trigger's cron expression — the editor's copy of the backend's
 * `cron_problem` (`app/services/cron.py`). Both run `shared/cron-cases.json`: keep them identical.
 * Classic 5-part cron: `*`, numbers, `a-b`, `/n`, `,` and three-letter month / weekday names.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const PARTS: [name: string, low: number, high: number, names: string[]][] = [
  ["minute", 0, 59, []],
  ["hour", 0, 23, []],
  ["day of the month", 1, 31, []],
  ["month", 1, 12, MONTHS],
  ["day of the week", 0, 7, WEEKDAYS],
];
const ITEM = /^(?:\*|(\w+)(?:-(\w+))?)(?:\/(\d+))?$/;

export const WRONG_LENGTH =
  "must have 5 parts: minute, hour, day of the month, month and day of the week";

function value(token: string, low: number, high: number, names: string[]): number | null {
  if (/^[0-9]+$/.test(token)) {
    const n = Number(token);
    return n >= low && n <= high ? n : null;
  }
  const index = names.indexOf(token.toLowerCase());
  return index >= 0 ? low + index : null;
}

function validPart(part: string, low: number, high: number, names: string[]): boolean {
  return part.split(",").every((item) => {
    const match = ITEM.exec(item);
    if (!match) return false;
    const [, start, end, step] = match;
    if (step !== undefined && !(Number(step) >= 1 && Number(step) <= high)) return false;
    if (start === undefined) return true; // *
    const first = value(start, low, high, names);
    if (first === null) return false;
    if (end === undefined) return true;
    const last = value(end, low, high, names);
    return last !== null && last >= first;
  });
}

/** What's wrong with the expression (completes "Cron expression …"), or null. */
export function cronProblem(expression: string): string | null {
  const parts = expression.split(/\s+/).filter(Boolean);
  if (parts.length !== PARTS.length) return WRONG_LENGTH;
  for (const [i, [name, low, high, names]] of PARTS.entries()) {
    if (!validPart(parts[i], low, high, names)) return `has an invalid ${name}: “${parts[i]}”`;
  }
  return null;
}
