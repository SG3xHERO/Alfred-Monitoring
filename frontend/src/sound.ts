/**
 * Self-contained alert tones for the Wall — no audio files, just Web Audio
 * oscillators. Browsers block audio until a user gesture, so callers must
 * call unlockAudio() from a click handler before any tone will be audible;
 * once unlocked it stays armed for the tab's lifetime.
 */

const MUTE_KEY = "alfred_wall_muted";

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function isAudioUnlocked(): boolean {
  return !!ctx && ctx.state === "running";
}

export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(muted: boolean): void {
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

function tone(startAt: number, freq: number, duration: number, type: OscillatorType = "sine", peak = 0.22) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startAt;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function play(fn: () => void) {
  if (isMuted() || !ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  fn();
}

const REPEATS = 3;

/** Single beep, repeated a few times — a new warning. */
export function playWarning(): void {
  play(() => {
    for (let p = 0; p < REPEATS; p++) tone(p * 0.55, 660, 0.18, "sine");
  });
}

/** Urgent alternating tones, repeated a few times — a new critical/offline. */
export function playCritical(): void {
  play(() => {
    for (let p = 0; p < REPEATS; p++) {
      const base = p * 0.85;
      tone(base, 880, 0.14, "square", 0.18);
      tone(base + 0.12, 587, 0.14, "square", 0.18);
      tone(base + 0.24, 880, 0.14, "square", 0.18);
    }
  });
}

/** Pleasant ascending chime — an alert resolved. */
export function playResolved(): void {
  play(() => {
    tone(0, 523.25, 0.22, "sine", 0.18);
    tone(0.14, 659.25, 0.22, "sine", 0.18);
    tone(0.28, 783.99, 0.32, "sine", 0.2);
  });
}
