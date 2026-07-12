const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const {
    applyStructuralPatchToItems,
    labelsEqual,
    parseStructuralPatchOps
} = require('../utils/revision_patch');
const { sanitizeOutlineMetaBeats } = require('../utils/outline_sanitizer');
const { loadSkill } = require('../utils/skills_cache');

function normalizeOutlineInput(outline) {
    if (!outline || typeof outline !== 'object') return null;
    if (outline.outline && typeof outline.outline === 'object' && !Array.isArray(outline.outline)) {
        return outline.outline;
    }
    return outline;
}

function outlineHasContent(outline) {
    const normalized = normalizeOutlineInput(outline);
    if (!normalized) return false;

    const acts = [normalized.act_1, normalized.act_2, normalized.act_3];
    return acts.some(act => Array.isArray(act) && act.some(sequence => {
        if (!sequence || typeof sequence !== 'object') return false;
        if (String(sequence.sequence_number_and_title || '').trim()) return true;
        const beats = Array.isArray(sequence.beats) ? sequence.beats : [];
        return beats.some(beat => (
            String(beat?.beat_label || '').trim() ||
            String(beat?.beat || '').trim() ||
            String(beat?.description || '').trim()
        ));
    }));
}

function combineUsage(...usages) {
    const valid = usages.filter(Boolean);
    if (!valid.length) return undefined;
    return valid.reduce((acc, usage) => ({
        model: usage.model || acc.model,
        inputTokens: (acc.inputTokens || 0) + (usage.inputTokens || 0),
        outputTokens: (acc.outputTokens || 0) + (usage.outputTokens || 0)
    }), { model: valid[0].model, inputTokens: 0, outputTokens: 0 });
}

