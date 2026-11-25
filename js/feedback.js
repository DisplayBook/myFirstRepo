/**
 * Gentle feedback during sessions: soft beats (Web Audio), short vibrations,
 * and the Screen Wake Lock so the phone doesn't sleep mid-exercise.
 */

let ctx = null;

/** Must be called from a user gesture (e.g. the Start button) on iOS. */
export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

/** A soft, short sine "beat". */
export function beat(freq = 440, dur = 0.22, volume = 0.12) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/** Beat pitch by phase direction: up = higher, down = lower, hold = middle. */
export function phaseBeat(dir) {
  beat(dir === 'up' ? 587 : dir === 'down' ? 392 : 494);
}

export function chime() {
  beat(523, 0.3, 0.1);
  setTimeout(() => beat(659, 0.3, 0.1), 180);
  setTimeout(() => beat(784, 0.45, 0.1), 360);
}

export function vibrate(pattern = 40) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported (e.g. iOS) */
  }
}

/* ---------- Screen Wake Lock ---------- */
let lock = null;
let wanted = false;

export function wakeLockSupported() {
  return 'wakeLock' in navigator;
}

export async function keepAwake() {
  wanted = true;
  if (!wakeLockSupported()) return false;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener?.('release', () => (lock = null));
    return true;
  } catch {
    return false;
  }
}

export async function allowSleep() {
  wanted = false;
  try {
    await lock?.release();
  } catch {
    /* ignore */
  }
  lock = null;
}

// The lock is dropped when the page is hidden; take it again on return.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && !lock) keepAwake();
  });
}
