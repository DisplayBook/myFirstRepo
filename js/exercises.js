/**
 * Exercise library.
 *
 * Every exercise is gentle, low-impact and designed to avoid pressure on the
 * toes (especially the little toe). Fields:
 *
 *  id        stable key used in schedules, logs and levels
 *  name      display name
 *  summary   one-line description
 *  steps     plain-language, step-by-step instructions
 *  tip       "go gently" tip
 *  stop      "stop if" warning
 *  mode      'reps'  – guided by a tempo, counted automatically (or by tap)
 *            'timed' – countdown (optionally with a rhythm cue)
 *            'open'  – count-up stopwatch; you tap "Done" when finished
 *  reps/sets/duration  default starting level
 *  tempo     array of phases { cue, s, dir } – dir is 'up' | 'down' | 'hold'
 *            and drives the visual pulse (grow / shrink / steady)
 *  sides     optional labels; each set is repeated once per side
 *  rest      seconds of rest between sets
 *  progression  how the weekly plan steps up: { reps, maxReps, maxSets } or
 *               { seconds, maxDuration }
 *  locked    true = hidden from schedules until "progression" is unlocked
 *  optional  true = not in default templates
 */

const COMMON_STOP =
  'Stop if you feel sharp or increasing pain, throbbing, numbness or pins and needles, or if your feet feel hotter, redder or more swollen.';

