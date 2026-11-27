// To-do list for the trip: things to book, buy or sort out. Pure functions
// (no DOM), unit-tested. Each to-do is its own document, so people can add and
// tick at the same time:
//   { id, text, done, due: 'YYYY-MM-DD', who, note, source: 'manual'|'chat', at, by, doneAt, doneBy }

import { addDays, fmtDate } from './logic.js';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Still-to-do first (soonest due first, undated after, oldest first), then done (latest first). */
export function sortTodos(todos = []) {
  const open = todos.filter((t) => !t.done).sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return String(a.at || '').localeCompare(String(b.at || ''));
  });
  const done = todos.filter((t) => t.done).sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));
  return { open, done };
}

export const todoProgress = (todos = []) => ({ done: todos.filter((t) => t.done).length, total: todos.length });

/** How a due date reads today: { text, cls: 'overdue' | 'soon' | '' }. */
export function dueInfo(due, today) {
  if (!isDate(due)) return { text: '', cls: '' };
  if (due < today) return { text: `Overdue · ${fmtDate(due)}`, cls: 'overdue' };
  if (due === today) return { text: 'Due today', cls: 'soon' };
  if (due === addDays(today, 1)) return { text: 'Due tomorrow', cls: 'soon' };
  return { text: `By ${fmtDate(due)}`, cls: '' };
}

/** Is this task already on the list (same text, ignoring case)? */
export const hasTodo = (todos = [], text = '') => todos.some((t) => norm(t.text) === norm(text));

/** Clean to-dos suggested by the chat: [{text, due, note}], no blanks or repeats. */
export function normalizeTodos(list) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const text = clip(t?.text, 200);
    if (!text || seen.has(norm(text))) continue;
    seen.add(norm(text));
    out.push({ text, due: isDate(t.due) ? t.due : '', note: clip(t.note, 500) });
    if (out.length >= 10) break;
  }
  return out;
}

/** The to-do list as text for the trip chat. */
export function todosContext(todos = []) {
  if (!todos.length) return ['(none yet)'];
  const { open, done } = sortTodos(todos);
  const line = (t) => `- [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ` (by ${t.due})` : ''}${t.who ? ` — ${t.who}` : ''}${t.note ? ` — ${clip(t.note, 120)}` : ''}`;
  return [...open.slice(0, 60).map(line), ...done.slice(0, 20).map(line)];
}
