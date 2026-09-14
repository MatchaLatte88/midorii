import { describe, expect, it } from 'vitest';
import type { DataProvider } from '../src/core/ports/DataProvider';
import { BarStore } from '../src/data/BarStore';
import { MultiProviderFeed } from '../src/data/MultiProviderFeed';

function provider(search?: (query: string) => Promise<Array<{ ticker: string; description?: string }>>): DataProvider {
    return {
        getBars: () => Promise.resolve([]),
        listSymbols: () => Promise.resolve([]),
        ...(search ? { searchSymbols: search } : {}),
    };
}

describe('provider on-demand symbol search', () => {
    it('scopes calls, annotates ownership, and de-duplicates a provider response', async () => {
        const calls: string[] = [];
        const feed = new MultiProviderFeed(new BarStore());
        await Promise.all([
            feed.registerProvider('local', provider()),
            feed.registerProvider('global', provider((query) => {
                calls.push(query);
                return Promise.resolve([
                    { ticker: 'NASDAQ:AAPL', description: 'Apple' },
                    { ticker: 'NASDAQ:AAPL', description: 'duplicate' },
                ]);
            })),
        ]);

        expect(await feed.searchSymbols('AAPL', ['global'])).toEqual([
            { ticker: 'NASDAQ:AAPL', description: 'Apple', provider: 'global' },
        ]);
        expect(calls).toEqual(['AAPL']);
        expect(await feed.searchSymbols('AAPL', ['local'])).toEqual([]);
        expect(calls).toEqual(['AAPL']);
    });

    it('keeps another provider useful when one search fails', async () => {
        const feed = new MultiProviderFeed(new BarStore());
        await Promise.all([
            feed.registerProvider('broken', provider(() => Promise.reject(new Error('offline')))),
            feed.registerProvider('working', provider(() => Promise.resolve([{ ticker: 'CME:NQ' }]))),
        ]);
        expect(await feed.searchSymbols('NQ')).toEqual([{ ticker: 'CME:NQ', provider: 'working' }]);
    });
});

