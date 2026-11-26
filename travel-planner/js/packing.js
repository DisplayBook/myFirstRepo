// Packing lists: people on the trip, things to take, ticked off when packed.
// Pure functions (no DOM), unit-tested.
//
// Entries (one document each, so people can tick at the same time):
//   person: { id, kind: 'person', name, at }
//   item:   { id, kind: 'item', name, who: personId | 'shared', category, qty, done, at }

export const SHARED = 'shared';

export const PACK_CATEGORIES = [
  ['clothes', '👕 Clothes'],
  ['gear', '🎿 Ski & sports gear'],
  ['toiletries', '🧴 Toiletries'],
  ['documents', '🛂 Documents & money'],
  ['electronics', '🔌 Electronics'],
  ['health', '💊 Health'],
  ['kids', '🧸 Kids'],
  ['other', '📦 Other'],
];
export const categoryLabel = (c) => (PACK_CATEGORIES.find(([k]) => k === c) || PACK_CATEGORIES.at(-1))[1];

/** Ready-made lists. `who`: 'each' (one per person) or 'shared'. */
export const TEMPLATES = {
  ski: {
    label: '⛷️ Ski trip',
    items: [
      ['Ski jacket', 'clothes', 'each'], ['Ski trousers', 'clothes', 'each'], ['Thermal base layers', 'clothes', 'each', 2],
      ['Fleece / mid layer', 'clothes', 'each'], ['Ski socks', 'clothes', 'each', 3], ['Gloves', 'clothes', 'each'],
      ['Neck warmer / buff', 'clothes', 'each'], ['Hat / beanie', 'clothes', 'each'], ['Snow boots', 'clothes', 'each'],
      ['Helmet', 'gear', 'each'], ['Goggles', 'gear', 'each'], ['Sunglasses', 'gear', 'each'],
      ['Skis or snowboard (or rental booking)', 'gear', 'each'], ['Ski boots', 'gear', 'each'], ['Lift pass', 'documents', 'each'],
      ['Sun cream (high SPF)', 'toiletries', 'shared'], ['Lip balm with SPF', 'toiletries', 'each'],
      ['Hand warmers', 'gear', 'shared'], ['Small backpack', 'gear', 'shared'], ['Ski lock', 'gear', 'shared'],
      ['First-aid kit / blister plasters', 'health', 'shared'], ['Travel insurance with winter sports cover', 'documents', 'shared'],
    ],
  },
  beach: {
    label: '🏖️ Beach',
    items: [
      ['Swimwear', 'clothes', 'each', 2], ['Sun hat', 'clothes', 'each'], ['Sunglasses', 'clothes', 'each'], ['Flip-flops / sandals', 'clothes', 'each'],
      ['T-shirts', 'clothes', 'each', 5], ['Shorts', 'clothes', 'each', 3], ['Light evening wear', 'clothes', 'each'],
      ['Sun cream', 'toiletries', 'shared'], ['After-sun', 'toiletries', 'shared'], ['Insect repellent', 'toiletries', 'shared'],
      ['Beach towels', 'other', 'shared'], ['Snorkel & mask', 'gear', 'each'], ['Reusable water bottle', 'other', 'each'],
    ],
  },
  city: {
    label: '🏙️ City break',
    items: [
      ['Comfortable walking shoes', 'clothes', 'each'], ['Light jacket / rain jacket', 'clothes', 'each'], ['Day outfits', 'clothes', 'each', 3],
      ['Evening outfit', 'clothes', 'each'], ['Compact umbrella', 'other', 'shared'], ['Day bag', 'other', 'each'],
      ['Power bank', 'electronics', 'shared'], ['Travel adapter', 'electronics', 'shared'],
    ],
  },
  essentials: {
    label: '🧳 Essentials',
    items: [
      ['Passport / ID', 'documents', 'each'], ['Tickets & booking confirmations', 'documents', 'shared'], ['Bank cards & some cash', 'documents', 'each'],
      ['Phone & charger', 'electronics', 'each'], ['Travel adapter', 'electronics', 'shared'], ['Headphones', 'electronics', 'each'],
      ['Toothbrush & toothpaste', 'toiletries', 'each'], ['Medication', 'health', 'each'], ['Underwear', 'clothes', 'each', 5],
      ['Pyjamas', 'clothes', 'each'], ['Glasses / contact lenses', 'health', 'each'], ['Keys', 'other', 'shared'],
    ],
  },
};

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Split entries into people and items (people sorted by when added). */
export function splitPacking(entries = []) {
  const people = entries.filter((e) => e.kind === 'person').sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const items = entries.filter((e) => e.kind === 'item');
  return { people, items };
}

/**
 * Turn "add for 'each' / 'shared' / a person" into item drafts, skipping
 * anything that person already has (same name, ignoring case).
 * list: [{name, category, who, qty}] where who is 'each' | 'shared' | personId.
 */
export function expandItems(list, people, existing = []) {
  const have = new Set(existing.filter((e) => e.kind === 'item').map((e) => `${e.who}|${norm(e.name)}`));
  const out = [];
  for (const it of list) {
    const name = String(it.name || '').trim().slice(0, 120);
    if (!name) continue;
    const category = PACK_CATEGORIES.some(([k]) => k === it.category) ? it.category : 'other';
    const qty = Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1)));
    const targets = it.who === 'each' ? (people.length ? people.map((p) => p.id) : [SHARED]) : [it.who || SHARED];
    for (const who of targets) {
      const k = `${who}|${norm(name)}`;
      if (have.has(k)) continue;
      have.add(k);
      out.push({ kind: 'item', name, category, who, qty, done: false });
    }
  }
  return out;
}

/** Items from a ready-made list. */
export const templateItems = (key) => (TEMPLATES[key]?.items || []).map(([name, category, who, qty]) => ({ name, category, who, qty: qty || 1 }));

/** {done, total} for a person ('shared', a person id) or everything (null). */
export function progress(items, who = null) {
  const list = who === null ? items : items.filter((i) => i.who === who);
  return { done: list.filter((i) => i.done).length, total: list.length };
}

/** Items grouped by category, in category order; unpacked first, then by name. */
export function groupByCategory(items) {
  const groups = [];
  for (const [key, label] of PACK_CATEGORIES) {
    const list = items.filter((i) => (PACK_CATEGORIES.some(([k]) => k === i.category) ? i.category : 'other') === key)
      .sort((a, b) => Number(a.done) - Number(b.done) || norm(a.name).localeCompare(norm(b.name)));
    if (list.length) groups.push({ key, label, items: list });
  }
  return groups;
}

/** Match a suggested "who" (a person's name, "each", "shared") to an id. */
export function resolveWho(who, people) {
  const w = norm(who);
  if (!w || w === 'shared' || w === 'everyone (shared)' || w === 'group') return SHARED;
  if (w === 'each' || w === 'everyone' || w === 'each person') return 'each';
  const p = people.find((x) => norm(x.name) === w) || people.find((x) => norm(x.name).split(' ')[0] === w.split(' ')[0]);
  return p ? p.id : SHARED;
}