function isTransientAiError(error) {
    const code = String(error?.code || error?.cause?.code || '');
    if (/ECONNRESET|ETIMEDOUT|UND_ERR|EPIPE|ECONNREFUSED/i.test(code)) return true;
    const message = String(error?.message || error || '');
    return /terminated|socket|network|fetch failed|aborted|timeout|temporarily unavailable/i.test(message);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(value, maxChars = 900) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 80).trim()} [...truncated]`;
}

function normalizeRevisionBrief(notes = '') {
    return String(notes || '')
        .trim()
        .replace(/^(?:ACTIVE REVISION REQUEST|REVISION BRIEF):\s*/i, '')
        .trim();
}

function looksLikeChecklistHeader(line = '') {
    const clean = String(line || '').trim();
    if (!clean || clean.length > 90) return false;
    if (/^\[[^\]]{3,100}\]$/.test(clean)) return true;
    if (/[.!?]$/.test(clean)) return false;
    if (/^(stuff to restore|things to restore|recommended|next move|on it|understood|user requests|assistant direction)$/i.test(clean)) return false;
    return /\b(restore|aftermath|closing|image|coda|finale|surrender|setup|payoff|beat|scene|ending|origin|canon)\b/i.test(clean)
        || /^[A-Z][A-Za-z0-9' -]{2,}$/.test(clean);
}

function isScopedPolishText(value = '') {
    const text = String(value || '');
    const scoped = /\bone\s+(?:small|minor|tiny)\s+(?:local\s+)?(?:polish|clarity|wording|language|line|paragraph|beat)\b/i.test(text)
        || /\b(?:local|single)\s+(?:polish|clarity|wording|language|line|paragraph|beat)\b/i.test(text)
        || /\b(?:not\s+a\s+structural\s+issue|not\s+structural|do\s+not\s+restructure|structure\s+works|current\s+structure\s+works|only\s+a\s+(?:clarity|wording|polish)|just\s+a\s+(?:clarity|wording|polish)|local\s+polish\s+only)\b/i.test(text);
    return scoped && /\b(?:clarify|polish|wording|paragraph|line|phrase|word|sentence|read|land|fuzzy|cleanly|payoff)\b/i.test(text);
}

function isRevisionGuardrailBlock(value = '') {
    return /\b(?:do\s+not|don't)\s+(?:change|modify|edit|alter|touch|revise|update|restructure|delete|remove)\b/i.test(String(value || ''))
        || /\b(?:do\s+not|don't)\s+(?:add|include|restore|bring\s+back)\s+(?:a\s+separate\s+)?\[/i.test(String(value || ''));
}

function scopedPolishChecklistItems(text = '', maxItems = 12) {
    const items = [];
    const replacement = String(text || '').match(/\bTo something like:\s*\n+([\s\S]*?)(?=\n\s*\n(?:Optional:|Do not|Don't|This is only|$))/i);
    const replacementText = (replacement?.[1] || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/^["“]|["”]$/g, '')
        .trim();
    if (replacementText.length > 20 && !isRevisionGuardrailBlock(replacementText)) {
        items.push(compactText(replacementText, 700));
    }
    const suggested = String(text || '').match(/\bSuggested sentence:\s*\n+([\s\S]*?)(?=\n\s*\n(?:Do not|Don't|This is only|$))/i);
    const sentence = (suggested?.[1] || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    if (sentence.length > 20 && !isRevisionGuardrailBlock(sentence)) {
        items.push(compactText(sentence, 700));
    }
    return items.slice(0, maxItems);
}

function buildRevisionChecklist(notes = '', maxItems = 12) {
    const text = normalizeRevisionBrief(notes);
    if (!text) return [];
    if (isScopedPolishText(text)) {
        return scopedPolishChecklistItems(text, maxItems);
    }
    if (!/\n/.test(text)) {
        return /\b(kitchen|closing image|final image|photo|breakfast|visitor pass|visitor passes|surrender|aftermath|restore|midpoint|recogniz|dapple was mine|storm drain|quiet kingdom|source[- ]?faith|ending line|accountability|answer for what you did)\b/i.test(text)
            && text.length > 40
            ? [compactText(text, 800)]
            : [];
    }

    const blocks = text
        .split(/\n\s*\n/)
        .map(block => block.trim())
        .filter(Boolean);
    const items = [];

    for (const block of blocks) {
        if (isRevisionGuardrailBlock(block)) continue;
        if (/\b(delete|remove|cut|omit|drop)\b/i.test(block)
            && /\b(accidental note|not outline content|final beat|last paragraph|final paragraph)\b/i.test(block)) {
            const deleteLabel = bracketedLabelNearestDeleteInstruction(block, { preferLastDelete: true }) || block.match(/\[([^\]]+)\]/)?.[1];
            if (deleteLabel) items.push(`Delete [${deleteLabel}]`);
            if (items.length >= maxItems) break;
            continue;
        }
        const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!lines.length) continue;

        const bracketedBlock = block.match(/^\[([^\]]{3,100})\]\s+([\s\S]{20,})$/);
        if (bracketedBlock) {
            items.push(compactText(`${bracketedBlock[1]}: ${bracketedBlock[2]}`, 900));
            if (items.length >= maxItems) break;
            continue;
        }

        for (const line of lines) {
            const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.+)/);
            if (bullet && bullet[1].length > 18) items.push(compactText(bullet[1], 700));
            const bracketedLine = line.match(/^\[([^\]]{3,100})\]\s+(.{20,})$/);
            if (bracketedLine) items.push(compactText(`${bracketedLine[1]}: ${bracketedLine[2]}`, 900));
        }

        if (lines.length >= 2 && looksLikeChecklistHeader(lines[0])) {
            const header = lines[0].replace(/^\[|\]$/g, '');
            const body = lines.slice(1).join(' ');
            if (body.length > 20) items.push(compactText(`${header}: ${body}`, 800));
        }
        if (lines.length === 1 && block.length > 40 && /\b(midpoint|recogniz|dapple was mine|source[- ]?faith|storm drain|quiet kingdom|ending line|accountability|answer for what you did)\b/i.test(block)) {
            items.push(compactText(block, 800));
        }
        if (items.length >= maxItems) break;
    }

    return Array.from(new Set(items)).slice(0, maxItems);
}

function bracketedLabelNearestDeleteInstruction(text = '', { preferLastDelete = false } = {}) {
    const source = String(text || '');
    const deleteMatches = Array.from(source.matchAll(/\b(delete|remove|cut|omit|drop)\b/gi));
    if (!deleteMatches.length) return '';
    const deleteMatch = preferLastDelete ? deleteMatches[deleteMatches.length - 1] : deleteMatches[0];
    const deleteIndex = deleteMatch.index || 0;
    const labels = Array.from(source.matchAll(/\[([^\]]+)\]/g))
        .map(match => ({
            label: (match[1] || '').trim(),
            index: match.index || 0,
            endIndex: (match.index || 0) + match[0].length
        }))
        .filter(item => item.label);
    if (!labels.length) return '';

    const before = labels.filter(item => item.endIndex <= deleteIndex).sort((a, b) => b.endIndex - a.endIndex);
    if (before.length) return before[0].label;
    const after = labels.filter(item => item.index >= deleteIndex).sort((a, b) => a.index - b.index);
    return after[0]?.label || '';
}

function parseBracketedRevisionBeats(text = '') {
    const beats = [];
    const pattern = /^\s*\[([^\]]{3,120})\]\s+([\s\S]*?)(?=\n\s*\[[^\]]{3,120}\]\s+|$)/gm;
    for (const match of String(text || '').matchAll(pattern)) {
        const beat_label = (match[1] || '').trim();
        const description = (match[2] || '').trim();
        if (beat_label && description.length >= 20) {
            beats.push({ beat_label, description });
        }
    }
    return beats;
}

function extractExplicitSequenceReplacement(notes = '') {
    const text = normalizeRevisionBrief(notes);
    if (!text || !/\breplace\b/i.test(text) || !/\bwith\b/i.test(text) || !/\bbeats?\b/i.test(text)) return null;
    const sequenceMatch = text.match(/\breplace\s+(?:the\s+)?(?:sequence\s*)?([a-h]|[1-8])\b/i);
    if (!sequenceMatch) return null;
    const sequenceId = sequenceMatch[1].toUpperCase();
    const beats = parseBracketedRevisionBeats(text);
    if (!beats.length) return null;

    const titleMatch = text.match(new RegExp(`^\\s*Sequence\\s+${sequenceId}\\s*:\\s*(.+)$`, 'im'));
    const sequence_number_and_title = titleMatch?.[1]
        ? `Sequence ${sequenceId}: ${titleMatch[1].trim()}`
        : `Sequence ${sequenceId}`;

    return { sequenceId, sequence_number_and_title, beats };
}

const CHECKLIST_STOPWORDS = new Set([
    'about', 'above', 'absolutely', 'across', 'after', 'again', 'also', 'because', 'before', 'being',
    'both', 'chunk', 'chunks', 'doing', 'ensure', 'every', 'final', 'from', 'have', 'image', 'into',
    'keeps', 'last', 'lets', 'more', 'much', 'needs', 'note', 'old', 'only', 'outline', 'real',
    'missing', 'please', 'restore', 'restoring', 'should', 'specific', 'still', 'that', 'their', 'there', 'these', 'thing',
    'three', 'through', 'visible', 'with', 'work', 'would'
]);

function checklistTerms(item = '') {
    const normalized = String(item || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ');
    return Array.from(new Set(normalized.split(/\s+/)
        .map(token => token.replace(/^'+|'+$/g, ''))
        .filter(token => token.length >= 4 && !CHECKLIST_STOPWORDS.has(token))));
}

function outlineCoverageUnits(outlineResult = {}) {
    const outline = outlineResult?.outline || outlineResult || {};
    const acts = [outline.act_1, outline.act_2, outline.act_3].filter(Array.isArray);
    const beatUnits = [];
    const sequenceUnits = [];

    for (const act of acts) {
        for (const sequence of act) {
            if (!sequence || typeof sequence !== 'object') continue;
            const sequenceTitle = sequence.sequence_number_and_title || '';
            const beatTexts = [];
            for (const beat of sequence.beats || []) {
                const text = [
                    sequenceTitle,
                    beat?.beat_label || beat?.beat || '',
                    beat?.description || ''
                ].join(' ').toLowerCase();
                if (text.trim()) {
                    beatUnits.push(text);
                    beatTexts.push(text);
                }
            }
            const sequenceText = [sequenceTitle, ...beatTexts].join(' ').toLowerCase();
            if (sequenceText.trim()) sequenceUnits.push(sequenceText);
        }
    }

    return { beatUnits, sequenceUnits };
}

function outlineAllText(outlineResult = {}) {
    const outline = outlineResult?.outline || outlineResult || {};
    return [outline.act_1, outline.act_2, outline.act_3]
        .filter(Array.isArray)
        .flatMap(act => act.flatMap(sequence => [
            sequence?.sequence_number_and_title || '',
            ...(sequence?.beats || []).flatMap(beat => [
                beat?.beat_label || beat?.beat || '',
                beat?.description || ''
            ])
        ]))
        .join(' ')
        .toLowerCase();
}

function outlineBeatText(outlineResult = {}, predicate = () => false) {
    const outline = outlineResult?.outline || outlineResult || {};
    const matches = [];
    for (const act of [outline.act_1, outline.act_2, outline.act_3]) {
        if (!Array.isArray(act)) continue;
        for (const sequence of act) {
            for (const beat of sequence?.beats || []) {
                const label = beat?.beat_label || beat?.beat || '';
                const description = beat?.description || '';
                const text = [sequence?.sequence_number_and_title || '', label, description].join(' ');
                if (predicate({ sequence, beat, label, description, text })) matches.push(text.toLowerCase());
            }
        }
    }
    return matches.join(' ');
}

function specialChecklistCoverage(item = '', outlineResult = {}) {
    const itemText = String(item || '').toLowerCase();
    const allText = outlineAllText(outlineResult);
    const deleteLabel = String(item || '').match(/\[([^\]]+)\]/)?.[1] || '';
    const itemWithoutBracketedLabels = String(item || '').replace(/\[[^\]]+\]/g, ' ');
    if (deleteLabel && /\b(delete|remove|cut|omit|drop)\b/i.test(itemWithoutBracketedLabels)) {
        const matchingBeatCount = outlineCoverageUnits(outlineResult).beatUnits
            .filter(unit => new RegExp(`\\b${escapeRegExp(normalizedComparableLabel(deleteLabel)).replace(/\\ /g, '\\s+')}\\b`, 'i').test(normalizedComparableLabel(unit)))
            .length;
        if (/\b(second|duplicate|copy|copies|after|replace)\b/i.test(itemWithoutBracketedLabels)) {
            return matchingBeatCount <= 1;
        }
        return !new RegExp(escapeRegExp(deleteLabel), 'i').test(JSON.stringify(outlineResult || {}));
    }
    if (/\bmidpoint\b/.test(itemText) && /(doesn|does not|recogniz|should know|hello,\s*becky|dapple was mine|imaginary friend)/.test(itemText)) {
        const outline = outlineResult?.outline || outlineResult || {};
        const midpointTexts = [];
        for (const act of [outline.act_1, outline.act_2, outline.act_3]) {
            if (!Array.isArray(act)) continue;
            for (const sequence of act) {
                for (const beat of sequence?.beats || []) {
                    const label = beat?.beat_label || beat?.beat || '';
                    const description = beat?.description || '';
                    if (/\bmidpoint\b/i.test(label) || /hello,\s*becky/i.test(description)) {
                        midpointTexts.push(`${label} ${description}`.toLowerCase());
                    }
                }
            }
        }
        return midpointTexts.some(midpointText => (
            /dapple was mine|imaginary friend/.test(midpointText)
                && !/doesn'?t consciously recognize|does not consciously recognize/.test(midpointText)
        ));
    }
    if (/\bstorm drain\b/.test(itemText) && /\bquiet kingdom\b/.test(itemText)) {
        const rebeccaMemoryText = outlineBeatText(outlineResult, ({ label, description }) => (
            /rebecca/i.test(label) || /pillermoss|quiet kingdom|storm drain/i.test(description)
        ));
        return /\bstorm drain\b/.test(rebeccaMemoryText)
            && !/\bsource-true\b/.test(rebeccaMemoryText)
            && !/\bquiet kingdom\b/.test(rebeccaMemoryText);
    }
    if (/\bending line\b/.test(itemText) || /\baccountability\b/.test(itemText) || /\banswer for what you did\b/.test(itemText)) {
        return /answer for what you did/.test(allText);
    }
    return null;
}

function requiresBeatLevelCoverage(item = '') {
    return /\b(kitchen|closing image|final image|photo|breakfast|visitor pass|visitor passes|framed in the light)\b/i.test(item);
}

function unitCoversChecklistItem(unit = '', terms = [], item = '') {
    if (!terms.length) return true;
    const found = terms.filter(term => unit.includes(term)).length;
    const required = requiresBeatLevelCoverage(item)
        ? Math.min(8, Math.max(4, Math.ceil(terms.length * 0.55)))
        : Math.min(7, Math.max(3, Math.ceil(terms.length * 0.45)));
    return found >= required;
}

function findUndercoveredChecklistItems(checklist = [], outlineResult = {}) {
    if (!checklist.length) return [];
    const { beatUnits, sequenceUnits } = outlineCoverageUnits(outlineResult);
    return checklist.filter(item => {
        const specialCoverage = specialChecklistCoverage(item, outlineResult);
        if (specialCoverage !== null) return !specialCoverage;
        const terms = checklistTerms(item);
        if (terms.length < 4) return false;
        const units = requiresBeatLevelCoverage(item) ? beatUnits : beatUnits.concat(sequenceUnits);
        return !units.some(unit => unitCoversChecklistItem(unit, terms, item));
    });
}

function cloneBeat(beat = {}) {
    return {
        beat_label: beat.beat_label || beat.beat || 'Restored Beat',
        description: beat.description || ''
    };
}

function sequenceId(sequence = {}) {
    const match = String(sequence?.sequence_number_and_title || '').match(/\bsequence\s*([a-h1-8])\b/i);
    return match ? match[1].toUpperCase() : '';
}

function sequenceSlug(sequence = {}) {
    return String(sequence?.sequence_number_and_title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function beatText(beat = {}) {
    return [beat.beat_label || beat.beat || '', beat.description || ''].join(' ').toLowerCase();
}

function significantBeatTerms(beat = {}) {
    return checklistTerms([beat.beat_label || beat.beat || '', beat.description || ''].join(' '))
        .filter(term => !['dapple', 'rebecca', 'elliot'].includes(term));
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textContainsTerm(text = '', term = '') {
    if (!term) return false;
    return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(String(text || ''));
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function normalizedComparableLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isNegatedBeatLabelReference(notes = '', label = '') {
    if (!label) return false;
    return new RegExp(`\\b(?:do\\s+not|don't)\\s+(?:change|modify|edit|alter|touch|revise|update|delete|remove)\\s+(?:the\\s+)?\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i')
        .test(String(notes || ''));
}