export const EXERCISES = [
  {
    id: 'seated-calf-raise',
    name: 'Seated calf raises',
    summary: 'Slow heel lifts while sitting. Pumps blood back up from the calves.',
    steps: [
      'Sit tall near the front of a firm chair, feet flat and hip-width apart.',
      'Keep your toes relaxed. Let the weight rest on the ball of the foot, not the toes.',
      'Lift both heels slowly (1 second).',
      'Pause at the top for 1 second.',
      'Lower your heels slowly over 3 seconds.',
    ],
    tip: 'Only lift as high as feels comfortable. Low and slow still works the calf pump.',
    stop: COMMON_STOP + ' Stop if the little toe is pressed or sore.',
    mode: 'reps',
    reps: 15,
    sets: 2,
    rest: 45,
    tempo: [
      { cue: 'Lift heels', s: 1, dir: 'up' },
      { cue: 'Pause', s: 1, dir: 'hold' },
      { cue: 'Lower slowly', s: 3, dir: 'down' },
    ],
    progression: { reps: 2, maxReps: 25, maxSets: 3 },
  },
  {
    id: 'ankle-pumps',
    name: 'Ankle pumps',
    summary: 'Point and flex your feet in the air. The simplest circulation booster.',
    steps: [
      'Sit back in a chair or lie down with your legs out, heels resting on the floor or a cushion.',
      'Gently point your toes away from you, like pressing a soft pedal.',
      'Then pull your toes back towards your shin.',
      'Keep the movement smooth. The toes stay in the air and never press on anything.',
    ],
    tip: 'Move from the ankle, not the toes. Curling the toes is not needed.',
    stop: COMMON_STOP,
    mode: 'reps',
    reps: 20,
    sets: 1,
    rest: 30,
    tempo: [
      { cue: 'Point toes away', s: 1.5, dir: 'down' },
      { cue: 'Pull toes to shin', s: 1.5, dir: 'up' },
    ],
    progression: { reps: 2, maxReps: 30, maxSets: 2 },
  },
  {
    id: 'ankle-circles',
    name: 'Ankle circles',
    summary: 'Slow circles with each foot, both directions.',
    steps: [
      'Sit with one foot lifted slightly off the floor (rest your heel on a cushion if easier).',
      'Draw slow circles with your big toe as if tracing a clock face.',
      'Do 10 circles one way, then 10 the other way.',
      'Swap feet.',
    ],
    tip: 'Small circles are fine. Keep the toes relaxed and in the air.',
    stop: COMMON_STOP,
    mode: 'reps',
    reps: 10,
    sets: 1,
    rest: 20,
    sides: ['Left foot, clockwise', 'Left foot, anticlockwise', 'Right foot, clockwise', 'Right foot, anticlockwise'],
    tempo: [{ cue: 'Slow circle', s: 3, dir: 'up' }],
    progression: { reps: 2, maxReps: 15, maxSets: 1 },
  },
  {
    id: 'heel-toe-rock',
    name: 'Heel-toe rocking',
    summary: 'Seated, gently rock between lifting your toes and lifting your heels.',
    steps: [
      'Sit with feet flat on the floor.',
      'Lift your toes and the front of your foot, keeping your heels down.',
      'Lower, then lift your heels, keeping the ball of the foot down.',
      'Keep a slow, easy rocking rhythm.',
    ],
    tip: 'When the heels lift, the weight goes through the ball of the foot. The toes stay soft and relaxed.',
    stop: COMMON_STOP,
    mode: 'timed',
    duration: 45,
    sets: 1,
    rest: 20,
    tempo: [
      { cue: 'Toes up', s: 2, dir: 'up' },
      { cue: 'Heels up', s: 2, dir: 'down' },
    ],
    progression: { seconds: 10, maxDuration: 60, maxSets: 2 },
  },
  {
    id: 'seated-march',
    name: 'Seated marching',
    summary: 'Lift one knee at a time while sitting, like a slow march.',
    steps: [
      'Sit tall, feet flat, hands resting on the chair seat.',
      'Lift one knee a few centimetres, then lower the foot gently, heel first.',
      'Swap legs. Each lift counts as one rep.',
      'Keep it slow and quiet. There is no stamping.',
    ],
    tip: 'Place the foot down softly, heel first, so the toes never take the landing.',
    stop: COMMON_STOP,
    mode: 'reps',
    reps: 20,
    sets: 1,
    rest: 30,
    tempo: [
      { cue: 'Lift knee', s: 1.5, dir: 'up' },
      { cue: 'Lower gently', s: 1.5, dir: 'down' },
    ],
    progression: { reps: 2, maxReps: 30, maxSets: 2 },
  },
  {
    id: 'knee-extension',
    name: 'Seated knee extensions',
    summary: 'Straighten one leg, hold for 3 seconds, and lower slowly.',
    steps: [
      'Sit tall at the back of the chair.',
      'Slowly straighten one knee until the leg is out in front of you.',
      'Pull your toes gently towards you and hold for 3 seconds.',
      'Lower slowly. Do all reps on one leg, then switch.',
    ],
    tip: 'The leg does not need to be fully straight. Stop just short of any strain.',
    stop: COMMON_STOP + ' Stop if your knee aches.',
    mode: 'reps',
    reps: 10,
    sets: 1,
    rest: 20,
    sides: ['Left leg', 'Right leg'],
    tempo: [
      { cue: 'Straighten', s: 2, dir: 'up' },
      { cue: 'Hold', s: 3, dir: 'hold' },
      { cue: 'Lower slowly', s: 2, dir: 'down' },
    ],
    progression: { reps: 2, maxReps: 15, maxSets: 2 },
  },
  {
    id: 'toe-wiggle',
    name: 'Toe spreading and wiggling',
    summary: 'Gently fan your toes apart and relax them. No pressure on the little toe.',
    steps: [
      'Sit with your feet resting lightly on a soft towel or with the heels on the floor.',
      'Gently spread your toes apart as if fanning them out.',
      'Relax them back together, then give them a soft wiggle.',
      'If the little toe is sore, leave it out and let it rest.',
    ],
    tip: 'This should feel like a light stretch. Never squeeze, grip or press the toes into the floor.',
    stop: COMMON_STOP + ' Stop straight away if the little toe hurts.',
    mode: 'reps',
    reps: 10,
    sets: 1,
    rest: 20,
    tempo: [
      { cue: 'Spread gently', s: 2, dir: 'up' },
      { cue: 'Relax', s: 2, dir: 'down' },
    ],
    progression: { reps: 2, maxReps: 15, maxSets: 2 },
  },
  {
    id: 'standing-calf-raise',
    name: 'Standing calf raises',
    summary: 'Both feet, slow, holding a counter. Unlock this in Settings, then Progression.',
    steps: [
      'Stand facing a kitchen counter or a sturdy chair back, holding on with both hands.',
      'Feet hip-width apart, weight through the middle of the forefoot.',
      'Rise slowly onto the balls of your feet (1 second). Keep the weight away from the little-toe side.',
      'Pause for 1 second, then lower over 3 seconds.',
    ],
    tip: 'Imagine the weight running through your big and second toe joints, not the outer edge of the foot.',
    stop: COMMON_STOP + ' Stop if you feel unsteady or the outer edge of the foot hurts.',
    mode: 'reps',
    reps: 10,
    sets: 1,
    rest: 60,
    tempo: [
      { cue: 'Rise', s: 1, dir: 'up' },
      { cue: 'Pause', s: 1, dir: 'hold' },
      { cue: 'Lower slowly', s: 3, dir: 'down' },
    ],
    progression: { reps: 2, maxReps: 20, maxSets: 3 },
    locked: true,
  },
  {
    id: 'stairs',
    name: 'Stair walking (optional)',
    summary: 'One or two flights of stairs, slowly, whole foot on each step, holding the handrail.',
    steps: [
      'Hold the handrail the whole time.',
      'Place your whole foot on each step, heel included. The toes never hang over the edge.',
      'Go slowly, one step at a time, and rest at the top if you need to.',
      'Tap "Done" when you have finished 1 to 2 flights.',
    ],
    tip: 'Comfortable, roomy shoes help. Going up with the stronger leg first is fine.',
    stop: COMMON_STOP + ' Stop if you feel dizzy or breathless.',
    mode: 'open',
    target: '1 to 2 flights',
    sets: 1,
    rest: 60,
    optional: true,
  },
  {
    id: 'elevation',
    name: 'Leg elevation break',
    summary: 'Lie down with your feet above heart level. Do gentle ankle pumps when prompted.',
    steps: [
      'Lie on your back on a bed or sofa in a cool room.',
      'Rest your lower legs on pillows so your feet are above the level of your heart.',
      'Relax. Every 2 minutes you will be reminded to do 10 slow ankle pumps.',
      'When the timer ends, sit up slowly before standing.',
    ],
    tip: 'Support the whole calf, not just the heels, and keep the toes free of the bedding.',
    stop: 'Stop if you feel breathless, dizzy or uncomfortable lying flat, or if any leg pain increases.',
    mode: 'timed',
    duration: 15 * 60,
    sets: 1,
    rest: 0,
    pumpEvery: 120,
    progression: { seconds: 60, maxDuration: 20 * 60, maxSets: 1 },
  },
  {
    id: 'wall-calf-stretch',
    name: 'Calf stretch against a wall',
    summary: 'Gentle calf stretch with the back heel down, both feet flat.',
    steps: [
      'Stand facing a wall with your hands on it at shoulder height.',
      'Step one foot back. Keep both feet flat and pointing forwards.',
      'Keep the back heel down and the back leg straight. Bend the front knee slowly until you feel a gentle stretch in the back calf.',
      'Hold without bouncing, then switch sides.',
    ],
    tip: 'A small stretch is enough. Keep the toes soft so they do not grip the floor.',
    stop: COMMON_STOP + ' Stop if you feel unsteady.',
    mode: 'timed',
    duration: 20,
    sets: 2,
    rest: 15,
    sides: ['Left calf (left leg back)', 'Right calf (right leg back)'],
    progression: { seconds: 5, maxDuration: 30, maxSets: 3 },
  },
  {
    id: 'walking-pad',
    name: 'Walking pad session',
    summary: 'Slow, easy walking on a walking pad or treadmill.',
    steps: [
      'Wear supportive, roomy shoes that do not press on the little toe.',
      'Start the pad at a slow pace you could hold a conversation at.',
      'Walk with a relaxed heel-to-toe step. Keep a fan or window open nearby to stay cool.',
      'Slow down for the last minute, then sit with your feet up.',
    ],
    tip: 'Slow is the goal. You should be able to talk easily the whole time.',
    stop: COMMON_STOP + ' Stop if you feel breathless, dizzy or have chest discomfort.',
    mode: 'timed',
    duration: 5 * 60,
    sets: 1,
    rest: 0,
    progression: { seconds: 60, maxDuration: 10 * 60, maxSets: 1 },
  },
];

