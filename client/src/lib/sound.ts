/**
 * Feedback tones, synthesised rather than shipped as audio files — a typing
 * trainer should not pull down assets to make a click.
 *
 * The context is created on the first real keystroke because browsers refuse to
 * start audio before a user gesture.
 */

let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  if (!context) {
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }

  // Autoplay policies suspend the context until a gesture resumes it.
  if (context.state === 'suspended') void context.resume();
  return context;
}

/** A short, low thud. Distinct from a keypress, easy to ignore peripherally. */
export function playError(): void {
  const ctx = ensureContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(180, now);
  oscillator.frequency.exponentialRampToValueAtTime(110, now + 0.09);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.13);
}
