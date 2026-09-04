// The changelog renderer behind the version number in the status bar. It reads the
// real CHANGELOG.md, so what matters is the shapes that file actually contains:
// wrapped bullets, bold leads, inline breaking-change notes, and code spans.
import { describe, expect, it } from 'vitest';

import { renderChangelog } from '../app/renderer/about/changelogMarkdown';

describe('renderChangelog', () => {
    it('renders the heading levels the format uses', () => {
        expect(renderChangelog('# Changelog')).toBe('<h1>Changelog</h1>');
        expect(renderChangelog('## [v0.6.16]')).toBe('<h2>[v0.6.16]</h2>');
        expect(renderChangelog('### Added')).toBe('<h3>Added</h3>');
    });

    it('joins a bullet that wraps across lines back into one entry', () => {
        const html = renderChangelog([
            '- **A built-in catalog.** The indicators dialog now ships',
            '  more than seventy studies out of the box.',
            '- **A second entry.** Its own bullet.',
        ].join('\n'));

        expect(html).toBe(
            '<ul>'
            + '<li><strong>A built-in catalog.</strong> The indicators dialog now ships '
            + 'more than seventy studies out of the box.</li>'
            + '<li><strong>A second entry.</strong> Its own bullet.</li>'
            + '</ul>',
        );
    });

    it('marks up emphasis and code the way the entries write them', () => {
        expect(renderChangelog('- Gone _(Breaking: use `setMarket` instead)_'))
            .toBe('<ul><li>Gone <em>(Breaking: use <code>setMarket</code> instead)</em></li></ul>');
    });

    it('keeps a link\'s text and drops where it points', () => {
        expect(renderChangelog('See [the guide](https://example.com/guide).'))
            .toBe('<p>See the guide.</p>');
    });

    it('never lets the source text become markup', () => {
        const html = renderChangelog('- A `<script>` tag & an <em>angle bracket</em>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&amp;');
    });

    it('separates sections on blank lines', () => {
        const html = renderChangelog([
            '### Fixed',
            '',
            '- One thing.',
            '',
            'A closing note.',
        ].join('\n'));

        expect(html).toBe('<h3>Fixed</h3><ul><li>One thing.</li></ul><p>A closing note.</p>');
    });
});
