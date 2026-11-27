// Voice questions for the trip chat: the phone's own speech recognition turns
// what you say into text. No audio is sent anywhere by this app.

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const canListen = () => !!Recognition();

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
  // Make sure the microphone is let go once listening ends.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rec.onend = null;
    try { rec.abort(); } catch { /* already stopped */ }
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
