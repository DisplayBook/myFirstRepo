// Voice for the trip chat: speak a question (the browser's speech recognition)
// and hear the answer (speech synthesis). Both are built into the phone; no
// audio is sent anywhere by this app.

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const canListen = () => !!Recognition();
export const canSpeak = () => 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

const lang = () => navigator.language || 'en-GB';

/**
 * iPhone audio mode (Safari 16.4+). While the microphone is in use the phone is
 * in "record" mode, which plays any sound quietly through the earpiece and
 * shows the microphone icon. Switching to "playback" before speaking sends it
 * to the loudspeaker.
 */
function audioMode(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { /* not supported */ }
}

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
  audioMode('play-and-record');
  // Make sure the microphone is let go once listening ends.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rec.onend = null;
    try { rec.abort(); } catch { /* already stopped */ }
    audioMode('playback');
  };
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
  rec.onerror = (e) => { failed = true; release(); onError?.(e.error || 'error'); };
  rec.onend = () => { const ok = !failed; release(); if (ok) onEnd?.(text); };
  try { rec.start(); } catch { failed = true; onError?.('busy'); }
  return { stop() { try { rec.stop(); } catch { /* already stopped */ } } };
}

/**
 * iPhones only play speech that a tap started. Speaking something real (but
 * silent) during the tap unlocks speech for the answer that arrives later;
 * an empty or blank utterance is ignored and doesn't count.
 */
export function unlockSpeech() {
  if (!canSpeak()) return;
  audioMode('playback');
  try {
    const u = new SpeechSynthesisUtterance('.');
    u.volume = 0;
    u.rate = 2;
    keep.add(u);
    u.onend = () => keep.delete(u);
    u.onerror = () => keep.delete(u);
    window.speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

// Safari can drop an utterance (and never finish it) if nothing references it.
const keep = new Set();

function bestVoice() {
  const voices = window.speechSynthesis.getVoices?.() || [];
  const l = lang().toLowerCase().replace('_', '-');
  const base = l.split('-')[0];
  const ok = (v) => v.lang?.toLowerCase().replace('_', '-');
  return voices.find((v) => ok(v) === l && v.localService)
    || voices.find((v) => ok(v) === l)
    || voices.find((v) => ok(v)?.startsWith(base) && v.localService)
    || voices.find((v) => ok(v)?.startsWith(base)) || null;
}

/** Split into sentence-sized pieces (long utterances stop early on some phones). */
export function speechChunks(text, max = 220) {
  const parts = String(text).match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > max) { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim()); continue; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

let session = 0;

/** Read text aloud (stops anything already being read). onEnd when finished or stopped. */
export function speak(text, { onEnd } = {}) {
  const chunks = canSpeak() ? speechChunks(String(text || '').slice(0, 3000)) : [];
  if (!chunks.length) { onEnd?.(); return; }
  const synth = window.speechSynthesis;
  audioMode('playback');
  const id = ++session;
  let done = false;
  const finish = () => { if (!done) { done = true; onEnd?.(); } };
  const start = () => {
    if (id !== session) { finish(); return; }
    if (synth.paused) synth.resume();
    const voice = bestVoice();
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = lang();
      if (voice) u.voice = voice;
      u.rate = 1;
      keep.add(u);
      const last = i === chunks.length - 1;
      u.onend = () => { keep.delete(u); if (last) finish(); };
      u.onerror = () => { keep.delete(u); finish(); };
      synth.speak(u);
    });
  };
  // On iPhone, speak() straight after cancel() is often dropped: only cancel
  // when something is playing, then give it a moment.
  if (synth.speaking || synth.pending) { synth.cancel(); setTimeout(start, 250); } else start();
}

export const isSpeaking = () => canSpeak() && !!(window.speechSynthesis.speaking || window.speechSynthesis.pending);

export function stopSpeaking() {
  session++;
  if (canSpeak()) window.speechSynthesis.cancel();
}
