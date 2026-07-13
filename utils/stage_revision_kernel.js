const {
    bracketedBlocks,
    cloneValue,
    labelsEqual,
    normalizePatchLabel,
    parseStructuralPatchOps
} = require('./revision_patch');

function normalizeProtectedBeatEntry(entry = '') {
    if (typeof entry === 'string') {
        const label = entry.trim();
        return label ? { label, description: '', sequenceHint: '', final: false } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const label = String(entry.label || entry.beat_label || entry.beat || '').trim();
    if (!label) return null;
    return {
        label,
        description: String(entry.description || entry.body || '').trim(),
        sequenceHint: String(entry.sequenceHint || entry.sequence_hint || entry.sequence || '').trim(),
        final: Boolean(entry.final || entry.is_final || entry.final_beat || entry.protect_final_position)
    };
}

function normalizeProtectedBeats(input = []) {
    let value = input;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            value = value.split(/\r?\n|,/).map(label => label.trim()).filter(Boolean);
        }
    }
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(value?.protected_beats)
            ? value.protected_beats
            : [];
    const result = [];
    for (const entry of entries) {
        const normalized = normalizeProtectedBeatEntry(entry);
        if (!normalized || result.some(existing => labelsEqual(existing.label, normalized.label))) continue;
        result.push(normalized);
    }
    return result;
}

function protectedBeatFor(label = '', protectedBeats = []) {
    return normalizeProtectedBeats(protectedBeats).find(beat => labelsEqual(beat.label, label)) || null;
}

function existingBeatFor(outline = {}, label = '') {
    const row = flattenOutlineBeats(outline).find(item => labelsEqual(item.label, label));
    if (!row) return null;
    return {
        label: row.label,
        description: String(row.beat?.description || '').trim(),
        sequenceHint: String(row.sequence?.sequence_number_and_title || '').trim(),
        final: row.actKey === 'act_3' && row.sequence === finalOutlineSequence(outline)
    };
}

function fallbackBeatFor(label = '', outline = {}, protectedBeats = []) {
    const protectedBeat = protectedBeatFor(label, protectedBeats);
    const existingBeat = existingBeatFor(outline, label);
    if (!protectedBeat && !existingBeat) return null;
    return {
        ...(existingBeat || {}),
        ...(protectedBeat || {}),
        description: protectedBeat?.description || existingBeat?.description || '',
        sequenceHint: protectedBeat?.sequenceHint || existingBeat?.sequenceHint || '',
        final: Boolean(protectedBeat?.final || existingBeat?.final)
    };
}

