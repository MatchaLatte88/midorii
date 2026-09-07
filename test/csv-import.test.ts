import { describe, it, expect } from 'vitest';
import {
    dominantInterval, makeTimeReader, mapColumns, parseMarketCsv, sniffCsv, sniffDateStyle, splitRow,
} from '../app/electron/data/csv.js';

/**
 * Reading a market CSV.
 *
 * The failure worth testing for is not a crash — it is a file that imports cleanly and is
 * wrong. A day-first export read as month-first produces a dataset that looks entirely
 * normal and misplaces every date after the twelfth of a month, and a New York export read
 * as UTC shifts every bar by four or five hours depending on the season. Both are checked
 * here against the exact shapes real exports arrive in.
 */

const BINANCE_HEADERLESS = [
    '1704067200000,42000.0,42100.0,41900.0,42050.0,10.5,1704067259999,441000,120,6.0,252000,0',
    '1704067260000,42050.0,42200.0,42000.0,42150.0,8.0,1704067319999,337000,90,3.5,147000,0',
    '1704067320000,42150.0,42160.0,42010.0,42020.0,4.0,1704067379999,168000,40,1.0,42000,0',
].join('\n');

const NQ_EXPORT = [
    'timestamp ET,open,high,low,close,volume,Vwap_RTH',
    '12/26/2022 18:01,13759,13794.75,13759,13788.5,540,0',
    '12/26/2022 18:02,13790.25,13794,13784,13790.25,304,0',
    '12/26/2022 18:03,13790.25,13791,13780,13781,210,0',
].join('\n');

const EUROPEAN = [
    'Datum;Zeit;Eröffnung;Hoch;Tief;Schluss;Volumen',
].join('\n');