export const EXERCISE_BY_ID = Object.fromEntries(EXERCISES.map((e) => [e.id, e]));

export function getExercise(id) {
  return EXERCISE_BY_ID[id];
}

/** Default level (the user-adjustable dose) for an exercise. */
export function defaultLevel(ex) {
  return {
    reps: ex.reps ?? null,
    sets: ex.sets ?? 1,
    duration: ex.duration ?? null,
  };
}

/** Seconds per rep for a tempo-guided exercise. */
export function cycleSeconds(ex) {
  return (ex.tempo || []).reduce((t, p) => t + p.s, 0);
}

/** Plain-language dose, e.g. "15 reps × 2 sets" or "5 min". */
export function describeDose(ex, level) {
  const lv = level || defaultLevel(ex);
  const sideTxt = ex.sides ? (ex.sides.length === 2 ? ' each side' : ' each way, each foot') : '';
  if (ex.mode === 'reps') {
    return `${lv.reps} reps${sideTxt}${lv.sets > 1 ? ` × ${lv.sets} sets` : ''}`;
  }
  if (ex.mode === 'timed') {
    const d = lv.duration >= 60 ? `${Math.round((lv.duration / 60) * 10) / 10} min` : `${lv.duration} s`;
    return `${d}${sideTxt}${lv.sets > 1 ? ` × ${lv.sets}` : ''}`;
  }
  return ex.target || 'At your own pace';
}
