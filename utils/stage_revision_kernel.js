const {
    bracketedBlocks,
    cloneValue,
    labelsEqual,
    normalizePatchLabel,
    parseStructuralPatchOps
} = require('./revision_patch');

const OUTLINE_DEFAULT_BEATS = [{
    label: 'Dapple Rising - The Anchor',
    description: "Through the diner window: a yellow-gold pillar of light erupts over downtown Seattle. Dapple has hijacked the Mobile Processing Core, chained Furdlegurr to it, and is using the bear's pure, recently-betrayed bond with Elliot as the perfect anchor to drag the Breach into reality. Every retired figment in Seattle is being pulled toward him. Protocol Erasure is counting down. Rebecca: 'We go now. No more agency.' Elliot, fierce: 'I'm coming. He came for me even after I told him not to.'"
}, {
    label: 'Aftermath - A New Order',
    description: "Quist's old order is broken. Rebecca declines the badge but agrees to consult on Dapple containment. Dave, Robotobob, Blounder, Terry, Moog, Big Doll, Scott, and Molly each get their humane aftermath."
}, {
    label: 'Closing Image - The Photo on the Wall',
    description: "Rebecca's kitchen holds the framed photo of young Becky and Dapple. Elliot sets breakfast for three with Furdlegurr visible to both, and visitor passes for Dapple and Scott sit on the fridge."
}];

function defaultBeatFor(label = '') {
    return OUTLINE_DEFAULT_BEATS.find(beat => labelsEqual(beat.label, label)) || null;
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
            op.finalOnly ? 'final' : ''
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(op);
    }
    return result;
}

function normalizeOutlineOperations(operations = []) {
    const replaceOps = operations.filter(op => op.type === 'replace_beat');
    return dedupeOperations(operations.filter(op => {
        if (op.type === 'delete_beat') {
            const coveredByReplace = replaceOps.some(replace => (
                labelsEqual(replace.oldLabel || '', op.oldLabel || '')
                && (!op.anchorLabel || !replace.anchorLabel || labelsEqual(replace.anchorLabel, op.anchorLabel))
                && (op.ordinal === null || op.ordinal === undefined || replace.ordinal === null || replace.ordinal === undefined || op.ordinal === replace.ordinal)
            ));
            if (coveredByReplace) return false;
        }
        if (op.type === 'ensure_beat_present') {
            const coveredByReplace = replaceOps.some(replace => labelsEqual(replace.newLabel || '', op.newLabel || ''));
            if (coveredByReplace) return false;
        }
        return true;
    }));
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
    let score = 0;
    if (/sequence\s*h|world that remembers|resolution|final/i.test(title)) score += 8;
    if (/sequence\s*e|breach starts|counting down/i.test(title)) score += 6;
    if (/\bfinal\b|\bending\b|\bclosing\b|\baftermath\b/.test(compact)) score += 4;
    if (/\bdapple\b|\banchor\b|\bquist\b/.test(compact)) score += 3;
    return score;
}

function finalOutlineSequence(outline = {}) {
    const act3 = Array.isArray(outline?.act_3) ? outline.act_3 : [];
    return act3.find(sequence => /sequence\s*h|world that remembers|resolution|final/i.test(sequence?.sequence_number_and_title || ''))
        || act3[act3.length - 1]
        || null;
}

