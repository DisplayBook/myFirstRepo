// Voice for the trip chat: speak a question (the browser's speech recognition)
// and hear the answer (speech synthesis). Both are built into the phone; no
// audio is sent anywhere by this app.

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const canListen = () => !!Recognition();
export const canSpeak = () => 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

const lang = () => navigator.language || 'en-GB';

/**
 * Listen for one question. Calls onText(text, final) as words come in and
 * onEnd(finalText) when the person stops talking (or stop() is called).
 * onError(code) for problems: 'not-allowed', 'no-speech', 'service-not-allowed', 'network', …
 */
export function listen({ onText, onEnd, onError } = {}) {
  const R = Recognition();
  if (!R) { onError?.('unsupported'); return { stop() {} }; }
  const rec = new R();
  rec.lang = lang();
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let text = '';
  let failed = false;
  rec.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
    }
    text = (final + interim).trim();
    onText?.(text, !interim);
  };
  rec.onerror = (e) => { failed = true; onError?.(e.error || 'error'); };
  rec.onend = () => { if (!failed) onEnd?.(text); };
  try { rec.start(); } catch { failed = true; onError?.('busy'); }
  return { stop() { try { rec.stop(); } catch { /* already stopped */ } } };
}

/** iPhones only allow speech started from a tap: call this in the tap handler. */
export function unlockSpeech() {
  if (!canSpeak()) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

function bestVoice() {
  const voices = window.speechSynthesis.getVoices?.() || [];
  const l = lang().toLowerCase();
  const base = l.split('-')[0];
  return voices.find((v) => v.lang?.toLowerCase() === l && v.localService)
    || voices.find((v) => v.lang?.toLowerCase() === l)
    || voices.find((v) => v.lang?.toLowerCase().startsWith(base)) || null;
}

/** Read text aloud (stops anything already being read). onEnd when finished or stopped. */
export function speak(text, { onEnd } = {}) {
  if (!canSpeak() || !String(text || '').trim()) { onEnd?.(); return; }
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(String(text).slice(0, 3000));
  u.lang = lang();
  const v = bestVoice();
  if (v) u.voice = v;
  u.rate = 1;
  let done = false;
  const finish = () => { if (!done) { done = true; onEnd?.(); } };
  u.onend = finish;
  u.onerror = finish;
  synth.speak(u);
}

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel();
}
