import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortTodos, todoProgress, dueInfo, hasTodo, normalizeTodos, todosContext } from '../../travel-planner/js/todos.js';
import { todosFrom, buildTripContext } from '../../travel-planner/js/chat.js';
import { buildReminders } from '../../travel-planner/js/reminders.js';

const todos = [
  { id: 'a', text: 'Order dollars', due: '2026-12-02', at: '2026-11-01' },
  { id: 'b', text: 'Pack chargers', at: '2026-11-02' },
  { id: 'c', text: 'Renew passport', due: '2026-11-20', at: '2026-11-03' },
  { id: 'd', text: 'Book transfer', done: true, doneAt: '2026-11-10' },
  { id: 'e', text: 'Buy adapter', done: true, doneAt: '2026-11-12' },
];

test('to-dos: order, progress, due dates, duplicates', () => {
  const { open, done } = sortTodos(todos);
  assert.deepEqual(open.map((t) => t.id), ['c', 'a', 'b'], 'soonest due first, undated last');
  assert.deepEqual(done.map((t) => t.id), ['e', 'd'], 'latest done first');
  assert.deepEqual(todoProgress(todos), { done: 2, total: 5 });
  assert.deepEqual(dueInfo('2026-11-20', '2026-11-27'), { text: 'Overdue · Fri 20 Nov', cls: 'overdue' });
  assert.deepEqual(dueInfo('2026-11-27', '2026-11-27'), { text: 'Due today', cls: 'soon' });
  assert.deepEqual(dueInfo('2026-11-28', '2026-11-27'), { text: 'Due tomorrow', cls: 'soon' });
  assert.deepEqual(dueInfo('2026-12-02', '2026-11-27'), { text: 'By Wed 2 Dec', cls: '' });
  assert.deepEqual(dueInfo('', '2026-11-27'), { text: '', cls: '' });
  assert.ok(hasTodo(todos, '  order   DOLLARS '));
  assert.ok(!hasTodo(todos, 'Order euros'));
});

test('to-dos from the chat are cleaned, and the chat sees the list', () => {
  const content = [
    { type: 'text', text: 'Here you go' },
    { type: 'tool_use', name: 'report_todos', input: { todos: [
      { text: ' Book the airport transfer ', due: '2026-11-28', note: 'JFK' },
      { text: 'book the airport transfer', due: '', note: '' },
      { text: '', due: '', note: '' },
      { text: 'Buy tickets', due: 'next week', note: '' },
    ] } },
  ];
  assert.deepEqual(todosFrom(content), [
    { text: 'Book the airport transfer', due: '2026-11-28', note: 'JFK' },
    { text: 'Buy tickets', due: '', note: '' },
  ]);
  assert.deepEqual(todosFrom([{ type: 'text', text: 'x' }]), []);
  assert.equal(normalizeTodos(Array.from({ length: 20 }, (_, i) => ({ text: `T${i}` }))).length, 10);
  assert.deepEqual(todosContext([]), ['(none yet)']);
  const ctx = buildTripContext({ meta: { name: 'NY' }, items: [], todos });
  assert.match(ctx, /## To-do list/);
  assert.match(ctx, /- \[ \] Renew passport \(by 2026-11-20\)\n- \[ \] Order dollars \(by 2026-12-02\)\n- \[ \] Pack chargers\n- \[x\] Buy adapter/);
});

test('to-dos due get a 9:00 reminder that day (one per day)', () => {
  const list = buildReminders({ meta: {}, items: [], packing: [], todos: [
    { id: 'a', text: 'Order dollars', due: '2026-12-02' },
    { id: 'b', text: 'Pack chargers', due: '2026-12-02' },
    { id: 'c', text: 'Renew passport', due: '2026-11-30', note: 'Post office' },
    { id: 'd', text: 'Done already', due: '2026-12-01', done: true },
  ] }, { now: Date.UTC(2026, 10, 27), deviceTz: 'Europe/London' });
  const todo = list.filter((r) => r.kind === 'todo');
  assert.deepEqual(todo.map((r) => [new Date(r.at).toISOString().slice(0, 16), r.title, r.body]), [
    ['2026-11-30T09:00', '✅ To do today: Renew passport', 'Post office'],
    ['2026-12-02T09:00', '✅ 2 to-dos due today', 'Order dollars · Pack chargers'],
  ]);
});
