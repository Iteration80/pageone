const crypto = require('crypto');
const {
    labelsEqual,
    normalizePatchLabel,
    notesRequestRemoval,
    parseStructuralPatchOps
} = require('./revision_patch');

function dataHash(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(value ?? null))
        .digest('hex');
}

function textOf(value = '') {
    return String(value || '').trim();
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function flattenOutlineBeats(outlineInput = {}) {
    const outline = outlineInput?.outline || outlineInput || {};
    const rows = [];
    for (const actKey of ['act_1', 'act_2', 'act_3']) {
        const act = Array.isArray(outline[actKey]) ? outline[actKey] : [];
        act.forEach((sequence, sequenceIndex) => {
            const beats = Array.isArray(sequence?.beats) ? sequence.beats : [];
            beats.forEach((beat, beatIndex) => {
                rows.push({
                    actKey,
                    sequenceIndex,
                    beatIndex,
                    sequenceTitle: sequence?.sequence_number_and_title || '',
                    label: beat?.beat_label || beat?.beat || '',
                    text: [beat?.beat_label || beat?.beat || '', beat?.description || ''].join(' '),
                    value: beat
                });
            });
        });
    }
    return rows;
}

function countLabel(rows = [], label = '') {
    return rows.filter(row => labelsEqual(row.label, label)).length;
}

function hasAdjacentLabel(rows = [], anchorLabel = '', nextLabel = '') {
    return rows.some((row, index) => {
        if (!labelsEqual(row.label, anchorLabel)) return false;
        return Boolean(rows[index + 1] && labelsEqual(rows[index + 1].label, nextLabel));
    });
}

function hasAnchorFollowedByDifferentLabel(rows = [], anchorLabel = '', excludedLabel = '') {
    const anchorIndexes = rows
        .map((row, index) => (labelsEqual(row.label, anchorLabel) ? index : -1))
        .filter(index => index >= 0);
    return anchorIndexes.length > 0 && anchorIndexes.every(index => {
        const next = rows[index + 1];
        return !next || !labelsEqual(next.label, excludedLabel);
    });
}

function verifyOutlineOperation(op = {}, beforeRows = [], afterRows = []) {
    if (!op?.type) return false;
    if (op.type === 'replace') {
        if (op.anchorLabel) {
            return hasAdjacentLabel(afterRows, op.anchorLabel, op.newLabel);
        }
        return countLabel(afterRows, op.newLabel) > countLabel(beforeRows, op.newLabel)
            || countLabel(afterRows, op.oldLabel) < countLabel(beforeRows, op.oldLabel);
    }
    if (op.type === 'delete') {
        if (op.anchorLabel) {
            return hasAnchorFollowedByDifferentLabel(afterRows, op.anchorLabel, op.oldLabel);
        }
        return countLabel(afterRows, op.oldLabel) === 0
            || countLabel(afterRows, op.oldLabel) < countLabel(beforeRows, op.oldLabel);
    }
    if (op.type === 'insert') {
        if (op.verifyMode === 'present' || op.presenceOnly) {
            return countLabel(afterRows, op.newLabel) > 0;
        }
        if (op.anchorLabel) {
            return hasAdjacentLabel(afterRows, op.anchorLabel, op.newLabel);
        }
        return countLabel(afterRows, op.newLabel) > countLabel(beforeRows, op.newLabel);
    }
    return false;
}

function outlineRevisionAdapter({ before, after, notes = '', structuralPatch = null }) {
    const beforeRows = flattenOutlineBeats(before);
    const afterRows = flattenOutlineBeats(after);
    const patchOps = structuralPatch?.operations?.length
        ? structuralPatch.operations
        : parseStructuralPatchOps(notes);
    const operations = patchOps.map(op => {
        const verified = verifyOutlineOperation(op, beforeRows, afterRows);
        return {
            type: op.type,
            oldLabel: op.oldLabel || '',
            newLabel: op.newLabel || '',
            anchorLabel: op.anchorLabel || '',
            status: verified ? 'verified' : 'unverified'
        };
    });
    const changedLabels = afterRows
        .filter((row, index) => JSON.stringify(row.value || {}) !== JSON.stringify(beforeRows[index]?.value || null))
        .slice(0, 12)
        .map(row => row.label)
        .filter(Boolean);
    const failures = operations.filter(op => op.status !== 'verified');
    return {
        operations,
        failures,
        summary: operations.length
            ? `${operations.filter(op => op.status === 'verified').length}/${operations.length} structural outline operation(s) verified.`
            : (changedLabels.length ? `Outline changed: ${changedLabels.join(', ')}.` : 'No structural outline operations detected.')
    };
}

function namedItemDiffAdapter({
    before = [],
    after = [],
    labelKey = 'name',
    itemType = 'item',
    notes = '',
    guardDeletions = false,
    massShrinkRatio = 0.7,
    massShrinkMinCount = 5
}) {
    const beforeItems = Array.isArray(before) ? before : [];
    const afterItems = Array.isArray(after) ? after : [];
    const beforeMap = new Map(beforeItems.map(item => [normalizePatchLabel(item?.[labelKey] || ''), item]));
    const afterMap = new Map(afterItems.map(item => [normalizePatchLabel(item?.[labelKey] || ''), item]));
    const operations = [];

    for (const [key, afterItem] of afterMap.entries()) {
        const label = afterItem?.[labelKey] || key;
        if (!beforeMap.has(key)) {
            operations.push({ type: 'insert', itemType, label, status: 'verified' });
        } else if (JSON.stringify(beforeMap.get(key)) !== JSON.stringify(afterItem)) {
            operations.push({ type: 'update', itemType, label, status: 'verified' });
        }
    }
    for (const [key, beforeItem] of beforeMap.entries()) {
        if (!afterMap.has(key)) {
            const label = beforeItem?.[labelKey] || key;
            // A deletion is only "verified" when the revision brief explicitly asked
            // for it (or this adapter doesn't guard deletions). Unrequested deletions
            // are failures: a model returning a partial list must never silently
            // shrink the saved artifact (2026-07-12: 29 of 30 characters wiped).
            const requested = !guardDeletions || notesRequestRemoval(notes, label);
            operations.push({ type: 'delete', itemType, label, status: requested ? 'verified' : 'unverified' });
        }
    }

    const failures = operations.filter(op => op.status !== 'verified');
    if (
        guardDeletions
        && beforeItems.length >= massShrinkMinCount
        && afterItems.length < beforeItems.length * massShrinkRatio
    ) {
        failures.push({
            type: 'mass_shrink',
            itemType,
            label: `${itemType} count dropped ${beforeItems.length} → ${afterItems.length}`,
            status: 'unverified'
        });
    }

    return {
        operations: operations.slice(0, 24),
        failures: failures.slice(0, 12),
        summary: operations.length
            ? `${operations.length - failures.filter(f => f.type !== 'mass_shrink').length}/${operations.length} ${itemType} operation(s) verified.`
            : `No ${itemType} operations detected.`
    };
}

function characterRevisionAdapter({ before, after, notes = '' }) {
    return namedItemDiffAdapter({ before, after, labelKey: 'name', itemType: 'character', notes, guardDeletions: true });
}

function flattenStage4Beats(stage4 = {}) {
    return (Array.isArray(stage4?.hybrid_beat_sheet) ? stage4.hybrid_beat_sheet : [])
        .flatMap(sequence => (Array.isArray(sequence?.beats) ? sequence.beats : [])
            .map(beat => ({
                ...beat,
                _label: `${sequence.sequence_number || ''}:${beat.beat_name || ''}`
            })));
}

function stage4RevisionAdapter({ before, after }) {
    return namedItemDiffAdapter({
        before: flattenStage4Beats(before),
        after: flattenStage4Beats(after),
        labelKey: '_label',
        itemType: 'stage4_beat'
    });
}

function treatmentRevisionAdapter({ before = {}, after = {} }) {
    const fields = ['title_logline_characters', 'act_1', 'act_2a', 'act_2b', 'act_3'];
    const operations = fields
        .filter(field => textOf(before?.[field]) !== textOf(after?.[field]))
        .map(field => ({ type: 'update', itemType: 'treatment_section', label: field, status: 'verified' }));
    return {
        operations,
        failures: [],
        summary: operations.length
            ? `${operations.length} treatment section(s) verified.`
            : 'No treatment section changes detected.'
    };
}

function flattenScenes(blueprint = []) {
    return (Array.isArray(blueprint) ? blueprint : [])
        .flatMap(sequence => (Array.isArray(sequence?.scenes) ? sequence.scenes : [])
            .map(scene => ({
                ...scene,
                _label: `Scene ${scene.scene_number || ''}: ${scene.scene_heading || ''}`
            })));
}

function sceneBlueprintRevisionAdapter({ before, after }) {
    return namedItemDiffAdapter({
        before: flattenScenes(before),
        after: flattenScenes(after),
        labelKey: '_label',
        itemType: 'scene'
    });
}

function createRevisionTransaction({ stageId, before, after, notes = '', structuralPatch = null, adapter = null }) {
    const beforeSnapshot = cloneValue(before);
    const afterSnapshot = cloneValue(after);
    const beforeHash = dataHash(beforeSnapshot);
    const afterHash = dataHash(afterSnapshot);
    const diffChanged = beforeHash !== afterHash;
    const adapterResult = typeof adapter === 'function'
        ? adapter({ before: beforeSnapshot, after: afterSnapshot, notes, structuralPatch, diffChanged })
        : { operations: [], failures: [], summary: '' };
    const operations = Array.isArray(adapterResult.operations) ? adapterResult.operations : [];
    const failures = Array.isArray(adapterResult.failures) ? adapterResult.failures : [];
    const appliedCount = operations.filter(op => op.status === 'verified' || op.status === 'applied').length;
    const structuralApplied = Number(structuralPatch?.appliedCount || 0) > 0;
    const changed = diffChanged || structuralApplied || appliedCount > 0;

    return {
        changed,
        beforeHash,
        afterHash,
        receipt: {
            stageId,
            changed,
            verified: changed && failures.length === 0,
            beforeHash,
            afterHash,
            operationCount: operations.length,
            appliedOperationCount: appliedCount,
            operations: operations.slice(0, 30),
            failures: failures.slice(0, 12),
            summary: adapterResult.summary || (changed ? 'Revision changed the saved artifact.' : 'Revision produced no saved artifact changes.')
        }
    };
}

module.exports = {
    createRevisionTransaction,
    dataHash,
    outlineRevisionAdapter,
    characterRevisionAdapter,
    stage4RevisionAdapter,
    treatmentRevisionAdapter,
    sceneBlueprintRevisionAdapter
};
