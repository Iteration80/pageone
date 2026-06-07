const crypto = require('crypto');

const STAGE_ARTIFACTS = {
    1: { stage: 1, stageKey: 'stage1_pitch', stageName: 'Pitch' },
    2: { stage: 2, stageKey: 'stage2_outline', stageName: 'Outline' },
    3: { stage: 3, stageKey: 'stage3_characters', stageName: 'Characters' },
    4: { stage: 4, stageKey: 'stage4_beats', stageName: 'Beats' },
    5: { stage: 5, stageKey: 'stage5_treatment', stageName: 'Treatment' },
    6: { stage: 6, stageKey: 'stage6_scenes', stageName: 'Scenes' },
    7: { stage: 7, stageKey: 'stage7_style', stageName: 'Style' },
    8: { stage: 8, stageKey: 'stage6_scenes', stageName: 'Draft' },
    9: { stage: 9, stageKey: 'stage8_coverage', stageName: 'Coverage' },
    10: { stage: 10, stageKey: 'stage9_rewrites', stageName: 'Rewrite' }
};

const DATA_KEY_TO_STAGE = {
    stage1_pitch: 1,
    stage2_outline: 2,
    stage3_characters: 3,
    stage4_beats: 4,
    stage4_treatment: 4,
    stage5_treatment: 5,
    stage6_scenes: 6,
    stage7_style: 7,
    stage8_coverage: 9,
    stage9_rewrites: 10
};

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function artifactHash(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(value ?? null))
        .digest('hex')
        .slice(0, 20);
}

function hasSnapshotValue(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function stageConfig(stageOrKey) {
    const stage = typeof stageOrKey === 'string' && DATA_KEY_TO_STAGE[stageOrKey]
        ? DATA_KEY_TO_STAGE[stageOrKey]
        : Number(stageOrKey);
    return STAGE_ARTIFACTS[stage] || null;
}

function snapshotForStage(projectData = {}, stageOrKey) {
    const config = stageConfig(stageOrKey);
    if (!config) return null;
    const data = projectData.data || {};
    if (config.stage === 4) return cloneValue(data.stage4_beats || data.stage4_treatment || null);
    return cloneValue(data[config.stageKey]);
}

function snapshotTypeLabel(type = '') {
    return String(type || 'working')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function pruneVersionHistory(history = [], { perStageWorkingLimit = 25 } = {}) {
    const grouped = new Map();
    for (const entry of history) {
        const stage = Number(entry.stage || 0);
        if (!grouped.has(stage)) grouped.set(stage, []);
        grouped.get(stage).push(entry);
    }

    const keep = [];
    for (const entries of grouped.values()) {
        const alwaysKeep = [];
        const working = [];
        for (const entry of entries) {
            const type = entry.snapshotType || 'approved';
            if (entry.pinned || type === 'approved' || type === 'exported') alwaysKeep.push(entry);
            else working.push(entry);
        }
        working.sort((a, b) => new Date(b.createdAt || b.approvedAt || 0) - new Date(a.createdAt || a.approvedAt || 0));
        keep.push(...alwaysKeep, ...working.slice(0, perStageWorkingLimit));
    }

    return keep.sort((a, b) => new Date(a.createdAt || a.approvedAt || 0) - new Date(b.createdAt || b.approvedAt || 0));
}

function appendArtifactSnapshot(projectData, {
    projectId = projectData?.id || '',
    stage,
    stageKey,
    stageName,
    snapshot,
    snapshotType = 'working',
    reason = '',
    note = '',
    revisionReceipt = null,
    force = false
} = {}) {
    const config = stageConfig(stage || stageKey);
    const resolvedStage = Number(stage || config?.stage);
    const resolvedStageKey = stageKey || config?.stageKey;
    const resolvedStageName = stageName || config?.stageName || `Stage ${resolvedStage}`;
    if (!resolvedStage || !resolvedStageKey || !hasSnapshotValue(snapshot)) return null;

    projectData.data = projectData.data || {};
    const history = Array.isArray(projectData.data.versionHistory)
        ? projectData.data.versionHistory
        : [];
    const snapshotClone = cloneValue(snapshot);
    const snapshotHash = artifactHash(snapshotClone);
    const lastSameType = [...history]
        .reverse()
        .find(entry => Number(entry.stage) === resolvedStage && (entry.snapshotType || 'approved') === snapshotType);
    if (!force && lastSameType?.snapshotHash === snapshotHash) {
        projectData.data.versionHistory = history;
        return null;
    }

    const version = history
        .filter(entry => Number(entry.stage) === resolvedStage)
        .reduce((max, entry) => Math.max(max, Number(entry.version) || 0), 0) + 1;
    const createdAt = new Date().toISOString();
    const entry = {
        id: `${projectId || 'project'}_stage${resolvedStage}_${snapshotType}_${createdAt.replace(/[^0-9]/g, '')}_${version}`,
        stage: resolvedStage,
        stageKey: resolvedStageKey,
        stageName: resolvedStageName,
        version,
        snapshotType,
        label: snapshotTypeLabel(snapshotType),
        createdAt,
        approvedAt: createdAt,
        snapshotHash,
        reason,
        note,
        snapshot: snapshotClone
    };
    if (revisionReceipt) entry.revisionReceipt = cloneValue(revisionReceipt);

    history.push(entry);
    projectData.data.versionHistory = pruneVersionHistory(history);
    return entry;
}

function recordStageMutationSnapshots(projectData, {
    projectId = projectData?.id || '',
    stage,
    before,
    after,
    operation = 'revision',
    note = '',
    revisionReceipt = null
} = {}) {
    const beforeHash = artifactHash(before);
    const afterHash = artifactHash(after);
    if (beforeHash === afterHash) return [];

    const entries = [];
    const preType = `pre_${operation}`;
    const postType = `post_${operation}`;
    const pre = appendArtifactSnapshot(projectData, {
        projectId,
        stage,
        snapshot: before,
        snapshotType: preType,
        reason: operation,
        note
    });
    if (pre) entries.push(pre);
    const post = appendArtifactSnapshot(projectData, {
        projectId,
        stage,
        snapshot: after,
        snapshotType: postType,
        reason: operation,
        note,
        revisionReceipt,
        force: true
    });
    if (post) entries.push(post);
    return entries;
}

function changedStageKeysFromUpdate(dataUpdate = {}) {
    return Object.keys(dataUpdate)
        .filter(key => key !== 'versionHistory' && DATA_KEY_TO_STAGE[key]);
}

module.exports = {
    STAGE_ARTIFACTS,
    DATA_KEY_TO_STAGE,
    appendArtifactSnapshot,
    artifactHash,
    changedStageKeysFromUpdate,
    hasSnapshotValue,
    pruneVersionHistory,
    recordStageMutationSnapshots,
    snapshotForStage,
    stageConfig,
    snapshotTypeLabel
};