function dedupeOperations(operations = []) {
    const seen = new Set();
    const result = [];
    for (const op of operations) {
        const key = [
            op.type || '',
            normalizePatchLabel(op.oldLabel || ''),
            normalizePatchLabel(op.newLabel || ''),
            normalizePatchLabel(op.anchorLabel || ''),
            op.sequenceHint || '',
            op.ordinal ?? '',
            op.finalOnly ? 'final' : '',
            op.finalLast ? 'last' : ''
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(op);
    }
    return result;
}

function ensureOperationScore(op = {}) {
    let score = 0;
    if (op.anchorLabel) score += 20;
    if (op.sequenceHint) score += 8;
    if (op.final) score += 6;
    if (op.finalLast) score += 7;
    if (op.newBody) score += Math.min(10, Math.floor(String(op.newBody).length / 40));
    return score;
}

function mergeEnsureOperation(existing = {}, incoming = {}) {
    const preferred = ensureOperationScore(incoming) > ensureOperationScore(existing)
        ? incoming
        : existing;
    const fallback = preferred === incoming ? existing : incoming;
    return {
        ...fallback,
        ...preferred,
        newBody: preferred.newBody || fallback.newBody || '',
        anchorLabel: preferred.anchorLabel || fallback.anchorLabel || '',
        sequenceHint: preferred.sequenceHint || fallback.sequenceHint || '',
        final: Boolean(preferred.final || fallback.final),
        finalLast: Boolean(preferred.finalLast || fallback.finalLast)
    };
}

function consolidateEnsureOperations(operations = []) {
    const result = [];
    const ensureIndexes = new Map();
    for (const op of operations) {
        if (op.type !== 'ensure_beat_present') {
            result.push(op);
            continue;
        }
        const key = normalizePatchLabel(op.newLabel || '');
        if (!key || !ensureIndexes.has(key)) {
            ensureIndexes.set(key, result.length);
            result.push(op);
            continue;
        }
        const index = ensureIndexes.get(key);
        result[index] = mergeEnsureOperation(result[index], op);
    }
    return result;
}

function normalizeOutlineOperations(operations = []) {
    const replaceOps = operations.filter(op => op.type === 'replace_beat');
    const filtered = operations.filter(op => {
        if (op.type === 'delete_beat') {
            const coveredByReplace = replaceOps.some(replace => (
                labelsEqual(replace.oldLabel || '', op.oldLabel || '')
                && (!op.anchorLabel || !replace.anchorLabel || labelsEqual(replace.anchorLabel, op.anchorLabel))
            ));
            if (coveredByReplace) return false;
        }
        if (op.type === 'ensure_beat_present') {
            const coveredByReplace = replaceOps.some(replace => labelsEqual(replace.newLabel || '', op.newLabel || ''));
            if (coveredByReplace) return false;
        }
        return true;
    });
    return dedupeOperations(consolidateEnsureOperations(filtered));
}

function exactLabelMention(notes = '', label = '') {
    const text = String(notes || '');
    if (new RegExp(`\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i').test(text)) return true;
    return normalizePatchLabel(text).includes(normalizePatchLabel(label));
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bracketedBodyFor(notes = '', label = '') {
    const block = bracketedBlocks(notes).find(item => labelsEqual(item.label, label));
    return block?.body || '';
}

function hasNegatedLabelInstruction(notes = '', label = '', verbs = '') {
    if (!label || !verbs) return false;
    return new RegExp(`\\bdo\\s+not\\s+(?:${verbs})\\s+(?:a\\s+separate\\s+|the\\s+)?\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i')
        .test(String(notes || ''));
}

function isNegatedDeleteInstruction(notes = '', label = '') {
    return hasNegatedLabelInstruction(notes, label, 'delete|remove|cut|omit|drop|strip');
}

function isNegatedAddInstruction(notes = '', label = '') {
    return hasNegatedLabelInstruction(notes, label, 'add|insert|include|restore|bring\\s+back');
}

function inferContextualAnchorForOldLabel(notes = '', oldLabel = '') {
    if (!oldLabel) return '';
    const match = new RegExp(`\\bafter\\s+\\[([^\\]]+)\\][\\s\\S]{0,320}?\\[\\s*${escapeRegExp(oldLabel)}\\s*\\]`, 'i')
        .exec(String(notes || ''));
    return (match?.[1] || '').trim();
}

function flattenOutlineBeats(outline = {}) {
    const rows = [];
    for (const actKey of ['act_1', 'act_2', 'act_3']) {
        const act = Array.isArray(outline?.[actKey]) ? outline[actKey] : [];
        act.forEach((sequence, sequenceIndex) => {
            const beats = Array.isArray(sequence?.beats) ? sequence.beats : [];
            beats.forEach((beat, beatIndex) => {
                rows.push({
                    actKey,
                    sequence,
                    sequenceIndex,
                    beatIndex,
                    label: beat?.beat_label || beat?.beat || '',
                    beat
                });
            });
        });
    }
    return rows;
}

function outlineSequenceScore(sequence = {}, hint = '') {
    const title = String(sequence?.sequence_number_and_title || '');
    const compact = normalizePatchLabel(`${title} ${hint}`);
    const normalizedTitle = normalizePatchLabel(title);
    const normalizedHint = normalizePatchLabel(hint);
    let score = 0;
    const hintSequenceId = String(hint || '').match(/\bsequence\s*([a-h])\b/i)?.[1]?.toLowerCase();
    if (hintSequenceId && new RegExp(`\\bsequence\\s*${hintSequenceId}\\b`, 'i').test(title)) score += 14;
    if (normalizedHint && normalizedTitle && (normalizedTitle.includes(normalizedHint) || normalizedHint.includes(normalizedTitle))) score += 10;
    if (/sequence\s*h|world that remembers|resolution|final/i.test(title)) score += 8;
    if (/sequence\s*e|breach starts|counting down/i.test(title)) score += 6;
    if (/\bfinal\b|\bending\b|\bclosing\b|\baftermath\b/.test(compact)) score += 4;
    return score;
}

function finalOutlineSequence(outline = {}) {
    const act3 = Array.isArray(outline?.act_3) ? outline.act_3 : [];
    return act3.find(sequence => /sequence\s*h|world that remembers|resolution|final/i.test(sequence?.sequence_number_and_title || ''))
        || act3[act3.length - 1]
        || null;
}

function bestSequenceForOperation(outline = {}, op = {}) {
    if (op.final || op.finalLast) {
        return finalOutlineSequence(outline);
    }
    let best = null;
    let bestScore = -1;
    for (const actKey of ['act_1', 'act_2', 'act_3']) {
        const act = Array.isArray(outline?.[actKey]) ? outline[actKey] : [];
        for (const sequence of act) {
            const labels = (sequence.beats || []).map(beat => beat?.beat_label || beat?.beat || '').join(' ');
            let score = outlineSequenceScore(sequence, `${op.anchorLabel || ''} ${op.oldLabel || ''} ${op.newLabel || ''}`);
            if (op.anchorLabel && labelsEqual(labels, op.anchorLabel)) score += 0;
            if (op.anchorLabel && (sequence.beats || []).some(beat => labelsEqual(beat?.beat_label || beat?.beat || '', op.anchorLabel))) score += 20;
            if (op.oldLabel && (sequence.beats || []).some(beat => labelsEqual(beat?.beat_label || beat?.beat || '', op.oldLabel))) score += 8;
            if (op.newLabel && (sequence.beats || []).some(beat => labelsEqual(beat?.beat_label || beat?.beat || '', op.newLabel))) score += 4;
            if (score > bestScore) {
                best = sequence;
                bestScore = score;
            }
        }
    }
    return best;
}

function beatLabel(beat = {}) {
    return beat?.beat_label || beat?.beat || '';
}

function beatIndexAfterAnchor(beats = [], label = '', anchorLabel = '') {
    if (!anchorLabel) return -1;
    const anchorIndex = beats.findIndex(beat => labelsEqual(beatLabel(beat), anchorLabel));
    if (anchorIndex < 0) return -1;
    return beats.findIndex((beat, index) => index > anchorIndex && labelsEqual(beatLabel(beat), label));
}

function nthBeatIndex(beats = [], label = '', ordinal = null) {
    const matches = [];
    beats.forEach((beat, index) => {
        if (labelsEqual(beatLabel(beat), label)) matches.push(index);
    });
    if (!matches.length) return -1;
    if (ordinal === 'last') return matches[matches.length - 1];
    if (Number.isInteger(ordinal)) return matches[ordinal] ?? -1;
    return matches[0];
}

function removeEquivalentBeat(sequence = {}, label = '') {
    if (!Array.isArray(sequence?.beats)) return 0;
    const before = sequence.beats.length;
    sequence.beats = sequence.beats.filter(beat => !labelsEqual(beatLabel(beat), label));
    return before - sequence.beats.length;
}

function buildBeat(label = '', description = '', options = {}) {
    const fallback = fallbackBeatFor(label, options.outline || {}, options.protectedBeats || []);
    return {
        beat_label: label || fallback?.label || 'Inserted Beat',
        description: description || fallback?.description || ''
    };
}

// Stage 2 beats carry Save the Cat annotations (beat_name, emotional_arc,
// pacing_notes, genre_variation_notes) that deterministic edits must not drop:
// backfill them from the beat being replaced when the edit doesn't set them.
const BEAT_ANNOTATION_KEYS = ['beat_name', 'emotional_arc', 'pacing_notes', 'genre_variation_notes'];

function carryBeatAnnotations(target = {}, source = {}) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object') return target;
    for (const key of BEAT_ANNOTATION_KEYS) {
        if (source[key] && !target[key]) target[key] = source[key];
    }
    return target;
}

function insertBeat(sequence = {}, beat = {}, { anchorLabel = '', final = false, protectedBeats = [] } = {}) {
    if (!sequence) return false;
    if (!Array.isArray(sequence.beats)) sequence.beats = [];
    const equivalent = sequence.beats.find(existing => labelsEqual(beatLabel(existing), beat.beat_label));
    if (equivalent) carryBeatAnnotations(beat, equivalent);
    removeEquivalentBeat(sequence, beat.beat_label);

    const protectedOrder = normalizeProtectedBeats(protectedBeats);
    const protectedIndex = protectedOrder.findIndex(item => labelsEqual(item.label, beat.beat_label));
    if (protectedIndex >= 0) {
        const nextProtectedIndex = sequence.beats.findIndex(existing => {
            const index = protectedOrder.findIndex(item => labelsEqual(item.label, beatLabel(existing)));
            return index > protectedIndex;
        });
        if (nextProtectedIndex >= 0) {
            sequence.beats.splice(nextProtectedIndex, 0, beat);
            return true;
        }
    }

    if (final) {
        sequence.beats.push(beat);
        return true;
    }
    if (anchorLabel) {
        const anchorIndex = sequence.beats.findIndex(existing => labelsEqual(beatLabel(existing), anchorLabel));
        if (anchorIndex >= 0) {
            sequence.beats.splice(anchorIndex + 1, 0, beat);
            return true;
        }
    }
    sequence.beats.push(beat);
    return true;
}

function labelHasFinalPlacementInstruction(notes = '', label = '') {
    if (!label) return false;
    const text = String(notes || '');
    const labelPattern = `(?:\\[\\s*${escapeRegExp(label)}\\s*\\]|${escapeRegExp(label)})`;
    return new RegExp(`\\b(final|ending|closing)\\s+(?:ending\\s+)?beats?\\b[\\s\\S]{0,260}?${labelPattern}`, 'i').test(text)
        || new RegExp(`${labelPattern}[\\s\\S]{0,220}?\\b(?:as\\s+)?(?:the\\s+)?(?:final|ending|closing)\\s+(?:ending\\s+)?beats?\\b`, 'i').test(text)
        || new RegExp(`\\bafter\\s+\\[[^\\]]+\\][\\s\\S]{0,260}?${labelPattern}[\\s\\S]{0,180}?\\bfinal\\b`, 'i').test(text);
}

function labelHasFinalLastInstruction(notes = '', label = '') {
    if (!label) return false;
    const text = String(notes || '');
    const labelPattern = `(?:\\[\\s*${escapeRegExp(label)}\\s*\\]|${escapeRegExp(label)})`;
    return new RegExp(`\\bfinal\\s+beat\\s+(?:should|must|needs\\s+to)?\\s*(?:be|remain)?\\s*${labelPattern}`, 'i').test(text)
        || new RegExp(`${labelPattern}[\\s\\S]{0,120}?\\b(?:is|as|remain|stays?|should\\s+be)\\s+(?:the\\s+)?final\\s+beat\\b`, 'i').test(text);
}

function labelHasDeleteOrDoNotAddInstruction(notes = '', label = '') {
    if (!label) return false;
    const text = String(notes || '');
    const labelPattern = `(?:\\[\\s*${escapeRegExp(label)}\\s*\\]|${escapeRegExp(label)})`;
    return new RegExp(`\\b(?:delete|remove|cut|omit|drop|strip)\\s+(?:a\\s+separate\\s+|the\\s+)?${labelPattern}(?=\\W|$)`, 'i').test(text)
        || new RegExp(`\\b(?:do\\s+not|don't)\\s+(?:add|insert|include|restore|bring\\s+back)\\s+(?:a\\s+separate\\s+|the\\s+)?${labelPattern}(?=\\W|$)`, 'i').test(text);
}

function addDeleteOperationsForMentionedOutlineLabels(operations = [], outline = {}, notes = '') {
    const seenLabels = new Set();
    for (const row of flattenOutlineBeats(outline)) {
        const label = row.label || '';
        const key = normalizePatchLabel(label);
        if (!label || seenLabels.has(key)) continue;
        seenLabels.add(key);
        if (!labelHasDeleteOrDoNotAddInstruction(notes, label)) continue;
        if (operations.some(op => op.type === 'delete_beat' && labelsEqual(op.oldLabel || '', label))) continue;
        operations.push({ type: 'delete_beat', oldLabel: label });
    }
}

function inferOrderedListAnchor(notes = '', label = '') {
    const blocks = bracketedBlocks(notes);
    const index = blocks.findIndex(block => labelsEqual(block.label, label));
    if (index <= 0) return '';
    const previous = blocks[index - 1];
    const context = String(notes || '').slice(Math.max(0, previous.index - 220), blocks[index].index);
    if (!/\b(exact\s+order|in\s+order|these\s+(?:two|three|four|final\s+)?beats?|following\s+beats?)\b/i.test(context)) return '';
    return previous.label || '';
}

function buildStage2OutlinePlan(outline = {}, notes = '', options = {}) {
    const operations = [];
    const text = String(notes || '');
    const parsedOps = parseStructuralPatchOps(text);
    const protectedBeats = normalizeProtectedBeats(options.protectedBeats || []);

    for (const op of parsedOps) {
        if (op.type === 'replace') {
            if (isNegatedAddInstruction(text, op.newLabel) || isNegatedDeleteInstruction(text, op.oldLabel)) continue;
            const fallback = fallbackBeatFor(op.newLabel, outline, protectedBeats);
            operations.push({
                type: 'replace_beat',
                oldLabel: op.oldLabel,
                newLabel: op.newLabel,
                newBody: op.newBody || bracketedBodyFor(text, op.newLabel) || fallback?.description || '',
                anchorLabel: op.anchorLabel || inferContextualAnchorForOldLabel(text, op.oldLabel) || '',
                ordinal: op.ordinal
            });
        } else if (op.type === 'delete') {
            if (isNegatedDeleteInstruction(text, op.oldLabel)) continue;
            operations.push({
                type: 'delete_beat',
                oldLabel: op.oldLabel,
                anchorLabel: op.anchorLabel || '',
                ordinal: op.ordinal,
                finalOnly: op.finalOnly
            });
        } else if (op.type === 'insert') {
            if (isNegatedAddInstruction(text, op.newLabel) || /^[.,;:)]/.test(String(op.newBody || '').trim())) continue;
            const fallback = fallbackBeatFor(op.newLabel, outline, protectedBeats);
            operations.push({
                type: 'ensure_beat_present',
                newLabel: op.newLabel,
                newBody: op.newBody || bracketedBodyFor(text, op.newLabel) || fallback?.description || '',
                anchorLabel: op.anchorLabel || (labelHasFinalPlacementInstruction(text, op.newLabel) ? '' : inferOrderedListAnchor(text, op.newLabel)),
                sequenceHint: fallback?.sequenceHint || '',
                final: Boolean(fallback?.final || labelHasFinalPlacementInstruction(text, op.newLabel)),
                finalLast: labelHasFinalLastInstruction(text, op.newLabel)
            });
        }
    }

    for (const beat of protectedBeats) {
        if (!exactLabelMention(text, beat.label)) continue;
        if (!isNegatedDeleteInstruction(text, beat.label)
            && /\b(delete|remove|cut|omit|drop|strip)\s+(?:the\s+)?\[/i.test(text)
            && new RegExp(`\\b(delete|remove|cut|omit|drop|strip)\\s+(?:the\\s+)?\\[\\s*${escapeRegExp(beat.label)}\\s*\\]`, 'i').test(text)) {
            continue;
        }
        if (/\b(preserve|restore|restoring|keep|include|bring back|lost|missing|final ending beats?|ending beats?|should remain|revert|version\s*13)\b/i.test(text)
            || /\[[^\]]+\]\s+.{12,}/.test(text)) {
            operations.push({
                type: 'ensure_beat_present',
                newLabel: beat.label,
                newBody: bracketedBodyFor(text, beat.label) || beat.description,
                anchorLabel: labelHasFinalPlacementInstruction(text, beat.label) ? '' : inferOrderedListAnchor(text, beat.label),
                sequenceHint: beat.sequenceHint,
                final: Boolean(beat.final || labelHasFinalPlacementInstruction(text, beat.label)),
                finalLast: labelHasFinalLastInstruction(text, beat.label)
            });
        }
    }

    addDeleteOperationsForMentionedOutlineLabels(operations, outline, text);

    const normalizedOperations = normalizeOutlineOperations(operations);
    return {
        stageId: 'stage2_outline',
        artifactType: 'outline',
        strategy: 'deterministic_patch',
        operations: normalizedOperations,
        canApplyDirectly: normalizedOperations.length > 0
            && /\b(delete|remove|replace|restore|preserve|keep|missing|lost|duplicate|do not add|bring back|include)\b/i.test(text)
    };
}

function applyStage2Operation(outline = {}, op = {}, options = {}) {
    const sequence = bestSequenceForOperation(outline, op);
    if (!sequence) return { status: 'unmet', reason: 'No matching sequence found.' };
    if (!Array.isArray(sequence.beats)) sequence.beats = [];

    if (op.type === 'delete_beat') {
        const before = sequence.beats.length;
        let index = -1;
        if (op.anchorLabel) index = beatIndexAfterAnchor(sequence.beats, op.oldLabel, op.anchorLabel);
        if (index < 0) index = nthBeatIndex(sequence.beats, op.oldLabel, op.finalOnly ? 'last' : op.ordinal);
        if (index >= 0) sequence.beats.splice(index, 1);
        const changed = sequence.beats.length !== before;
        const stillPresent = flattenOutlineBeats(outline).some(row => labelsEqual(row.label, op.oldLabel));
        return {
            status: changed || !stillPresent ? 'applied' : 'unmet',
            changed,
            reason: changed || !stillPresent ? '' : `Could not delete ${op.oldLabel}.`
        };
    }

    if (op.type === 'replace_beat') {
        const beat = buildBeat(op.newLabel, op.newBody, { ...options, outline });
        let index = -1;
        if (op.anchorLabel) index = beatIndexAfterAnchor(sequence.beats, op.oldLabel, op.anchorLabel);
        if (index < 0) index = nthBeatIndex(sequence.beats, op.oldLabel, op.ordinal);
        if (index >= 0) {
            carryBeatAnnotations(beat, sequence.beats[index]);
            sequence.beats[index] = beat;
            return { status: 'applied', changed: true };
        }
        if (op.anchorLabel && insertBeat(sequence, beat, { anchorLabel: op.anchorLabel, protectedBeats: options.protectedBeats })) {
            return { status: 'applied', changed: true };
        }
        return { status: 'unmet', changed: false, reason: `Could not replace ${op.oldLabel || 'target beat'} with ${op.newLabel}.` };
    }

    if (op.type === 'ensure_beat_present') {
        const beat = buildBeat(op.newLabel, op.newBody, { ...options, outline });
        const previous = JSON.stringify(sequence.beats || []);
        insertBeat(sequence, beat, { anchorLabel: op.anchorLabel, final: op.final || op.finalLast, protectedBeats: options.protectedBeats });
        return { status: 'applied', changed: previous !== JSON.stringify(sequence.beats || []) };
    }

    return { status: 'unmet', changed: false, reason: `Unsupported operation ${op.type || 'unknown'}.` };
}

function verifyStage2Operation(outline = {}, op = {}) {
    const rows = flattenOutlineBeats(outline);
    if (op.type === 'delete_beat') {
        if (op.anchorLabel) {
            const sequence = bestSequenceForOperation(outline, op);
            const beats = sequence?.beats || [];
            return beatIndexAfterAnchor(beats, op.oldLabel, op.anchorLabel) < 0;
        }
        return !rows.some(row => labelsEqual(row.label, op.oldLabel));
    }
    if (op.type === 'replace_beat') {
        if (op.anchorLabel) {
            const sequence = bestSequenceForOperation(outline, op);
            const beats = sequence?.beats || [];
            const anchorIndex = beats.findIndex(beat => labelsEqual(beatLabel(beat), op.anchorLabel));
            return anchorIndex >= 0 && beats[anchorIndex + 1] && labelsEqual(beatLabel(beats[anchorIndex + 1]), op.newLabel);
        }
        return rows.some(row => labelsEqual(row.label, op.newLabel));
    }
    if (op.type === 'ensure_beat_present') {
        const labelRows = rows.filter(row => labelsEqual(row.label, op.newLabel));
        if (!labelRows.length) return false;
        if (op.finalLast) {
            const sequence = finalOutlineSequence(outline);
            return Boolean(sequence?.beats?.length && labelsEqual(beatLabel(sequence.beats[sequence.beats.length - 1]), op.newLabel));
        }
        if (op.final) return labelRows.some(row => row.sequence === finalOutlineSequence(outline));
        return true;
    }
    return false;
}

function receiptForPlan(plan = {}, outline = {}, application = []) {
    const operations = (plan.operations || []).map((op, index) => {
        const verified = verifyStage2Operation(outline, op);
        return {
            type: op.type,
            itemType: 'outline_beat',
            oldLabel: op.oldLabel || '',
            newLabel: op.newLabel || '',
            anchorLabel: op.anchorLabel || '',
            status: verified ? 'verified' : 'unverified',
            reason: application[index]?.reason || ''
        };
    });
    const failures = operations.filter(op => op.status !== 'verified');
    return {
        verified: failures.length === 0,
        operations,
        failures,
        summary: operations.length
            ? `${operations.filter(op => op.status === 'verified').length}/${operations.length} deterministic outline operation(s) verified.`
            : 'No deterministic outline operations detected.',
        planner: 'stage_revision_kernel'
    };
}

function normalizeStageId(stageId) {
    if (stageId === 2 || stageId === '2') return 'stage2_outline';
    return String(stageId || '');
}

function unwrapStageArtifact(stageId, artifact = {}) {
    if ((stageId === 'stage2_outline' || stageId === 2 || stageId === '2') && artifact?.outline && typeof artifact.outline === 'object') {
        return artifact.outline;
    }
    return artifact;
}

const STAGE_REVISION_ADAPTERS = {
    stage2_outline: {
        buildPlan: buildStage2OutlinePlan,
        applyOperation: applyStage2Operation,
        receiptForPlan
    }
};

function applyStageRevisionPlan({ stageId, artifact, notes, protectedBeats }) {
    const normalizedStageId = normalizeStageId(stageId);
    const adapter = STAGE_REVISION_ADAPTERS[normalizedStageId];
    if (!adapter) return null;
    const activeProtectedBeats = normalizeProtectedBeats(
        protectedBeats !== undefined ? protectedBeats : artifact?.protected_beats
    );
    const options = { protectedBeats: activeProtectedBeats };
    const stageArtifact = unwrapStageArtifact(normalizedStageId, artifact || {});
    const before = cloneValue(stageArtifact || {}) || {};
    const after = cloneValue(stageArtifact || {}) || {};
    const plan = adapter.buildPlan(after, notes, options);
    if (!plan.canApplyDirectly || !plan.operations.length) return null;

    const application = plan.operations.map(op => adapter.applyOperation(after, op, options));
    const receipt = adapter.receiptForPlan(plan, after, application, options);
    const changed = JSON.stringify(before) !== JSON.stringify(after);

    return {
        stageId: 'stage2_outline',
        before,
        after,
        changed,
        plan,
        application,
        receipt
    };
}

module.exports = {
    applyStageRevisionPlan,
    buildStage2OutlinePlan,
    normalizeProtectedBeats,
    STAGE_REVISION_ADAPTERS
};
