/**
 * Built-in safety rules. DOM-free.
 *
 * - Toe pain >= 5 or heat/redness >= 7: suggest stopping, offer an elevation
 *   break instead, and make the next session lighter.
 * - Any such report in the past 7 days blocks the weekly progression
 *   (the app never increases the dose when pain is reported).
 */

import { addDays, dateKey } from './util.js';

export const TOE_PAIN_LIMIT = 5;
export const HEAT_LIMIT = 7;

/** Evaluate one log entry. */
export function assessEntry(entry) {
  const reasons = [];
  if (Number(entry.toePain) >= TOE_PAIN_LIMIT) {
    reasons.push(`little-toe pain of ${entry.toePain}/10`);
  }
  if (Number(entry.heat) >= HEAT_LIMIT) {
    reasons.push(`heat/redness of ${entry.heat}/10`);
  }
  if (entry.stoppedForPain) reasons.push('you stopped a session because of pain');
  return { flagged: reasons.length > 0, reasons };
}

/** Did any entry in the last 7 days report pain or heat above the limits? */
export function painInLastWeek(history, today = new Date()) {
  const from = dateKey(addDays(today, -6));
  return history.some((e) => e.date >= from && assessEntry(e).flagged);
}

/** Text shown in the "When to get medical help" panel. */
export const MEDICAL_HELP = {
  urgent: [
    'One calf that is suddenly painful, swollen, warm or red. This can be a sign of a blood clot (DVT).',
    'Breathlessness, chest pain, or coughing up blood. Call emergency services (999 / 112 / 911).',
  ],
  soon: [
    'Redness that is spreading, or red streaks up the foot or leg.',
    'A foot or toe that is hot and swollen, especially with fever or feeling unwell.',
    'A wound, blister, or broken skin on the toe or foot that is not healing, or that has pus.',
    'Swelling that is getting worse, is only on one side, or does not go down overnight with elevation.',
    'Skin on the toe turning pale, blue, grey or black, or numbness that does not go away.',
  ],
};
