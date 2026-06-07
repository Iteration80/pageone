function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePatchLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(the|a|an)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function labelsEqual(a = '', b = '') {
    const left = normalizePatchLabel(a);
    const right = normalizePatchLabel(b);
    return Boolean(left && right && left === right);
}

function labelTerms(label = '') {
    return normalizePatchLabel(label)
        .split(/\s+/)
        .filter(term => term.length >= 3);
}

function textMentionsLabel(text = '', label = '') {
    const rawLabel = String(label || '').trim();
    if (!rawLabel) return false;
    if (new RegExp(`\\[\\s*${escapeRegExp(rawLabel)}\\s*\\]`, 'i').test(String(text || ''))) return true;
    const normalizedText = normalizePatchLabel(text);
    const normalizedLabel = normalizePatchLabel(label);
    if (normalizedLabel && normalizedText.includes(normalizedLabel)) return true;
    const terms = labelTerms(label);
    if (!terms.length) return false;
    const found = terms.filter(term => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(normalizedText)).length;
    return found >= Math.min(terms.length, 3);
}

function bracketedLabelOccurrences(text = '') {
    const occurrences = [];
    for (const match of String(text || '').matchAll(/\[([^\]]{2,180})\]/g)) {
        occurrences.push({
            label: (match[1] || '').trim(),
            index: match.index || 0,
            endIndex: (match.index || 0) + match[0].length
        });
    }
    return occurrences;
}

function bodyAfterLabel(text = '', occurrence = {}) {
    const rest = String(text || '').slice(occurrence.endIndex || 0);
    const stopMatch = rest.match(/\n\s*\n\s*(?=(?:\d+[.)]\s+|[-*]\s+|#{1,6}\s+|\[[^\]]{2,180}\]\s+))/);
    const rawBody = stopMatch ? rest.slice(0, stopMatch.index) : rest;
    return rawBody
        .replace(/^\s*[:\-\u2013\u2014]\s*/, '')
        .trim();
}

function bracketedBlocks(text = '') {
    return bracketedLabelOccurrences(text)
        .map(occurrence => ({
            ...occurrence,
            body: bodyAfterLabel(text, occurrence)
        }))
        .filter(block => block.label && block.body.length >= 12);
}

function ordinalValue(value = '') {
    const text = String(value || '').toLowerCase();
    if (text === 'first') return 0;
    if (text === 'second') return 1;
    if (text === 'third') return 2;
    if (text === 'fourth') return 3;
    if (text === 'last') return 'last';
    return null;
}

function inferOldLabelBefore(text = '', replaceIndex = 0, anchorLabel = '') {
    const before = bracketedLabelOccurrences(String(text || '').slice(0, replaceIndex));
    for (const occurrence of before.reverse()) {
        if (anchorLabel && labelsEqual(occurrence.label, anchorLabel)) continue;
        return occurrence.label;
    }
    return '';
}

function inferReplacementBlockAfter(text = '', replaceIndex = 0, anchorLabel = '') {
    return bracketedBlocks(text)
        .filter(block => block.index > replaceIndex)
        .find(block => !anchorLabel || !labelsEqual(block.label, anchorLabel)) || null;
}

function inferDeleteReplaceContextBefore(text = '', replaceIndex = 0) {
    const before = String(text || '').slice(Math.max(0, replaceIndex - 650), replaceIndex);
    const matches = Array.from(before.matchAll(/\b(?:delete|remove|cut|omit|drop)\s+(?:the\s+)?(?:(first|second|third|fourth|last)\s+)?\[([^\]]+)\](?:\s*,?\s*after\s+\[([^\]]+)\])?/gi));
    const match = matches[matches.length - 1];
    if (!match) return null;
    return {
        oldLabel: (match[2] || '').trim(),
        anchorLabel: (match[3] || '').trim(),
        ordinal: ordinalValue(match[1] || '')
    };
}

