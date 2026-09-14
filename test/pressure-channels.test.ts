import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { Range } from '../src/core/analysis/range';
import type { NativeIndicatorContext, NativeIndicatorOutput } from '../src/core/native-indicators';
import { summarizeVolumePressure, volumePressureOfBar } from '../src/core/analysis/volumePressure';
import {
    buildPressureChannelsOutput,
    pressureChannelsDescriptor,
    type PressureChannelViewOptions,
} from '../src/core/native-indicators/pressure-channels';

function bar(close: number, volume: number | undefined = 100): OHLCV {
    return { time: 0, open: 5, high: 10, low: 0, close, volume };
}

const VIEW: PressureChannelViewOptions = {
    showPressure: true,
    showMeter: true,
    pressureScale: 0.75,
    pressureHistory: 800,
    channelColor: '#5b9cf6',
    bullColor: '#089981',
    bearColor: '#f23645',
};

function channel(active = true): Range {
    return {
        startIndex: 0,
        startTime: 1_000,
        index: 2,
        time: 3_000,
        endIndex: 3,
        endTime: 4_000,
        length: 4,
        top: 110,
        bottom: 90,
        middle: 100,
        height: 20,
        confirmTop: 110,
        confirmBottom: 90,
        compression: 0.4,
        touchesTop: 2,
        touchesBottom: 2,
        breakIndex: null,
        breakTime: null,
        breakDirection: null,
        breakClose: null,
        active,
    };
}

function pressureBars(): OHLCV[] {
    return [
        { time: 1_000, open: 100, high: 110, low: 90, close: 109, volume: 100 },
        { time: 2_000, open: 100, high: 110, low: 90, close: 91, volume: 50 },
        { time: 3_000, open: 100, high: 110, low: 90, close: 106, volume: 80 },
        { time: 4_000, open: 100, high: 110, low: 90, close: 104, volume: 120 },
    ];
}

describe('volume pressure', () => {
    it('maps a close at the high, middle and low to positive, balanced and negative pressure', () => {
        expect(volumePressureOfBar(bar(10))).toEqual({ bias: 1, volume: 100, signedVolume: 100 });
        expect(volumePressureOfBar(bar(5))).toEqual({ bias: 0, volume: 100, signedVolume: 0 });
        expect(volumePressureOfBar(bar(0))).toEqual({ bias: -1, volume: 100, signedVolume: -100 });
    });

    it('does not invent pressure when the feed reports no volume', () => {
        const noVolume: OHLCV = { time: 0, open: 5, high: 10, low: 0, close: 10 };
        expect(volumePressureOfBar(noVolume)).toBeNull();
        expect(summarizeVolumePressure([noVolume], 0, 0)).toBeNull();
    });

    it('gives a newer bar more influence without leaving the normalized range', () => {
        const readings = [bar(0), bar(10)];
        const summary = summarizeVolumePressure(readings, 0, 1, 0.5)!;
        expect(summary.score).toBeCloseTo(1 / 3, 10);
        expect(summary.averageVolume).toBe(100);
        expect(summary.bars).toBe(2);
    });

    it('falls back to direction on a flat bar', () => {
        const previous = { time: 0, open: 9, high: 9, low: 9, close: 9, volume: 1 };
        const flat = { time: 1, open: 10, high: 10, low: 10, close: 10, volume: 20 };
        expect(volumePressureOfBar(flat, previous)).toMatchObject({ bias: 1, signedVolume: 20 });
    });
});