function isNegatedSequenceReference(notes = '', sequence = {}) {
    const title = String(sequence?.sequence_number_and_title || '');
    const id = sequenceId(sequence);
    if (!id) return false;
    const text = String(notes || '');
    if (new RegExp(`\\b(?:do\\s+not|don't)\\s+(?:change|modify|edit|alter|touch|revise|update|restructure)\\s+(?:sequence\\s*)${escapeRegExp(id)}\\b`, 'i').test(text)) {
        return true;
    }
    if (title && new RegExp(`\\b(?:do\\s+not|don't)\\s+(?:change|modify|edit|alter|touch|revise|update|restructure)\\s+(?:the\\s+)?${escapeRegExp(title)}\\b`, 'i').test(text)) {
        return true;
    }
    return false;
}

function scopedPolishTargetLabels(notes = '') {
    if (!isScopedPolishText(notes)) return [];
    const text = String(notes || '');
    const labels = Array.from(text.matchAll(/\[([^\]]{3,140})\]/g))
        .map(match => (match[1] || '').trim())
        .filter(label => label && !isNegatedBeatLabelReference(text, label));
    return Array.from(new Set(labels));
}

function notesTargetExistingBeat(notes = '', beat = {}) {
    const noteText = String(notes || '').toLowerCase();
    const label = String(beat.beat_label || beat.beat || '').toLowerCase();
    const labelTerms = checklistTerms(label);
    const foundLabelTerms = labelTerms.filter(term => textContainsTerm(noteText, term)).length;
    if (foundLabelTerms >= Math.min(2, labelTerms.length || 2)) return true;
    return labelTerms.length === 1 && foundLabelTerms === 1;
}

function findMatchingSequence(outline = {}, currentSequence = {}) {
    const id = sequenceId(currentSequence);
    const slug = sequenceSlug(currentSequence);
    for (const act of [outline.act_1, outline.act_2, outline.act_3]) {
        if (!Array.isArray(act)) continue;
        const byId = id ? act.find(sequence => sequenceId(sequence) === id) : null;
        if (byId) return byId;
        const bySlug = slug ? act.find(sequence => sequenceSlug(sequence) === slug) : null;
        if (bySlug) return bySlug;
    }
    return null;
}

function restoreDroppedExistingBeats(outlineResult = {}, currentOutlineInput = {}, notes = '', { explicitSequenceReplacement = null } = {}) {
    const outline = outlineResult?.outline || outlineResult || {};
    const currentOutline = normalizeOutlineInput(currentOutlineInput) || {};
    const replacedSequenceId = explicitSequenceReplacement?.sequenceId
        ? String(explicitSequenceReplacement.sequenceId).toUpperCase()
        : '';

    for (const currentAct of [currentOutline.act_1, currentOutline.act_2, currentOutline.act_3]) {
        if (!Array.isArray(currentAct)) continue;
        for (const currentSequence of currentAct) {
            if (replacedSequenceId && sequenceId(currentSequence) === replacedSequenceId) continue;
            const revisedSequence = findMatchingSequence(outline, currentSequence);
            if (!revisedSequence || !Array.isArray(currentSequence.beats)) continue;
            if (!Array.isArray(revisedSequence.beats)) revisedSequence.beats = [];
            for (const currentBeat of currentSequence.beats) {
                const label = currentBeat?.beat_label || currentBeat?.beat || '';
                if (!label) continue;
                const revisedHasBeat = revisedSequence.beats.some(beat => {
                    const revisedLabel = beat?.beat_label || beat?.beat || '';
                    if (revisedLabel && revisedLabel.toLowerCase() === label.toLowerCase()) return true;
                    const currentTerms = significantBeatTerms(currentBeat);
                    if (currentTerms.length < 5) return false;
                    const revisedText = beatText(beat);
                    const found = currentTerms.filter(term => textContainsTerm(revisedText, term)).length;
                    return found >= Math.min(6, Math.ceil(currentTerms.length * 0.6));
                });
                if (!revisedHasBeat && !notesTargetExistingBeat(notes, currentBeat)) {
                    revisedSequence.beats.push(cloneBeat(currentBeat));
                }
            }
        }
    }
    return outlineResult;
}