function parseStructuralPatchOps(notes = '') {
    const text = String(notes || '');
    const ops = [];
    const occurrences = bracketedLabelOccurrences(text);
    const blocks = bracketedBlocks(text);
    const replaceMatches = Array.from(text.matchAll(/\breplace\b/gi));
    const replacementLabels = new Set();

    for (const match of replaceMatches) {
        const replaceIndex = match.index || 0;
        const span = text.slice(replaceIndex, replaceIndex + 900);
        const deleteReplaceContext = inferDeleteReplaceContextBefore(text, replaceIndex);
        const anchorLabel = (span.match(/\bafter\s+\[([^\]]+)\]/i)?.[1] || deleteReplaceContext?.anchorLabel || '').trim();
        const ordinal = ordinalValue(span.match(/\b(first|second|third|fourth|last)\b/i)?.[1] || '') ?? deleteReplaceContext?.ordinal ?? null;
        const explicitOld = (span.match(/\breplace\s+(?:the\s+)?(?:first|second|third|fourth|last\s+)?\[([^\]]+)\]/i)?.[1] || '').trim();
        const explicitNew = (span.match(/\bwith\s+(?:the\s+)?\[([^\]]+)\]/i)?.[1] || '').trim();
        const replacementBlock = explicitNew
            ? blocks.find(block => labelsEqual(block.label, explicitNew)) || null
            : inferReplacementBlockAfter(text, replaceIndex, anchorLabel);
        const newLabel = explicitNew || replacementBlock?.label || '';
        const oldLabel = explicitOld || deleteReplaceContext?.oldLabel || inferOldLabelBefore(text, replaceIndex, anchorLabel);

        if (!oldLabel && !newLabel) continue;
        if (newLabel) replacementLabels.add(normalizePatchLabel(newLabel));
        ops.push({
            type: 'replace',
            oldLabel,
            newLabel,
            newBody: replacementBlock?.body || '',
            anchorLabel,
            ordinal
        });
    }

    for (const block of blocks) {
        const normalized = normalizePatchLabel(block.label);
        if (replacementLabels.has(normalized)) continue;
        const before = text.slice(Math.max(0, block.index - 220), block.index);
        const after = text.slice(block.endIndex, block.endIndex + 260);
        const windowText = `${before} ${after}`;
        const hasAddIntent = /\b(add|insert|restore|include|bring back)\b/i.test(before)
            && !/\breplace\b/i.test(before.slice(-80));
        if (!hasAddIntent) continue;
        const anchorLabel = (before.match(/\bafter\s+\[([^\]]+)\][^\[]*$/i)?.[1] || '').trim();
        ops.push({
            type: 'insert',
            newLabel: block.label,
            newBody: block.body,
            anchorLabel
        });
    }

    for (const occurrence of occurrences) {
        const before = text.slice(Math.max(0, occurrence.index - 180), occurrence.index);
        const after = text.slice(occurrence.endIndex, occurrence.endIndex + 280);
        const windowText = `${before} ${after}`;
        if (!/\b(delete|remove|cut|omit|drop|strip)\b/i.test(windowText)) continue;
        if (/\bafter\s*$/i.test(before)) continue;
        if (/\breplace\b/i.test(windowText) && replacementLabels.has(normalizePatchLabel(occurrence.label))) continue;
        ops.push({
            type: 'delete',
            oldLabel: occurrence.label,
            anchorLabel: (after.match(/\bafter\s+\[([^\]]+)\]/i)?.[1] || '').trim(),
            ordinal: ordinalValue(windowText.match(/\b(first|second|third|fourth|last)\b/i)?.[1] || ''),
            finalOnly: /\b(last|final)\s+(?:paragraph|beat|section|entry)\b/i.test(windowText)
        });
    }

    return ops;
}

function itemLabel(item = {}, getLabel) {
    return String(getLabel ? getLabel(item) : item.label || '').trim();
}

