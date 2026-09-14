import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { NativeIndicatorContext, NativeIndicatorOutput } from '../src/core/native-indicators';
import {
    buildVolumeSentimentProfile,
    detectVolumeSentimentChannels,
    type VolumeSentimentAnalysis,
} from '../src/core/analysis/volumeSentimentChannels';
import {
    buildVolumeSentimentChannelsOutput,
    volumeSentimentChannelsDescriptor,
} from '../src/core/native-indicators/volume-sentiment-channels';

const VIEW = { bullColor: '#00ffbb', bearColor: '#ff1100' };

function priceBar(index: number, close: number, open = 50, volume = 100): OHLCV {
    return { time: 1_700_000_000_000 + index * 60_000, open, high: 100, low: 0, close, volume };
}

/**
 * Stable normalized volatility, a long quiet stretch, then a renewed expansion.
 * Fixed 0..100 highs/lows make normalized close observable without changing the channel bounds.
 */
function regimeBars(): OHLCV[] {
    const bars: OHLCV[] = [];
    for (let i = 0; i < 140; i += 1) bars.push(priceBar(i, i % 2 === 0 ? 20 : 80, 50, 80 + (i % 7) * 10));
    for (let i = 0; i < 35; i += 1) bars.push(priceBar(bars.length, 50, 50, 90));
    for (let i = 0; i < 20; i += 1) bars.push(priceBar(bars.length, i % 2 === 0 ? 15 : 85, 50, 120 + i));
    return bars;
}

function latestActivePrefix(): OHLCV[] {
    const bars = regimeBars();
    const analysis = detectVolumeSentimentChannels(bars);
    const formed = analysis.channelFormed.findIndex(Boolean);
    if (formed < 0) throw new Error('fixture did not form a channel');
    return bars.slice(0, formed + 1);
}

describe('volume sentiment profile', () => {
    it('assigns whole candle volume to the price bins its range touches and signs it by candle direction', () => {
        const bars: OHLCV[] = [
            { time: 0, open: 1, high: 4, low: 1, close: 4, volume: 100 },
            { time: 1, open: 9, high: 9, low: 6, close: 6, volume: 50 },
        ];
        const profile = buildVolumeSentimentProfile(bars, 0, 1, 0, 10, 2);
        expect(profile.bins).toEqual([
            { bottom: 0, top: 5, volume: 100, signedVolume: 100 },
            { bottom: 5, top: 10, volume: 50, signedVolume: -50 },
        ]);
        expect(profile).toMatchObject({
            maxVolume: 100,
            maxAbsSignedVolume: 100,
            signedVolume: 50,
            currentBin: 1,
            currentSentiment: -0.5,
            overallSentiment: 'bullish',
        });
    });

    it('keeps the price bins but does not invent volume when the feed has none', () => {
        const bars: OHLCV[] = [{ time: 0, open: 1, high: 9, low: 1, close: 8 }];
        const profile = buildVolumeSentimentProfile(bars, 0, 0, 0, 10, 2);
        expect(profile.bins).toHaveLength(2);
        expect(profile.bins.every((bin) => bin.volume === 0 && bin.signedVolume === 0)).toBe(true);
        expect(profile.currentSentiment).toBeNull();
    });
});

