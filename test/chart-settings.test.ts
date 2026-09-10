// The chart's settings dialog takes its whole tab list at once, which is right for a library
// with one host and wrong for a host with several things to say. Trading arrives with an
// account and leaves with it; the chart's cards stay. Left to call the workspace directly,
// whichever ran last would silently be the only tab in the dialog.
// See app/renderer/shell/chartSettings.ts.
import { describe, it, expect } from 'vitest';
import { contributeChartSettings } from '../app/renderer/shell/chartSettings';
import type { HostSettingsSection, VelaWorkspace } from '../src/workspace';

/** A workspace as far as this registry is concerned: the one call it makes. */
function fakeWorkspace(): { ws: VelaWorkspace; titles: () => string[] } {
    let last: ReadonlyArray<{ title: string }> = [];
    const ws = {
        setAppSettingsSections(sections: ReadonlyArray<{ title: string }>) { last = sections; },
    } as unknown as VelaWorkspace;
    return { ws, titles: () => last.map((s) => s.title) };
}

const section = (title: string): HostSettingsSection => (
    { title, id: title.toLowerCase(), rows: [] } as unknown as HostSettingsSection
);

describe('the chart settings registry', () => {
    it('keeps every contributor, rather than the last one to speak', () => {
        const { ws, titles } = fakeWorkspace();
        contributeChartSettings(ws, 'chart-cards', section('Chart cards'));
        contributeChartSettings(ws, 'trading', section('Trading'));
        expect(titles()).toEqual(['Chart cards', 'Trading']);
    });

    it('takes one tab down without taking the others with it', () => {
        // An account being put down: its tab goes, the chart's own stays.
        const { ws, titles } = fakeWorkspace();
        contributeChartSettings(ws, 'chart-cards', section('Chart cards'));
        contributeChartSettings(ws, 'trading', section('Trading'));
        contributeChartSettings(ws, 'trading', null);
        expect(titles()).toEqual(['Chart cards']);
    });

    it('replaces a contributor in place, keeping the order tabs first appeared in', () => {
        // A tab that comes and goes must not reshuffle the ones beside it.
        const { ws, titles } = fakeWorkspace();
        contributeChartSettings(ws, 'chart-cards', section('Chart cards'));
        contributeChartSettings(ws, 'trading', section('Trading'));
        contributeChartSettings(ws, 'chart-cards', section('Chart cards'));
        expect(titles()).toEqual(['Chart cards', 'Trading']);
    });

    it('keeps two charts apart', () => {
        // A replay builds its own workspace; its tabs are not the main chart's.
        const a = fakeWorkspace();
        const b = fakeWorkspace();
        contributeChartSettings(a.ws, 'trading', section('Trading'));
        contributeChartSettings(b.ws, 'chart-cards', section('Chart cards'));
        expect(a.titles()).toEqual(['Trading']);
        expect(b.titles()).toEqual(['Chart cards']);
    });

    it('removing something never contributed leaves the list alone', () => {
        const { ws, titles } = fakeWorkspace();
        contributeChartSettings(ws, 'trading', section('Trading'));
        contributeChartSettings(ws, 'nothing-here', null);
        expect(titles()).toEqual(['Trading']);
    });
});
