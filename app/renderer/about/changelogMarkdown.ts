/**
 * The slice of Markdown the changelog format actually uses — headings, bullets,
 * bold, emphasis, inline code — turned into HTML.
 *
 * Deliberately not a Markdown library: CHANGELOG.md is a file we write, to a
 * format AGENTS.md pins down, and the whole of it is covered below. DOM-free so
 * it can be tested as what it is, a string function.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** The output is assigned as innerHTML, so the source text is neutralised first. */
function escape(text: string): string {
    return text.replace(/[&<>]/g, (c) => ESCAPES[c]!);
}

/**
 * The inline run of one line. Links are reduced to their text: nothing in a
 * desktop app should navigate the window away from the app.
 */
function inline(text: string): string {
    return escape(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>');
}

/**
 * Render a changelog to HTML.
 *
 * Wrapped lines matter here: entries are written to a column width, so a bullet
 * or a paragraph continues on the next line and has to be joined back up rather
 * than broken into two.
 */
export function renderChangelog(markdown: string): string {
    const out: string[] = [];
    let list: string[] = [];
    let para: string[] = [];

    const flushList = (): void => {
        if (list.length === 0) return;
        out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
        list = [];
    };
    const flushPara = (): void => {
        if (para.length === 0) return;
        out.push(`<p>${inline(para.join(' '))}</p>`);
        para = [];
    };
    const flushAll = (): void => { flushList(); flushPara(); };

    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (line.trim() === '') { flushAll(); continue; }

        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
            flushAll();
            const level = heading[1]!.length;
            out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
            continue;
        }

        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        if (bullet) {
            flushPara();
            list.push(bullet[1]!);
            continue;
        }

        // An indented line continues the bullet above it; anything else is prose.
        if (list.length > 0 && /^\s+\S/.test(line)) {
            list[list.length - 1] += ` ${line.trim()}`;
            continue;
        }
        flushList();
        para.push(line.trim());
    }

    flushAll();
    return out.join('');
}
