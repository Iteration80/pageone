/**
 * Section-level diffing for Stage 7 style directives.
 *
 * Why this exists: refining a style used to be a blind full regeneration. The
 * route handed back `{slug, content, meta}` and nothing else, so the assistant
 * had no view of what actually changed and narrated its own intent instead —
 * "Every other constraint remains exactly as it was" was said on 2026-08-05
 * about a rewrite that touched all six sections, including the deletion of
 * "Show only what a camera can film or a microphone can pick up".
 *
 * Every other stage solves this with a receipt the model must read. This is the
 * style stage's version, kept as pure functions so it can be unit-tested without
 * a route or a model call.
 */

/**
 * Split a directive body into its `## Section` blocks, in order.
 * Front matter is ignored — pass the body, or the whole file and it will be stripped.
 * Returns { sectionName: bodyText }.
 */
function parseStyleSections(content) {
    let text = String(content || '');

    // Strip YAML front matter if a whole file was passed.
    const fm = text.match(/^---\n[\s\S]*?\n---\n?/);
    if (fm) text = text.slice(fm[0].length);

    const sections = {};
    let current = null;
    const buffer = [];

    const flush = () => {
        if (current !== null) sections[current] = buffer.join('\n').trim();
        buffer.length = 0;
    };

    for (const line of text.split('\n')) {
        const heading = line.match(/^##\s+(.+?)\s*$/);
        if (heading) {
            flush();
            current = heading[1].trim();
        } else if (current !== null) {
            buffer.push(line);
        }
    }
    flush();

    return sections;
}

/** Whitespace-insensitive comparison: a reflowed line is not an edit. */
function normalizeForCompare(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Compare two directive versions section by section.
 *
 * Returns {
 *   changed, changedSections, unchangedSections, addedSections, removedSections,
 *   summary  // one line, written for the model to read aloud
 * }
 */
function diffStyleSections(previousContent, nextContent) {
    const before = parseStyleSections(previousContent);
    const after = parseStyleSections(nextContent);

    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);

    const addedSections = afterKeys.filter(k => !(k in before));
    const removedSections = beforeKeys.filter(k => !(k in after));

    const shared = afterKeys.filter(k => k in before);
    const changedSections = shared.filter(k => normalizeForCompare(before[k]) !== normalizeForCompare(after[k]));
    const unchangedSections = shared.filter(k => normalizeForCompare(before[k]) === normalizeForCompare(after[k]));

    const changed = changedSections.length > 0 || addedSections.length > 0 || removedSections.length > 0;

    const parts = [];
    if (changedSections.length) parts.push(`rewrote ${changedSections.join(', ')}`);
    if (addedSections.length) parts.push(`added ${addedSections.join(', ')}`);
    if (removedSections.length) parts.push(`removed ${removedSections.join(', ')}`);
    if (unchangedSections.length) parts.push(`left ${unchangedSections.join(', ')} byte-identical`);

    const summary = changed
        ? `Style refine: ${parts.join('; ')}.`
        : 'Style refine: no section changed.';

    return { changed, changedSections, unchangedSections, addedSections, removedSections, summary };
}

module.exports = { parseStyleSections, diffStyleSections, normalizeForCompare };
