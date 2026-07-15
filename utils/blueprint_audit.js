const QUIET_FUNCTIONS = new Set([
    'aftermath',
    'setup-plant',
    'irony-marination',
    'tonal-reset',
    'transition',
    'pressure-valve'
]);

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
    'has', 'have', 'he', 'her', 'his', 'in', 'into', 'is', 'it', 'its', 'of',
    'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'then', 'there',
    'they', 'this', 'to', 'up', 'was', 'we', 'with', 'who', 'what', 'when',
    'where', 'why', 'how', 'scene', 'sequence', 'function', 'dramatic',
    'audience', 'character', 'characters', 'story'
]);

const STC_BEATS = [
    'opening image',
    'theme stated',
    'set-up',
    'setup',
    'catalyst',
    'debate',
    'break into two',
    'b story',
    'fun and games',
    'midpoint',
    'bad guys close in',
    'all is lost',
    'dark night of the soul',
    'break into three',
    'finale',
    'final image'
];

const EVENT_JOB_PATTERNS = [
    /\breveal(?:s|ed|ing)?\b/i,
    /\bbetray(?:s|ed|al|ing)?\b/i,
    /\bescape(?:s|d|ing)?\b/i,
    /\bdiscover(?:s|ed|y|ing)?\b/i,
    /\bcapture(?:s|d|ing)?\b/i,
    /\bconfront(?:s|ed|ation|ing)?\b/i,
    /\bconfess(?:es|ed|ion|ing)?\b/i,
    /\bexpose(?:s|d|ing)?\b/i,
    /\bpay(?:s)? off\b/i,
    /\bset(?:s)? up\b/i,
    /\brescue(?:s|d|ing)?\b/i,
    /\bchoose(?:s|n)?\b|\bchoice\b/i,
    /\bsacrifice(?:s|d|ing)?\b/i,
    /\btransform(?:s|ed|ation|ing)?\b/i
];

function markerValue(text, marker) {
    const pattern = new RegExp(`^\\s*${marker}\\s*:\\s*(.+?)\\s*$`, 'im');
    const match = String(text || '').match(pattern);
    return match ? match[1].trim() : null;
}

function parseFunctionDeclarations(scene = {}) {
    const text = String(scene.dramaturgical_function || '');
    const quiet = markerValue(text, 'QUIET FUNCTION');
    const quietFunction = quiet && QUIET_FUNCTIONS.has(quiet.toLowerCase())
        ? quiet.toLowerCase()
        : null;
    return {
        valueShift: markerValue(text, 'VALUE SHIFT'),
        quietFunction,
        setsUp: markerValue(text, 'SETS UP'),
        paysOff: markerValue(text, 'PAYS OFF'),
        uniqueJob: markerValue(text, 'UNIQUE JOB')
    };
}

function normalizeSequences(input) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input?.sequences)) return input.sequences;
    if (Array.isArray(input?.scenes)) return [{ sequence_title: 'Blueprint', scenes: input.scenes }];
    return [];
}

function flattenScenes(sequences = []) {
    const flat = [];
    let fallbackSceneNumber = 1;
    normalizeSequences(sequences).forEach((sequence, sequenceIndex) => {
        if (!Array.isArray(sequence?.scenes)) return;
        sequence.scenes.forEach((scene) => {
            flat.push({
                scene,
                scene_number: Number(scene?.scene_number) || fallbackSceneNumber,
                sequence_number: Number(sequence.sequence_number) || sequenceIndex + 1,
                sequence_title: sequence.sequence_title || sequence.title || sequence.name || `Sequence ${sequenceIndex + 1}`
            });
            fallbackSceneNumber += 1;
        });
    });
    return flat;
}

function tokenize(text = '') {
    return Array.from(new Set(String(text || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9+\- ]+/g, ' ')
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token.length >= 3 && !STOPWORDS.has(token))));
}