describe('volume sentiment channel detection', () => {
    it('forms a channel when normalized volatility expands after more than ten quiet bars', () => {
        const bars = regimeBars();
        const analysis = detectVolumeSentimentChannels(bars);
        const formed = analysis.channelFormed.findIndex(Boolean);
        expect(formed).toBeGreaterThan(0);
        expect(analysis.channels).toHaveLength(1);
        expect(analysis.channels[0]).toMatchObject({
            formedIndex: formed,
            top: 100,
            bottom: 0,
            middle: 50,
            active: true,
            breakIndex: null,
        });
        expect(analysis.channels[0]!.profile.bins).toHaveLength(20);
    });

    it('requires the candle midpoint to clear an edge in strong-close mode', () => {
        const base = latestActivePrefix();
        const index = base.length;
        const closeOnlyBreak: OHLCV = {
            time: 1_700_000_000_000 + index * 60_000,
            open: 90,
            high: 108,
            low: 88,
            close: 105,
            volume: 200,
        };
        const strong = detectVolumeSentimentChannels([...base, closeOnlyBreak], { strongClosesOnly: true });
        const loose = detectVolumeSentimentChannels([...base, closeOnlyBreak], { strongClosesOnly: false });
        expect(strong.bullishBreak[index]).toBe(false);
        expect(strong.channels[0]!.active).toBe(true);
        expect(loose.bullishBreak[index]).toBe(true);
        expect(loose.channels[0]).toMatchObject({ active: false, breakIndex: index, breakDirection: 'up' });
    });

    it('starts the expanding low average and marker signal after a bullish strong close', () => {
        const base = latestActivePrefix();
        const index = base.length;
        const broken = [...base, {
            time: 1_700_000_000_000 + index * 60_000,
            open: 108,
            high: 122,
            low: 105,
            close: 120,
            volume: 250,
        }];
        const analysis = detectVolumeSentimentChannels(broken);
        expect(analysis.bullishBreak[index]).toBe(true);
        expect(analysis.channels[0]).toMatchObject({ active: false, endIndex: index - 1, breakDirection: 'up' });
        expect(analysis.bullishTrend[index]).toBe(105);
        expect(analysis.bearishTrend[index]).toBeNaN();
    });

    it('mirrors the breakout and trend for a bearish strong close', () => {
        const base = latestActivePrefix();
        const index = base.length;
        const broken = [...base, {
            time: 1_700_000_000_000 + index * 60_000,
            open: -8,
            high: -5,
            low: -22,
            close: -20,
            volume: 250,
        }];
        const analysis = detectVolumeSentimentChannels(broken);
        expect(analysis.bearishBreak[index]).toBe(true);
        expect(analysis.channels[0]).toMatchObject({ active: false, breakIndex: index, breakDirection: 'down' });
        expect(analysis.bearishTrend[index]).toBe(-5);
        expect(analysis.bullishTrend[index]).toBeNaN();
    });
});

describe('volume sentiment channel rendering', () => {
    it('draws the channel, both profiles, five structural lines and both trend fills', () => {
        const bars = latestActivePrefix();
        const analysis = detectVolumeSentimentChannels(bars);
        const out = buildVolumeSentimentChannelsOutput(analysis, bars, VIEW);
        const boxes = out.boxes ?? [];
        const lines = out.lines ?? [];
        expect(boxes.filter((item) => item.id.includes('_sentiment_'))).toHaveLength(20);
        expect(boxes.filter((item) => item.id.includes('_live_profile_'))).toHaveLength(20);
        expect(boxes.some((item) => item.id.endsWith('_channel'))).toBe(true);
        expect(boxes.some((item) => item.id.endsWith('_upper'))).toBe(true);
        expect(boxes.some((item) => item.id.endsWith('_lower'))).toBe(true);
        expect(lines).toHaveLength(5);
        expect(out.series).toHaveLength(3);
        expect(out.fills).toHaveLength(2);
        expect(out.labels).toEqual([]);
    });

    it('removes the live profile and adds an absolute breakout marker after resolution', () => {
        const base = latestActivePrefix();
        const index = base.length;
        const bars = [...base, {
            time: 1_700_000_000_000 + index * 60_000,
            open: 108,
            high: 122,
            low: 105,
            close: 120,
            volume: 250,
        }];
        const analysis = detectVolumeSentimentChannels(bars);
        const out = buildVolumeSentimentChannelsOutput(analysis, bars, VIEW);
        expect((out.boxes ?? []).some((item) => item.id.includes('_live_profile_'))).toBe(false);
        expect(out.labels).toEqual([expect.objectContaining({
            id: `sentiment_break_up_${index}`,
            style: 'triangleup',
            y: expect.any(Number),
        })]);
        const bullish = out.series?.find((item) => item.title === 'Bullish Trend');
        expect(bullish?.kind).toBe('line');
        if (bullish?.kind === 'line') expect(bullish.points[index]!.value).toBe(105);
    });
});