function nthMatchingIndex(items = [], label = '', ordinal = null, getLabel) {
    const matches = [];
    items.forEach((item, index) => {
        if (labelsEqual(itemLabel(item, getLabel), label)) matches.push(index);
    });
    if (!matches.length) return -1;
    if (ordinal === 'last') return matches[matches.length - 1];
    if (Number.isInteger(ordinal) && ordinal >= 0) return matches[ordinal] ?? -1;
    return matches[0];
}

function buildReplacementItem(originalItem = {}, op = {}, options = {}) {
    const replacement = cloneValue(originalItem) || {};
    if (options.setLabel) options.setLabel(replacement, op.newLabel);
    else replacement.label = op.newLabel;
    if (op.newBody) {
        if (options.setBody) options.setBody(replacement, op.newBody);
        else replacement.body = op.newBody;
    }
    if (options.onBuildReplacement) {
        return options.onBuildReplacement(replacement, originalItem, op);
    }
    return replacement;
}

function applyStructuralPatchToItems(items = [], notes = '', options = {}) {
    const ops = Array.isArray(notes) ? notes : parseStructuralPatchOps(notes);
    let next = cloneValue(Array.isArray(items) ? items : []) || [];
    let appliedCount = 0;
    const unmet = [];
    const getLabel = options.getLabel || (item => item.label);

    for (const op of ops) {
        if (op.type === 'delete') {
            const beforeLength = next.length;
            if (op.anchorLabel) {
                const anchorIndex = next.findIndex(item => labelsEqual(itemLabel(item, getLabel), op.anchorLabel));
                const deleteIndex = anchorIndex >= 0
                    ? next.findIndex((item, index) => index > anchorIndex && labelsEqual(itemLabel(item, getLabel), op.oldLabel))
                    : -1;
                if (deleteIndex >= 0) next.splice(deleteIndex, 1);
            } else if (op.finalOnly) {
                const index = nthMatchingIndex(next, op.oldLabel, 'last', getLabel);
                if (index >= 0) next.splice(index, 1);
            } else if (op.ordinal !== null && op.ordinal !== undefined) {
                const index = nthMatchingIndex(next, op.oldLabel, op.ordinal, getLabel);
                if (index >= 0) next.splice(index, 1);
            } else {
                next = next.filter(item => !labelsEqual(itemLabel(item, getLabel), op.oldLabel));
            }
            if (next.length !== beforeLength) appliedCount += 1;
            else unmet.push(op);
            continue;
        }

        if (op.type === 'insert') {
            if (!op.newLabel) {
                unmet.push(op);
                continue;
            }
            const alreadyPresent = next.some(item => labelsEqual(itemLabel(item, getLabel), op.newLabel));
            if (alreadyPresent) continue;
            const newItem = options.buildNewItem
                ? options.buildNewItem(op)
                : buildReplacementItem({}, op, options);
            let insertIndex = next.length;
            if (op.anchorLabel) {
                const anchorIndex = next.findIndex(item => labelsEqual(itemLabel(item, getLabel), op.anchorLabel));
                if (anchorIndex >= 0) insertIndex = anchorIndex + 1;
            }
            next.splice(insertIndex, 0, newItem);
            appliedCount += 1;
            continue;
        }

        if (op.type === 'replace') {
            if (!op.newLabel) {
                unmet.push(op);
                continue;
            }

            let targetIndex = -1;
            let anchorIndex = -1;
            if (op.anchorLabel) {
                anchorIndex = next.findIndex(item => labelsEqual(itemLabel(item, getLabel), op.anchorLabel));
                if (anchorIndex >= 0 && op.oldLabel) {
                    targetIndex = next.findIndex((item, index) => (
                        index > anchorIndex && labelsEqual(itemLabel(item, getLabel), op.oldLabel)
                    ));
                }
            }
            if (targetIndex < 0 && op.oldLabel && !op.anchorLabel) {
                targetIndex = nthMatchingIndex(next, op.oldLabel, op.ordinal, getLabel);
            }

            if (targetIndex >= 0) {
                next[targetIndex] = buildReplacementItem(next[targetIndex], op, options);
                appliedCount += 1;
            } else if (anchorIndex >= 0) {
                const newItem = options.buildNewItem
                    ? options.buildNewItem(op)
                    : buildReplacementItem({}, op, options);
                next.splice(anchorIndex + 1, 0, newItem);
                appliedCount += 1;
            } else {
                unmet.push(op);
            }
        }
    }

    return {
        items: next,
        appliedCount,
        operations: ops,
        unmet
    };
}