describe('csv rows', () => {
    it('keeps a quoted delimiter inside its field', () => {
        expect(splitRow('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
        expect(splitRow('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b']);
    });
});

describe('csv sniffing', () => {
    it('reads a headerless Binance dump positionally, taker volume included', () => {
        const sniffed = sniffCsv(BINANCE_HEADERLESS);

        expect(sniffed.hasHeader).toBe(false);
        expect(sniffed.delimiter).toBe(',');
        expect(sniffed.mapping.time).toBe(0);
        expect(sniffed.mapping.close).toBe(4);
        // Column 9 is the volume the buyer was the aggressor for.
        expect(sniffed.mapping.buyVolume).toBe(9);
        expect(sniffed.needsTimeZone).toBe(false);
        expect(sniffed.missing).toEqual([]);
    });

    it('maps a header whose timestamp column names its own time zone', () => {
        const sniffed = sniffCsv(NQ_EXPORT);

        expect(sniffed.hasHeader).toBe(true);
        expect(sniffed.mapping).toMatchObject({ time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 });
        // `Vwap_RTH` is nothing the store keeps, and is left where it is.
        expect(sniffed.mapping.buyVolume).toBeNull();
        // Written-out timestamps: which clock they are on is a real question.
        expect(sniffed.needsTimeZone).toBe(true);
        expect(sniffed.dateStyle).toBe('mdy');
    });

    it('joins a Date column to the Time column beside it', () => {
        const mapping = mapColumns(['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Volume']);
        expect(mapping.date).toBe(0);
        expect(mapping.clock).toBe(1);
        expect(mapping.time).toBeNull();
    });

    it('treats a lone Date column as the timestamp', () => {
        const mapping = mapColumns(['Date', 'Open', 'High', 'Low', 'Close']);
        expect(mapping.time).toBe(0);
        expect(mapping.date).toBeNull();
        expect(mapping.clock).toBeNull();
    });

    it('picks the delimiter that splits every line the same way', () => {
        const semicolons = [
            'time;open;high;low;close',
            '2024-01-05 10:30;1,5;2,5;1,0;2,0',
            '2024-01-05 10:31;2,0;2,5;1,5;1,8',
        ].join('\n');
        expect(sniffCsv(semicolons).delimiter).toBe(';');
    });

    it('reports what a file has no column for instead of importing half of it', () => {
        const sniffed = sniffCsv('time,close\n2024-01-05,42000\n2024-01-06,42100');
        expect(sniffed.missing).toEqual(['open', 'high', 'low']);
    });

    it('refuses an empty file', () => {
        expect(() => sniffCsv('   \n\n')).toThrow(/empty/i);
    });
});

describe('date style', () => {
    it('reads a number above twelve in the first place as the day', () => {
        expect(sniffDateStyle(['13/01/2024 10:00', '14/01/2024 10:00'])).toBe('dmy');
    });

    it('reads a number above twelve in the second place as the day', () => {
        expect(sniffDateStyle(['01/13/2024 10:00', '01/14/2024 10:00'])).toBe('mdy');
    });

    it('reads a four-digit lead as the year', () => {
        expect(sniffDateStyle(['2024/03/04 10:00'])).toBe('ymd');
        expect(sniffDateStyle(['2024-03-04T10:00:00'])).toBe('ymd');
    });

    it('falls back to month-first when nothing in the sample decides it', () => {
        // 03/04 is either reading. The dialog shows the choice; it is not hidden.
        expect(sniffDateStyle(['03/04/2024', '05/06/2024'])).toBe('mdy');
    });
});

describe('timestamps', () => {
    const utc = makeTimeReader({ dateStyle: 'ymd', timeZone: 'UTC' });

    it('reads epoch seconds, milliseconds and microseconds by magnitude', () => {
        expect(utc('1704450600')).toBe(1_704_450_600_000);
        expect(utc('1704450600000')).toBe(1_704_450_600_000);
        expect(utc('1704450600000000')).toBe(1_704_450_600_000);
    });

    it('takes a stamp that carries its own offset at its word', () => {
        const newYork = makeTimeReader({ dateStyle: 'ymd', timeZone: 'America/New_York' });
        // Explicitly Z: the import's time zone must not touch it.
        expect(newYork('2024-01-05T10:30:00Z')).toBe(Date.parse('2024-01-05T10:30:00Z'));
        expect(newYork('2024-01-05T10:30:00+02:00')).toBe(Date.parse('2024-01-05T08:30:00Z'));
    });

    it('reads a naive stamp as wall-clock time in the chosen zone', () => {
        const newYork = makeTimeReader({ dateStyle: 'mdy', timeZone: 'America/New_York' });
        // Winter: ET is five hours behind.
        expect(newYork('12/26/2022 18:01')).toBe(Date.parse('2022-12-26T23:01:00Z'));
        // Summer: four. Getting this from a fixed offset would put it an hour out.
        expect(newYork('7/5/2023 09:30')).toBe(Date.parse('2023-07-05T13:30:00Z'));
    });

    it('lands on the right side of a daylight-saving jump', () => {
        const newYork = makeTimeReader({ dateStyle: 'mdy', timeZone: 'America/New_York' });
        // 02:00 does not exist on 2023-03-12; the minute before and the hour after do.
        expect(newYork('3/12/2023 01:59')).toBe(Date.parse('2023-03-12T06:59:00Z'));
        expect(newYork('3/12/2023 03:00')).toBe(Date.parse('2023-03-12T07:00:00Z'));
    });

    it('joins a split date and clock', () => {
        expect(utc('2024-01-05', '10:30:00')).toBe(Date.parse('2024-01-05T10:30:00Z'));
    });

    it('answers NaN for a cell that is not a timestamp', () => {
        expect(utc('total')).toBeNaN();
        expect(utc('')).toBeNaN();
    });
});

describe('parsing a whole file', () => {
    it('turns a Binance dump into bars, taker volume and all', () => {
        const sniffed = sniffCsv(BINANCE_HEADERLESS);
        const { bars, skipped, intervalMs } = parseMarketCsv(BINANCE_HEADERLESS, sniffed);

        expect(bars).toHaveLength(3);
        expect(skipped).toBe(0);
        expect(intervalMs).toBe(60_000);
        expect(bars[0]).toMatchObject({
            time: 1_704_067_200_000, open: 42_000, high: 42_100, low: 41_900, close: 42_050, volume: 10.5, buyVolume: 6,
        });
    });

    it('reads a New York export in New York time', () => {
        const sniffed = sniffCsv(NQ_EXPORT);
        const { bars } = parseMarketCsv(NQ_EXPORT, { ...sniffed, timeZone: 'America/New_York' });

        expect(bars[0]!.time).toBe(Date.parse('2022-12-26T23:01:00Z'));
        expect(bars[2]!.close).toBe(13_781);
    });

    it('reads a semicolon file as European decimals', () => {
        const text = [
            'time;open;high;low;close;volume',
            '2024-01-05 10:30;1.234,5;1.240,0;1.230,0;1.238,0;12,5',
            '2024-01-05 10:31;1.238,0;1.239,0;1.235,0;1.236,0;9,0',
        ].join('\n');
        const sniffed = sniffCsv(text);
        const { bars } = parseMarketCsv(text, sniffed);

        expect(bars[0]).toMatchObject({ open: 1234.5, high: 1240, low: 1230, close: 1238, volume: 12.5 });
    });

    it('counts a row it cannot read rather than dropping it silently', () => {
        const text = [
            'time,open,high,low,close',
            '2024-01-05T10:30:00Z,10,11,9,10.5',
            'Total,,,,',
            '2024-01-05T10:31:00Z,10.5,11,10,10.8',
        ].join('\n');
        const { bars, skipped, rows, firstError } = parseMarketCsv(text, sniffCsv(text));

        expect(bars).toHaveLength(2);
        expect(rows).toBe(3);
        expect(skipped).toBe(1);
        expect(firstError).toMatch(/Total/);
    });

    it('refuses a bar whose own high is below its open', () => {
        // The signature of a wrong column mapping, not of a typo.
        const text = ['time,open,high,low,close', '2024-01-05T10:30:00Z,10,9,8,8.5'].join('\n');
        expect(() => parseMarketCsv(text, sniffCsv(text))).toThrow(/parsed as a bar/);
    });

    it('sorts what it read, whatever order the file was in', () => {
        const text = [
            'time,open,high,low,close',
            '2024-01-05T10:31:00Z,2,3,1,2',
            '2024-01-05T10:30:00Z,1,2,1,2',
        ].join('\n');
        const { bars } = parseMarketCsv(text, sniffCsv(text));
        expect(bars.map((b) => b.time)).toEqual([
            Date.parse('2024-01-05T10:30:00Z'), Date.parse('2024-01-05T10:31:00Z'),
        ]);
    });

    it('refuses to parse under a mapping that is missing a price', () => {
        expect(() => parseMarketCsv('a,b\n1,2', {
            mapping: { time: 0, date: null, clock: null, open: 1, high: null, low: null, close: null, volume: null, buyVolume: null },
        })).toThrow(/no column for: high, low, close/);
    });

    it('leaves the European header sample alone when it has no rows to read', () => {
        // A header and nothing under it: the sniff succeeds, the parse has nothing to do.
        expect(() => parseMarketCsv(EUROPEAN, sniffCsv(EUROPEAN))).toThrow();
    });
});

describe('bar length', () => {
    const at = (minutes: number[]) => minutes.map((m) => ({ time: m * 60_000 } as { time: number }));

    it('is the gap that occurs most often, not the smallest', () => {
        // A session break of an hour among minute bars must not make this an hour.
        expect(dominantInterval(at([0, 1, 2, 3, 63, 64, 65]))).toBe(60_000);
    });

    it('survives a duplicated timestamp', () => {
        expect(dominantInterval(at([0, 1, 1, 2, 3]))).toBe(60_000);
    });

    it('reports nothing when the bars agree on nothing', () => {
        expect(dominantInterval(at([0, 3, 11, 40, 96, 100]))).toBeNull();
    });

    it('reports nothing for a series too short to have a shape', () => {
        expect(dominantInterval(at([0, 1]))).toBeNull();
    });
});
