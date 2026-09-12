/**
 * A sound when something fills.
 *
 * The one event on a trading screen worth hearing rather than seeing: a stop that triggered
 * while you were reading something else is the thing you most need to know and the thing you
 * are least likely to be looking at. Everything else the app has to say is a toast.
 *
 * Synthesized rather than shipped as a file, for two reasons that are the same reason: an
 * audio asset would have to be loaded before it could ever be heard — so the first fill of a
 * session would be the silent one — and it would be one more thing in the bundle that exists
 * for a hundred milliseconds of sound.
 *
 * Off until somebody turns it on. A trading app that made a noise the first time it was opened
 * is a trading app that gets muted at the operating system, along with everything else it might
 * ever have wanted to say.
 */

const STORAGE_KEY = 'midorii-fill-chime';

/** Whether a fill makes a sound on this machine. */
export function chimeOn(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
        console.error('[midorii] could not read the fill-sound setting', err);
        return false;
    }
}

export function setChime(on: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch (err) {
        console.error('[midorii] could not persist the fill-sound setting', err);
    }
}

/** One context for the life of the page. Built on the first sound, never before: a context
 *  created without a gesture behind it starts suspended and stays that way. */
let audio: AudioContext | null = null;

/**
 * A short, soft two-tone blip — up for a fill, down for a close.
 *
 * Deliberately quiet and deliberately short. This has to be audible over a room and forgettable
 * within a second, because it happens every time anything trades; anything longer becomes the
 * thing people turn off.
 */
export function chime(kind: 'fill' | 'close'): void {
    if (!chimeOn()) return;
    try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        audio ??= new Ctor();
        if (audio.state === 'suspended') void audio.resume();

        const now = audio.currentTime;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        /* A fill rises and a close falls, which is the only thing the sound has to say beyond
         * "something happened" — and it says it without anybody having to learn two tones. */
        const [from, to] = kind === 'fill' ? [660, 880] : [660, 440];
        osc.frequency.setValueAtTime(from, now);
        osc.frequency.exponentialRampToValueAtTime(to, now + 0.08);
        /* Ramped rather than switched: a gain that starts at its full value clicks, and a click
         * is the part people actually find unpleasant. */
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.06, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
        osc.connect(gain).connect(audio.destination);
        osc.start(now);
        osc.stop(now + 0.18);
    } catch (err) {
        /* A sound that cannot be made is not a reason to fail a trade, and not worth a toast
         * either — the toast that goes with it is already on screen. */
        console.warn('[midorii] could not play the fill sound', err);
    }
}