describe('pressure-channel geometry', () => {
    it('draws a channel, pressure pulses and a live meter around equilibrium', () => {
        const out = buildPressureChannelsOutput([channel()], pressureBars(), VIEW);
        const boxes = out.boxes ?? [];
        const lines = out.lines ?? [];
        const labels = out.labels ?? [];

        expect(boxes).toHaveLength(1);
        expect(boxes[0]).toMatchObject({
            id: 'pressure_0_channel',
            top: 110,
            bottom: 90,
            bgColor: 'rgba(8,153,129,0.055)',
            bgColorTo: 'rgba(242,54,69,0.055)',
        });
        const pulses = lines.filter((item) => item.id.includes('_pulse_'));
        expect(pulses).toHaveLength(4);
        expect(pulses[0]).toMatchObject({ xloc: 'bar_index', x1: 0.48, x2: 0.48 });
        expect(lines.filter((item) => item.id.includes('_meter_'))).toHaveLength(11);
        expect(lines.find((item) => item.id === 'pressure_0_equilibrium')).toMatchObject({
            y1: 100,
            y2: 100,
            style: 'dashed',
            extend: 'right',
        });
        expect(labels).toHaveLength(1);
        expect(labels[0]).toMatchObject({ id: 'pressure_0_meter_value', style: 'label_left', xloc: 'bar_index' });
        expect(labels[0]!.text).toMatch(/^\+\d+%$/);
    });

    it('keeps the channel and shows an honest no-volume meter', () => {
        const data = pressureBars().map(({ volume: _volume, ...item }) => item);
        const out = buildPressureChannelsOutput([channel()], data, VIEW);
        expect(out.boxes).toHaveLength(1);
        expect((out.lines ?? []).some((item) => item.id.includes('_pulse_'))).toBe(false);
        expect(out.labels?.[0]?.text).toBe('VOL —');
    });

    it('marks a completed upward breakout and removes the live meter', () => {
        const broken: Range = {
            ...channel(false),
            breakIndex: 4,
            breakTime: 5_000,
            breakDirection: 'up',
            breakClose: 116,
        };
        const out = buildPressureChannelsOutput([broken], pressureBars(), VIEW);
        expect((out.lines ?? []).find((item) => item.id === 'pressure_0_break')).toMatchObject({
            x1: 4_000,
            y1: 110,
            x2: 5_000,
            y2: 116,
            arrowRight: true,
        });
        expect(out.labels).toEqual([expect.objectContaining({
            id: 'pressure_0_break_marker',
            style: 'triangleup',
            color: '#089981',
        })]);
        expect((out.lines ?? []).some((item) => item.id.includes('_meter_'))).toBe(false);
    });

    it('can hide all pressure marks without changing channel detection marks', () => {
        const out = buildPressureChannelsOutput([channel()], pressureBars(), { ...VIEW, showPressure: false });
        expect(out.boxes).toHaveLength(1);
        expect((out.lines ?? []).filter((item) => item.id.includes('_pulse_'))).toHaveLength(0);
        expect((out.lines ?? []).filter((item) => item.id.includes('_meter_'))).toHaveLength(0);
        expect(out.labels).toEqual([]);
    });
});

describe('pressure-channel descriptor', () => {
    it('is a price overlay with stable defaults and room for multiple tunings', () => {
        expect(pressureChannelsDescriptor).toMatchObject({
            type: 'pressure-channels',
            title: 'Pressure Channels',
            paneHint: 'price',
            overlay: true,
            autoscaleDrawings: false,
            multiInstance: true,
        });
        const declared = Object.fromEntries(
            pressureChannelsDescriptor.inputsSchema().map((input) => [input.key, input.defval]),
        );
        expect(declared).toEqual(pressureChannelsDescriptor.defaultInputs());
        expect(declared).toMatchObject({ confirmedOnly: true, showPressure: true, showMeter: true });
    });

    it('waits for the live bar to close before it reports a breakout by default', () => {
        const data: OHLCV[] = [];
        let price = 100;
        for (let i = 0; i < 30; i += 1) {
            data.push({ time: i, open: price, high: price + 10, low: price, close: price + 10, volume: 100 });
            price += 10;
        }
        for (let i = 0; i < 40; i += 1) {
            data.push(i % 2 === 0
                ? { time: 30 + i, open: 400, high: 406, low: 400, close: 404, volume: 100 }
                : { time: 30 + i, open: 400, high: 400, low: 394, close: 396, volume: 100 });
        }
        data.push({ time: 70, open: 400, high: 460, low: 400, close: 455, volume: 200 });

        const emitted: NativeIndicatorOutput[] = [];
        const ctx: NativeIndicatorContext = {
            symbol: 'TEST',
            timeframe: '1m',
            live: true,
            bars: () => data,
            data: {} as NativeIndicatorContext['data'],
            emit: (out) => emitted.push(out),
            pushData: () => undefined,
            setStatus: () => undefined,
        };
        const indicator = pressureChannelsDescriptor.create();
        indicator.start(ctx, pressureChannelsDescriptor.defaultInputs());
        let latest = emitted[emitted.length - 1]!;
        expect(latest.lines?.some((item) => item.id.endsWith('_break'))).toBe(false);
        expect(latest.labels?.some((item) => item.id.endsWith('_meter_value'))).toBe(true);

        indicator.setInputs({ ...pressureChannelsDescriptor.defaultInputs(), confirmedOnly: false });
        latest = emitted[emitted.length - 1]!;
        expect(latest.lines?.some((item) => item.id.endsWith('_break'))).toBe(true);
        expect(latest.labels?.some((item) => item.id.endsWith('_meter_value'))).toBe(false);
    });
});