function jaccard(tokensA = [], tokensB = []) {
    const a = new Set(tokensA);
    const b = new Set(tokensB);
    if (!a.size || !b.size) return { similarity: 0, sharedTerms: [] };
    const sharedTerms = Array.from(a).filter(token => b.has(token));
    const unionSize = new Set([...a, ...b]).size;
    return {
        similarity: sharedTerms.length / unionSize,
        sharedTerms
    };
}

function formatSceneLabel(item) {
    const heading = item?.scene?.scene_heading || item?.scene?.slugline || '';
    return `Scene ${item.scene_number}${heading ? ` - ${heading}` : ''}`;
}

function candidateId(candidate = {}) {
    const counterpart = candidate.counterpart_scene ? `:${candidate.counterpart_scene}` : '';
    return `${candidate.type}:${candidate.scene_number}${counterpart}`;
}

function nominateRedundant(sequences = [], { threshold = 0.55, maxPairs = 20 } = {}) {
    const flat = flattenScenes(sequences)
        .map(item => ({
            ...item,
            tokens: tokenize(item.scene?.dramaturgical_function || '')
        }))
        .filter(item => item.tokens.length >= 5);
    const pairs = [];

    for (let i = 0; i < flat.length; i += 1) {
        for (let j = i + 1; j < flat.length; j += 1) {
            const comparison = jaccard(flat[i].tokens, flat[j].tokens);
            if (comparison.similarity < threshold) continue;
            pairs.push({
                type: 'redundant',
                scene_number: flat[j].scene_number,
                counterpart_scene: flat[i].scene_number,
                scene: flat[j].scene,
                counterpart: flat[i].scene,
                similarity: Number(comparison.similarity.toFixed(3)),
                sharedTerms: comparison.sharedTerms.slice(0, 12),
                evidence: `${formatSceneLabel(flat[j])} appears to repeat ${formatSceneLabel(flat[i])}; token overlap ${comparison.similarity.toFixed(2)} (${comparison.sharedTerms.slice(0, 8).join(', ')}).`,
                parsedDeclarations: parseFunctionDeclarations(flat[j].scene),
                counterpartDeclarations: parseFunctionDeclarations(flat[i].scene)
            });
        }
    }

    return pairs
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxPairs);
}

function nominateNoShift(sequences = []) {
    return flattenScenes(sequences)
        .filter(item => {
            const declarations = parseFunctionDeclarations(item.scene);
            if (declarations.valueShift || declarations.quietFunction) return false;
            return !/\bVALUE SHIFT\b/i.test(String(item.scene?.dramaturgical_function || ''));
        })
        .map(item => ({
            type: 'no_shift',
            scene_number: item.scene_number,
            scene: item.scene,
            evidence: `${formatSceneLabel(item)} declares neither VALUE SHIFT nor QUIET FUNCTION.`,
            parsedDeclarations: parseFunctionDeclarations(item.scene)
        }));
}

function countOverloadJobs(functionText = '') {
    const text = String(functionText || '');
    const lower = text.toLowerCase();
    const namedStcBeats = STC_BEATS.filter(beat => lower.includes(beat));
    const eventJobs = EVENT_JOB_PATTERNS
        .map(pattern => (pattern.source.match(/\\b([a-z]+)/i) || [])[1] || pattern.source)
        .filter((_, index) => EVENT_JOB_PATTERNS[index].test(text));

    return {
        count: new Set([...namedStcBeats, ...eventJobs]).size,
        namedStcBeats,
        eventJobs: Array.from(new Set(eventJobs))
    };
}

function nominateOverloaded(sequences = []) {
    return flattenScenes(sequences)
        .map(item => ({
            item,
            jobs: countOverloadJobs(item.scene?.dramaturgical_function || '')
        }))
        .filter(({ jobs }) => jobs.count >= 3)
        .map(({ item, jobs }) => ({
            type: 'overloaded',
            scene_number: item.scene_number,
            scene: item.scene,
            jobCount: jobs.count,
            evidence: `${formatSceneLabel(item)} appears to carry ${jobs.count} distinct dramatic jobs (${[...jobs.namedStcBeats, ...jobs.eventJobs].slice(0, 8).join(', ')}).`,
            parsedDeclarations: parseFunctionDeclarations(item.scene)
        }));
}