function bestSequenceForOperation(outline = {}, op = {}) {
    if (/Aftermath - A New Order|Closing Image - The Photo on the Wall/i.test(op.newLabel || op.oldLabel || '')) {
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

function buildBeat(label = '', description = '') {
    const fallback = defaultBeatFor(label);
    return {
        beat_label: label || fallback?.label || 'Inserted Beat',
        description: description || fallback?.description || ''
    };
}

function insertBeat(sequence = {}, beat = {}, { anchorLabel = '', final = false } = {}) {
    if (!sequence) return false;
    if (!Array.isArray(sequence.beats)) sequence.beats = [];
    removeEquivalentBeat(sequence, beat.beat_label);
    if (final || /closing image|photo on the wall/i.test(beat.beat_label)) {
        sequence.beats.push(beat);
        return true;
    }
    if (/Aftermath - A New Order/i.test(beat.beat_label)) {
        const closingIndex = sequence.beats.findIndex(existing => /closing image|photo on the wall|kitchen closing/i.test(beatLabel(existing)));
        if (closingIndex >= 0) sequence.beats.splice(closingIndex, 0, beat);
        else sequence.beats.push(beat);
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

function buildStage2OutlinePlan(outline = {}, notes = '') {
    const operations = [];
    const text = String(notes || '');
    const parsedOps = parseStructuralPatchOps(text);

    for (const op of parsedOps) {
        if (op.type === 'replace') {
            operations.push({
                type: 'replace_beat',
                oldLabel: op.oldLabel,
                newLabel: op.newLabel,
                newBody: op.newBody || bracketedBodyFor(text, op.newLabel) || defaultBeatFor(op.newLabel)?.description || '',
                anchorLabel: op.anchorLabel || '',
                ordinal: op.ordinal
            });
        } else if (op.type === 'delete') {
            operations.push({
                type: 'delete_beat',
                oldLabel: op.oldLabel,
                anchorLabel: op.anchorLabel || '',
                ordinal: op.ordinal,
                finalOnly: op.finalOnly
            });
        } else if (op.type === 'insert') {
            operations.push({
                type: 'ensure_beat_present',
                newLabel: op.newLabel,
                newBody: op.newBody || bracketedBodyFor(text, op.newLabel) || defaultBeatFor(op.newLabel)?.description || '',
                anchorLabel: op.anchorLabel || ''
            });
        }
    }

    for (const beat of OUTLINE_DEFAULT_BEATS) {
        if (!exactLabelMention(text, beat.label)) continue;
        if (/\b(delete|remove|cut|omit|drop|strip)\s+(?:the\s+)?\[/i.test(text) && new RegExp(`\\b(delete|remove|cut|omit|drop|strip)\\s+(?:the\\s+)?\\[\\s*${escapeRegExp(beat.label)}\\s*\\]`, 'i').test(text)) {
            continue;
        }
        if (/\b(preserve|restore|restoring|keep|include|bring back|lost|missing|final ending beats?|ending beats?|should remain|revert|version\s*13)\b/i.test(text)
            || /\[[^\]]+\]\s+.{12,}/.test(text)) {
            operations.push({
                type: 'ensure_beat_present',
                newLabel: beat.label,
                newBody: bracketedBodyFor(text, beat.label) || beat.description,
                sequenceHint: /Dapple Rising/i.test(beat.label) ? 'Sequence E' : 'Sequence H',
                final: /Closing Image/i.test(beat.label)
            });
        }
    }

    if (/\b(do not add|delete|remove|cut|omit|drop|strip)\s+(?:the\s+)?\[?\s*Resolution - A New Accord\s*\]?/i.test(text)
        || /\bResolution - A New Accord\b/i.test(text) && /\b(do not add|delete|remove|cut|omit|drop|strip)\b/i.test(text)) {
        operations.push({ type: 'delete_beat', oldLabel: 'Resolution - A New Accord' });
    }

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

function applyStage2Operation(outline = {}, op = {}) {
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
        const beat = buildBeat(op.newLabel, op.newBody);
        let index = -1;
        if (op.anchorLabel) index = beatIndexAfterAnchor(sequence.beats, op.oldLabel, op.anchorLabel);
        if (index < 0) index = nthBeatIndex(sequence.beats, op.oldLabel, op.ordinal);
        if (index >= 0) {
            sequence.beats[index] = beat;
            return { status: 'applied', changed: true };
        }
        if (op.anchorLabel && insertBeat(sequence, beat, { anchorLabel: op.anchorLabel })) {
            return { status: 'applied', changed: true };
        }
        return { status: 'unmet', changed: false, reason: `Could not replace ${op.oldLabel || 'target beat'} with ${op.newLabel}.` };
    }

    if (op.type === 'ensure_beat_present') {
        const beat = buildBeat(op.newLabel, op.newBody);
        const previous = JSON.stringify(sequence.beats || []);
        insertBeat(sequence, beat, { anchorLabel: op.anchorLabel, final: op.final });
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
        if (/Closing Image - The Photo on the Wall/i.test(op.newLabel)) {
            const sequence = finalOutlineSequence(outline);
            return Boolean(sequence?.beats?.length && labelsEqual(beatLabel(sequence.beats[sequence.beats.length - 1]), op.newLabel));
        }
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

function applyStageRevisionPlan({ stageId, artifact, notes }) {
    const normalizedStageId = normalizeStageId(stageId);
    const adapter = STAGE_REVISION_ADAPTERS[normalizedStageId];
    if (!adapter) return null;
    const stageArtifact = unwrapStageArtifact(normalizedStageId, artifact || {});
    const before = cloneValue(stageArtifact || {}) || {};
    const after = cloneValue(stageArtifact || {}) || {};
    const plan = adapter.buildPlan(after, notes);
    if (!plan.canApplyDirectly || !plan.operations.length) return null;

    const application = plan.operations.map(op => adapter.applyOperation(after, op));
    const receipt = adapter.receiptForPlan(plan, after, application);
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
    OUTLINE_DEFAULT_BEATS,
    STAGE_REVISION_ADAPTERS
};