function mentionedItemLabels(items = [], notes = '', getLabel = item => item.label) {
    return items
        .map(item => itemLabel(item, getLabel))
        .filter(label => label && textMentionsLabel(notes, label));
}

function mergeSurgicalLabeledItems(currentItems = [], revisedItems = [], notes = '', options = {}) {
    const getLabel = options.getLabel || (item => item.label);
    const current = cloneValue(Array.isArray(currentItems) ? currentItems : []) || [];
    const revised = cloneValue(Array.isArray(revisedItems) ? revisedItems : []) || [];
    const ops = parseStructuralPatchOps(notes);
    const opLabels = new Set(ops.flatMap(op => [op.oldLabel, op.newLabel].filter(Boolean)).map(normalizePatchLabel));
    const explicitTargets = Array.isArray(options.targetLabels) && options.targetLabels.length
        ? new Set(options.targetLabels.map(normalizePatchLabel).filter(Boolean))
        : null;
    const mentionedLabels = explicitTargets
        || new Set(mentionedItemLabels(current.concat(revised), notes, getLabel).map(normalizePatchLabel));
    const targetLabels = new Set([...opLabels, ...mentionedLabels]);

    const revisedByLabel = new Map();
    revised.forEach(item => {
        const label = normalizePatchLabel(itemLabel(item, getLabel));
        if (label) revisedByLabel.set(label, item);
    });

    let changed = 0;
    let merged = current.map(item => {
        const label = normalizePatchLabel(itemLabel(item, getLabel));
        if (!targetLabels.has(label)) return item;
        const replacement = revisedByLabel.get(label);
        if (!replacement) return item;
        changed += 1;
        return replacement;
    });

    for (const item of revised) {
        const label = normalizePatchLabel(itemLabel(item, getLabel));
        if (!label || merged.some(existing => normalizePatchLabel(itemLabel(existing, getLabel)) === label)) continue;
        if (targetLabels.has(label) || /\b(add|insert|new|restore|include|bring back)\b/i.test(notes)) {
            merged.push(item);
            changed += 1;
        }
    }

    const patched = applyStructuralPatchToItems(merged, ops, options);
    merged = patched.items;
    changed += patched.appliedCount;

    return {
        items: merged,
        changed,
        operations: ops,
        targetLabels: Array.from(targetLabels)
    };
}

function parseSequenceTargets(notes = '') {
    const targets = new Set();
    for (const match of String(notes || '').matchAll(/\bsequence[s]?\s+([a-h]|[1-8])\b/gi)) {
        const raw = match[1].toUpperCase();
        const numeric = raw.charCodeAt(0) >= 65 ? raw.charCodeAt(0) - 64 : Number(raw);
        if (Number.isFinite(numeric)) targets.add(numeric);
    }
    return targets;
}

function isBroadRevisionIntent(notes = '') {
    return /\b(all|every|entire|whole|full|global|throughout|across the board|from top to bottom)\b/i.test(String(notes || ''));
}

module.exports = {
    applyStructuralPatchToItems,
    bracketedBlocks,
    bracketedLabelOccurrences,
    cloneValue,
    isBroadRevisionIntent,
    labelsEqual,
    mergeSurgicalLabeledItems,
    normalizePatchLabel,
    parseSequenceTargets,
    parseStructuralPatchOps,
    textMentionsLabel
};