function nominateAll(sequences = [], options = {}) {
    const merged = [
        ...nominateRedundant(sequences, options),
        ...nominateNoShift(sequences),
        ...nominateOverloaded(sequences)
    ];
    const byId = new Map();
    for (const candidate of merged) {
        if (!byId.has(candidateId(candidate))) byId.set(candidateId(candidate), candidate);
    }
    return Array.from(byId.values());
}

function stableBlueprintForAudit(sequences = []) {
    return normalizeSequences(sequences).map((sequence, sequenceIndex) => ({
        sequence_number: Number(sequence?.sequence_number) || sequenceIndex + 1,
        sequence_title: sequence?.sequence_title || sequence?.title || sequence?.name || '',
        scenes: Array.isArray(sequence?.scenes)
            ? sequence.scenes.map((scene, sceneIndex) => ({
                scene_number: Number(scene?.scene_number) || sceneIndex + 1,
                scene_heading: scene?.scene_heading || scene?.slugline || '',
                narrative_action: scene?.narrative_action || '',
                dramaturgical_function: scene?.dramaturgical_function || '',
                estimated_page_count: scene?.estimated_page_count ?? ''
            }))
            : []
    }));
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashText(text = '') {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `s6a_${hash.toString(16).padStart(8, '0')}`;
}

function hashBlueprintScenes(sequences = []) {
    return hashText(stableStringify(stableBlueprintForAudit(sequences)));
}

function auditFlagKey(flag = {}) {
    return `${flag.type}:${Number(flag.scene_number) || 0}:${Number(flag.counterpart_scene) || 0}`;
}

function mergeDismissedFlags(previousAudit = {}, flags = []) {
    const dismissed = new Set((previousAudit.flags || [])
        .filter(flag => flag?.dismissed)
        .map(auditFlagKey));
    return flags.map(flag => ({
        ...flag,
        dismissed: dismissed.has(auditFlagKey(flag)) || flag.dismissed === true
    }));
}

function visibleAuditFlags(audit = {}) {
    return Array.isArray(audit?.flags)
        ? audit.flags.filter(flag => flag && !flag.dismissed)
        : [];
}

function formatAuditFlagsForCoverage(audit = {}) {
    const flags = visibleAuditFlags(audit);
    if (!flags.length) return '';
    const lines = flags.map(flag => {
        const type = String(flag.type || '').toUpperCase();
        const counterpart = flag.counterpart_scene ? ` with Scene ${flag.counterpart_scene}` : '';
        const evidence = String(flag.evidence || flag.failed_defense || '').replace(/\s+/g, ' ').trim();
        return `- Scene ${flag.scene_number} ${type}${counterpart}: ${evidence}`;
    });
    return `BLUEPRINT-STAGE DRAMATURGICAL FLAGS (adjudicated, writer has not dismissed):\n${lines.join('\n')}`;
}

function formatAuditSummaryForAssistant(audit = {}) {
    const flags = visibleAuditFlags(audit);
    if (!flags.length) return '';
    const counts = flags.reduce((acc, flag) => {
        acc[flag.type] = (acc[flag.type] || 0) + 1;
        return acc;
    }, {});
    const parts = ['redundant', 'no_shift', 'overloaded']
        .filter(type => counts[type])
        .map(type => `${counts[type]} ${type.replace('_', ' ')}`);
    return `Stage 6 dramaturgical audit has ${flags.length} active advisory flag${flags.length === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

module.exports = {
    QUIET_FUNCTIONS,
    parseFunctionDeclarations,
    flattenScenes,
    tokenize,
    nominateRedundant,
    nominateNoShift,
    nominateOverloaded,
    nominateAll,
    countOverloadJobs,
    stableBlueprintForAudit,
    hashBlueprintScenes,
    auditFlagKey,
    mergeDismissedFlags,
    visibleAuditFlags,
    formatAuditFlagsForCoverage,
    formatAuditSummaryForAssistant
};