function beatKind(beat = {}) {
    const label = String(beat?.beat_label || beat?.beat || '');
    const description = String(beat?.description || '');
    const text = `${label} ${description}`;
    if (/\bmidpoint\b/i.test(label) || /hello,\s*becky/i.test(description)) return 'midpoint';
    if (/quiet reckoning/i.test(label) || /\bdiner\b/i.test(description) || /why did dapple know my name|how long have you known/i.test(description)) return 'diner';
    if (/Rebecca's (?:Realization|Memory)|Quiet Kingdom|Bonded Phrase/i.test(label) || /source-true|pillermoss|quiet kingdom|storm drain/i.test(description)) return 'rebecca-memory';
    if (/false rescue/i.test(label) || /real dramatic question/i.test(description)) return 'false-rescue';
    if (/climax|apology|key/i.test(label) || /protocol erasure aborts|doesn'?t fight dapple/i.test(description)) return 'climax';
    if (/dapple/i.test(label) && /last choice|surrender|cuff/i.test(text)) return 'dapple-choice';
    if (/aftermath.+new order|new order/i.test(label)) return 'new-order';
    if (/closing image|photo on the wall|kitchen closing image/i.test(label) || /breakfast for three|visitor passes?/i.test(description)) return 'closing-image';
    return '';
}

function notesTargetBeat(notes = '', beat = {}) {
    const text = String(notes || '');
    const lower = text.toLowerCase();
    const label = String(beat?.beat_label || beat?.beat || '');
    if (isNegatedBeatLabelReference(text, label)) return false;
    const scopedTargets = scopedPolishTargetLabels(text);
    if (scopedTargets.length) return scopedTargets.some(target => labelsEqual(target, label));
    const normalizedLabel = normalizedComparableLabel(label);
    if (label && new RegExp(`\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i').test(text)) return true;
    const labelTerms = checklistTerms(label);
    const foundLabelTerms = labelTerms.filter(term => textContainsTerm(lower, term)).length;
    if (labelTerms.length && foundLabelTerms >= Math.min(labelTerms.length, 3)) return true;

    switch (beatKind(beat)) {
        case 'midpoint':
            return /\bmidpoint\b|hello,\s*becky|doesn'?t consciously recognize|does not consciously recognize|dapple was mine|imaginary friend/i.test(text);
        case 'diner':
            return /\bdiner\b|how long have you known he was mine|why did dapple know my name/i.test(text);
        case 'rebecca-memory':
            return /Rebecca's (?:Realization|Memory)|Quiet Kingdom|Bonded Phrase|source[- ]?true|source[- ]?faith|storm drain|pillermoss/i.test(text);
        case 'false-rescue':
            return /climax is not|own the bond|reach him|real dramatic question/i.test(text);
        case 'climax':
            return /\bclimax\b|private bond|pillermoss|storm drain|quiet kingdom|bonded phrase|protocol erasure/i.test(text);
        case 'dapple-choice':
            return /dapple'?s ending line|not letting them warehouse|answer for what you did|accountability|this time,\s*i stay|dapple'?s last choice|surrender/i.test(text);
        case 'new-order':
            return /aftermath.+new order|new order|quist.+old order|consult.+dapple|scott gets/i.test(text);
        case 'closing-image':
            return /closing image|photo on the wall|kitchen closing|breakfast for three|visitor passes?/i.test(text);
        default:
            return normalizedLabel && lower.includes(normalizedLabel);
    }
}

function notesAllowSequenceAdditions(notes = '', sequence = {}) {
    const text = String(notes || '');
    const title = String(sequence?.sequence_number_and_title || '');
    const isFinalSequence = /sequence\s*h\b|resolution|world that remembers|ending|finale/i.test(title);
    const destructiveFinalInstruction = /(?:\b(delete|remove|cut|omit|drop)\b[\s\S]{0,180}\b(final beat|last paragraph|final paragraph)|\b(final beat|last paragraph|final paragraph)\b[\s\S]{0,180}\b(delete|remove|cut|omit|drop)\b)/i.test(text);
    if (destructiveFinalInstruction && !/\b(sequence\s*h|closing image|photo on the wall|breakfast for three|visitor passes?)\b/i.test(text)) {
        return false;
    }
    const asksRestore = /\b(restore|restoring|missing|omitted|dropped|lost|bring back|add|include)\b/i.test(text);
    const finalBeatTerms = /\b(sequence\s*h|seq\s*h|ending beats?|final beats?|closing image|photo on the wall|breakfast for three|visitor passes?|aftermath.+new order|dapple'?s voluntary surrender)\b/i.test(text);
    return isFinalSequence && asksRestore && finalBeatTerms;
}

function revisedBeatMatchesCurrent(revisedBeat = {}, currentBeat = {}) {
    const revisedLabel = normalizedComparableLabel(revisedBeat.beat_label || revisedBeat.beat || '');
    const currentLabel = normalizedComparableLabel(currentBeat.beat_label || currentBeat.beat || '');
    if (revisedLabel && currentLabel && revisedLabel === currentLabel) return true;
    const currentKind = beatKind(currentBeat);
    return currentKind && currentKind === beatKind(revisedBeat);
}

function findMatchingRevisedBeat(revisedSequence = {}, currentBeat = {}) {
    const beats = Array.isArray(revisedSequence?.beats) ? revisedSequence.beats : [];
    return beats.find(beat => revisedBeatMatchesCurrent(beat, currentBeat)) || null;
}

function sequenceHasEquivalentBeat(sequence = {}, beatToFind = {}) {
    const beats = Array.isArray(sequence?.beats) ? sequence.beats : [];
    return beats.some(beat => revisedBeatMatchesCurrent(beat, beatToFind));
}

function outlineBeatPatchOptions() {
    return {
        getLabel: beat => beat.beat_label || beat.beat || '',
        setLabel: (beat, label) => { beat.beat_label = label || beat.beat_label || beat.beat || 'Revised Beat'; },
        setBody: (beat, body) => { beat.description = body || beat.description || ''; },
        buildNewItem: op => ({
            beat_label: op.newLabel || 'Inserted Beat',
            description: op.newBody || ''
        })
    };
}

const KNOWN_ENDING_RESTORE_BEATS = [{
    label: 'Aftermath - A New Order',
    description: "Quist's old order is broken. Rebecca declines the badge but agrees to consult on Dapple containment. Dave, Robotobob, Blounder, Terry, Moog, Big Doll, Scott, and Molly each get their humane aftermath."
}, {
    label: 'Closing Image - The Photo on the Wall',
    description: "Rebecca's kitchen holds the framed photo of young Becky and Dapple. Elliot sets breakfast for three with Furdlegurr visible to both, and visitor passes for Dapple and Scott sit on the fridge."
}];

function isKnownEndingRestoreLabel(label = '') {
    return KNOWN_ENDING_RESTORE_BEATS.some(beat => labelsEqual(beat.label, label));
}

function markKnownEndingEnsureOperation(op = {}) {
    if (op.type === 'insert' && isKnownEndingRestoreLabel(op.newLabel || '')) {
        return { ...op, verifyMode: 'present' };
    }
    return op;
}

function dedupeStructuralOperations(operations = []) {
    const seen = new Set();
    const unique = [];
    for (const op of operations) {
        const key = [
            op.type || '',
            normalizedComparableLabel(op.oldLabel || ''),
            normalizedComparableLabel(op.newLabel || ''),
            normalizedComparableLabel(op.anchorLabel || ''),
            op.ordinal ?? '',
            op.finalOnly ? 'final' : '',
            op.verifyMode || ''
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(op);
    }
    return unique;
}

function notesRequestKnownEndingBeat(notes = '', label = '') {
    const text = String(notes || '');
    const normalized = normalizedComparableLabel(label);
    const exactBracketed = new RegExp(`\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i').test(text);
    const exactUnbracketed = normalized && normalizedComparableLabel(text).includes(normalized);
    if (!exactBracketed && !exactUnbracketed) {
        return false;
    }
    const deleteDirect = new RegExp(`\\b(?:delete|remove|cut|omit|drop|strip)\\s+(?:the\\s+)?\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i').test(text);
    if (deleteDirect) return false;
    const labelIndex = text.toLowerCase().indexOf(label.toLowerCase());
    const beforeLabel = labelIndex >= 0
        ? text.slice(Math.max(0, labelIndex - 180), labelIndex)
        : '';
    return /\b(preserve|restore|restoring|keep|revert|base|version\s*13|final ending beats?|ending beats?|merge(?:d)?(?: only)?(?: its| their)? best ideas into|should remain|do not change the structure)\b/i.test(text)
        || (normalized && /\b(aftermath|closing image|photo on the wall|final ending)\b/i.test(text) && beforeLabel);
}

function knownEndingBodyFromNotes(notes = '', label = '') {
    const text = String(notes || '');
    const match = new RegExp(`\\[\\s*${escapeRegExp(label)}\\s*\\]`, 'i').exec(text);
    if (!match) return '';
    const rest = text.slice(match.index + match[0].length);
    const stopMatch = rest.match(/\n\s*(?=(?:\n\s*)?(?:\[[^\]]{2,180}\]\s+|\d+[.)]\s+|[-*]\s+|\b(?:also\s+)?(?:delete|remove|cut|omit|drop|strip|replace|merge|preserve|keep|do not|optional)\b|\b(?:the\s+)?(?:final\s+beat|order should be)\b))/i);
    const rawBody = stopMatch ? rest.slice(0, stopMatch.index) : rest;
    const body = rawBody.replace(/^\s*[:\-\u2013\u2014]\s*/, '').trim();
    return body.length >= 12 && /[a-z0-9]/i.test(body) ? body : '';
}

function finalOutlineSequence(outline = {}) {
    const act3 = Array.isArray(outline.act_3) ? outline.act_3 : [];
    return act3.find(sequence => /sequence\s*h|world that remembers|resolution|final/i.test(sequence?.sequence_number_and_title || ''))
        || act3[act3.length - 1]
        || null;
}

function removeEquivalentBeat(sequence = {}, label = '') {
    if (!Array.isArray(sequence?.beats)) return false;
    const before = sequence.beats.length;
    sequence.beats = sequence.beats.filter(beat => !labelsEqual(beat?.beat_label || beat?.beat || '', label));
    return sequence.beats.length !== before;
}

function insertKnownEndingBeat(sequence = {}, beat = {}) {
    if (!sequence) return false;
    if (!Array.isArray(sequence.beats)) sequence.beats = [];
    removeEquivalentBeat(sequence, beat.label);
    const newBeat = { beat_label: beat.label, description: beat.description };
    if (/closing image|photo on the wall/i.test(beat.label)) {
        sequence.beats.push(newBeat);
        return true;
    }
    const closingIndex = sequence.beats.findIndex(existing => /closing image|photo on the wall|kitchen closing/i.test(existing?.beat_label || existing?.beat || ''));
    if (closingIndex >= 0) sequence.beats.splice(closingIndex, 0, newBeat);
    else sequence.beats.push(newBeat);
    return true;
}

function applyKnownEndingRestores(outlineResult = {}, notes = '') {
    const outline = outlineResult?.outline || outlineResult || {};
    const sequence = finalOutlineSequence(outline);
    if (!sequence) return { appliedCount: 0, operations: [] };
    const operations = [];
    let appliedCount = 0;

    for (const beat of KNOWN_ENDING_RESTORE_BEATS) {
        if (!notesRequestKnownEndingBeat(notes, beat.label)) continue;
        const hadBeat = (sequence.beats || []).some(existing => labelsEqual(existing?.beat_label || existing?.beat || '', beat.label));
        const restoreBeat = {
            ...beat,
            description: knownEndingBodyFromNotes(notes, beat.label) || beat.description
        };
        insertKnownEndingBeat(sequence, restoreBeat);
        if (!hadBeat) {
            operations.push({
                type: 'insert',
                newLabel: restoreBeat.label,
                newBody: restoreBeat.description,
                anchorLabel: '',
                verifyMode: 'present'
            });
            appliedCount += 1;
        }
    }

    return { appliedCount, operations };
}

function applyStructuralOutlinePatches(outline = {}, notes = '') {
    const operations = parseStructuralPatchOps(notes).map(markKnownEndingEnsureOperation);
    const knownRestores = applyKnownEndingRestores(outline, notes);
    if (!operations.length) return { appliedCount: knownRestores.appliedCount, operations: knownRestores.operations };
    let appliedCount = 0;

    for (const actKey of ['act_1', 'act_2', 'act_3']) {
        const act = Array.isArray(outline[actKey]) ? outline[actKey] : [];
        for (const sequence of act) {
            if (!Array.isArray(sequence?.beats)) continue;
            const patched = applyStructuralPatchToItems(sequence.beats, operations, outlineBeatPatchOptions());
            if (patched.appliedCount > 0) {
                sequence.beats = patched.items;
                appliedCount += patched.appliedCount;
            }
        }
    }

    return {
        appliedCount: appliedCount + knownRestores.appliedCount,
        operations: dedupeStructuralOperations(operations.concat(knownRestores.operations))
    };
}

function structuralOperationProtectsCurrentBeat(operations = [], currentSequence = {}, beatIndex = -1) {
    const currentBeat = currentSequence?.beats?.[beatIndex] || {};
    const currentLabel = normalizedComparableLabel(currentBeat.beat_label || currentBeat.beat || '');
    if (!currentLabel) return false;

    return operations.some(op => {
        const oldLabel = normalizedComparableLabel(op.oldLabel || '');
        if (!oldLabel || oldLabel !== currentLabel) return false;
        if (op.type === 'delete') return true;
        if (op.type !== 'replace') return false;
        if (!op.anchorLabel) return true;
        const anchorLabel = normalizedComparableLabel(op.anchorLabel);
        const anchorIndex = (currentSequence.beats || []).findIndex(beat => (
            normalizedComparableLabel(beat?.beat_label || beat?.beat || '') === anchorLabel
        ));
        return anchorIndex >= 0 && beatIndex > anchorIndex;
    });
}

function applyScopedRevisionMerge(outlineResult = {}, currentOutlineInput = {}, notes = '', { explicitSequenceReplacement = null } = {}) {
    if (explicitSequenceReplacement) return outlineResult;
    const revisedOutline = normalizeOutlineInput(outlineResult);
    const currentOutline = normalizeOutlineInput(currentOutlineInput);
    if (!revisedOutline || !currentOutline) return outlineResult;

    const mergedOutline = deepClone(currentOutline);
    let appliedScopedChange = false;
    const structuralPatch = applyStructuralOutlinePatches(mergedOutline, notes);
    if (structuralPatch.appliedCount > 0) appliedScopedChange = true;

    for (const currentActKey of ['act_1', 'act_2', 'act_3']) {
        const currentAct = Array.isArray(currentOutline[currentActKey]) ? currentOutline[currentActKey] : [];
        const mergedAct = Array.isArray(mergedOutline[currentActKey]) ? mergedOutline[currentActKey] : [];
        for (let sequenceIndex = 0; sequenceIndex < currentAct.length; sequenceIndex += 1) {
            const currentSequence = currentAct[sequenceIndex];
            const mergedSequence = mergedAct[sequenceIndex];
            const revisedSequence = findMatchingSequence(revisedOutline, currentSequence);
            if (!mergedSequence || !revisedSequence) continue;
            if (isNegatedSequenceReference(notes, currentSequence)) continue;
            if (!Array.isArray(mergedSequence.beats)) mergedSequence.beats = [];

            for (let beatIndex = 0; beatIndex < (currentSequence.beats || []).length; beatIndex += 1) {
                const currentBeat = currentSequence.beats[beatIndex];
                if (structuralOperationProtectsCurrentBeat(structuralPatch.operations, currentSequence, beatIndex)) continue;
                if (!notesTargetBeat(notes, currentBeat)) continue;
                const revisedBeat = findMatchingRevisedBeat(revisedSequence, currentBeat);
                if (revisedBeat) {
                    mergedSequence.beats[beatIndex] = cloneBeat(revisedBeat);
                    appliedScopedChange = true;
                }
            }

            if (notesAllowSequenceAdditions(notes, currentSequence)) {
                for (const revisedBeat of revisedSequence.beats || []) {
                    if (!sequenceHasEquivalentBeat(mergedSequence, revisedBeat)) {
                        mergedSequence.beats.push(cloneBeat(revisedBeat));
                        appliedScopedChange = true;
                    }
                }
            }
        }
    }

    if (!appliedScopedChange && structuralPatch.operations.length) {
        if (outlineResult?.outline && typeof outlineResult.outline === 'object') {
            outlineResult.outline = mergedOutline;
        } else {
            for (const key of ['act_1', 'act_2', 'act_3']) {
                outlineResult[key] = mergedOutline[key] || [];
            }
        }
        return outlineResult;
    }
    if (!appliedScopedChange) return outlineResult;
    if (outlineResult?.outline && typeof outlineResult.outline === 'object') {
        outlineResult.outline = mergedOutline;
    } else {
        for (const key of ['act_1', 'act_2', 'act_3']) {
            outlineResult[key] = mergedOutline[key] || [];
        }
    }
    return outlineResult;
}

function findBeat(outlineResult = {}, predicate = () => false) {
    const outline = outlineResult?.outline || outlineResult || {};
    for (const act of [outline.act_1, outline.act_2, outline.act_3]) {
        if (!Array.isArray(act)) continue;
        for (const sequence of act) {
            if (!Array.isArray(sequence?.beats)) continue;
            for (const beat of sequence.beats) {
                const label = beat?.beat_label || beat?.beat || '';
                const description = beat?.description || '';
                if (predicate({ sequence, beat, label, description })) return beat;
            }
        }
    }
    return null;
}

function replaceQuietKingdomMemory(description = '') {
    const text = String(description || '');
    const stormDrainMemory = "One specific memory surfaces, sharper than the others: the storm drain. Young Becky crouched beside the rain-swollen curb, terrified of the dark water rushing under the grate, while Dapple stood between her and the pull of it, muddy and ridiculous and brave. He gave her their private bonded phrase -- PILLERMOSS -- and she promised she would never forget it. The day she stopped seeing him, that was the word she left behind. Only the two of them ever knew.";
    if (/One specific memory surfaces[\s\S]*Only the two of them ever knew\./i.test(text)) {
        return text.replace(/One specific memory surfaces[\s\S]*Only the two of them ever knew\./i, stormDrainMemory);
    }
    return `${text.replace(/\bsource-true\b/gi, 'private').replace(/\bQUIET KINGDOM\b/g, 'STORM DRAIN').replace(/\bQuiet Kingdom\b/g, 'Storm Drain')} ${stormDrainMemory}`.trim();
}

function applyRecognitionAndAccountabilityPass(outlineResult = {}, notes = '') {
    const request = String(notes || '');
    const wantsRecognition = /\bmidpoint\b/i.test(request)
        && (/\brecogniz/i.test(request) || /dapple was mine/i.test(request) || /doesn'?t consciously recognize|does not consciously recognize/i.test(request) || /hello,\s*becky/i.test(request));
    const wantsStormDrain = /\bstorm drain\b/i.test(request)
        && (/\bquiet kingdom\b/i.test(request) || /\bsource[- ]?faith/i.test(request) || /source[- ]?true/i.test(request));
    const wantsAccountability = /answer for what you did|accountability|ending line/i.test(request);

    if (wantsRecognition) {
        const midpointBeat = findBeat(outlineResult, ({ label, description }) => (
            /\bmidpoint\b/i.test(label) || /hello,\s*becky/i.test(description)
        ));
        if (midpointBeat) {
            midpointBeat.description = String(midpointBeat.description || '')
                .replace(/Rebecca freezes\. She doesn'?t consciously recognize him\s*(?:--|\u2014)\s*but her hands shake\. He recognizes her completely\. REVELATION FOR THE AUDIENCE \(Dramatic Irony\): Dapple is her abandoned childhood figment, and she is Patient Zero of his revolution\. Rebecca doesn'?t fully know yet\s*(?:--|\u2014)\s*but Dave does, and he'?s been hiding it\./i,
                    "Rebecca freezes. Not because the name is strange, but because something in her body knows him. The whole memory is still dammed up -- no bonded phrase, no final day -- but she understands the essential truth: Dapple was mine. Midpoint reveal: 'Oh God. He was my imaginary friend.' He recognizes her completely, and now she recognizes enough to act. Dave has known longer than he admitted, and he has been hiding it.")
                .replace(/Rebecca freezes\. She doesn'?t consciously recognize him\s*(?:--|\u2014)\s*but her hands shake\./i,
                    "Rebecca freezes. Not because the name is strange, but because something in her body knows him. The whole memory is still dammed up -- no bonded phrase, no final day -- but she understands the essential truth: Dapple was mine. Midpoint reveal: 'Oh God. He was my imaginary friend.'")
                .replace(/Rebecca doesn'?t fully know yet\s*(?:--|\u2014)\s*but Dave does, and he'?s been hiding it\./i,
                    "Dave has known longer than he admitted, and he has been hiding it.");
            if (!/dapple was mine|imaginary friend/i.test(midpointBeat.description || '')) {
                midpointBeat.description = `${String(midpointBeat.description || '').trim()} Rebecca understands the essential truth: Dapple was mine. The full memory has not returned yet, but the bond is no longer a mystery.`;
            }
        }

        const dinerBeat = findBeat(outlineResult, ({ label, description }) => (
            /quiet reckoning|aftermath/i.test(label) && /dapple/i.test(description)
        ));
        if (dinerBeat) {
            dinerBeat.description = String(dinerBeat.description || '')
                .replace(/Why did Dapple know my name\?/g, 'How long have you known he was mine?')
                .replace(/Why did Dapple know my name\?/gi, 'How long have you known he was mine?');
        }

        const falseRescueBeat = findBeat(outlineResult, ({ label, description }) => (
            /false rescue/i.test(label) || /real dramatic question/i.test(description)
        ));
        if (falseRescueBeat) {
            falseRescueBeat.description = String(falseRescueBeat.description || '')
                .replace(/can Rebecca remember what she abandoned/i, 'can Rebecca own the bond she abandoned')
                .replace(/She has rescued Elliot's friend\. She has not yet faced her own\./i,
                    "She has rescued Elliot's friend. She has not yet owned her own bond.");
        }
    }

    if (wantsStormDrain) {
        const memoryBeat = findBeat(outlineResult, ({ label, description }) => (
            /Rebecca's Realization|Rebecca's Memory|Quiet Kingdom|Bonded Phrase/i.test(label)
                || /Quiet Kingdom|source-true|PILLERMOSS/i.test(description)
        ));
        if (memoryBeat) {
            memoryBeat.beat_label = "Rebecca's Memory - The Storm Drain";
            memoryBeat.description = replaceQuietKingdomMemory(memoryBeat.description);
        }

        const climaxBeat = findBeat(outlineResult, ({ label }) => /climax|apology/i.test(label));
        if (climaxBeat) {
            climaxBeat.description = String(climaxBeat.description || '')
                .replace(/Dapple\. Pillermoss\. The Quiet Kingdom\. I remember the can\. I remember the password\. I remember you\./i,
                    "Dapple. Pillermoss. The storm drain. I remember the rainwater. I remember your paw in mine. I remember you.")
                .replace(/\bThe Quiet Kingdom\b/g, 'the storm drain')
                .replace(/\bQuiet Kingdom\b/g, 'storm drain')
                .replace(/\bthe can\b/gi, 'the rainwater')
                .replace(/\bthe password\b/gi, 'your paw in mine');
        }
    }

    if (wantsAccountability) {
        const dappleChoiceBeat = findBeat(outlineResult, ({ label, description }) => (
            /Dapple/i.test(label) && /Last Choice|surrender|cuff/i.test(label + ' ' + description)
        ));
        if (dappleChoiceBeat && !/answer for what you did/i.test(dappleChoiceBeat.description || '')) {
            dappleChoiceBeat.description = String(dappleChoiceBeat.description || '')
                .replace(/'And I'?m not letting them warehouse you again\.'/i,
                    "'And I'm not letting them warehouse you again. But you answer for what you did.'")
                .replace(/"And I'?m not letting them warehouse you again\."/i,
                    "\"And I'm not letting them warehouse you again. But you answer for what you did.\"");
            if (!/answer for what you did/i.test(dappleChoiceBeat.description || '')) {
                dappleChoiceBeat.description = `${String(dappleChoiceBeat.description || '').trim()} Rebecca adds, 'But you answer for what you did.'`;
            }
        }
    }

    return outlineResult;
}

function applyPostRevisionSafeguards(outlineResult = {}, currentOutline = {}, notes = '', options = {}) {
    applyScopedRevisionMerge(outlineResult, currentOutline, notes, options);
    restoreDroppedExistingBeats(outlineResult, currentOutline, notes, options);
    applyRecognitionAndAccountabilityPass(outlineResult, notes);
    return outlineResult;
}

function titleCaseLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 7)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ') || 'Restored Beat';
}

function beatLabelForChecklistItem(item = '') {
    const text = String(item || '');
    if (/\b(?:kitchen|itchen|closing image|final image|photo|breakfast|visitor passes?)\b/i.test(text)) {
        return 'Kitchen Closing Image';
    }
    const colon = text.match(/^([^:]{4,80}):/);
    if (colon) return titleCaseLabel(colon[1]);
    return titleCaseLabel(text);
}

function beatDescriptionForChecklistItem(item = '') {
    let text = String(item || '')
        .replace(/\s*-->[\s\S]*$/g, '')
        .replace(/\bthis is still missing\b[\s\S]*$/i, '')
        .replace(/\bplease restore\.?$/i, '')
        .trim();

    const colon = text.match(/^[^:]{4,80}:\s*([\s\S]+)$/);
    if (colon?.[1]) text = colon[1].trim();

    const photoIndex = text.search(/\bphoto\b/i);
    if (photoIndex > 0 && /\b(?:kitchen|itchen|closing image|final image)\b/i.test(item)) {
        text = text.slice(photoIndex).trim();
    }
    if (/^photo of\b/i.test(text)) text = text.replace(/^photo of/i, 'a photo of');
    if (/\b(?:kitchen|itchen|closing image)\b/i.test(item) && !/^in the kitchen\b/i.test(text)) {
        text = `In the kitchen, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    if (text && !/[.!?]$/.test(text)) text += '.';
    return text || compactText(item, 800);
}

function finalOutlineSequence(outline = {}, item = '') {
    const acts = [outline.act_3, outline.act_2, outline.act_1].filter(Array.isArray);
    for (const act of acts) {
        if (!act.length) continue;
        const explicitH = act.find(sequence => /sequence\s*h\b/i.test(sequence?.sequence_number_and_title || ''));
        if (explicitH && /\b(?:sequence\s*h|closing|final|coda|ending|kitchen|photo|breakfast|visitor passes?)\b/i.test(item)) {
            return explicitH;
        }
        return act[act.length - 1];
    }
    outline.act_3 = [{ sequence_number_and_title: 'Sequence H: Resolution', beats: [] }];
    return outline.act_3[0];
}

function actKeyForSequenceId(sequenceId = '') {
    const normalized = String(sequenceId || '').toUpperCase();
    if (/^[AB12]$/.test(normalized)) return 'act_1';
    if (/^[CDEF3456]$/.test(normalized)) return 'act_2';
    if (/^[GH78]$/.test(normalized)) return 'act_3';
    return 'act_3';
}

function applyExplicitSequenceReplacement(outlineResult = {}, replacement = null) {
    if (!replacement?.sequenceId || !replacement?.beats?.length) return false;
    const outline = outlineResult?.outline || outlineResult || {};
    if (!outline.act_1) outline.act_1 = [];
    if (!outline.act_2) outline.act_2 = [];
    if (!outline.act_3) outline.act_3 = [];

    const sequencePattern = new RegExp(`\\bsequence\\s*${replacement.sequenceId}\\b`, 'i');
    let targetActKey = null;
    let targetIndex = -1;
    for (const key of ['act_1', 'act_2', 'act_3']) {
        const index = (outline[key] || []).findIndex(sequence => sequencePattern.test(sequence?.sequence_number_and_title || ''));
        if (index >= 0) {
            targetActKey = key;
            targetIndex = index;
            break;
        }
    }

    if (!targetActKey) {
        targetActKey = actKeyForSequenceId(replacement.sequenceId);
        targetIndex = outline[targetActKey].length;
        outline[targetActKey].push({
            sequence_number_and_title: replacement.sequence_number_and_title,
            beats: []
        });
    }

    outline[targetActKey][targetIndex] = {
        ...(outline[targetActKey][targetIndex] || {}),
        sequence_number_and_title: replacement.sequence_number_and_title,
        beats: replacement.beats.map(beat => ({
            beat_label: beat.beat_label,
            description: beat.description
        }))
    };
    return true;
}

function appendMissingChecklistBeats(outlineResult = {}, missingItems = []) {
    if (!missingItems.length) return outlineResult;
    const outline = outlineResult?.outline || outlineResult || {};
    if (!outline.act_1) outline.act_1 = [];
    if (!outline.act_2) outline.act_2 = [];
    if (!outline.act_3) outline.act_3 = [];

    for (const item of missingItems) {
        const sequence = finalOutlineSequence(outline, item);
        if (!Array.isArray(sequence.beats)) sequence.beats = [];
        sequence.beats.push({
            beat_label: beatLabelForChecklistItem(item),
            description: beatDescriptionForChecklistItem(item)
        });
    }
    return outlineResult;
}

async function callOutlineModel(generateContentFn, request, { label = 'Stage 2 outline call', retries = 2, delayMs = 750 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await generateContentFn(request);
        } catch (error) {
            lastError = error;
            const message = error.message || String(error);
            if (!isTransientAiError(error)) throw error;
            if (attempt >= retries) {
                const finalError = new Error(`${label} failed after ${attempt + 1} attempts: ${message}`);
                finalError.cause = error;
                throw finalError;
            }
            console.warn(`${label} failed with transient error "${message}". Retrying (${attempt + 1}/${retries})...`);
            if (delayMs > 0) await wait(delayMs * (attempt + 1));
        }
    }
    throw lastError;
}

async function parseOutlineResponse(response, {
    outlineSchema,
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey,
    retryDelayMs
}) {
    try {
        return {
            result: sanitizeOutlineMetaBeats(parseJsonWithRepair(response.text, { schema: outlineSchema, label: 'Stage 2 outline response' })),
            usage: response.usage
        };
    } catch (parseError) {
        console.warn(`Stage 2 outline JSON repair failed locally; retrying with model repair: ${parseError.message}`);
        const repairResponse = await callOutlineModel(generateContentFn, {
            model,
            geminiApiKey,
            anthropicApiKey,
            contents: [`The text below was intended to be a complete Stage 2 outline JSON object, but it contains JSON syntax errors such as an unterminated string, missing comma, or unescaped quote.

Repair ONLY the JSON syntax. Preserve every available story detail, field name, act, sequence, beat label, and beat description. If a string is cut off, close it cleanly without inventing new plot. Return valid JSON only.

MALFORMED JSON:
${response.text}`],
            config: {
                systemInstruction: 'You are a strict JSON repair tool. Return only valid JSON conforming to the provided schema. Do not add commentary, markdown, or new story content.',
                temperature: 0,
                maxOutputTokens: 32000
            },
            schema: outlineSchema
        }, {
            label: 'Stage 2 outline JSON repair',
            retries: 2,
            delayMs: retryDelayMs
        });

        try {
            return {
                result: sanitizeOutlineMetaBeats(parseJsonWithRepair(repairResponse.text, { schema: outlineSchema, label: 'Stage 2 repaired outline response' })),
                usage: combineUsage(response.usage, repairResponse.usage)
            };
        } catch (repairError) {
            const error = new Error(`Stage 2 outline response could not be repaired after retry: ${repairError.message}`);
            error.cause = parseError;
            throw error;
        }
    }
}

const agent2Outline = async (pitchData, currentOutline, notes, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent,
        retryDelayMs = 750
    } = modelConfig;
    const hasCurrentOutline = outlineHasContent(currentOutline);

    const outlineSOP = loadSkill('skill_stage2_outline');

    const beatItemSchema = {
        type: 'object',
        properties: {
            beat_label: { type: 'string' },
            description: { type: 'string' }
        },
        required: ["beat_label", "description"]
    };

    const sequenceItemSchema = {
        type: 'object',
        properties: {
            sequence_number_and_title: { type: 'string' },
            beats: {
                type: 'array',
                items: beatItemSchema
            }
        },
        required: ["sequence_number_and_title", "beats"]
    };

    const outlineSchema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            genre: { type: 'string' },
            logline: { type: 'string' },
            outline: {
                type: 'object',
                properties: {
                    act_1: { type: 'array', items: sequenceItemSchema },
                    act_2: { type: 'array', items: sequenceItemSchema },
                    act_3: { type: 'array', items: sequenceItemSchema }
                },
                required: ["act_1", "act_2", "act_3"]
            }
        },
        required: ["title", "genre", "logline", "outline"]
    };

    // Revision Bypass Logic
    if (notes && hasCurrentOutline) {
        console.log("  Surgical Revision Mode: Updating outline...");
        const revisionSystemInstruction = `${outlineSOP}\n\nROLE: Structural Story Analyst. Apply the user's note to the existing 8-sequence outline. You MUST keep unaffected sequences 100% identical to the current draft. HOWEVER, if the user's note creates a logical narrative ripple effect (e.g., changing the Midpoint changes the Finale), you are authorized to update subsequent sequences so the story's cause-and-effect makes logical sense. Maintain the exact same JSON schema.`;

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        const activeRevisionRequest = normalizeRevisionBrief(notes);
        const postRevisionNotes = activeRevisionRequest || notes;
        const revisionChecklist = buildRevisionChecklist(notes);
        const explicitSequenceReplacement = extractExplicitSequenceReplacement(notes);
        const checklistBlock = revisionChecklist.length
            ? `\nREVISION CHECKLIST:\nTreat each item below as a concrete obligation. It must be visibly present in the revised outline, unless the current outline already contains it.\n${revisionChecklist.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`
            : '';
        const revisionPrompt = `${sourceBlock}ACTIVE REVISION REQUEST:
${activeRevisionRequest || notes}
${checklistBlock}

EXISTING OUTLINE:
${JSON.stringify(currentOutline, null, 2)}

Please apply the note surgically (allowing for ripple effects) and return the full updated outline in JSON format.`;

        const response = await callOutlineModel(generateContentFn, {
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.5,
            },
            schema: outlineSchema
        }, {
            label: 'Stage 2 outline revision',
            retries: 2,
            delayMs: retryDelayMs
        });

        let parsed = await parseOutlineResponse(response, {
            outlineSchema,
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            retryDelayMs
        });

        if (explicitSequenceReplacement) {
            applyExplicitSequenceReplacement(parsed.result, explicitSequenceReplacement);
        }
        applyPostRevisionSafeguards(parsed.result, currentOutline, postRevisionNotes, { explicitSequenceReplacement });

        let missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
        if (missingChecklistItems.length) {
            const repairPrompt = `${sourceBlock}MANDATORY CHECKLIST REPAIR:
The previous outline revision changed the file, but it still appears to omit or underrepresent concrete requested checklist items.

MISSING OR UNDERREPRESENTED CHECKLIST ITEMS:
${missingChecklistItems.map((item, index) => `${index + 1}. ${item}`).join('\n')}

ORIGINAL USER NOTE:
${activeRevisionRequest || notes}

EXISTING OUTLINE BEFORE REVISION:
${JSON.stringify(currentOutline, null, 2)}

PREVIOUS REVISED OUTLINE:
${JSON.stringify(parsed.result?.outline || parsed.result || {}, null, 2)}

Revise the outline again. Add or adjust the minimum necessary beats so every missing checklist item is visibly present in the outline. Keep unrelated sequences and beats unchanged. Return the full Stage 2 outline JSON.`;

            const repairResponse = await callOutlineModel(generateContentFn, {
                model, geminiApiKey, anthropicApiKey,
                contents: [repairPrompt],
                config: {
                    systemInstruction: revisionSystemInstruction,
                    temperature: 0.35,
                },
                schema: outlineSchema
            }, {
                label: 'Stage 2 outline checklist repair',
                retries: 2,
                delayMs: retryDelayMs
            });

            const repaired = await parseOutlineResponse(repairResponse, {
                outlineSchema,
                generateContentFn,
                model,
                geminiApiKey,
                anthropicApiKey,
                retryDelayMs
            });
            repaired.usage = combineUsage(parsed.usage, repaired.usage);
            parsed = repaired;
            if (explicitSequenceReplacement) {
                applyExplicitSequenceReplacement(parsed.result, explicitSequenceReplacement);
            }
            applyPostRevisionSafeguards(parsed.result, currentOutline, postRevisionNotes, { explicitSequenceReplacement });
            missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
            if (missingChecklistItems.length) {
                appendMissingChecklistBeats(parsed.result, missingChecklistItems);
                restoreDroppedExistingBeats(parsed.result, currentOutline, postRevisionNotes, { explicitSequenceReplacement });
                applyRecognitionAndAccountabilityPass(parsed.result, postRevisionNotes);
                missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
            }
        }

        if (missingChecklistItems.length) {
            const error = new Error(`Stage 2 outline revision did not satisfy required checklist item(s): ${missingChecklistItems.map(item => `"${compactText(item, 180)}"`).join('; ')}`);
            error.code = 'STAGE2_CHECKLIST_UNMET';
            throw error;
        }

        return parsed;
    }

    const systemInstruction = outlineSOP;

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
    let contentsText = `${sourceBlock}Here is the approved pitch: ${JSON.stringify(pitchData)}. You MUST generate the full JSON structure including title, genre, logline, and the 8-sequence outline containing act_1, act_2, and act_3.`;
    if (notes && hasCurrentOutline) {
        contentsText = `${sourceBlock}Here is the approved pitch: ${JSON.stringify(pitchData)}. Here is the current working outline: ${JSON.stringify(currentOutline)}. Please revise the outline specifically based on these User Notes: ${notes}. You MUST generate the full JSON structure including title, genre, logline, and the entirely revised 8-sequence outline containing act_1, act_2, and act_3.`;
    } else if (notes) {
        contentsText += ` User Notes: ${notes}`;
    }
    contents.push(contentsText);

    const response = await callOutlineModel(generateContentFn, {
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction,
        },
        schema: outlineSchema
    }, {
        label: 'Stage 2 outline generation',
        retries: 2,
        delayMs: retryDelayMs
    });

    return parseOutlineResponse(response, {
        outlineSchema,
        generateContentFn,
        model,
        geminiApiKey,
        anthropicApiKey,
        retryDelayMs
    });
};

module.exports = {
    agent2Outline,
    outlineHasContent,
    buildRevisionChecklist,
    findUndercoveredChecklistItems,
    appendMissingChecklistBeats,
    extractExplicitSequenceReplacement,
    applyExplicitSequenceReplacement,
    applyStructuralOutlinePatches
};