describe('volume sentiment native alerts', () => {
    function context(current: OHLCV[], outputs: NativeIndicatorOutput[], alerts: Array<{ title?: string; message: string }>): NativeIndicatorContext {
        return {
            symbol: 'TEST',
            timeframe: '1m',
            live: true,
            bars: () => current,
            data: {} as NativeIndicatorContext['data'],
            emit: (out) => outputs.push(out),
            emitAlert: (alert) => alerts.push(alert),
            pushData: () => undefined,
            setStatus: () => undefined,
        };
    }

    it('emits formation and breakout once, while initial history stays silent', () => {
        const full = regimeBars();
        const fullAnalysis = detectVolumeSentimentChannels(full);
        const formed = fullAnalysis.channelFormed.findIndex(Boolean);
        const current = full.slice(0, formed);
        const outputs: NativeIndicatorOutput[] = [];
        const alerts: Array<{ title?: string; message: string }> = [];
        const indicator = volumeSentimentChannelsDescriptor.create();
        indicator.start(context(current, outputs, alerts), volumeSentimentChannelsDescriptor.defaultInputs());
        expect(alerts).toEqual([]);

        current.push(full[formed]!);
        indicator.onBars();
        indicator.onBars();
        expect(alerts.map(({ title, message }) => ({ title, message }))).toEqual([
            { title: 'Channel Formed', message: 'A new channel has formed.' },
        ]);

        const index = current.length;
        current.push({
            time: 1_700_000_000_000 + index * 60_000,
            open: 108,
            high: 122,
            low: 105,
            close: 120,
            volume: 250,
        });
        indicator.onBars();
        indicator.onBars();
        expect(alerts.map(({ title, message }) => ({ title, message }))).toEqual([
            { title: 'Channel Formed', message: 'A new channel has formed.' },
            { title: 'Bullish Channel Break', message: 'Price broke above the channel.' },
        ]);
        expect(outputs.length).toBeGreaterThan(2);
    });

    it('emits the bearish breakout alert as its own condition', () => {
        const current = latestActivePrefix();
        const outputs: NativeIndicatorOutput[] = [];
        const alerts: Array<{ title?: string; message: string }> = [];
        const indicator = volumeSentimentChannelsDescriptor.create();
        indicator.start(context(current, outputs, alerts), volumeSentimentChannelsDescriptor.defaultInputs());
        const index = current.length;
        current.push({
            time: 1_700_000_000_000 + index * 60_000,
            open: -8,
            high: -5,
            low: -22,
            close: -20,
            volume: 250,
        });
        indicator.onBars();
        expect(alerts.map(({ title, message }) => ({ title, message }))).toEqual([
            { title: 'Bearish Channel Break', message: 'Price broke below the channel.' },
        ]);
    });

    it('primes deferred initial history without replaying old channel alerts', () => {
        const current: OHLCV[] = [];
        const outputs: NativeIndicatorOutput[] = [];
        const alerts: Array<{ title?: string; message: string }> = [];
        const indicator = volumeSentimentChannelsDescriptor.create();
        indicator.start(context(current, outputs, alerts), volumeSentimentChannelsDescriptor.defaultInputs());

        current.push(...latestActivePrefix());
        indicator.onBars();
        expect(alerts).toEqual([]);

        const index = current.length;
        current.push({
            time: 1_700_000_000_000 + index * 60_000,
            open: 108,
            high: 122,
            low: 105,
            close: 120,
            volume: 250,
        });
        indicator.onBars();
        expect(alerts.map(({ title, message }) => ({ title, message }))).toEqual([
            { title: 'Bullish Channel Break', message: 'Price broke above the channel.' },
        ]);
    });
});

describe('volume sentiment descriptor', () => {
    it('keeps the supplied settings and remains a separate native overlay', () => {
        expect(volumeSentimentChannelsDescriptor).toMatchObject({
            type: 'volume-sentiment-channels',
            title: 'Volume Sentiment Breakout Channels',
            paneHint: 'price',
            overlay: true,
            multiInstance: true,
            autoscaleDrawings: false,
        });
        const declared = Object.fromEntries(
            volumeSentimentChannelsDescriptor.inputsSchema().map((input) => [input.key, input.defval]),
        );
        expect(declared).toEqual(volumeSentimentChannelsDescriptor.defaultInputs());
        expect(Object.keys(declared)).toEqual([
            'normalizationLength', 'channelLength', 'strongClosesOnly', 'bullColor', 'bearColor',
        ]);
    });
});
