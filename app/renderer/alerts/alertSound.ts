/**
 * The chime a fired alert plays, alongside the OS notification — generated on the fly
 * (two short sine notes) rather than shipped as an asset, so the feature needs no bundled
 * audio file and no asset-pipeline wiring.
 */
let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
    ctx ??= new AudioContext();
    return ctx;
}

export function playAlertSound(): void {
    try {
        const audio = audioContext();
        void audio.resume(); // a fresh/suspended context needs this before it will produce sound
        const now = audio.currentTime;
        for (const [freq, start] of [[880, 0], [1318.5, 0.12]] as const) {
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, now + start);
            gain.gain.linearRampToValueAtTime(0.25, now + start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.3);
            osc.connect(gain).connect(audio.destination);
            osc.start(now + start);
            osc.stop(now + start + 0.32);
        }
    } catch (err) {
        console.error('[midorii] could not play the alert sound', err);
    }
}
