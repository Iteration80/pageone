require('dotenv').config();
const { setGlobalDispatcher, Agent } = require('undici');
setGlobalDispatcher(new Agent({ headersTimeout: 300_000, bodyTimeout: 300_000 }));
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
    BUILD_COMMIT,
    BUILD_DEPLOYMENT_ID,
    BUILD_TIMESTAMP,
    getBuildInfo
} = require('./utils/build_info');
const { loadSkill } = require('./utils/skills_cache');

// ─── Storage paths ───────────────────────────────────────────────────────────
const BUNDLED_DATA_ROOT = path.join(__dirname, 'data');
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || BUNDLED_DATA_ROOT);
const SETTINGS_PATH = path.join(DATA_ROOT, 'settings.json');
const DATA_DIR = path.join(DATA_ROOT, 'projects');
const STYLES_DIR = path.join(DATA_ROOT, 'styles');
const BUNDLED_STYLES_DIR = path.join(BUNDLED_DATA_ROOT, 'styles');
const SOURCE_FILES_DIR = path.join(DATA_ROOT, 'source-files');

// ─── Input validation helpers ─────────────────────────────────────────────────

/** Validate a project ID: must be a 13–14 digit numeric timestamp string. */
function isValidProjectId(id) {
    return typeof id === 'string' && /^\d{13,14}$/.test(id);
}

/** Validate a style slug: lowercase alphanumeric, hyphens, underscores only. */
function isValidSlug(slug) {
    return typeof slug === 'string' && /^[a-z0-9_-]+$/.test(slug) && slug.length <= 200;
}

/** Resolve a path and verify it stays within the expected base directory. */
async function safePath(base, ...parts) {
    const joined = path.join(base, ...parts);
    // Resolve symlinks and check the real path stays inside base
    const realBase = await fs.realpath(base).catch(() => base);
    let realJoined;
    try {
        realJoined = await fs.realpath(joined);
    } catch {
        // File doesn't exist yet — check the resolved parent
        realJoined = path.resolve(joined);
    }
    if (!realJoined.startsWith(realBase + path.sep) && realJoined !== realBase) {
        throw new Error('Path escape attempt');
    }
    return joined;
}

/** Safe JSON.parse that returns null on failure instead of throwing. */
function safeParse(str, fallback = null) {
    if (typeof str !== 'string') return str ?? fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

function stage2ProtectedBeatEntriesForRequest(projectData = {}, rawProtectedBeats) {
    const hasRequestValue = rawProtectedBeats !== undefined;
    const source = hasRequestValue
        ? safeParse(rawProtectedBeats, [])
        : projectData.data?.stage2_outline?.protected_beats || [];
    return normalizeProtectedBeats(source);
}

class ApiError extends Error {
    constructor(statusCode, message, { code = '', expose = statusCode < 500 } = {}) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.expose = expose;
    }
}

class BadRequestError extends ApiError {
    constructor(message = 'Bad request', options = {}) {
        super(400, message, { code: 'BAD_REQUEST', ...options });
    }
}

class NotFoundError extends ApiError {
    constructor(message = 'Not found', options = {}) {
        super(404, message, { code: 'NOT_FOUND', ...options });
    }
}

class RateLimitError extends ApiError {
    constructor(message = 'Too many requests', options = {}) {
        super(429, message, { code: 'RATE_LIMITED', ...options });
    }
}

function publicErrorDetail(error, maxChars = 900) {
    const message = String(error?.message || '').trim();
    if (!message) return '';
    return message
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/AIza[0-9A-Za-z_-]+/g, '[redacted]')
        .slice(0, maxChars);
}

function statusCodeForError(error) {
    const explicit = Number(error?.statusCode || error?.status);
    if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
    if (error?.code === 'ENOENT') return 404;
    return 500;
}

function sendApiError(res, error, fallbackMessage = 'Request failed') {
    const statusCode = statusCodeForError(error);
    const hasExplicitStatus = Number.isInteger(Number(error?.statusCode || error?.status));
    const expose = error instanceof ApiError ? error.expose : (hasExplicitStatus && statusCode < 500);
    const message = expose && error?.message ? error.message : fallbackMessage;
    const body = { error: message };
    if (error instanceof ApiError && error.code) body.code = error.code;
    return res.status(statusCode).json(body);
}

function assertValidProjectId(id, message = 'Invalid project ID') {
    if (!isValidProjectId(id)) throw new BadRequestError(message);
}

function assertValidSourceId(sourceId, message = 'Invalid source ID') {
    if (!/^src_[a-zA-Z0-9_]+$/.test(String(sourceId || ''))) throw new BadRequestError(message);
}

async function assertProjectExists(id, message = 'Project not found') {
    try {
        await fs.access(getProjectFilePath(id));
    } catch (error) {
        if (error.code === 'ENOENT') throw new NotFoundError(message);
        throw error;
    }
}

async function readProjectJSONById(id, {
    invalidMessage = 'Invalid project ID',
    notFoundMessage = 'Project not found'
} = {}) {
    assertValidProjectId(id, invalidMessage);
    try {
        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') throw new NotFoundError(notFoundMessage);
        throw error;
    }
}

function isClientAbortError(error) {
    return error?.code === 'CLIENT_DISCONNECTED' || error?.name === 'AbortError';
}

function throwIfClientAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Client disconnected');
    error.code = 'CLIENT_DISCONNECTED';
    throw error;
}

function createClientAbortTracker(res, label = 'streaming request') {
    const controller = new AbortController();
    let completed = false;
    const abort = () => {
        if (completed || res.writableEnded || controller.signal.aborted) return;
        const error = new Error('Client disconnected');
        error.code = 'CLIENT_DISCONNECTED';
        controller.abort(error);
        console.warn(`${label}: client disconnected; aborting in-flight work.`);
    };
    res.on('close', abort);
    return {
        signal: controller.signal,
        markComplete() {
            completed = true;
            res.off?.('close', abort);
        },
        throwIfAborted() {
            throwIfClientAborted(controller.signal);
        }
    };
}

function withAbortSignal(modelConfig = {}, signal = null) {
    if (!signal) return modelConfig;
    const baseGenerateContent = modelConfig.generateContentFn || generateContent;
    return {
        ...modelConfig,
        abortSignal: signal,
        generateContentFn: async (request = {}) => {
            throwIfClientAborted(signal);
            return baseGenerateContent({
                ...request,
                config: {
                    ...(request.config || {}),
                    abortSignal: signal
                }
            });
        }
    };
}

/**
 * Atomic file write — writes to a temp file in the same directory, then renames.
 * Prevents corruption from concurrent writes or interrupted I/O.
 */
async function atomicWriteFile(targetPath, data) {
    const dir = path.dirname(targetPath);
    const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, targetPath);
}

/** Shorthand: atomic JSON write with pretty-printing. */
async function atomicWriteJSON(targetPath, obj) {
    await atomicWriteFile(targetPath, JSON.stringify(obj, null, 2));
}

// ─── Project write queue ─────────────────────────────────────────────────────
const projectWriteQueues = new Map();

function getProjectFilePath(projectId) {
    return path.join(DATA_DIR, `${projectId}.json`);
}

function projectIdFromPath(filePath) {
    const parsed = path.parse(filePath);
    if (path.resolve(parsed.dir) !== path.resolve(DATA_DIR)) return null;
    return isValidProjectId(parsed.name) ? parsed.name : null;
}

async function withProjectWriteLock(projectId, task) {
    if (!isValidProjectId(projectId)) return task();
    const previous = projectWriteQueues.get(projectId) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    projectWriteQueues.set(projectId, run);
    run.finally(() => {
        if (projectWriteQueues.get(projectId) === run) {
            projectWriteQueues.delete(projectId);
        }
    }).catch(() => {});
    return run;
}

async function writeProjectJSON(projectId, projectData) {
    await withProjectWriteLock(projectId, async () => {
        await atomicWriteJSON(getProjectFilePath(projectId), projectData);
    });
}

async function writeJSONQueued(targetPath, obj) {
    const projectId = projectIdFromPath(targetPath);
    if (projectId) return writeProjectJSON(projectId, obj);
    return atomicWriteJSON(targetPath, obj);
}

async function updateProjectJSON(projectId, updater) {
    return withProjectWriteLock(projectId, async () => {
        const filePath = getProjectFilePath(projectId);
        const raw = await fs.readFile(filePath, 'utf-8');
        const project = JSON.parse(raw);
        const updated = await updater(project, filePath);
        const nextProject = updated || project;
        await atomicWriteJSON(filePath, nextProject);
        return nextProject;
    });
}

/** Extracts plain text from a chat attachment ({ name, mimeType, data: base64 }). */
async function extractAttachmentText(attachment) {
    if (!attachment?.data) return '';
    const buf = Buffer.from(attachment.data, 'base64');
    const name = (attachment.name || '').toLowerCase();
    const mime = (attachment.mimeType || '').toLowerCase();
    try {
        if (mime === 'text/plain' || mime === 'text/markdown' || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.fountain')) {
            return buf.toString('utf8');
        }
        if (name.endsWith('.fdx')) {
            const { parseFdx } = require('./utils/script-import');
            const parsed = parseFdx(buf.toString('utf8'));
            const parts = [];
            if (parsed.title) parts.push(`Title: ${parsed.title}`);
            if (parsed.scenes?.length) {
                parts.push(parsed.scenes.map(scene => scene.text || scene.scene_heading || '').filter(Boolean).join('\n\n'));
            }
            return parts.join('\n\n');
        }
        if (mime === 'application/pdf' || name.endsWith('.pdf')) {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buf);
            return parsed.text;
        }
        if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: buf });
            return result.value;
        }
    } catch (e) {
        console.error('Attachment extraction error:', e.message);
    }
    return '';
}

// ─── Settings (BYOK + per-stage model config) ─────────────────────────────────
let appSettings = {};

async function loadSettings() {
    try {
        const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
        appSettings = JSON.parse(raw);
        console.log(`Settings loaded from ${SETTINGS_PATH}`);
    } catch {
        appSettings = {}; // file doesn't exist yet — fall back to .env
    }
}

const APP_SECRET = process.env.APP_SECRET;
const RUNTIME_API_KEYS_ENABLED = process.env.ALLOW_RUNTIME_API_KEYS === 'true' || (!APP_SECRET && process.env.ALLOW_RUNTIME_API_KEYS !== 'false');

/** Returns the model + API keys to use for a given stage number (1–10). */
function getModelConfig(stageNum) {
    return {
        model: appSettings.stageModels?.[`stage${stageNum}`] || process.env.GEMINI_MODEL,
        geminiApiKey: (RUNTIME_API_KEYS_ENABLED && appSettings.geminiApiKey) || process.env.GEMINI_API_KEY,
        anthropicApiKey: (RUNTIME_API_KEYS_ENABLED && appSettings.anthropicApiKey) || process.env.ANTHROPIC_API_KEY
    };
}

function getAssistantModelConfig(stageNum = 1) {
    const config = getModelConfig(stageNum);
    const explicitModel = appSettings.brainstormModel || process.env.BRAINSTORM_MODEL;
    if (explicitModel) return { ...config, model: explicitModel };
    if (config.geminiApiKey) return { ...config, model: 'gemini-3-flash-preview' };
    if (config.anthropicApiKey && (!config.model || String(config.model).startsWith('gemini-'))) {
        return { ...config, model: 'claude-sonnet-5' };
    }
    return config;
}
/** Append API usage record to the project's apiUsage array. */
async function trackUsage(projectId, usageOrList) {
    if (!projectId || !usageOrList) return;
    if (!isValidProjectId(projectId)) return;
    try {
        const usages = Array.isArray(usageOrList) ? usageOrList : [usageOrList];
        await updateProjectJSON(projectId, (project) => {
            if (!project.data) project.data = {};
            if (!project.data.apiUsage) project.data.apiUsage = [];
            const now = Date.now();
            for (const u of usages) {
                if (!u || !u.model) continue;
                project.data.apiUsage.push({
                    timestamp: now,
                    model: u.model,
                    inputTokens: u.inputTokens || 0,
                    outputTokens: u.outputTokens || 0,
                });
            }
            return project;
        });
    } catch (err) {
        console.error('trackUsage error:', err.message);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

const {
    generatePitchDocx,
    generateBeatsDocx,
    generateScenesDocx,
    generateCoverageDocx,
    generateOutlineDocx,
    generateCharactersDocx,
    generateTreatmentDocx,
    generateDraftDocx,
    generateScreenplayPdf
} = require('./agents/export');

const { agent1Pitch } = require('./agents/agent_1_pitch');
const { agent1Refine } = require('./agents/agent_1_refine');
const {
    agent2Outline,
    buildRevisionChecklist: buildOutlineRevisionChecklist,
    findUndercoveredChecklistItems: findUndercoveredOutlineChecklistItems,
    appendMissingChecklistBeats: appendMissingOutlineChecklistBeats,
    extractExplicitSequenceReplacement: extractExplicitOutlineSequenceReplacement,
    applyExplicitSequenceReplacement: applyExplicitOutlineSequenceReplacement,
    applyStructuralOutlinePatches
} = require('./agents/agent_2_outline');
const { agent3Characters } = require('./agents/agent_3_characters');
const { agent4Beats } = require('./agents/agent_4_beats');
const { agent5Treatment } = require('./agents/agent_5_treatment');
const { generateStage6Scenes } = require('./agents/agent_6_scenes');
const { reviseStage6Scenes } = require('./agents/agent_6_revise');
const { generateSceneDraft } = require('./agents/agent_8_draft');
const { humanizeDraft } = require('./agents/agent_humanizer');
const { runContinuityCheck, applyCheckResult, buildContinuityContext, clearSceneFacts, resolveError } = require('./agents/agent_continuity');
const { agent8Coverage } = require('./agents/agent_9_coverage');
const { rewriteScene } = require('./agents/agent_10_rewrite');
const { generateStyleFile, generateTrainedStyle, parseStyleFile } = require('./agents/agent_7_style');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./agents/memory_contract');
const { stampGenerated, stampRevised, buildSourceAuthorityBlock } = require('./utils/stageMetadata');
const {
    createRevisionTransaction,
    outlineRevisionAdapter,
    characterRevisionAdapter,
    stage4RevisionAdapter,
    treatmentRevisionAdapter,
    sceneBlueprintRevisionAdapter
} = require('./utils/revision_transaction');
const { applyStageRevisionPlan, normalizeProtectedBeats } = require('./utils/stage_revision_kernel');
const {
    appendArtifactSnapshot,
    changedStageKeysFromUpdate,
    recordStageMutationSnapshots,
    snapshotForStage,
    stageConfig
} = require('./utils/artifact_snapshots');
const { sanitizeOutlineMetaBeats } = require('./utils/outline_sanitizer');
const { seedStage3TierOverridesForDirectory } = require('./scripts/seed-stage3-tier-overrides');
const { generateContent } = require('./agents/ai-client');
const { runAssistantTurn, buildNeutralMessages } = require('./agents/assistant');
const { registerAssistantRoutes } = require('./routes/assistant');
const { registerExportRoutes } = require('./routes/export');
const { registerGenerationRoutes } = require('./routes/generation');
const { registerKnowledgeRoutes } = require('./routes/knowledge');
const { registerProjectRoutes } = require('./routes/projects');
const { registerRewriteRoutes } = require('./routes/rewrite');
const { registerStyleRoutes } = require('./routes/styles');
const { isGoogleAuthEnabled, getSessionEmail, registerAuthRoutes } = require('./utils/auth');

const STAGE_NAMES = {
    1: 'Pitch Generation', 2: 'Outline', 3: 'Characters',
    4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint',
    7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite'
};

const SOURCE_TEXT_LIMIT = 60_000;
const SOURCE_CHUNK_SIZE = 3_500;
const SOURCE_CHUNK_OVERLAP = 300;
const SOURCE_CHUNK_LIMIT = 40;
const KNOWLEDGE_CONTEXT_LIMIT = 14_000;
const SOURCE_TYPE_OPTIONS = new Set([
    'source_material',
    'source_reference',
    'style_reference',
    'script_reference',
    'development_notes'
]);
const SOURCE_TYPE_TAGS = new Set(['source_reference', 'style', 'script', 'notes']);
const SOURCE_TYPE_DEFAULT_TAG = {
    source_reference: 'source_reference',
    style_reference: 'style',
    script_reference: 'script',
    development_notes: 'notes'
};
const STOP_WORDS = new Set([
    'about', 'after', 'again', 'against', 'already', 'also', 'because', 'before',
    'being', 'between', 'could', 'current', 'every', 'first', 'from', 'have',
    'into', 'just', 'make', 'more', 'only', 'other', 'project', 'scene', 'stage',
    'that', 'their', 'there', 'these', 'thing', 'this', 'through', 'under', 'want',
    'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'writer',
    'your'
]);

const STAGE_SOURCE_PROFILES = {
    1: {
        label: 'Premise and adaptation promise',
        maxSources: 4,
        queryTerms: ['premise', 'theme', 'world', 'protagonist', 'conflict', 'ending'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'canon', 'notes'],
        directives: [
            'Use source material to anchor the premise, core conflict, and adaptation promise.',
            'Keep invented pitch elements clearly compatible with source canon and accepted divergences.',
            'Do not overfit to minor source details unless they define the concept.'
        ]
    },
    2: {
        label: 'Plot spine and act architecture',
        maxSources: 6,
        queryTerms: ['plot', 'act', 'sequence', 'turning point', 'timeline', 'climax', 'ending'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes', 'outline'],
        directives: [
            'Preserve source-supported chronology, major turns, and causal relationships.',
            'Use accepted divergences to decide where adaptation structure intentionally departs from source order.',
            'Avoid introducing new plot mechanics that contradict saved source facts.'
        ]
    },
    3: {
        label: 'Characters and relationships',
        maxSources: 7,
        queryTerms: ['character', 'relationship', 'motivation', 'backstory', 'arc', 'identity'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes', 'character'],
        directives: [
            'Ground character identities, relationships, motivations, and limits in saved source material.',
            'Track merged, renamed, or omitted characters as project adaptation choices.',
            'Prefer source-backed contradictions and tensions over generic traits.'
        ]
    },
    4: {
        label: 'Beats, causality, and set pieces',
        maxSources: 7,
        queryTerms: ['beat', 'set piece', 'cause', 'effect', 'reveal', 'choice', 'consequence'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes', 'beats'],
        directives: [
            'Use source references to preserve cause-and-effect logic between major moments.',
            'Flag or avoid beats that skip a source-supported motivation or consequence.',
            'Keep set pieces tied to source-supported stakes unless a divergence has been accepted.'
        ]
    },
    5: {
        label: 'Treatment continuity and emotional logic',
        maxSources: 8,
        queryTerms: ['treatment', 'emotion', 'arc', 'theme', 'timeline', 'scene', 'relationship'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes', 'treatment'],
        directives: [
            'Carry forward source-supported story logic while expanding cinematic connective tissue.',
            'Preserve emotional turns, relationship changes, and timeline facts already established in source/project memory.',
            'Make adaptation additions serve source-backed stakes or logged project decisions.'
        ]
    },
    6: {
        label: 'Scene blueprint continuity',
        maxSources: 8,
        queryTerms: ['scene', 'location', 'timeline', 'prop', 'action', 'continuity', 'sequence'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes', 'scene'],
        directives: [
            'Use source material to lock scene order, locations, recurring objects, and continuity-sensitive details.',
            'Preserve established handoffs from earlier approved stages.',
            'Avoid blueprint scenes that contradict source canon without an accepted divergence.'
        ]
    },
    7: {
        label: 'Style references without canon drift',
        maxSources: 5,
        queryTerms: ['style', 'tone', 'voice', 'dialogue', 'visual', 'pace', 'reference'],
        preferredTypes: ['style_reference', 'source_reference', 'script_reference'],
        preferredTags: ['style', 'source_reference', 'script'],
        directives: [
            'Use style references for tone, rhythm, point of view, and cinematic texture.',
            'Do not let style exploration change source canon, character facts, or story decisions.',
            'Separate tonal inspiration from source facts when giving the style directive.'
        ]
    },
    8: {
        label: 'Draft scene execution',
        maxSources: 8,
        queryTerms: ['scene', 'dialogue', 'action', 'location', 'prop', 'emotion', 'continuity'],
        preferredTypes: ['source_reference', 'script_reference', 'style_reference'],
        preferredTags: ['source_reference', 'script', 'style', 'scene'],
        directives: [
            'Use source references for concrete scene details, continuity, dialogue intent, and visual facts.',
            'Preserve accepted divergences and approved handoffs while drafting cinematic prose.',
            'Do not add source-incompatible business to solve a local scene problem.'
        ]
    },
    9: {
        label: 'Coverage against project memory',
        maxSources: 6,
        queryTerms: ['coverage', 'issue', 'continuity', 'theme', 'character', 'structure'],
        preferredTypes: ['source_reference', 'development_notes'],
        preferredTags: ['source_reference', 'notes'],
        directives: [
            'Evaluate draft issues against source facts, project memory, and accepted divergences.',
            'Distinguish source alignment problems from normal screenplay craft notes.',
            'Do not reopen divergences the writer already accepted.'
        ]
    },
    10: {
        label: 'Rewrite changes with source accountability',
        maxSources: 8,
        queryTerms: ['rewrite', 'scene', 'priority', 'fix', 'continuity', 'character', 'dialogue'],
        preferredTypes: ['source_reference', 'script_reference', 'development_notes'],
        preferredTags: ['source_reference', 'script', 'notes', 'scene'],
        directives: [
            'Use source references to constrain rewrite fixes so they do not solve one problem by creating source drift.',
            'Respect accepted divergences as intentional adaptation decisions.',
            'When planning changes, identify the source/project-memory facts the rewrite must preserve.'
        ]
    }
};

/**
 * Load the style file for a project, if one is set and exists.
 * Returns { styleContent, styleWarning, referenceContent } where styleContent
 * is the directive markdown (or null), referenceContent is the full reference
 * for Tier 3 trained styles (or null), and styleWarning is a UI-facing notice.
 */
async function loadProjectStyle(projectData) {
    const slug = projectData.data?.stage7_style;
    if (!slug || slug === 'none') return { styleContent: null, styleWarning: null, referenceContent: null };
    if (!isValidSlug(slug)) {
        console.warn(`loadProjectStyle: invalid slug "${slug}" — skipping.`);
        return { styleContent: null, styleWarning: 'Invalid style slug — drafting without style directives.', referenceContent: null };
    }

    // Try new naming first (-directive.md), fall back to legacy (.md)
    let styleContent = null, referenceContent = null, styleWarning = null;
    try {
        styleContent = await fs.readFile(path.join(STYLES_DIR, `${slug}-directive.md`), 'utf-8');
    } catch {
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${slug}.md`), 'utf-8');
        } catch {
            console.warn(`Style file "${slug}" not found — drafting without style directives.`);
            styleWarning = `The style "${slug}" is no longer available. Drafting without style directives.`;
        }
    }

    // Load full reference if it exists (Tier 3 trained styles only)
    try {
        referenceContent = await fs.readFile(path.join(STYLES_DIR, `${slug}-reference.md`), 'utf-8');
    } catch { /* no reference = Tier 2 conversational or legacy style */ }

    return { styleContent, styleWarning, referenceContent };
}

async function styleSlugExists(slug) {
    for (const suffix of ['-directive.md', '-reference.md', '.md']) {
        try {
            await fs.access(path.join(STYLES_DIR, `${slug}${suffix}`));
            return true;
        } catch { /* keep checking */ }
    }
    return false;
}

async function uniqueStyleSlug(candidate) {
    const base = (candidate || 'custom-style')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'custom-style';
    let slug = base;
    let suffix = 2;
    while (await styleSlugExists(slug)) {
        slug = `${base}-${suffix}`;
        suffix += 1;
    }
    return slug;
}

function compactText(value, maxChars = 4_000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

function normalizeSourceText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

function normalizeStoredRelativePath(filePath) {
    return path.relative(DATA_ROOT, filePath).split(path.sep).join('/');
}

function sourceFileExtension(name = '', mimeType = '') {
    const ext = path.extname(String(name || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (ext) return ext.slice(0, 16);
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('pdf')) return '.pdf';
    if (mime.includes('wordprocessingml')) return '.docx';
    if (mime.includes('markdown')) return '.md';
    if (mime.includes('xml')) return '.xml';
    if (mime.includes('plain')) return '.txt';
    return '.bin';
}

function sanitizeSourceAssetName(name, fallback = 'source') {
    const base = path.basename(String(name || fallback))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[^\w .@()+,-]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base || base === '.' || base === '..') return fallback;
    return base.slice(0, 160);
}

function markdownNameForSource(name, sourceId) {
    const safeName = sanitizeSourceAssetName(name, sourceId || 'source');
    const parsed = path.parse(safeName);
    const base = (parsed.name || sourceId || 'source').slice(0, 140);
    return `${base}.md`;
}

function buildExtractedMarkdownContent({ sourceId, name, mimeType, uploadedAt, contentHash, text }) {
    const safeName = String(name || 'Untitled source').replace(/\r?\n/g, ' ').trim() || 'Untitled source';
    const metadata = [
        `original_name: ${JSON.stringify(safeName)}`,
        `source_id: ${JSON.stringify(sourceId || '')}`,
        `mime_type: ${JSON.stringify(mimeType || 'application/octet-stream')}`,
        `extracted_at: ${JSON.stringify(uploadedAt || new Date().toISOString())}`,
        `content_hash: ${JSON.stringify(contentHash || '')}`
    ].join('\n');

    return `---\n${metadata}\n---\n\n# ${safeName}\n\n${normalizeSourceText(text)}\n`;
}

async function persistKnowledgeSourceAssets({
    projectId,
    sourceId,
    attachment,
    fileText,
    uploadedAt,
    contentHash,
    sourceRoot = SOURCE_FILES_DIR
}) {
    if (!projectId || !sourceId || !attachment?.data || !fileText) return null;
    if (!isValidProjectId(String(projectId)) || !/^src_[a-zA-Z0-9_]+$/.test(String(sourceId))) return null;

    const sourceDir = path.join(sourceRoot, String(projectId), String(sourceId));
    await fs.mkdir(sourceDir, { recursive: true });

    const originalBuffer = Buffer.from(attachment.data, 'base64');
    const originalName = sanitizeSourceAssetName(
        attachment.name || `source${sourceFileExtension('', attachment.mimeType)}`,
        `source${sourceFileExtension('', attachment.mimeType)}`
    );
    const originalPath = path.join(sourceDir, originalName);
    await fs.writeFile(originalPath, originalBuffer);

    const markdownContent = buildExtractedMarkdownContent({
        sourceId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        uploadedAt,
        contentHash,
        text: fileText
    });
    const markdownName = markdownNameForSource(attachment.name, sourceId);
    const markdownPath = path.join(sourceDir, markdownName);
    await fs.writeFile(markdownPath, markdownContent, 'utf8');

    return {
        originalFile: {
            filename: originalName,
            path: normalizeStoredRelativePath(originalPath),
            mimeType: attachment.mimeType || 'application/octet-stream',
            byteCount: originalBuffer.length,
            sha256: crypto.createHash('sha256').update(originalBuffer).digest('hex')
        },
        extractedMarkdown: {
            filename: markdownName,
            path: normalizeStoredRelativePath(markdownPath),
            mimeType: 'text/markdown',
            charCount: markdownContent.length,
            sha256: crypto.createHash('sha256').update(markdownContent).digest('hex'),
            generatedAt: uploadedAt || new Date().toISOString()
        }
    };
}

async function tryPersistKnowledgeSourceAssets(options) {
    try {
        return await persistKnowledgeSourceAssets(options);
    } catch (error) {
        console.error('source asset persistence error:', error.message);
        return null;
    }
}

async function removeKnowledgeSourceAssets(projectId, sourceId) {
    if (!isValidProjectId(String(projectId)) || !/^src_[a-zA-Z0-9_]+$/.test(String(sourceId))) return;
    await fs.rm(path.join(SOURCE_FILES_DIR, String(projectId), String(sourceId)), { recursive: true, force: true });
}

async function removeProjectSourceAssets(projectId) {
    if (!isValidProjectId(String(projectId))) return;
    await fs.rm(path.join(SOURCE_FILES_DIR, String(projectId)), { recursive: true, force: true });
}

function ensureProjectKnowledge(projectData) {
    if (!projectData.data) projectData.data = {};
    const existing = projectData.data.knowledge;
    const knowledge = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};

    if (!Array.isArray(knowledge.source_registry)) knowledge.source_registry = [];
    if (!knowledge.source_bible || typeof knowledge.source_bible !== 'object' || Array.isArray(knowledge.source_bible)) {
        knowledge.source_bible = {
            summary: typeof knowledge.source_bible === 'string' ? knowledge.source_bible : '',
            sources_summary: '',
            updatedAt: null,
            sourceIds: []
        };
    } else {
        knowledge.source_bible.summary = knowledge.source_bible.summary || '';
        knowledge.source_bible.sources_summary = knowledge.source_bible.sources_summary || '';
        if (!Array.isArray(knowledge.source_bible.sourceIds)) knowledge.source_bible.sourceIds = [];
    }
    if (!Array.isArray(knowledge.source_bible.curated_notes)) knowledge.source_bible.curated_notes = [];
    if (!Array.isArray(knowledge.continuity_watchlist)) knowledge.continuity_watchlist = [];
    if (!Array.isArray(knowledge.decision_log)) knowledge.decision_log = [];
    if (!Array.isArray(knowledge.accepted_divergences)) knowledge.accepted_divergences = [];
    if (!knowledge.stage_handoffs || typeof knowledge.stage_handoffs !== 'object' || Array.isArray(knowledge.stage_handoffs)) {
        knowledge.stage_handoffs = {};
    }
    if (!knowledge.stage_source_plans || typeof knowledge.stage_source_plans !== 'object' || Array.isArray(knowledge.stage_source_plans)) {
        knowledge.stage_source_plans = {};
    }
    if (!knowledge.stage_source_audits || typeof knowledge.stage_source_audits !== 'object' || Array.isArray(knowledge.stage_source_audits)) {
        knowledge.stage_source_audits = {};
    }

    projectData.data.knowledge = knowledge;
    return knowledge;
}

function inferSourceTypeAndTags(name, mimeType, stageId, originTag = 'chat_upload') {
    const lowerName = String(name || '').toLowerCase();
    const lowerMime = String(mimeType || '').toLowerCase();
    const tags = new Set();
    let type = 'source_material';

    if (originTag) tags.add(originTag);
    if (stageId) tags.add(`stage${stageId}`);
    if (lowerMime.includes('pdf') || lowerName.endsWith('.pdf')) tags.add('pdf');
    if (lowerName.endsWith('.docx') || lowerMime.includes('wordprocessingml')) tags.add('docx');
    if (lowerName.endsWith('.fountain')) tags.add('screenplay');
    if (lowerName.endsWith('.fdx')) tags.add('screenplay');
    if (lowerName.endsWith('.md') || lowerMime.includes('markdown')) tags.add('markdown');

    if (/\b(graphic|comic|manga|novel|source|bible|canon|reference)\b/.test(lowerName)) {
        type = 'source_reference';
        tags.add('source_reference');
    } else if (/\b(style|sample|voice)\b/.test(lowerName)) {
        type = 'style_reference';
        tags.add('style');
    } else if (/\b(script|screenplay|draft|fountain)\b/.test(lowerName)) {
        type = 'script_reference';
        tags.add('script');
    } else if (/\b(notes|outline|treatment|beats?)\b/.test(lowerName)) {
        type = 'development_notes';
        tags.add('notes');
    }

    return { type, tags: Array.from(tags) };
}

function buildSourceChunks(text) {
    const chunks = [];
    let index = 0;
    let offset = 0;
    while (offset < text.length && chunks.length < SOURCE_CHUNK_LIMIT) {
        const end = Math.min(text.length, offset + SOURCE_CHUNK_SIZE);
        chunks.push({
            id: `chunk_${index + 1}`,
            index,
            start: offset,
            text: text.slice(offset, end).trim()
        });
        index += 1;
        offset = end >= text.length ? end : Math.max(offset + 1, end - SOURCE_CHUNK_OVERLAP);
    }
    return chunks;
}

function summarizeSourceText(text) {
    const paragraphs = text
        .split(/\n\s*\n+/)
        .map(p => p.trim())
        .filter(Boolean);
    const lead = paragraphs.slice(0, 4).join('\n\n') || text;
    return compactText(lead, 1_400);
}

function refreshSourceBibleSummary(knowledge) {
    const bible = knowledge.source_bible;
    const sourceBullets = knowledge.source_registry.slice(-20).map(source => {
        const descriptor = source.summary || compactText(source.text || source.chunks?.[0]?.text || '', 700);
        return `- ${source.name} (${source.type || 'source'}, ${source.uploadedAt || 'unknown date'}): ${descriptor}`;
    });
    bible.sources_summary = compactText(sourceBullets.join('\n'), 6_000);
    bible.sourceIds = knowledge.source_registry.map(source => source.id);
    bible.updatedAt = new Date().toISOString();
}

async function persistChatAttachmentToKnowledge(projectData, attachment, { stageId, userMessage, originTag = 'chat_upload', projectId = null } = {}) {
    if (!attachment) return { fileText: '', savedSource: null };

    const fileText = normalizeSourceText(await extractAttachmentText(attachment));
    if (!fileText) return { fileText: '', savedSource: null };

    const knowledge = ensureProjectKnowledge(projectData);
    const now = new Date().toISOString();
    const contentHash = crypto.createHash('sha256').update(fileText).digest('hex').slice(0, 20);
    const existing = knowledge.source_registry.find(source => source.contentHash === contentHash);
    const sourceAssetProjectId = projectId || projectData.id || projectData.projectId || null;

    if (existing) {
        existing.lastReferencedAt = now;
        existing.stagesReferenced = Array.from(new Set([...(existing.stagesReferenced || []), stageId].filter(Boolean)));
        existing.tags = Array.from(new Set([...(existing.tags || []), originTag].filter(Boolean)));
        if (sourceAssetProjectId && (!existing.originalFile || !existing.extractedMarkdown)) {
            const assets = await tryPersistKnowledgeSourceAssets({
                projectId: sourceAssetProjectId,
                sourceId: existing.id,
                attachment,
                fileText,
                uploadedAt: existing.uploadedAt || now,
                contentHash
            });
            if (assets) {
                existing.originalFile = existing.originalFile || assets.originalFile;
                existing.extractedMarkdown = existing.extractedMarkdown || assets.extractedMarkdown;
            }
        }
        return {
            fileText,
            savedSource: {
                id: existing.id,
                name: existing.name,
                duplicate: true,
                charCount: existing.charCount || fileText.length,
                type: existing.type || 'source_material',
                originalFile: existing.originalFile || null,
                extractedMarkdown: existing.extractedMarkdown || null
            }
        };
    }

    const rawName = String(attachment.name || 'Untitled source').slice(0, 240);
    const { type, tags } = inferSourceTypeAndTags(rawName, attachment.mimeType, stageId, originTag);
    const entry = {
        id: `src_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        name: rawName,
        mimeType: attachment.mimeType || 'application/octet-stream',
        uploadedAt: now,
        stageId: stageId || null,
        type,
        tags,
        charCount: fileText.length,
        contentHash,
        summary: summarizeSourceText(fileText),
        sourceNote: compactText(userMessage || '', 500)
    };

    const assets = await tryPersistKnowledgeSourceAssets({
        projectId: sourceAssetProjectId,
        sourceId: entry.id,
        attachment,
        fileText,
        uploadedAt: now,
        contentHash
    });
    if (assets) {
        entry.originalFile = assets.originalFile;
        entry.extractedMarkdown = assets.extractedMarkdown;
    }

    if (fileText.length <= SOURCE_TEXT_LIMIT) {
        entry.storage = 'text';
        entry.text = fileText;
    } else {
        const chunks = buildSourceChunks(fileText);
        entry.storage = 'chunks';
        entry.chunks = chunks;
        const lastChunk = chunks[chunks.length - 1];
        entry.truncated = !lastChunk || (lastChunk.start + SOURCE_CHUNK_SIZE) < fileText.length;
    }

    knowledge.source_registry.push(entry);
    refreshSourceBibleSummary(knowledge);

    return {
        fileText,
        savedSource: {
            id: entry.id,
            name: entry.name,
            duplicate: false,
            charCount: entry.charCount,
            type: entry.type,
            originalFile: entry.originalFile || null,
            extractedMarkdown: entry.extractedMarkdown || null
        }
    };
}

function uploadFileToAttachment(file) {
    if (!file?.buffer) return null;
    return {
        name: file.originalname || 'Untitled source',
        mimeType: file.mimetype || 'application/octet-stream',
        data: file.buffer.toString('base64')
    };
}

function isPdfUploadFile(file) {
    const name = String(file?.originalname || '').toLowerCase();
    const mime = String(file?.mimetype || '').toLowerCase();
    return mime.includes('pdf') || name.endsWith('.pdf');
}

function uploadedSourcePromptBlock(attachment, fileText) {
    if (!attachment || !fileText) return '';
    return `## UPLOADED SOURCE FILE: ${attachment.name}\n${compactText(fileText, 80_000)}`;
}

function appendUploadedSourceBlock(text, uploadContext) {
    const base = String(text || '').trim();
    const block = uploadContext?.textBlock || '';
    if (!block) return base;
    return [base, block].filter(Boolean).join('\n\n');
}

async function prepareGenerationUpload(projectData, uploadedFile, { stageId, userMessage = '', originTag = 'stage_upload', forceTextBlock = false, projectId = null } = {}) {
    const attachment = uploadFileToAttachment(uploadedFile);
    if (!attachment) {
        return { attachment: null, fileText: '', savedSource: null, agentFile: null, textBlock: '', isPdf: false };
    }

    let fileText = '';
    let savedSource = null;
    if (projectData) {
        const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId, userMessage, originTag, projectId });
        fileText = persisted.fileText;
        savedSource = persisted.savedSource;
    } else {
        fileText = normalizeSourceText(await extractAttachmentText(attachment));
    }

    const isPdf = isPdfUploadFile(uploadedFile);
    return {
        attachment,
        fileText,
        savedSource,
        agentFile: isPdf ? uploadedFile : null,
        textBlock: (!isPdf || forceTextBlock) ? uploadedSourcePromptBlock(attachment, fileText) : '',
        isPdf
    };
}

function tokenizeForKnowledge(text) {
    const counts = new Map();
    const source = String(text || '').toLowerCase().slice(0, 40_000);
    for (const token of source.match(/[a-z0-9][a-z0-9'-]{2,}/g) || []) {
        if (token.length < 4 || STOP_WORDS.has(token)) continue;
        counts.set(token, (counts.get(token) || 0) + 1);
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 35)
        .map(([token]) => token);
}

function scoreAgainstKeywords(text, keywords) {
    if (!text || !keywords.length) return 0;
    const lower = String(text).toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
        if (lower.includes(keyword)) score += 1;
    }
    return score;
}

function excerptAroundKeywords(text, keywords, maxChars = 1_000) {
    const source = String(text || '').trim();
    if (source.length <= maxChars) return source;
    const lower = source.toLowerCase();
    const hit = keywords.map(k => lower.indexOf(k)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    if (hit === undefined) return compactText(source, maxChars);
    const start = Math.max(0, hit - Math.floor(maxChars / 3));
    const end = Math.min(source.length, start + maxChars);
    return `${start > 0 ? '[...] ' : ''}${source.slice(start, end).trim()}${end < source.length ? ' [...]' : ''}`;
}

function sourceSegments(source) {
    if (Array.isArray(source.chunks) && source.chunks.length) {
        return source.chunks.map(chunk => ({ label: `${source.name} / chunk ${chunk.index + 1}`, text: chunk.text, source }));
    }
    if (source.text) {
        return buildSourceChunks(source.text).map(chunk => ({ label: `${source.name} / chunk ${chunk.index + 1}`, text: chunk.text, source }));
    }
    if (source.summary) return [{ label: `${source.name} / summary`, text: source.summary, source }];
    return [];
}

function relevantSourceSegments(knowledge, query, maxSegments = 5) {
    const sources = knowledge.source_registry || [];
    if (!sources.length) return [];
    const keywords = tokenizeForKnowledge(query);
    const scored = [];

    for (const source of sources) {
        const meta = `${source.name || ''} ${(source.tags || []).join(' ')} ${source.type || ''} ${source.summary || ''}`;
        const metaScore = scoreAgainstKeywords(meta, keywords);
        for (const segment of sourceSegments(source)) {
            const score = scoreAgainstKeywords(segment.text, keywords) + (metaScore * 2);
            if (score > 0) scored.push({ ...segment, score, keywords });
        }
    }

    if (!scored.length) {
        return sources.slice(-3).map(source => ({
            label: `${source.name} / summary`,
            text: source.summary || source.text || source.chunks?.[0]?.text || '',
            source,
            score: 0,
            keywords
        }));
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, maxSegments);
}

function stageSourceProfile(stageId) {
    return STAGE_SOURCE_PROFILES[Number(stageId)] || {
        label: STAGE_NAMES[stageId] || `Stage ${stageId}`,
        maxSources: 5,
        queryTerms: [],
        preferredTypes: ['source_reference', 'development_notes', 'script_reference', 'style_reference'],
        preferredTags: ['source_reference', 'notes', 'script', 'style'],
        directives: [
            'Use saved source material as concrete project memory.',
            'Respect accepted divergences and approved stage handoffs.',
            'Prefer source-supported facts over unsupported invention.'
        ]
    };
}

function sourceProfileBoost(source, profile) {
    let boost = 0;
    if ((profile.preferredTypes || []).includes(source.type)) boost += 4;
    const tags = source.tags || [];
    for (const tag of profile.preferredTags || []) {
        if (tags.includes(tag)) boost += 2;
    }
    if (tags.includes('source_reference')) boost += 2;
    return boost;
}

function relevantSourceSegmentsForStage(knowledge, query, stageId, maxSegments) {
    const sources = knowledge.source_registry || [];
    if (!sources.length) return [];
    const profile = stageSourceProfile(stageId);
    const keywords = tokenizeForKnowledge(`${profile.queryTerms.join(' ')}\n${query}`);
    const scored = [];

    for (const source of sources) {
        const meta = `${source.name || ''} ${(source.tags || []).join(' ')} ${source.type || ''} ${source.summary || ''}`;
        const metaScore = scoreAgainstKeywords(meta, keywords);
        const profileBoost = sourceProfileBoost(source, profile);
        for (const segment of sourceSegments(source)) {
            const score = scoreAgainstKeywords(segment.text, keywords) + (metaScore * 2) + profileBoost;
            if (score > 0) scored.push({ ...segment, score, keywords });
        }
    }

    if (!scored.length) return relevantSourceSegments(knowledge, query, maxSegments || profile.maxSources || 5);
    return scored.sort((a, b) => b.score - a.score).slice(0, maxSegments || profile.maxSources || 5);
}

function sourceReferenceForSegment(segment) {
    const source = segment?.source || {};
    return {
        sourceId: source.id || null,
        name: source.name || 'Untitled source',
        type: source.type || 'source_material',
        label: segment?.label || source.name || 'Source',
        excerpt: excerptAroundKeywords(segment?.text || source.summary || '', segment?.keywords || [], 360)
    };
}

function sourcePlanDataHash(stageData = '') {
    const text = typeof stageData === 'string' ? stageData : JSON.stringify(stageData ?? '', null, 2);
    return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 20);
}

function assertRevisionTransactionVerified(transaction, stageLabel = 'Stage output') {
    const failures = transaction?.receipt?.failures || [];
    if (!failures.length) return;
    const failureList = failures
        .map(failure => failure.newLabel || failure.oldLabel || failure.label || failure.type || 'requested edit')
        .filter(Boolean)
        .slice(0, 5)
        .join('; ');
    throw new Error(`${stageLabel} revision failed verification${failureList ? `: ${failureList}` : ''}`);
}

function recordArtifactMutation(projectData, {
    projectId = projectData?.id || '',
    stage,
    before,
    after,
    operation = 'revision',
    note = '',
    revisionReceipt = null
} = {}) {
    return recordStageMutationSnapshots(projectData, {
        projectId,
        stage,
        before,
        after,
        operation,
        note: compactText(note || '', 500),
        revisionReceipt
    });
}

function recordExportSnapshot(projectData, projectId, stage, note = '') {
    const config = stageConfig(stage);
    if (!config) return null;
    const snapshot = snapshotForStage(projectData, config.stage);
    return appendArtifactSnapshot(projectData, {
        projectId,
        stage: config.stage,
        snapshot,
        snapshotType: 'exported',
        reason: 'export',
        note: compactText(note || '', 500),
        force: true
    });
}

function exportStageNumber(stage = '') {
    const key = String(stage || '').toLowerCase();
    const map = {
        pitch: 1,
        outline: 2,
        characters: 3,
        beats: 4,
        treatment: 5,
        scenes: 6,
        style: 7,
        draft: 8,
        coverage: 9,
        rewrite: 10
    };
    return map[key] || null;
}

function mergeVersionHistory(existing = [], incoming = []) {
    const byId = new Map();
    for (const entry of Array.isArray(existing) ? existing : []) {
        if (entry?.id) byId.set(entry.id, entry);
    }
    for (const entry of Array.isArray(incoming) ? incoming : []) {
        if (entry?.id) byId.set(entry.id, entry);
    }
    return Array.from(byId.values())
        .sort((a, b) => new Date(a.createdAt || a.approvedAt || 0) - new Date(b.createdAt || b.approvedAt || 0));
}

function sourcePlanCacheKey(stageId) {
    return `stage${Number(stageId)}`;
}

function summarizeCachedSourcePlan(entry, currentStageHash) {
    if (!entry || typeof entry !== 'object') return null;
    const isStale = !!(entry.invalidatedAt || (entry.stageOutputHash && currentStageHash && entry.stageOutputHash !== currentStageHash));
    return {
        stageId: entry.stageId || null,
        stageName: entry.stageName || '',
        profile: entry.profile || '',
        generatedAt: entry.generatedAt || null,
        lastUsedAt: entry.lastUsedAt || null,
        reason: entry.reason || '',
        stageOutputHash: entry.stageOutputHash || '',
        sourceIds: Array.isArray(entry.sourceIds) ? entry.sourceIds : [],
        sourceReferences: Array.isArray(entry.sourceReferences) ? entry.sourceReferences : [],
        localCheck: entry.localCheck || null,
        invalidatedAt: entry.invalidatedAt || null,
        invalidatedReason: entry.invalidatedReason || '',
        isStale,
        status: isStale ? 'stale' : (entry.lastUsedAt ? 'used' : 'cached')
    };
}

function localSourcePlanCheck(knowledge, plan) {
    const warnings = [];
    const sources = knowledge.source_registry || [];
    const sourceIds = new Set(sources.map(source => source.id).filter(Boolean));
    const refs = Array.isArray(plan?.sourceReferences) ? plan.sourceReferences : [];

    if (sources.length && !refs.length) {
        warnings.push({
            kind: 'no_selected_source_segments',
            message: 'Saved source documents exist, but this stage plan selected no concrete source segment.'
        });
    }

    for (const ref of refs) {
        if (ref.sourceId && !sourceIds.has(ref.sourceId)) {
            warnings.push({
                kind: 'missing_selected_source',
                message: `Selected source ${ref.sourceId} is no longer present in the project source registry.`
            });
        }
    }

    return {
        ok: warnings.length === 0,
        warnings
    };
}

function compactSourcePlanReference(ref = {}) {
    return {
        sourceId: ref.sourceId || null,
        name: compactText(ref.name || 'Untitled source', 180),
        type: ref.type || 'source_material',
        label: compactText(ref.label || ref.name || 'Source', 220)
    };
}

function recordSourcePlanUsage(projectData, stageId, stageData = '', reason = 'generation', usedPlan = null) {
    const numericStageId = Number(stageId);
    if (!numericStageId || !STAGE_NAMES[numericStageId]) return null;

    const knowledge = ensureProjectKnowledge(projectData);
    const plan = usedPlan || buildSourceUsePlan(projectData, numericStageId, stageData);
    const now = new Date().toISOString();
    const sourceReferences = (plan.sourceReferences || []).map(compactSourcePlanReference);
    const sourceIds = Array.from(new Set(sourceReferences.map(ref => ref.sourceId).filter(Boolean)));
    const localCheck = localSourcePlanCheck(knowledge, plan);
    const entry = {
        stageId: numericStageId,
        stageName: plan.stageName || STAGE_NAMES[numericStageId],
        profile: plan.profile || stageSourceProfile(numericStageId).label,
        generatedAt: now,
        lastUsedAt: now,
        reason,
        stageOutputHash: sourcePlanDataHash(stageData),
        sourceCount: plan.sourceCount || 0,
        sourceIds,
        sourceReferences,
        directives: Array.isArray(plan.directives) ? plan.directives : [],
        memorySnapshotUsed: !!plan.usesMemorySnapshot,
        memorySnapshot: plan.memorySnapshot || null,
        localCheck
    };

    knowledge.stage_source_plans[sourcePlanCacheKey(numericStageId)] = entry;

    if (plan.hasKnowledge) {
        const selectedSummary = sourceIds.length
            ? `selected ${sourceIds.length} source${sourceIds.length === 1 ? '' : 's'}`
            : 'used source bible/project knowledge with no specific source segment selected';
        boundedKnowledgePush(knowledge.decision_log, {
            type: 'source_plan_used',
            stageId: numericStageId,
            stageName: entry.stageName,
            at: now,
            summary: `${entry.stageName} ${reason.replace(/_/g, ' ')} ${selectedSummary}${entry.memorySnapshotUsed ? ' with compact memory snapshot' : ''}.`,
            sourceIds,
            memorySnapshotUsed: entry.memorySnapshotUsed,
            warnings: localCheck.warnings.map(warning => warning.message)
        }, 120);
    }

    return entry;
}

function summarizeMemorySnapshotForPlan(snapshot = {}) {
    const stageHandoffs = Array.isArray(snapshot.stageHandoffs) ? snapshot.stageHandoffs.slice(-5) : [];
    const continuity = Array.isArray(snapshot.continuityWatchlist) ? snapshot.continuityWatchlist.slice(-6) : [];
    const divergences = Array.isArray(snapshot.acceptedDivergences) ? snapshot.acceptedDivergences.slice(-4) : [];
    const summary = compactText(snapshot.summary || snapshot.sourceBibleSummary || '', 900);
    const hasSnapshot = !!(summary || stageHandoffs.length || continuity.length || divergences.length);
    return hasSnapshot ? {
        hasSnapshot,
        generatedAt: snapshot.generatedAt || null,
        sourceCount: snapshot.sourceCount || 0,
        summary,
        stageHandoffs,
        continuityWatchlist: continuity,
        acceptedDivergences: divergences
    } : null;
}

function buildSourceUsePlan(projectData, stageId, stageData = '') {
    const numericStageId = Number(stageId);
    const knowledge = ensureProjectKnowledge(projectData);
    const profile = stageSourceProfile(numericStageId);
    const stageName = STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`;
    const stageOutputHash = sourcePlanDataHash(stageData);
    const cachedPlan = summarizeCachedSourcePlan(
        knowledge.stage_source_plans?.[sourcePlanCacheKey(numericStageId)],
        stageOutputHash
    );
    const bibleSummary = sourceBibleSummary(knowledge);
    const handoff = knowledge.stage_handoffs?.[`stage${numericStageId}`] || knowledge.stage_handoffs?.[numericStageId] || '';
    const acceptedDivergences = (knowledge.accepted_divergences || []).slice(-8).map(formatKnowledgeItem).filter(Boolean);
    const continuityWatchlist = (knowledge.continuity_watchlist || []).slice(-10).map(formatKnowledgeItem).filter(Boolean);
    const memorySnapshot = summarizeMemorySnapshotForPlan(
        knowledge.memory_snapshot || buildKnowledgeSnapshot(projectData, { includeReadiness: false })
    );
    const query = `${profile.queryTerms.join(' ')}\n${stageName}\n${compactText(stageData, 8_000)}`;
    const sourceReferences = relevantSourceSegmentsForStage(
        knowledge,
        query,
        numericStageId,
        profile.maxSources
    ).map(sourceReferenceForSegment);
    const hasKnowledge = !!(knowledge.source_registry.length || bibleSummary || handoff || acceptedDivergences.length || continuityWatchlist.length || memorySnapshot);

    return {
        stageId: numericStageId,
        stageName,
        profile: profile.label,
        hasKnowledge,
        sourceCount: knowledge.source_registry.length,
        directives: profile.directives,
        sourceReferences,
        hasStyleReferences: sourceReferences.some(ref => ref.type === 'style_reference'),
        continuityWatchlist,
        acceptedDivergences,
        handoff: formatKnowledgeItem(handoff),
        bibleSummary: compactText(bibleSummary, 1_600),
        memorySnapshot,
        usesMemorySnapshot: !!memorySnapshot,
        stageOutputHash,
        cachedPlan,
        freshness: cachedPlan?.status || 'not_used'
    };
}

function formatSourceUsePlan(plan) {
    if (!plan?.hasKnowledge) return '';
    const sections = [
        `## SOURCE-FIRST GENERATION PLAN`,
        `Stage Focus: ${plan.profile || plan.stageName}`,
        `Use this plan before generating or revising. It is a source-selection guide, not prose for the final output.`
    ];
    if (plan.directives?.length) {
        sections.push(`### Stage-Specific Source Rules\n${plan.directives.map(item => `- ${item}`).join('\n')}`);
    }
    if (plan.hasStyleReferences) {
        sections.push('### Style Reference Boundary\nStyle references are tonal guidance only. Use them for voice, rhythm, texture, and cinematic handling; do not treat them as source canon for plot, character facts, chronology, settings, or continuity.');
    }
    if (plan.memorySnapshot?.hasSnapshot) {
        const lines = [];
        if (plan.memorySnapshot.summary) lines.push(compactText(plan.memorySnapshot.summary, 900));
        if (plan.memorySnapshot.stageHandoffs?.length) {
            lines.push(`Stage handoffs:\n${plan.memorySnapshot.stageHandoffs.map(item => `- ${item.stageName || `Stage ${item.stageId || ''}`}: ${formatKnowledgeItem(item.summary || item)}`).join('\n')}`);
        }
        if (plan.memorySnapshot.continuityWatchlist?.length) {
            lines.push(`Continuity:\n${plan.memorySnapshot.continuityWatchlist.map(item => `- ${formatKnowledgeItem(item)}`).join('\n')}`);
        }
        sections.push(`### Compact Memory Snapshot\n${lines.filter(Boolean).join('\n\n')}`);
    }
    if (plan.handoff) sections.push(`### Approved Stage Handoff\n${plan.handoff}`);
    if (plan.continuityWatchlist?.length) {
        sections.push(`### Continuity To Preserve\n${plan.continuityWatchlist.map(item => `- ${item}`).join('\n')}`);
    }
    if (plan.acceptedDivergences?.length) {
        sections.push(`### Accepted Divergences\n${plan.acceptedDivergences.map(item => `- ${item}`).join('\n')}`);
    }
    if (plan.sourceReferences?.length) {
        sections.push(`### Source References To Consult\n${plan.sourceReferences.map((ref, index) => {
            return `${index + 1}. ${ref.name} (${ref.sourceId || 'source'}, ${ref.label || ref.type})\n${compactText(ref.excerpt || '', 420)}`;
        }).join('\n\n')}`);
    } else if (plan.sourceCount) {
        sections.push('### Source References To Consult\nNo keyword-specific source segment was selected; fall back to the source bible and source library summaries.');
    }
    return compactText(sections.filter(Boolean).join('\n\n'), 8_000);
}

function formatKnowledgeItem(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item || '');
    return item.summary || item.decision || item.note || item.text || JSON.stringify(item);
}

function sourceBibleSummary(knowledge) {
    const bible = knowledge.source_bible;
    if (!bible) return '';
    if (typeof bible === 'string') return bible;
    const formatList = (label, items) => Array.isArray(items) && items.length
        ? `${label}:\n${items.slice(0, 20).map(item => `- ${item}`).join('\n')}`
        : '';
    return [
        bible.summary,
        formatList('Canon Facts', bible.canon_facts),
        formatList('Characters', bible.characters),
        formatList('Settings', bible.settings),
        formatList('Timeline', bible.timeline),
        formatList('Rules', bible.rules),
        formatList('Must Keep Elements', bible.must_keep_elements),
        formatList('Project Adaptation Notes', bible.curated_notes),
        formatList('Open Questions', bible.open_questions),
        bible.sources_summary
    ].filter(Boolean).join('\n\n');
}

function formatMemorySnapshotForContext(snapshot = {}) {
    const lines = [];
    if (snapshot.summary) lines.push(`Summary:\n${compactText(snapshot.summary, 1_200)}`);
    if (snapshot.stageHandoffs?.length) {
        lines.push(`Stage Handoffs:\n${snapshot.stageHandoffs.slice(-8).map(item => {
            return `- ${item.stageName || `Stage ${item.stageId || ''}`}: ${formatKnowledgeItem(item.summary || item)}`;
        }).join('\n')}`);
    }
    if (snapshot.continuityWatchlist?.length) {
        lines.push(`Continuity Watchlist:\n${snapshot.continuityWatchlist.slice(-10).map(item => `- ${formatKnowledgeItem(item)}`).join('\n')}`);
    }
    if (snapshot.acceptedDivergences?.length) {
        lines.push(`Accepted Divergences:\n${snapshot.acceptedDivergences.slice(-6).map(item => `- ${formatKnowledgeItem(item)}`).join('\n')}`);
    }
    if (snapshot.sourceReadiness?.length) {
        lines.push(`Source Readiness:\n${snapshot.sourceReadiness.slice(0, 10).map(item => {
            const issues = item.issueCount ? `, ${item.issueCount} issue${item.issueCount === 1 ? '' : 's'}` : '';
            return `- ${item.stageName || `Stage ${item.stageId || ''}`}: ${item.label || item.status || 'Unknown'}${issues}`;
        }).join('\n')}`);
    }
    if (!lines.length) return '';
    return `### Compact Memory Snapshot\nUse this first. It is the curated project state that should guide downstream choices before consulting detailed source excerpts.\n\n${lines.join('\n\n')}`;
}

function buildKnowledgeContextBlock(projectData, { stageId, userMessage = '', stageName = '', stageData = '', maxChars = KNOWLEDGE_CONTEXT_LIMIT } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);
    const sources = knowledge.source_registry || [];
    const bibleSummary = sourceBibleSummary(knowledge);
    const memorySnapshot = buildKnowledgeSnapshot(projectData);
    const memorySnapshotBlock = formatMemorySnapshotForContext(memorySnapshot);
    const watchlist = (knowledge.continuity_watchlist || []).slice(-12).map(formatKnowledgeItem).filter(Boolean);
    const recentDecisions = (knowledge.decision_log || []).slice(-8).map(formatKnowledgeItem).filter(Boolean);
    const acceptedDivergences = (knowledge.accepted_divergences || []).slice(-8).map(formatKnowledgeItem).filter(Boolean);
    const handoff = knowledge.stage_handoffs?.[`stage${stageId}`] || knowledge.stage_handoffs?.[stageId] || '';
    const hasKnowledge = memorySnapshotBlock || sources.length || bibleSummary || watchlist.length || recentDecisions.length || acceptedDivergences.length || handoff;
    if (!hasKnowledge) return '';

    const query = `${userMessage}\n${stageName}\n${compactText(stageData, 8_000)}`;
    const relevant = stageId
        ? relevantSourceSegmentsForStage(knowledge, query, stageId)
        : relevantSourceSegments(knowledge, query);
    const hasStyleSources = sources.some(source => source.type === 'style_reference' || (source.tags || []).includes('style'));
    const sections = [
        '## PROJECT KNOWLEDGE (PERSISTENT MEMORY)\nUse this as source-aware project memory. Treat source material as reference/canon when it conflicts with assistant speculation.'
    ];
    if (hasStyleSources) {
        sections.push('### Source Type Boundary\nStyle references are tonal guidance only. Use them for voice, rhythm, texture, and cinematic handling; do not treat them as source canon for plot, character facts, chronology, settings, or continuity.');
    }

    if (memorySnapshotBlock) sections.push(memorySnapshotBlock);
    if (bibleSummary) sections.push(`### Source Bible Summary\n${compactText(bibleSummary, 3_500)}`);
    if (watchlist.length) sections.push(`### Continuity Watchlist\n${watchlist.map(item => `- ${item}`).join('\n')}`);
    if (relevant.length) {
        sections.push(`### Relevant Source Documents\n${relevant.map(segment => {
            const source = segment.source || {};
            return `Source: ${source.name || 'Untitled'} (${source.type || 'source'}, id=${source.id || 'unknown'})\n${excerptAroundKeywords(segment.text, segment.keywords || [], 1_000)}`;
        }).join('\n\n')}`);
    }
    if (recentDecisions.length) sections.push(`### Recent Decisions\n${recentDecisions.map(item => `- ${item}`).join('\n')}`);
    if (acceptedDivergences.length) sections.push(`### Accepted Source Divergences\n${acceptedDivergences.map(item => `- ${item}`).join('\n')}`);
    if (handoff) sections.push(`### Current Stage Handoff\n${formatKnowledgeItem(handoff)}`);

    return compactText(sections.join('\n\n'), maxChars);
}

function sourceGenerationWarnings(readiness = {}) {
    const stageName = readiness.stageName || `Stage ${readiness.stageId || ''}`;
    switch (readiness.status) {
        case 'needs_audit':
            return [`${stageName} has saved project sources but no recorded source audit yet. Generate conservatively from the source packet and avoid unsupported canon changes.`];
        case 'stale':
            return [`${stageName} changed after the last source audit. Treat source facts as authoritative and avoid compounding possible drift.`];
        case 'issues':
            return [`${stageName} has unresolved source audit findings. Do not rely on flagged stage material when it conflicts with saved source material.`];
        case 'fixed_since_audit':
            return [`${stageName} has source fixes applied after the last audit. Preserve the fixes and avoid reopening the same source drift.`];
        default:
            return [];
    }
}

function formatSourceReadinessForGeneration(readiness = {}, gate = {}, warnings = []) {
    if (!readiness.sourceCount && !readiness.hasAudit && !warnings.length) return '';
    const lines = [
        '## SOURCE READINESS',
        `Status: ${readiness.label || readiness.status || 'Unknown'} (${readiness.status || 'unknown'})`
    ];
    if (readiness.checkedAt) lines.push(`Last source audit: ${readiness.checkedAt}`);
    if (readiness.issueCounts?.total) lines.push(`Open audit findings: ${readiness.issueCounts.total}`);
    if (gate.message) lines.push(`Gate note: ${gate.message}`);
    if (warnings.length) {
        lines.push('Generation warnings:');
        warnings.forEach(warning => lines.push(`- ${warning}`));
    }
    return lines.join('\n');
}

function buildSourceGenerationPacket(projectData, stageId, stageData = '', { userMessage = '', maxChars = 16_000, readinessStageData = null } = {}) {
    const numericStageId = Number(stageId);
    const stageName = STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`;
    const packetStageData = stageData === undefined || stageData === null ? '' : stageData;
    const auditStageData = readinessStageData === null
        ? stageDataForReadiness(projectData, numericStageId)
        : readinessStageData;
    const readiness = buildSourceReadiness(projectData, numericStageId, auditStageData);
    const gate = buildSourceReadinessGate(readiness);
    const warnings = sourceGenerationWarnings(readiness);
    const sourceUsePlan = buildSourceUsePlan(projectData, numericStageId, packetStageData);
    const knowledgeContext = buildKnowledgeContextBlock(projectData, {
        stageId: numericStageId,
        userMessage: userMessage || `Generate or revise ${stageName} using persistent source material.`,
        stageName,
        stageData: packetStageData,
        maxChars: 12_000
    });
    const readinessBlock = formatSourceReadinessForGeneration(readiness, gate, warnings);
    const sourceUsePlanText = formatSourceUsePlan(sourceUsePlan);
    const sections = [readinessBlock, knowledgeContext, sourceUsePlanText].filter(Boolean);
    const contextBlock = sections.length
        ? `${compactText(sections.join('\n\n---\n\n'), maxChars)}

## SOURCE CANON RULE
Preserve concrete facts from project knowledge and source documents. If existing stage material conflicts with source canon, prefer the source unless the writer's explicit notes or an accepted source divergence say otherwise.`
        : '';

    return {
        stageId: numericStageId,
        stageName,
        stageDataHash: sourcePlanDataHash(packetStageData),
        readinessStageDataHash: sourcePlanDataHash(auditStageData),
        readiness,
        gate,
        warnings,
        sourceUsePlan,
        sourceUsePlanText,
        knowledgeContext,
        contextBlock
    };
}

function sourceWarningsForResponse(packet = {}) {
    if (!packet) return undefined;
    const readiness = packet.readiness || {};
    if (readiness.status === 'needs_audit' && !readiness.isAuditInvalidated) return undefined;
    if (!Array.isArray(packet.warnings) || !packet.warnings.length) return undefined;

    const stageName = readiness.stageName || packet.stageName || `Stage ${readiness.stageId || packet.stageId || ''}`.trim();
    const friendlyWarnings = packet.warnings.map(warning => {
        if (readiness.status === 'stale') {
            return `${stageName} changed after its last source check. Run Check Source before approval if this stage needs to stay aligned with your uploads.`;
        }
        if (readiness.status === 'issues') {
            return `${stageName} has unresolved source check findings. Review them before treating this stage as source-aligned.`;
        }
        if (readiness.status === 'fixed_since_audit') {
            return `${stageName} has source fixes that have not been checked yet. Run Check Source to confirm them.`;
        }
        return String(warning || '')
            .replace(/\bsource audit\b/gi, 'source check')
            .replace(/\bsource packet\b/gi, 'saved sources')
            .replace(/\bcanon\b/gi, 'source material');
    }).filter(Boolean);

    return friendlyWarnings.length ? friendlyWarnings : undefined;
}

function compactMemoryLabels(items = [], maxItems = 4) {
    const seen = new Set();
    const output = [];
    for (const item of items) {
        const label = compactText(formatKnowledgeItem(item), 180);
        const key = memoryDedupeKey(label);
        if (!label || seen.has(key)) continue;
        seen.add(key);
        output.push(label);
        if (output.length >= maxItems) break;
    }
    return output;
}

function sourceMemoryForResponse(packet = {}) {
    const plan = packet?.sourceUsePlan;
    if (!plan?.hasKnowledge) return undefined;

    const sources = (plan.sourceReferences || []).slice(0, 3).map(ref => ({
        sourceId: ref.sourceId || null,
        name: ref.name || 'Untitled source',
        type: ref.type || 'source',
        label: ref.label || ref.name || 'Source'
    }));
    const handoffs = Array.isArray(plan.memorySnapshot?.stageHandoffs)
        ? plan.memorySnapshot.stageHandoffs.slice(-4).map(item => ({
            stageId: item.stageId || null,
            stageName: item.stageName || (item.stageId ? `Stage ${item.stageId}` : 'Stage handoff'),
            summary: compactText(formatKnowledgeItem(item.summary || item), 180)
        })).filter(item => item.summary)
        : [];
    const acceptedDivergences = compactMemoryLabels(plan.acceptedDivergences || plan.memorySnapshot?.acceptedDivergences || [], 3);
    const continuity = compactMemoryLabels(plan.continuityWatchlist || plan.memorySnapshot?.continuityWatchlist || [], 3);
    const summary = compactText(plan.memorySnapshot?.summary || plan.bibleSummary || '', 280);

    if (!sources.length && !handoffs.length && !acceptedDivergences.length && !continuity.length && !summary) {
        return undefined;
    }

    const key = [
        plan.stageId || packet.stageId || '',
        sources.map(source => source.sourceId || source.name).join(','),
        handoffs.map(handoff => `${handoff.stageId || handoff.stageName}:${handoff.summary}`).join(','),
        acceptedDivergences.join(','),
        continuity.join(',')
    ].join('|');

    return {
        stageId: plan.stageId || packet.stageId || null,
        stageName: plan.stageName || packet.stageName || '',
        sources,
        handoffs,
        acceptedDivergences,
        continuity,
        summary,
        key
    };
}

function sourceResponseExtras(packet = {}) {
    if (!packet) return {};
    const warnings = sourceWarningsForResponse(packet);
    const memory = sourceMemoryForResponse(packet);
    return {
        ...(warnings && { sourceWarnings: warnings }),
        ...(memory && { sourceMemory: memory })
    };
}

function memoryUsageForStage(projectData, stageId, stageData = '', userMessage = '') {
    if (!projectData) return undefined;
    const numericStageId = Number(stageId);
    const plan = buildSourceUsePlan(projectData, numericStageId, `${userMessage || ''}\n${stageData || ''}`);
    return sourceMemoryForResponse({
        stageId: numericStageId,
        stageName: STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`,
        sourceUsePlan: plan
    });
}

function isMemoryRecallRequest(message = '') {
    const text = String(message || '').toLowerCase();
    return /\b(what do (you|we) (already )?(remember|know)|what have we (already )?(established|decided)|what is in project memory|what's in project memory|what do you have in memory|what do you remember)\b/.test(text);
}

function buildMemoryRecallResponse(projectData, { stageId, stageName = '', userMessage = '', stageData = '' } = {}) {
    if (!isMemoryRecallRequest(userMessage)) return null;

    const numericStageId = Number(stageId);
    const plan = buildSourceUsePlan(projectData, numericStageId, `${userMessage}\n${stageData}`);
    const memory = sourceMemoryForResponse({
        stageId: numericStageId,
        stageName: stageName || STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`,
        sourceUsePlan: plan
    });

    if (!memory) {
        return {
            message: 'I do not see saved project memory for this stage yet. Upload source material or approve a stage handoff and I can carry it forward.',
            sourceMemory: undefined
        };
    }

    const lines = [`Here is the compact project memory I have for ${memory.stageName || `Stage ${numericStageId}`}:`];
    if (memory.sources.length) {
        lines.push('', 'Sources I can use:');
        for (const source of memory.sources) {
            lines.push(`- ${source.name}`);
        }
    }
    if (memory.handoffs.length) {
        lines.push('', 'Stage handoffs:');
        for (const handoff of memory.handoffs) {
            lines.push(`- ${handoff.stageName}: ${handoff.summary}`);
        }
    }
    if (memory.continuity.length) {
        lines.push('', 'Continuity to preserve:');
        for (const item of memory.continuity) lines.push(`- ${item}`);
    }
    if (memory.acceptedDivergences.length) {
        lines.push('', 'Accepted divergences:');
        for (const item of memory.acceptedDivergences) lines.push(`- ${item}`);
    }
    lines.push('', 'I will use source references as canon, accepted divergences as approved departures, and compact handoffs as downstream story state.');

    return {
        message: lines.join('\n'),
        sourceMemory: memory
    };
}

async function persistStageConversation(filePath, projectData, stageKey, messages, assistantMessage) {
    const MAX_HISTORY = 100;
    const updated = [...messages, { role: 'assistant', content: assistantMessage }];
    const nextHistory = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;
    const projectId = projectIdFromPath(filePath);

    if (projectId) {
        await updateProjectJSON(projectId, (freshProject) => {
            freshProject.data = freshProject.data || {};
            const convos = freshProject.data.conversations || {};
            convos[stageKey] = nextHistory;
            freshProject.data.conversations = convos;
            return freshProject;
        });
        return;
    }

    projectData.data = projectData.data || {};
    const convos = projectData.data.conversations || {};
    convos[stageKey] = nextHistory;
    projectData.data.conversations = convos;
    await writeJSONQueued(filePath, projectData);
}

function conversationKeyForAssistantStage(stageId) {
    return Number(stageId) === 10 ? 'stage9' : `stage${stageId}`;
}

function isGlobalStyleAssistantStage(stageId) {
    return String(stageId) === 'style_global';
}

async function buildGlobalStyleAssistantContext() {
    let contextBlock = `## STYLE CREATOR
You are helping the writer create a reusable style outside any single project. There is no active project artifact to revise. Use the generate_style tool only when the writer confirms a concrete style direction.`;

    const existingStyles = [];
    try {
        const files = await fs.readdir(STYLES_DIR);
        for (const file of files) {
            if (!file.endsWith('-directive.md') && !file.endsWith('.md')) continue;
            if (file.endsWith('-reference.md')) continue;
            try {
                const raw = await fs.readFile(path.join(STYLES_DIR, file), 'utf-8');
                const { meta } = parseStyleFile(raw);
                existingStyles.push(meta.name || file.replace(/-directive\.md$|\.md$/g, ''));
            } catch {}
        }
    } catch {}

    if (existingStyles.length > 0) {
        contextBlock += `\n\n## EXISTING STYLES\n${existingStyles.map(name => `- ${name}`).join('\n')}`;
    }

    try {
        const projectFiles = await fs.readdir(DATA_DIR);
        const pitches = [];
        for (const f of projectFiles) {
            if (!f.endsWith('.json')) continue;
            try {
                const pData = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf-8'));
                const pitch = pData.data?.stage1_pitch?.pitch;
                if (pitch?.title) {
                    pitches.push(`- "${pitch.title}" (${pitch.genre || 'genre TBD'}): ${(pitch.synopsis || '').slice(0, 200)}`);
                }
            } catch {}
        }
        if (pitches.length > 0) {
            contextBlock += `\n\n## WRITER'S PROJECTS\n${pitches.join('\n')}\nIf the writer mentions a project by name, tailor the style to that story.`;
        }
    } catch {}

    return contextBlock;
}

function recordSourceGenerationUsage(projectData, packet, stageData = '', reason = 'generation') {
    if (!packet?.stageId) return null;
    return recordSourcePlanUsage(projectData, packet.stageId, stageData, reason, packet.sourceUsePlan);
}

function getModelConfigWithSourcePacket(stageNum, packet) {
    const config = getModelConfig(stageNum);
    return packet?.contextBlock ? { ...config, knowledgeContext: packet.contextBlock } : config;
}

function buildGenerationKnowledgeContext(projectData, stageId, stageData = '') {
    return buildSourceGenerationPacket(projectData, stageId, stageData).contextBlock;
}

function getModelConfigWithKnowledge(stageNum, projectData, stageData = '') {
    return getModelConfigWithSourcePacket(stageNum, buildSourceGenerationPacket(projectData, stageNum, stageData));
}

async function prepareGenerationProjectContext(req, res, {
    projectId = req.body?.projectId,
    invalidProjectMessage = 'Missing or invalid projectId',
    notFoundMessage = 'Project not found',
    notFoundLog = '',
    validate = null
} = {}) {
    if (!isValidProjectId(projectId)) {
        throw new BadRequestError(invalidProjectMessage);
    }

    const filePath = getProjectFilePath(projectId);
    let projectData;
    try {
        projectData = await readProjectJSONById(projectId, { invalidMessage: invalidProjectMessage, notFoundMessage });
    } catch (err) {
        if (notFoundLog) console.error(notFoundLog);
        throw err;
    }

    if (validate) {
        const validationError = validate(projectData);
        if (validationError) {
            throw new BadRequestError(validationError);
        }
    }

    return { projectId, filePath, projectData, data: projectData.data || {} };
}

async function finalizeGeneratedStageArtifact({
    projectId,
    filePath,
    projectData,
    stage,
    stageKey,
    result,
    before,
    operation = 'generation',
    note = '',
    revisionReceipt = null,
    changed = true,
    sourcePacket = null,
    usage = null,
    sourceReason = operation,
    sourceData = result,
    beforeSave = null,
    afterSave = null
} = {}) {
    const snapshotEntries = recordArtifactMutation(projectData, {
        projectId,
        stage,
        before,
        after: result,
        operation,
        note: note || '',
        revisionReceipt
    });

    projectData.data = projectData.data || {};
    projectData.data[stageKey] = result;
    if (beforeSave) await beforeSave(projectData);

    if (operation === 'revision') {
        if (changed) stampRevised(projectData, stageKey);
    } else {
        stampGenerated(projectData, stageKey);
    }

    if (sourcePacket) {
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(sourceData, null, 2), sourceReason);
    }

    await writeJSONQueued(filePath, projectData);
    if (afterSave) await afterSave({ filePath, projectData, result });
    trackUsage(projectId, usage);
    return {
        snapshotIds: snapshotEntries.map(entry => entry.id)
    };
}

function createVerifiedGenerationRevision({ enabled, label, build }) {
    if (!enabled) return null;
    const revisionTransaction = build();
    assertRevisionTransactionVerified(revisionTransaction, label);
    return revisionTransaction;
}

async function finalizeGenerationEndpointArtifact({
    context,
    stage,
    stageKey,
    result,
    before,
    operation = 'generation',
    note = '',
    revisionTransaction = null,
    revisionReceipt = undefined,
    changed = operation !== 'revision' || revisionTransaction?.changed === true,
    sourcePacket = null,
    usage = null,
    sourceReason = operation,
    sourceData = result,
    beforeSave = null,
    afterSave = null
} = {}) {
    const receipt = revisionReceipt !== undefined
        ? revisionReceipt
        : (revisionTransaction?.receipt || null);
    const { snapshotIds } = await finalizeGeneratedStageArtifact({
        projectId: context.projectId,
        filePath: context.filePath,
        projectData: context.projectData,
        stage,
        stageKey,
        result,
        before,
        operation,
        note,
        revisionReceipt: receipt,
        changed,
        sourcePacket,
        usage,
        sourceReason,
        sourceData,
        beforeSave,
        afterSave
    });
    return { snapshotIds, revisionReceipt: receipt, changed };
}

function completeGenerationEndpoint({ res, streaming = false, send = null, payload }) {
    if (streaming && send) {
        send({ type: 'complete', ...payload });
        return;
    }
    res.json(payload);
}

function summarizeSourceForClient(source) {
    return {
        id: source.id,
        name: source.name,
        mimeType: source.mimeType,
        uploadedAt: source.uploadedAt,
        updatedAt: source.updatedAt,
        lastReferencedAt: source.lastReferencedAt,
        stageId: source.stageId,
        stagesReferenced: source.stagesReferenced || [],
        type: source.type || 'source_material',
        tags: source.tags || [],
        charCount: source.charCount || 0,
        chunkCount: Array.isArray(source.chunks) ? source.chunks.length : 0,
        truncated: !!source.truncated,
        sourceNote: source.sourceNote || '',
        storage: source.storage || (source.text ? 'text' : source.chunks ? 'chunks' : 'summary'),
        summary: source.summary || '',
        originalFile: source.originalFile || null,
        extractedMarkdown: source.extractedMarkdown || null
    };
}

function resolveStoredSourceAssetPath(projectId, sourceId, storedAsset) {
    if (!isValidProjectId(String(projectId)) || !/^src_[a-zA-Z0-9_]+$/.test(String(sourceId))) return null;
    const storedPath = String(storedAsset?.path || '');
    if (!storedPath || storedPath.includes('\0')) return null;

    const resolved = path.resolve(DATA_ROOT, storedPath);
    const expectedDir = path.resolve(SOURCE_FILES_DIR, String(projectId), String(sourceId));
    if (resolved !== expectedDir && !resolved.startsWith(expectedDir + path.sep)) return null;
    return resolved;
}

function sourceTextFromRegistry(source) {
    if (!source) return '';
    if (source.text) return normalizeSourceText(source.text);
    if (Array.isArray(source.chunks) && source.chunks.length) {
        const chunks = source.chunks
            .filter(chunk => chunk && typeof chunk.text === 'string')
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        let output = '';
        let previousEnd = 0;
        for (const chunk of chunks) {
            const start = Number.isFinite(chunk.start) ? chunk.start : previousEnd;
            const text = chunk.text || '';
            const overlap = output ? Math.max(0, previousEnd - start) : 0;
            output += text.slice(overlap);
            previousEnd = Math.max(previousEnd, start + text.length);
        }
        return normalizeSourceText(output);
    }
    return normalizeSourceText(source.summary || '');
}

function hasRecoverableSourceText(source) {
    if (!source) return false;
    if (typeof source.text === 'string' && normalizeSourceText(source.text)) return true;
    return Array.isArray(source.chunks)
        && source.chunks.some(chunk => chunk && typeof chunk.text === 'string' && normalizeSourceText(chunk.text));
}

async function readKnowledgeSourceAssetForClient(projectData, projectId, sourceId, assetKind = 'extracted') {
    const knowledge = ensureProjectKnowledge(projectData);
    const source = knowledge.source_registry.find(item => item.id === sourceId);
    if (!source) {
        throw new NotFoundError('Source not found');
    }

    if (assetKind === 'original') {
        const filePath = resolveStoredSourceAssetPath(projectId, sourceId, source.originalFile);
        if (!filePath) {
            throw new NotFoundError('Original source file is not available.');
        }
        const buffer = await fs.readFile(filePath);
        return {
            source: summarizeSourceForClient(source),
            assetKind,
            filename: source.originalFile?.filename || source.name || 'source',
            mimeType: source.originalFile?.mimeType || source.mimeType || 'application/octet-stream',
            byteCount: buffer.length,
            buffer
        };
    }

    if (assetKind === 'extracted') {
        const filePath = resolveStoredSourceAssetPath(projectId, sourceId, source.extractedMarkdown);
        if (filePath) {
            try {
                const content = await fs.readFile(filePath, 'utf8');
                return {
                    source: summarizeSourceForClient(source),
                    assetKind,
                    filename: source.extractedMarkdown?.filename || markdownNameForSource(source.name, sourceId),
                    mimeType: 'text/markdown; charset=utf-8',
                    charCount: content.length,
                    content
                };
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }

    if (assetKind === 'text' || assetKind === 'extracted') {
        const text = sourceTextFromRegistry(source);
        if (!text) {
            throw new NotFoundError('No readable text is available for this source.');
        }
        return {
            source: summarizeSourceForClient(source),
            assetKind: 'text',
            filename: `${path.parse(source.name || sourceId).name || sourceId}.txt`,
            mimeType: 'text/plain; charset=utf-8',
            charCount: text.length,
            content: text
        };
    }

    throw new BadRequestError('Unknown source asset type.');
}

function contentDispositionFilename(name, fallback = 'source') {
    return sanitizeSourceAssetName(name, fallback).replace(/"/g, '');
}

function stableLegacySourceId(projectId, source = {}, index = 0, usedIds = new Set()) {
    const seed = [
        projectId || '',
        source.id || '',
        source.name || '',
        source.contentHash || '',
        source.summary || '',
        source.text || '',
        index
    ].join('|');
    const base = `src_legacy_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
    let candidate = base;
    let suffix = 1;
    while (usedIds.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
}

async function storedAssetExists(projectId, sourceId, storedAsset) {
    const assetPath = resolveStoredSourceAssetPath(projectId, sourceId, storedAsset);
    if (!assetPath) return false;
    try {
        await fs.access(assetPath);
        return true;
    } catch {
        return false;
    }
}

async function writeRecoveredMarkdownAsset(projectId, source, text, now) {
    if (!isValidProjectId(String(projectId)) || !/^src_[a-zA-Z0-9_]+$/.test(String(source?.id || ''))) return null;
    const sourceDir = path.join(SOURCE_FILES_DIR, String(projectId), String(source.id));
    await fs.mkdir(sourceDir, { recursive: true });
    const markdownName = markdownNameForSource(source.name, source.id);
    const markdownPath = path.join(sourceDir, markdownName);
    const markdownContent = buildExtractedMarkdownContent({
        sourceId: source.id,
        name: source.name || 'Legacy source',
        mimeType: source.mimeType || 'text/plain',
        uploadedAt: source.uploadedAt || now,
        contentHash: source.contentHash || '',
        text
    });
    await fs.writeFile(markdownPath, markdownContent, 'utf8');
    return {
        filename: markdownName,
        path: normalizeStoredRelativePath(markdownPath),
        mimeType: 'text/markdown',
        charCount: markdownContent.length,
        sha256: crypto.createHash('sha256').update(markdownContent).digest('hex'),
        generatedAt: now
    };
}

async function upgradeLegacyProjectKnowledge(projectData, projectId, { writeAssets = false, now = new Date().toISOString() } = {}) {
    const before = JSON.stringify(projectData.data?.knowledge ?? null);
    const knowledge = ensureProjectKnowledge(projectData);
    const report = {
        projectId,
        title: projectData.title || projectData.data?.stage1_pitch?.pitch?.title || 'Untitled Project',
        changed: false,
        normalizedKnowledge: before !== JSON.stringify(knowledge),
        sourceCount: knowledge.source_registry.length,
        recoveredMarkdown: 0,
        missingOriginal: 0,
        missingExtractedMarkdown: 0,
        missingReadableText: 0,
        truncatedSources: 0,
        warnings: []
    };

    const usedIds = new Set();
    for (let index = 0; index < knowledge.source_registry.length; index += 1) {
        const source = knowledge.source_registry[index] || {};
        if (!/^src_[a-zA-Z0-9_]+$/.test(String(source.id || '')) || usedIds.has(source.id)) {
            const previousId = source.id || '';
            source.id = stableLegacySourceId(projectId, source, index, usedIds);
            report.changed = true;
            report.warnings.push({
                sourceId: source.id,
                kind: 'source_id_recovered',
                message: previousId ? `Replaced invalid or duplicate source id "${previousId}".` : 'Created a source id for legacy source material.'
            });
        } else {
            usedIds.add(source.id);
        }

        source.name = source.name || 'Legacy source';
        source.mimeType = source.mimeType || 'text/plain';
        source.type = SOURCE_TYPE_OPTIONS.has(source.type) ? source.type : 'source_material';
        source.tags = sanitizeSourceTags(source.tags || []);

        const readableText = hasRecoverableSourceText(source) ? sourceTextFromRegistry(source) : '';
        if (readableText) {
            if (!source.charCount) source.charCount = readableText.length;
            if (!source.contentHash) source.contentHash = crypto.createHash('sha256').update(readableText).digest('hex').slice(0, 20);
            if (!source.summary) source.summary = summarizeSourceText(readableText);
            if (!source.storage) source.storage = source.text ? 'text' : (Array.isArray(source.chunks) ? 'chunks' : 'summary');
        } else {
            report.missingReadableText += 1;
            report.warnings.push({
                sourceId: source.id,
                kind: 'source_text_unavailable',
                message: `${source.name || source.id} has no recoverable full text in the legacy registry.`
            });
        }

        if (source.truncated) {
            report.truncatedSources += 1;
            report.warnings.push({
                sourceId: source.id,
                kind: 'source_text_truncated',
                message: `${source.name || source.id} was stored as truncated chunks before source-file assets existed.`
            });
        }

        const hasOriginal = await storedAssetExists(projectId, source.id, source.originalFile);
        if (!hasOriginal) {
            report.missingOriginal += 1;
            report.warnings.push({
                sourceId: source.id,
                kind: 'original_file_unavailable',
                message: `${source.name || source.id} does not have a recoverable original uploaded file.`
            });
        }

        const hasExtractedMarkdown = await storedAssetExists(projectId, source.id, source.extractedMarkdown);
        if (!hasExtractedMarkdown && readableText && writeAssets) {
            const recovered = await writeRecoveredMarkdownAsset(projectId, source, readableText, now);
            if (recovered) {
                source.extractedMarkdown = recovered;
                report.recoveredMarkdown += 1;
                report.changed = true;
            }
        } else if (!hasExtractedMarkdown) {
            report.missingExtractedMarkdown += 1;
        }
    }

    if (before !== JSON.stringify(projectData.data?.knowledge ?? null)) {
        report.changed = true;
    }

    const shouldCompact = report.normalizedKnowledge
        || report.changed
        || !knowledge.memory_snapshot
        || !knowledge.source_bible?.compactedAt;
    if (shouldCompact) {
        refreshSourceBibleSummary(knowledge);
        compactProjectKnowledge(projectData, { now });
        report.changed = true;
    }

    const after = JSON.stringify(projectData.data?.knowledge ?? null);
    report.changed = report.changed || before !== after;
    return report;
}

async function auditOrUpgradeAllProjectKnowledge({ write = false, now = new Date().toISOString() } = {}) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const files = (await fs.readdir(DATA_DIR)).filter(file => file.endsWith('.json'));
    const reports = [];
    for (const file of files) {
        const projectId = path.basename(file, '.json');
        if (!isValidProjectId(projectId)) continue;
        const filePath = path.join(DATA_DIR, file);
        const projectData = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const report = await upgradeLegacyProjectKnowledge(projectData, projectId, { writeAssets: write, now });
        if (write && report.changed) {
            await writeJSONQueued(filePath, projectData);
        }
        reports.push(report);
    }
    const totals = reports.reduce((acc, report) => {
        acc.projects += 1;
        if (report.changed) acc.changed += 1;
        acc.sources += report.sourceCount;
        acc.recoveredMarkdown += report.recoveredMarkdown;
        acc.missingOriginal += report.missingOriginal;
        acc.missingExtractedMarkdown += report.missingExtractedMarkdown;
        acc.missingReadableText += report.missingReadableText;
        acc.truncatedSources += report.truncatedSources;
        return acc;
    }, {
        projects: 0,
        changed: 0,
        sources: 0,
        recoveredMarkdown: 0,
        missingOriginal: 0,
        missingExtractedMarkdown: 0,
        missingReadableText: 0,
        truncatedSources: 0
    });
    return { ok: true, write, totals, projects: reports };
}

function sanitizeSourceTags(tags) {
    const rawTags = Array.isArray(tags)
        ? tags
        : String(tags || '').split(/[,\s]+/);
    const cleanTags = rawTags
        .map(tag => String(tag || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
        .filter(Boolean)
        .filter(tag => tag.length <= 40);
    return Array.from(new Set(cleanTags)).slice(0, 12);
}

function updateKnowledgeSourceMetadata(projectData, sourceId, { type, tags } = {}, { now = new Date().toISOString() } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);
    const source = knowledge.source_registry.find(item => item.id === sourceId);
    if (!source) {
        throw new NotFoundError('Source not found');
    }

    const cleanType = SOURCE_TYPE_OPTIONS.has(type) ? type : (source.type || 'source_material');
    const baseTags = tags === undefined ? (source.tags || []) : tags;
    const cleanTags = sanitizeSourceTags(baseTags).filter(tag => !SOURCE_TYPE_TAGS.has(tag));
    const typeTag = SOURCE_TYPE_DEFAULT_TAG[cleanType];
    source.type = cleanType;
    source.tags = Array.from(new Set([...cleanTags, typeTag].filter(Boolean)));
    source.updatedAt = now;

    refreshSourceBibleSummary(knowledge);
    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type: 'source_metadata_updated',
        sourceId,
        summary: `Updated source metadata for ${source.name || sourceId}.`
    }, 120);
    compactProjectKnowledge(projectData, { now });
    return source;
}

function removeKnowledgeSource(projectData, sourceId, { now = new Date().toISOString() } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);
    const source = knowledge.source_registry.find(item => item.id === sourceId);
    if (!source) {
        throw new NotFoundError('Source not found');
    }

    const invalidatedReason = `Source ${source.name || sourceId} was removed from project knowledge.`;
    knowledge.source_registry = knowledge.source_registry.filter(item => item.id !== sourceId);
    refreshSourceBibleSummary(knowledge);

    for (const plan of Object.values(knowledge.stage_source_plans || {})) {
        if (!plan || typeof plan !== 'object') continue;
        const sourceIds = Array.isArray(plan.sourceIds) ? plan.sourceIds : [];
        const sourceReferences = Array.isArray(plan.sourceReferences) ? plan.sourceReferences : [];
        const touched = sourceIds.includes(sourceId) || sourceReferences.some(ref => ref?.sourceId === sourceId);
        if (!touched) continue;

        plan.sourceIds = sourceIds.filter(id => id !== sourceId);
        plan.sourceReferences = sourceReferences.filter(ref => ref?.sourceId !== sourceId);
        plan.invalidatedAt = now;
        plan.invalidatedReason = invalidatedReason;
        plan.localCheck = localSourcePlanCheck(knowledge, plan);
    }

    for (const audit of Object.values(knowledge.stage_source_audits || {})) {
        if (!audit || typeof audit !== 'object') continue;
        const camelReferences = Array.isArray(audit.sourceReferences) ? audit.sourceReferences : [];
        const snakeReferences = Array.isArray(audit.source_references) ? audit.source_references : [];
        const touched = [...camelReferences, ...snakeReferences].some(ref => ref?.sourceId === sourceId);
        if (!touched) continue;

        audit.sourceReferences = camelReferences.filter(ref => ref?.sourceId !== sourceId);
        if (snakeReferences.length) {
            audit.source_references = snakeReferences.filter(ref => ref?.sourceId !== sourceId);
        }
        audit.invalidatedAt = now;
        audit.invalidatedReason = invalidatedReason;
    }

    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type: 'source_removed',
        sourceId,
        summary: invalidatedReason
    });
    compactProjectKnowledge(projectData, { now });
    return source;
}

function updateKnowledgeReview(projectData, { continuity_watchlist, curated_notes, stage_handoffs } = {}, { now = new Date().toISOString() } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);

    if (Array.isArray(continuity_watchlist)) {
        knowledge.continuity_watchlist = continuity_watchlist
            .map(item => compactText(item, 600))
            .filter(Boolean)
            .slice(-80);
    }
    if (Array.isArray(curated_notes)) {
        knowledge.source_bible.curated_notes = curated_notes
            .map(item => compactText(item, 600))
            .filter(Boolean)
            .slice(-100);
        knowledge.source_bible.updatedAt = now;
    }
    if (stage_handoffs && typeof stage_handoffs === 'object' && !Array.isArray(stage_handoffs)) {
        const nextHandoffs = {};
        for (const [key, value] of Object.entries(stage_handoffs)) {
            if (!/^stage(?:[1-9]|10)$/.test(key)) continue;
            const summary = typeof value === 'string' ? value : value?.summary;
            if (!summary || !String(summary).trim()) continue;
            const previous = knowledge.stage_handoffs[key] || {};
            nextHandoffs[key] = {
                ...previous,
                at: now,
                type: 'manual_memory_review',
                summary: compactText(summary, 1_200)
            };
        }
        knowledge.stage_handoffs = nextHandoffs;
    }

    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type: 'project_memory_review_updated',
        summary: 'Project memory was manually reviewed and updated.'
    }, 120);
    compactProjectKnowledge(projectData, { now });
    return knowledge;
}

function recordAcceptedSourceDivergence(projectData, { stageId, summary, audit } = {}, { now = new Date().toISOString(), divergenceId = null } = {}) {
    const numericStageId = Number(stageId);
    if (!numericStageId || !STAGE_NAMES[numericStageId]) throw new Error('Invalid stage ID');

    const knowledge = ensureProjectKnowledge(projectData);
    const compactAudit = compactAuditForKnowledge(audit);
    const cleanSummary = compactText(
        summary || `Accepted Stage ${numericStageId} source divergence: ${summarizeAuditForDecision(audit)}`,
        1_000
    );
    const divergence = {
        id: divergenceId || `div_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        at: now,
        stageId: numericStageId,
        stageName: STAGE_NAMES[numericStageId],
        summary: cleanSummary,
        audit: compactAudit
    };

    boundedKnowledgePush(knowledge.accepted_divergences, divergence, 80);
    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type: 'accepted_source_divergence',
        stageId: numericStageId,
        summary: cleanSummary,
        divergenceId: divergence.id,
        audit: compactAudit
    }, 120);
    knowledge.stage_handoffs[`stage${numericStageId}`] = {
        at: now,
        type: 'accepted_source_divergence',
        summary: cleanSummary
    };
    compactProjectKnowledge(projectData, { now });
    return divergence;
}

function applyStageCurationToKnowledge(projectData, { stageId, proposal } = {}, { now = new Date().toISOString(), stageData = '' } = {}) {
    const numericStageId = Number(stageId);
    if (!numericStageId || !STAGE_NAMES[numericStageId]) throw new Error('Invalid stage ID');

    const cleanProposal = sanitizeStageCurationProposal(proposal, {
        stageId: numericStageId,
        stageName: STAGE_NAMES[numericStageId],
        stageData
    });
    const knowledge = ensureProjectKnowledge(projectData);
    knowledge.stage_handoffs[`stage${numericStageId}`] = {
        at: now,
        type: 'stage_approved_handoff',
        summary: cleanProposal.handoff_summary
    };

    const watchItems = [
        ...(knowledge.continuity_watchlist || []).map(formatKnowledgeItem),
        ...cleanProposal.continuity_watchlist_additions
    ].filter(Boolean);
    knowledge.continuity_watchlist = Array.from(new Set(watchItems)).slice(-60);

    const existingNotes = Array.isArray(knowledge.source_bible.curated_notes) ? knowledge.source_bible.curated_notes : [];
    const stagedNotes = cleanProposal.source_bible_notes.map(note => `Stage ${numericStageId}: ${note}`);
    knowledge.source_bible.curated_notes = Array.from(new Set([...existingNotes, ...stagedNotes])).slice(-80);
    knowledge.source_bible.updatedAt = now;

    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type: 'stage_memory_curated',
        stageId: numericStageId,
        summary: cleanProposal.decision_summary,
        handoff: cleanProposal.handoff_summary
    }, 120);
    compactProjectKnowledge(projectData, { now });
    return cleanProposal;
}

function knowledgePayloadForClient(knowledge, projectData = null) {
    return {
        source_registry: (knowledge.source_registry || []).map(summarizeSourceForClient),
        source_bible: knowledge.source_bible,
        continuity_watchlist: knowledge.continuity_watchlist || [],
        decision_log: knowledge.decision_log || [],
        stage_handoffs: knowledge.stage_handoffs || {},
        stage_source_plans: knowledge.stage_source_plans || {},
        stage_source_audits: knowledge.stage_source_audits || {},
        stage_source_readiness: projectData ? buildSourceReadinessList(projectData) : [],
        accepted_divergences: knowledge.accepted_divergences || [],
        memory_snapshot: projectData ? buildKnowledgeSnapshot(projectData) : (knowledge.memory_snapshot || null)
    };
}

function boundedKnowledgePush(list, item, maxItems = 100) {
    list.push(item);
    if (list.length > maxItems) list.splice(0, list.length - maxItems);
}

function memoryDedupeKey(value) {
    return String(formatKnowledgeItem(value) || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s:.-]/g, '')
        .trim();
}

function dedupeLatest(items = [], keyFn = memoryDedupeKey, maxItems = 80) {
    const seen = new Set();
    const output = [];
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.unshift(item);
    }
    return output.slice(-maxItems);
}

function buildStageHandoffSummary(stageId, stageName, stageData) {
    const fallback = buildFallbackStageCuration(stageId, stageName, stageData);
    return fallback.handoff_summary;
}

function refreshStageHandoff(projectData, stageId, stageData, { now = new Date().toISOString(), type = 'stage_auto_handoff' } = {}) {
    const numericStageId = Number(stageId);
    const stageName = STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`;
    const knowledge = ensureProjectKnowledge(projectData);
    const summary = buildStageHandoffSummary(numericStageId, stageName, stageData);
    const entry = {
        at: now,
        type,
        summary,
        stageOutputHash: sourcePlanDataHash(stageData)
    };
    knowledge.stage_handoffs[`stage${numericStageId}`] = entry;
    boundedKnowledgePush(knowledge.decision_log, {
        at: now,
        type,
        stageId: numericStageId,
        summary: `Refreshed ${stageName} memory handoff.`
    }, 120);
    compactProjectKnowledge(projectData, { now });
    return entry;
}

function buildKnowledgeSnapshot(projectData, { now = new Date().toISOString(), includeReadiness = true } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);
    const handoffs = Object.entries(knowledge.stage_handoffs || {})
        .map(([key, value]) => {
            const stageId = Number(String(key).replace('stage', ''));
            return {
                stageId,
                stageName: STAGE_NAMES[stageId] || key,
                at: value?.at || null,
                summary: compactText(value?.summary || value || '', 500)
            };
        })
        .filter(item => item.summary)
        .sort((a, b) => Number(a.stageId || 0) - Number(b.stageId || 0));
    const readiness = includeReadiness
        ? buildSourceReadinessList(projectData).map(item => ({
            stageId: item.stageId,
            stageName: item.stageName,
            status: item.status,
            label: item.label,
            checkedAt: item.checkedAt,
            issueCount: item.issueCounts?.total || 0
        }))
        : [];
    const sourceSummary = sourceBibleSummary(knowledge);
    const continuity = (knowledge.continuity_watchlist || []).map(formatKnowledgeItem).filter(Boolean).slice(-12);
    const divergences = (knowledge.accepted_divergences || []).map(formatKnowledgeItem).filter(Boolean).slice(-8);
    const decisions = (knowledge.decision_log || []).map(formatKnowledgeItem).filter(Boolean).slice(-8);

    return {
        generatedAt: now,
        sourceCount: knowledge.source_registry?.length || 0,
        sourceBibleSummary: compactText(sourceSummary, 2_200),
        stageHandoffs: handoffs,
        continuityWatchlist: continuity,
        acceptedDivergences: divergences,
        recentDecisions: decisions,
        sourceReadiness: readiness,
        summary: compactText([
            sourceSummary ? `Source bible: ${compactText(sourceSummary, 600)}` : '',
            handoffs.length ? `Stage handoffs: ${handoffs.map(item => `${item.stageName}: ${item.summary}`).join(' ')}` : '',
            continuity.length ? `Continuity: ${continuity.join(' ')}` : ''
        ].filter(Boolean).join('\n'), 1_600)
    };
}

function compactProjectKnowledge(projectData, { now = new Date().toISOString(), recordDecision = false, reason = 'memory_compacted' } = {}) {
    const knowledge = ensureProjectKnowledge(projectData);
    const bible = knowledge.source_bible || {};
    for (const key of ['canon_facts', 'characters', 'settings', 'timeline', 'rules', 'must_keep_elements', 'open_questions']) {
        if (Array.isArray(bible[key])) {
            bible[key] = dedupeLatest(bible[key].map(item => compactText(item, 600)).filter(Boolean), memoryDedupeKey, 80);
        }
    }
    bible.curated_notes = dedupeLatest((bible.curated_notes || []).map(item => compactText(item, 600)).filter(Boolean), memoryDedupeKey, 100);
    bible.compactedAt = now;

    knowledge.continuity_watchlist = dedupeLatest(
        (knowledge.continuity_watchlist || []).map(item => compactText(formatKnowledgeItem(item), 600)).filter(Boolean),
        memoryDedupeKey,
        80
    );
    knowledge.accepted_divergences = dedupeLatest(
        knowledge.accepted_divergences || [],
        item => memoryDedupeKey(item?.summary || item),
        80
    );
    knowledge.decision_log = dedupeLatest(
        knowledge.decision_log || [],
        item => `${item?.type || 'decision'}|${item?.stageId || ''}|${memoryDedupeKey(item?.summary || item)}`,
        120
    );

    const compactHandoffs = {};
    for (const [key, value] of Object.entries(knowledge.stage_handoffs || {})) {
        if (!/^stage(?:[1-9]|10)$/.test(key)) continue;
        const summary = compactText(value?.summary || value || '', 1_200);
        if (!summary) continue;
        compactHandoffs[key] = {
            ...(typeof value === 'object' && !Array.isArray(value) ? value : {}),
            summary
        };
    }
    knowledge.stage_handoffs = compactHandoffs;

    if (recordDecision) {
        boundedKnowledgePush(knowledge.decision_log, {
            at: now,
            type: reason,
            summary: 'Compacted project memory for downstream assistant context.'
        }, 120);
    }
    knowledge.memory_snapshot = buildKnowledgeSnapshot(projectData, { now });
    return knowledge;
}

function compactAuditForKnowledge(audit = {}) {
    const pick = (key, maxItems = 8) => Array.isArray(audit[key])
        ? audit[key].filter(Boolean).slice(0, maxItems).map(item => compactText(item, 500))
        : [];
    return {
        stageId: Number(audit.stageId) || null,
        stageName: compactText(audit.stageName || '', 120),
        checkedAt: audit.checkedAt || null,
        aligned_items: pick('aligned_items', 5),
        possible_source_mismatches: pick('possible_source_mismatches'),
        missing_source_elements: pick('missing_source_elements'),
        recommended_fixes: pick('recommended_fixes')
    };
}

function summarizeAuditForDecision(audit = {}) {
    const compact = compactAuditForKnowledge(audit);
    const parts = [];
    if (compact.possible_source_mismatches.length) parts.push(`${compact.possible_source_mismatches.length} mismatch${compact.possible_source_mismatches.length === 1 ? '' : 'es'}`);
    if (compact.missing_source_elements.length) parts.push(`${compact.missing_source_elements.length} missing source element${compact.missing_source_elements.length === 1 ? '' : 's'}`);
    if (compact.recommended_fixes.length) parts.push(`${compact.recommended_fixes.length} recommended fix${compact.recommended_fixes.length === 1 ? '' : 'es'}`);
    return parts.length ? parts.join(', ') : 'No source alignment issues recorded.';
}

function sourceAuditHasActionableItems(audit = {}) {
    return ['possible_source_mismatches', 'missing_source_elements', 'recommended_fixes']
        .some(key => Array.isArray(audit[key]) && audit[key].filter(Boolean).length > 0);
}

function buildSourceAuditFixNotes(audit = {}, { stageId, stageName, userInstruction = '' } = {}) {
    const compact = compactAuditForKnowledge({ ...audit, stageId, stageName });
    const section = (label, items) => items.length
        ? `\n${label}:\n${items.map(item => `- ${item}`).join('\n')}`
        : '';
    return compactText(`Apply source-alignment fixes to ${stageName || `Stage ${stageId}`}.
Preserve the existing structure, formatting shape, and approved creative intent. Only change content needed to resolve the source audit below.
${userInstruction ? `\nAdditional writer instruction:\n${userInstruction}\n` : ''}
${section('Possible source mismatches', compact.possible_source_mismatches)}
${section('Missing source elements', compact.missing_source_elements)}
${section('Recommended fixes', compact.recommended_fixes)}

Return a coherent revised stage output, not commentary about the revision.`, 6_000);
}

function stageDataOverrideToText(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}

function sanitizeStageCurationProposal(proposal = {}, { stageId, stageName, stageData } = {}) {
    const cleanList = (items, maxItems = 8, maxChars = 500) => Array.isArray(items)
        ? items.map(item => compactText(item, maxChars)).filter(Boolean).slice(0, maxItems)
        : [];
    const fallbackSummary = `${stageName || `Stage ${stageId}`} approved. ${compactText(stageData || '', 700)}`;
    return {
        stageId: Number(stageId) || null,
        stageName: stageName || STAGE_NAMES[stageId] || `Stage ${stageId}`,
        handoff_summary: compactText(proposal.handoff_summary || fallbackSummary, 1_200),
        continuity_watchlist_additions: cleanList(proposal.continuity_watchlist_additions, 8, 500),
        source_bible_notes: cleanList(proposal.source_bible_notes, 8, 500),
        decision_summary: compactText(proposal.decision_summary || `Approved ${stageName || `Stage ${stageId}`} and updated project memory.`, 800)
    };
}

function buildFallbackStageCuration(stageId, stageName, stageData) {
    return sanitizeStageCurationProposal({
        handoff_summary: `${stageName || `Stage ${stageId}`} approved. ${compactText(stageData || '', 700)}`,
        continuity_watchlist_additions: [],
        source_bible_notes: [],
        decision_summary: `Approved ${stageName || `Stage ${stageId}`} and saved a downstream handoff.`
    }, { stageId, stageName, stageData });
}

function stageHasApprovedOutput(projectData, stageId) {
    const data = projectData?.data || {};
    switch (Number(stageId)) {
        case 1: return !!data.stage1_pitch?.pitch;
        case 2: return !!data.stage2_outline?.outline?.length;
        case 3: return !!data.stage3_characters?.characters?.length;
        case 4: return !!data.stage4_beats;
        case 5: return !!data.stage5_treatment;
        case 6: return !!data.stage6_scenes?.length;
        case 7: return !!data.stage7_style;
        case 8: return !!data.stage7_approved;
        case 9: return !!data.stage8_coverage;
        case 10: return !!data.stage9_rewrites?.approved;
        default: return false;
    }
}

function latestVersionForStage(projectData, stageId) {
    const history = projectData?.data?.versionHistory || [];
    return history
        .filter(entry => Number(entry.stage) === Number(stageId))
        .sort((a, b) => new Date(b.approvedAt || 0) - new Date(a.approvedAt || 0))[0] || null;
}

function stageDataForReadiness(projectData, stageId) {
    const data = projectData?.data || {};
    switch (Number(stageId)) {
        case 1:
            return JSON.stringify({
                pitch: data.stage1_pitch?.pitch || {},
                notes: data.stage1_pitch?.notes || ''
            }, null, 2);
        case 2:
            return JSON.stringify({ outline: data.stage2_outline?.outline || [] }, null, 2);
        case 3:
            return JSON.stringify({ characters: data.stage3_characters?.characters || [] }, null, 2);
        case 4:
            return JSON.stringify(data.stage4_beats || data.stage4_treatment || [], null, 2);
        case 5:
            return JSON.stringify(data.stage5_treatment || {}, null, 2);
        case 6:
            return JSON.stringify(data.stage6_scenes || [], null, 2);
        case 7: {
            const styleSlug = data.stage7_style || null;
            let styleContent = '';
            if (styleSlug) {
                try {
                    styleContent = fsSync.readFileSync(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf8');
                } catch {
                    try {
                        styleContent = fsSync.readFileSync(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf8');
                    } catch {
                        styleContent = '';
                    }
                }
            }
            return JSON.stringify({ slug: styleSlug, content: styleContent }, null, 2);
        }
        case 8: {
            const scenes = [];
            for (const seq of data.stage6_scenes || []) {
                if (seq.scenes) scenes.push(...seq.scenes);
            }
            return JSON.stringify(scenes.map(scene => ({
                scene_number: scene.scene_number,
                slugline: scene.slugline || scene.scene_heading || '',
                draft_text: scene.humanized_draft_text || scene.draft_text || ''
            })), null, 2);
        }
        case 9:
            return JSON.stringify(data.stage8_coverage || {}, null, 2);
        case 10:
            return JSON.stringify({
                working: data.stage9_rewrites?.working || {},
                pending: data.stage9_rewrites?.pending || {},
                priority_idx: data.stage9_rewrites?.priority_idx ?? null
            }, null, 2);
        default:
            return '';
    }
}

function collectBlueprintScenes(projectData) {
    const scenes = [];
    for (const seq of projectData?.data?.stage6_scenes || []) {
        if (!Array.isArray(seq.scenes)) continue;
        for (const scene of seq.scenes) {
            scenes.push({
                ...scene,
                _sequence_number: seq.sequence_number,
                _sequence_title: seq.sequence_title || ''
            });
        }
    }
    return scenes.sort((a, b) => Number(a.scene_number || 0) - Number(b.scene_number || 0));
}

function formatSceneLockItem(scene, label) {
    if (!scene) return `${label}: None`;
    const slugline = scene.scene_heading || scene.slugline || '';
    return `${label}: Scene ${scene.scene_number}${slugline ? ` - ${slugline}` : ''}
Narrative action: ${compactText(scene.narrative_action || '', 900)}
Dramaturgical function: ${compactText(scene.dramaturgical_function || '', 500)}`;
}

function buildStage8SceneLockPacket(projectData, sceneNumber, targetedScene = null) {
    const sceneNum = Number(sceneNumber);
    const allScenes = collectBlueprintScenes(projectData);
    const currentIndex = allScenes.findIndex(scene => Number(scene.scene_number) === sceneNum);
    const currentScene = targetedScene || allScenes[currentIndex] || null;
    if (!currentScene) return '';

    const prevScene = currentIndex > 0 ? allScenes[currentIndex - 1] : null;
    const nextScene = currentIndex >= 0 && currentIndex < allScenes.length - 1 ? allScenes[currentIndex + 1] : null;
    const sequence = (projectData?.data?.stage6_scenes || []).find(seq => {
        return Array.isArray(seq.scenes) && seq.scenes.some(scene => Number(scene.scene_number) === sceneNum);
    });
    const sequenceScenes = Array.isArray(sequence?.scenes) ? sequence.scenes : [];
    const firstInSequence = sequenceScenes[0] || null;
    const lastInSequence = sequenceScenes[sequenceScenes.length - 1] || null;

    return compactText(`## APPROVED STAGE 8 SCENE LOCK PACKET
This packet constrains the draft. The writer may create dialogue, action beats, pacing, and texture, but must preserve the approved blueprint facts and handoffs.

Current sequence: ${sequence?.sequence_number || currentScene._sequence_number || 'unknown'}${sequence?.sequence_title || currentScene._sequence_title ? ` - ${sequence?.sequence_title || currentScene._sequence_title}` : ''}
Sequence start: ${firstInSequence ? `Scene ${firstInSequence.scene_number} - ${firstInSequence.scene_heading || firstInSequence.slugline || ''}` : 'unknown'}
Sequence endpoint: ${lastInSequence ? `Scene ${lastInSequence.scene_number} - ${lastInSequence.scene_heading || lastInSequence.slugline || ''}` : 'unknown'}

${formatSceneLockItem(prevScene, 'Previous scene handoff')}

${formatSceneLockItem(currentScene, 'Current scene to draft')}
Estimated page count: ${currentScene.estimated_page_count || 'unknown'}

${formatSceneLockItem(nextScene, 'Next scene handoff')}

Rules:
- Preserve the current scene's approved event, location, character placement, prop path, reveal, and endpoint.
- Do not pull events from the previous or next scene into this scene.
- Do not invent a new plot mechanism, death/survival state, source rule, or relationship turn to make the dialogue easier.
- If revision notes ask for a change, apply them inside this scene without breaking the previous/next handoff.`, 8_500);
}

function buildStage10PlannerSceneList(allScenes = [], working = {}) {
    return allScenes.map(scene => {
        const sceneText = working[scene.scene_number] || scene.humanized_draft_text || scene.draft_text || '';
        return `SCENE ${scene.scene_number} - ${scene.scene_heading || scene.slugline || ''}
Blueprint: ${compactText(scene.narrative_action || '', 320)}
Function: ${compactText(scene.dramaturgical_function || '', 220)}
Draft excerpt: ${compactText(sceneText, 420)}`;
    }).join('\n\n');
}

function buildStage10RewritePlanPrompt({
    sourceContext = '',
    title = 'Untitled',
    charBlock = '',
    styleNote = '',
    priorityTask = '',
    feedbackSection = '',
    contextSection = '',
    sceneList = ''
} = {}) {
    const sourceBlock = buildMemorySourcePromptBlock(sourceContext, 'Stage 10 Rewrite Plan');
    return `${sourceBlock ? `${sourceBlock}\n---\n\n` : ''}## PROJECT
Title: ${title}${charBlock}${styleNote}

## REWRITE TASK
${priorityTask}${feedbackSection}${contextSection}

## SCENE LIST
${sceneList}`;
}

function buildStage10RewritePlannerSystemInstruction(plannerSop) {
    return buildMemorySourceSystemInstruction(plannerSop, 'Stage 10 Rewrite Plan');
}

function buildStage10RewriteLockPacket(projectData, sceneNumber, sceneMeta = null, sceneText = '', plannedChange = '') {
    const basePacket = buildStage8SceneLockPacket(projectData, sceneNumber, sceneMeta);
    return compactText(`${basePacket}

## CURRENT REWRITE CONTEXT
Planned change for this pass:
${plannedChange || 'Apply the priority task only where it affects this scene.'}

Current scene text excerpt:
${compactText(sceneText || '', 1200)}

Stage 10 rule:
- Fix the coverage task, but preserve approved blueprint facts and the previous/next scene handoff unless the planned change explicitly says to alter them.
- If a broader continuity change is needed, keep the rewrite conservative and avoid introducing unrequested new canon.`, 10_000);
}

function stageHasReadinessOutput(projectData, stageId) {
    const data = projectData?.data || {};
    switch (Number(stageId)) {
        case 1: return !!data.stage1_pitch?.pitch;
        case 2: return !!data.stage2_outline?.outline?.length;
        case 3: return !!data.stage3_characters?.characters?.length;
        case 4: return !!(data.stage4_beats || data.stage4_treatment);
        case 5: return !!data.stage5_treatment;
        case 6: return !!data.stage6_scenes?.length;
        case 7: return !!data.stage7_style;
        case 8: {
            const scenes = [];
            for (const seq of data.stage6_scenes || []) {
                if (seq.scenes) scenes.push(...seq.scenes);
            }
            return scenes.some(scene => scene.draft_text || scene.humanized_draft_text);
        }
        case 9: return !!data.stage8_coverage;
        case 10: return !!Object.keys(data.stage9_rewrites?.working || {}).length;
        default: return false;
    }
}

function sourceAuditIssueCounts(audit = {}) {
    const count = key => Array.isArray(audit[key]) ? audit[key].filter(Boolean).length : 0;
    const possibleMismatches = count('possible_source_mismatches');
    const missingElements = count('missing_source_elements');
    const recommendedFixes = count('recommended_fixes');
    return {
        possibleMismatches,
        missingElements,
        recommendedFixes,
        total: possibleMismatches + missingElements + recommendedFixes
    };
}

function compactSourceAuditReference(ref = {}) {
    return {
        sourceId: ref.sourceId || null,
        name: compactText(ref.name || 'Source', 180),
        label: compactText(ref.label || ref.sourceId || '', 220),
        excerpt: compactText(ref.excerpt || '', 260)
    };
}

function recordStageSourceAudit(projectData, stageId, stageName, stageData, audit = {}, sourceReferences = [], { sourceCount = 0, acceptedDivergenceCount = 0 } = {}) {
    const numericStageId = Number(stageId);
    const knowledge = ensureProjectKnowledge(projectData);
    const checkedAt = audit.checkedAt || new Date().toISOString();
    const compactAudit = compactAuditForKnowledge({
        ...audit,
        stageId: numericStageId,
        stageName,
        checkedAt
    });
    const entry = {
        ...compactAudit,
        sourceCount,
        acceptedDivergenceCount,
        stageOutputHash: sourcePlanDataHash(stageData),
        issueCounts: sourceAuditIssueCounts(compactAudit),
        sourceReferences: sourceReferences.slice(0, 8).map(compactSourceAuditReference)
    };
    knowledge.stage_source_audits[sourcePlanCacheKey(numericStageId)] = entry;
    return entry;
}

function latestSourceAuditResolution(knowledge, stageId, checkedAt) {
    if (!checkedAt) return null;
    const resolutionTypes = new Set([
        'source_audit_fixes_applied',
        'accepted_source_divergence',
        'source_audit_approved_anyway'
    ]);
    return (knowledge.decision_log || [])
        .filter(item => Number(item.stageId) === Number(stageId))
        .filter(item => resolutionTypes.has(item.type))
        .filter(item => item.at && new Date(item.at) >= new Date(checkedAt))
        .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0] || null;
}

function buildSourceReadiness(projectData, stageId, stageData = null) {
    const numericStageId = Number(stageId);
    const knowledge = ensureProjectKnowledge(projectData);
    const currentStageData = stageData === null ? stageDataForReadiness(projectData, numericStageId) : stageData;
    const currentHash = sourcePlanDataHash(currentStageData);
    const audit = knowledge.stage_source_audits?.[sourcePlanCacheKey(numericStageId)] || null;
    const plan = buildSourceUsePlan(projectData, numericStageId, currentStageData);
    const sourceCount = knowledge.source_registry?.length || 0;
    const issueCounts = audit?.issueCounts || sourceAuditIssueCounts(audit || {});
    const isStale = !!(audit?.stageOutputHash && audit.stageOutputHash !== currentHash);
    const isAuditInvalidated = !!audit?.invalidatedAt;
    const resolution = audit ? latestSourceAuditResolution(knowledge, numericStageId, audit.checkedAt) : null;

    let status = 'no_sources';
    let label = 'No saved sources';
    if (sourceCount && (!audit || isAuditInvalidated)) {
        status = 'needs_audit';
        label = isAuditInvalidated ? 'Audit needs refresh' : 'No source audit yet';
    } else if (sourceCount && isStale && resolution) {
        status = 'fixed_since_audit';
        label = 'Fix applied, recheck recommended';
    } else if (sourceCount && isStale) {
        status = 'stale';
        label = 'Audit stale';
    } else if (sourceCount && issueCounts.total && resolution) {
        status = 'resolved';
        label = 'Issues addressed';
    } else if (sourceCount && issueCounts.total) {
        status = 'issues';
        label = 'Issues found';
    } else if (sourceCount) {
        status = 'ready';
        label = 'Source ready';
    }

    return {
        stageId: numericStageId,
        stageName: STAGE_NAMES[numericStageId] || `Stage ${numericStageId}`,
        status,
        label,
        sourceCount,
        hasOutput: stageHasReadinessOutput(projectData, numericStageId),
        hasAudit: !!audit,
        checkedAt: audit?.checkedAt || null,
        stageOutputHash: currentHash,
        auditStageOutputHash: audit?.stageOutputHash || '',
        isStale,
        isAuditInvalidated,
        auditInvalidatedAt: audit?.invalidatedAt || null,
        auditInvalidatedReason: audit?.invalidatedReason || '',
        issueCounts,
        lastResolution: resolution ? {
            at: resolution.at,
            type: resolution.type,
            summary: resolution.summary || ''
        } : null,
        sourcePlan: plan.cachedPlan ? {
            status: plan.freshness,
            lastUsedAt: plan.cachedPlan.lastUsedAt || null,
            isStale: !!plan.cachedPlan.isStale,
            sourceIds: plan.cachedPlan.sourceIds || []
        } : null
    };
}

function buildSourceReadinessGate(readiness = {}) {
    const status = readiness.status || 'unknown';
    const stageName = readiness.stageName || `Stage ${readiness.stageId || ''}`;
    if (status === 'no_sources') {
        return {
            action: 'proceed',
            severity: 'none',
            canProceed: true,
            shouldRunAudit: false,
            message: 'No saved project sources are available for this stage.'
        };
    }
    if (status === 'ready') {
        return {
            action: 'proceed',
            severity: 'ok',
            canProceed: true,
            shouldRunAudit: false,
            message: `${stageName} has a fresh source check with no open findings.`
        };
    }
    if (status === 'resolved') {
        return {
            action: 'proceed',
            severity: 'ok',
            canProceed: true,
            shouldRunAudit: false,
            message: `${stageName} source check findings have been addressed or accepted.`
        };
    }
    if (status === 'issues') {
        return {
            action: 'resolve_audit',
            severity: 'warning',
            canProceed: false,
            shouldRunAudit: false,
            message: `${stageName} has unresolved source check findings.`
        };
    }
    if (status === 'stale') {
        return {
            action: 'run_audit',
            severity: 'warning',
            canProceed: false,
            shouldRunAudit: true,
            message: `${stageName} changed after the last source check. Run Check Source again before approval.`
        };
    }
    if (status === 'fixed_since_audit') {
        return {
            action: 'run_audit',
            severity: 'warning',
            canProceed: false,
            shouldRunAudit: true,
            message: `${stageName} has source fixes applied after the last check. Recheck to confirm alignment.`
        };
    }
    if (status === 'needs_audit') {
        return {
            action: 'run_audit',
            severity: 'info',
            canProceed: false,
            shouldRunAudit: true,
            message: `PageOne has saved source material for ${stageName}. Run Check Source before approval if you want to verify this stage matches your uploads.`
        };
    }
    return {
        action: 'proceed',
        severity: 'unknown',
        canProceed: true,
        shouldRunAudit: false,
        message: `${stageName} source readiness is unknown.`
    };
}

function sourceAuditForClient(audit = {}, readiness = null) {
    if (!audit || typeof audit !== 'object') return null;
    return {
        stageId: audit.stageId || readiness?.stageId || null,
        stageName: audit.stageName || readiness?.stageName || '',
        sourceCount: audit.sourceCount || readiness?.sourceCount || 0,
        acceptedDivergenceCount: audit.acceptedDivergenceCount || 0,
        checkedAt: audit.checkedAt || null,
        invalidatedAt: audit.invalidatedAt || null,
        invalidatedReason: audit.invalidatedReason || '',
        source_references: audit.source_references || audit.sourceReferences || [],
        aligned_items: audit.aligned_items || [],
        possible_source_mismatches: audit.possible_source_mismatches || [],
        missing_source_elements: audit.missing_source_elements || [],
        recommended_fixes: audit.recommended_fixes || [],
        sourceReadiness: readiness || null
    };
}

function buildSourceReadinessList(projectData) {
    const knowledge = ensureProjectKnowledge(projectData);
    const stageIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    for (const key of Object.keys(knowledge.stage_source_audits || {})) {
        const stageId = Number(key.replace('stage', ''));
        if (stageId) stageIds.add(stageId);
    }
    for (const key of Object.keys(knowledge.stage_source_plans || {})) {
        const stageId = Number(key.replace('stage', ''));
        if (stageId) stageIds.add(stageId);
    }
    return Array.from(stageIds)
        .sort((a, b) => a - b)
        .map(stageId => buildSourceReadiness(projectData, stageId))
        .filter(item => item.hasOutput || item.hasAudit || item.sourcePlan || item.sourceCount);
}

function buildKnowledgeDiagnostics(projectData) {
    const knowledge = ensureProjectKnowledge(projectData);
    const issues = [];
    const add = (severity, kind, message, recommendedAction = '') => {
        issues.push({ severity, kind, message, recommendedAction });
    };

    const sourceCount = knowledge.source_registry.length;
    if (!sourceCount) {
        add('info', 'no_sources', 'No source documents are saved yet.', 'Upload source material through any stage chat.');
    }
    if (sourceCount && !sourceBibleSummary(knowledge)) {
        add('warning', 'empty_source_bible', 'Source documents exist, but the source bible is empty.', 'Open Project Knowledge and rebuild the source bible.');
    }

    for (const source of knowledge.source_registry) {
        if (source.truncated) {
            add('info', 'truncated_source', `${source.name || source.id} was stored in limited chunks.`, 'Review whether the uploaded source needs a shorter summary or focused excerpt.');
        }
        if ((source.storage === 'chunks' || source.chunks) && !Array.isArray(source.chunks)) {
            add('warning', 'source_chunk_shape', `${source.name || source.id} is marked as chunked but has no chunk list.`, 'Re-upload or remove this source.');
        }
    }

    for (const stageId of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
        if (!stageHasApprovedOutput(projectData, stageId)) continue;
        const key = `stage${stageId}`;
        const handoff = knowledge.stage_handoffs[key];
        if (!handoff) {
            add('warning', 'missing_stage_handoff', `${STAGE_NAMES[stageId]} has approved output but no memory handoff.`, 'Approve the stage again or save a handoff in Project Knowledge.');
            continue;
        }
        const latest = latestVersionForStage(projectData, stageId);
        if (latest?.approvedAt && handoff?.at && new Date(handoff.at) < new Date(latest.approvedAt)) {
            add('info', 'stale_stage_handoff', `${STAGE_NAMES[stageId]} handoff is older than the latest approved version.`, 'Review and refresh this stage handoff.');
        }
    }

    const divergenceSummaries = new Map();
    for (const divergence of knowledge.accepted_divergences || []) {
        const key = String(divergence.summary || '').toLowerCase().trim();
        if (!key) {
            add('info', 'blank_divergence', 'An accepted divergence has no summary.', 'Edit or remove the divergence from project memory.');
            continue;
        }
        divergenceSummaries.set(key, (divergenceSummaries.get(key) || 0) + 1);
        if (!divergence.audit) {
            add('info', 'divergence_without_audit', `Accepted divergence lacks audit detail: ${compactText(divergence.summary, 120)}`, 'Keep it if intentional, or re-run a source check for better provenance.');
        }
    }
    for (const [summary, count] of divergenceSummaries.entries()) {
        if (count > 1) {
            add('info', 'duplicate_divergence', `Accepted divergence appears ${count} times: ${compactText(summary, 120)}`, 'Consolidate duplicate divergences during memory review.');
        }
    }

    for (const [key, plan] of Object.entries(knowledge.stage_source_plans || {})) {
        if (!plan?.stageId) {
            add('info', 'source_plan_shape', `${key} source plan is missing a stage id.`, 'Regenerate this stage to refresh source-plan metadata.');
        }
        if (plan?.invalidatedAt) {
            add('warning', 'source_plan_invalidated', `${STAGE_NAMES[plan.stageId] || key} source plan references removed source material.`, 'Regenerate this stage or refresh its source plan.');
        }
        const warnings = plan?.localCheck?.warnings || [];
        for (const warning of warnings.slice(0, 3)) {
            add('warning', 'source_plan_warning', `${STAGE_NAMES[plan.stageId] || key}: ${warning.message || warning}`, 'Open Source Plan for this stage and refresh the generation if needed.');
        }
    }

    for (const [key, audit] of Object.entries(knowledge.stage_source_audits || {})) {
        if (audit?.invalidatedAt) {
            add('warning', 'source_audit_invalidated', `${STAGE_NAMES[audit.stageId] || key} source audit references removed source material.`, 'Run Check Source again before relying on this audit.');
        }
    }

    const readiness = buildSourceReadinessList(projectData);
    if (sourceCount) {
        for (const item of readiness) {
            if (!item.hasOutput) continue;
            if (item.status === 'needs_audit') {
                add('warning', 'missing_source_audit', `${item.stageName} has output but no source audit.`, 'Run Check Source before approval or downstream generation.');
            } else if (item.status === 'stale') {
                add('warning', 'stale_source_audit', `${item.stageName} source audit is older than the current stage output.`, 'Run Check Source again.');
            } else if (item.status === 'issues') {
                add('warning', 'unresolved_source_audit', `${item.stageName} has unresolved source audit findings.`, 'Apply recommended fixes or accept a divergence.');
            } else if (item.status === 'fixed_since_audit') {
                add('info', 'source_fix_needs_recheck', `${item.stageName} had source fixes applied after the last audit.`, 'Run Check Source again to confirm alignment.');
            }
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        counts: {
            sources: sourceCount,
            handoffs: Object.keys(knowledge.stage_handoffs || {}).length,
            sourcePlans: Object.keys(knowledge.stage_source_plans || {}).length,
            sourceAudits: Object.keys(knowledge.stage_source_audits || {}).length,
            continuityItems: (knowledge.continuity_watchlist || []).length,
            decisions: (knowledge.decision_log || []).length,
            acceptedDivergences: (knowledge.accepted_divergences || []).length,
            sourceBibleNotes: (knowledge.source_bible.curated_notes || []).length
        },
        sourceReadiness: readiness,
        issues
    };
}

function buildSourceBiblePrompt(knowledge) {
    const sources = knowledge.source_registry || [];
    return sources.map(source => {
        const body = compactText(
            source.text || (source.chunks || []).map(chunk => chunk.text).join('\n\n') || source.summary || '',
            10_000
        );
        return `SOURCE ID: ${source.id}
NAME: ${source.name}
TYPE: ${source.type || 'source_material'}
TAGS: ${(source.tags || []).join(', ')}
SUMMARY: ${source.summary || ''}
TEXT:
${body}`;
    }).join('\n\n---\n\n');
}

function buildStage4OutlineDiscussionBoundary(projectData) {
    const outline = projectData.data?.stage2_outline?.outline;
    if (!outline) return '';
    return `## STAGE 4 OUTLINE ALIGNMENT BOUNDARY
You are discussing the Stage 4 beat sheet, but the approved Stage 2 outline below is binding for sequence order, act placement, reveal placement, set-piece placement, cause/effect, transformations, and endpoints.

When the writer asks whether a Stage 4 beat originated in the outline, verify against this block before answering. If the beat sheet moved or invented a major event that is not in the same Stage 2 sequence, identify it as Stage 4 drift or an adaptation addition, not as outline intent.

APPROVED STAGE 2 OUTLINE:
${compactText(JSON.stringify(outline, null, 2), 12_000)}`;
}

function buildStage4CurrentBeatEvidenceBlock(projectData) {
    const sheet = projectData.data?.stage4_beats?.hybrid_beat_sheet
        || projectData.data?.stage4_treatment?.hybrid_beat_sheet;
    if (!Array.isArray(sheet) || !sheet.length) return '';

    const sequences = sheet.map(sequence => {
        const beats = Array.isArray(sequence.beats)
            ? sequence.beats.map(beat => {
                const text = [
                    beat.detailed_action,
                    beat.emotional_arc,
                    beat.genre_variation_notes,
                    beat.pacing_notes
                ].filter(Boolean).join(' ');
                return `- ${beat.beat_name || 'Unnamed beat'}: ${compactText(text, 1_200)}`;
            }).join('\n')
            : compactText(JSON.stringify(sequence.beats || [], null, 2), 700);
        return `Sequence ${sequence.sequence_number || '?'}: ${sequence.sequence_title || 'Untitled'}\n${beats}`;
    }).join('\n\n');

    return `## CURRENT STAGE 4 BEAT EVIDENCE
This is a compact map of the CURRENT saved beat sheet. It overrides earlier Stage 4 chat messages, which may refer to an older regenerated version.

Rules for analysis:
- Verify event placement against this current evidence before naming a contradiction.
- Do not repeat an earlier assistant claim unless the current evidence supports it.
- If prior chat says an event is in one sequence but the current evidence places it elsewhere, call the prior chat stale and analyze the current placement.

${compactText(sequences, 14_000)}`;
}

function isStage4CurrentArtifactAnalysisRequest(message = '') {
    const text = String(message || '').toLowerCase();
    return /\b(analy[sz]e|analysis|review|assess|source[- ]?faith|source material|contradict|contradiction|fundamental|outline|midpoint|beat sheet|current|regenerated|new version)\b/.test(text);
}

function isStage6SourceComparisonRequest(message = '', hasAttachment = false) {
    if (!hasAttachment) return false;
    const text = String(message || '').toLowerCase();
    return /\b(source|graphic novel|scene breakdown|compare|comparison|audit|missing|don't need|do not need|unnecessary|spiritually faithful|faithful)\b/.test(text);
}

function hasStage6ExplicitApplyIntent(message = '') {
    const text = String(message || '');
    const opening = text.slice(0, 420);
    return /\b(?:please|pls|go ahead|apply|revise|update|implement|integrate|work in|make)\b[\s\S]{0,100}\b(?:these|this|following|feedback|notes|changes|fixes|blueprint|scene|sequence)\b/i.test(opening)
        || /\b(?:apply|revise|update|implement|integrate|fix)\s+(?:the\s+)?(?:scene\s+)?blueprint\b/i.test(text);
}

function isStage6ExternalFeedbackReviewRequest(message = '') {
    const text = String(message || '');
    const opening = text.slice(0, 420);
    const looksExternal = /\b(?:claude|gemini|coverage|reader|editor|script notes|feedback)\b/i.test(opening)
        || /\b(?:tier\s+\d|hard canon breaks|what'?s working|craft flags|internal continuity)\b/i.test(text);
    return (looksExternal || text.length > 1400) && !hasStage6ExplicitApplyIntent(text);
}

function extractNumberedSourceItems(text = '', maxItems = 120) {
    const items = [];
    const seen = new Set();
    const lines = String(text || '').split(/\r?\n/);
    const itemPattern = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(\d+(?:\.\d+)+)\s*(?:[—–-]|:|\.)\s*(.+?)\s*$/;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(itemPattern);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({
            id,
            summary: compactText(match[2].replace(/\s+/g, ' '), 280)
        });
        if (items.length >= maxItems) break;
    }
    return items;
}

function buildSourceItemInventoryBlock(attachmentText = '') {
    const items = extractNumberedSourceItems(attachmentText);
    if (!items.length) {
        return `## SOURCE ITEM INVENTORY
No numbered source items were automatically detected in the attachment. If the attachment contains scene IDs in prose, manually identify them before auditing coverage.`;
    }
    return `## SOURCE ITEM INVENTORY
The attachment contains these numbered source items. Your audit must account for EVERY item ID below, including items that seem minor, compressed, relocated, or optional.

${items.map(item => `- ${item.id}: ${item.summary}`).join('\n')}`;
}

function stage4CurrentEventListTerm(message = '') {
    const text = String(message || '').trim();
    const match = text.match(/\blist\s+(?:all|every)\s+(.+?)(?:[-\s]?related)?\s+events?\b/i);
    if (!match) return '';
    return match[1]
        .replace(/\b(current|new|regenerated|stage\s*4|beat\s*sheet|only)\b/gi, ' ')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildStage4CurrentEventListResponse(projectData, message = '') {
    const term = stage4CurrentEventListTerm(message);
    if (!term) return null;

    const sheet = projectData.data?.stage4_beats?.hybrid_beat_sheet
        || projectData.data?.stage4_treatment?.hybrid_beat_sheet;
    if (!Array.isArray(sheet) || !sheet.length) {
        return {
            message: 'I do not see a current Stage 4 beat sheet saved for this project yet.'
        };
    }

    const needles = term.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const sequence of sheet) {
        for (const beat of Array.isArray(sequence.beats) ? sequence.beats : []) {
            const searchable = [
                sequence.sequence_title,
                beat.beat_name,
                beat.detailed_action,
                beat.emotional_arc,
                beat.genre_variation_notes,
                beat.pacing_notes
            ].filter(Boolean).join(' ');
            const lower = searchable.toLowerCase();
            if (!needles.every(needle => lower.includes(needle))) continue;
            matches.push({
                sequenceNumber: sequence.sequence_number || '?',
                sequenceTitle: sequence.sequence_title || 'Untitled',
                beatName: beat.beat_name || 'Unnamed beat',
                excerpt: compactText(beat.detailed_action || searchable, 420)
            });
        }
    }

    const heading = `From the current Stage 4 beat sheet only, I found ${matches.length} ${term}-related event${matches.length === 1 ? '' : 's'}:`;
    const body = matches.length
        ? matches.map(item => `- Sequence ${item.sequenceNumber}: ${item.sequenceTitle} — ${item.beatName}: ${item.excerpt}`).join('\n')
        : `- No current Stage 4 beats mention ${term}.`;

    return {
        message: `${heading}\n\n${body}`
    };
}

const STAGE4_CONFIRMATION_PATTERN = /\b(yes|yep|yeah|sure|ok|okay|go ahead|do it|apply|revise|revising|make the change|sounds good|i(?:'|\u2019)?m ok|i am ok|fine)\b/i;
const STAGE4_REVISION_PROPOSAL_PATTERN = /\b(want me to|should we|do you want|revise|revising|revision|update|align|work that|apply|applying|change|improve|sequence\s*5|kaiju march|source spiritually|faithful|flow)\b/i;
const STAGE4_ASSISTANT_ERROR_PATTERN = /^(error:|something went wrong|assistant request timed out|application failed|failed to respond)/i;

function isStage4AssistantErrorMessage(content = '') {
    return STAGE4_ASSISTANT_ERROR_PATTERN.test(String(content || '').trim());
}

function findRecentStage4RevisionProposal(messages = []) {
    return messages
        .slice(0, -1)
        .reverse()
        .find(m => m.role === 'assistant'
            && typeof m.content === 'string'
            && m.content.trim()
            && !isStage4AssistantErrorMessage(m.content)
            && STAGE4_REVISION_PROPOSAL_PATTERN.test(m.content));
}

function buildStage4ConfirmationBypassResponse(messages = []) {
    const latestUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const clean = String(latestUserMessage || '').trim();
    if (!clean || clean.length > 240) return null;
    if (!STAGE4_CONFIRMATION_PATTERN.test(clean)) return null;

    const priorAssistant = findRecentStage4RevisionProposal(messages);
    if (!priorAssistant) return null;

    return {
        message: 'On it — applying that Stage 4 revision now.'
    };
}

function buildStage4ConfirmationRevisionBrief(messages = []) {
    const latestUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const priorAssistant = findRecentStage4RevisionProposal(messages);
    const recentConversation = messages
        .slice(-10)
        .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content || ''}`)
        .join('\n\n---\n\n');
    return `LATEST USER CONFIRMATION:
${latestUserMessage}

Apply the most recent concrete Stage 4 beat-sheet revision proposal from the assistant context below. Preserve any constraints in the latest user confirmation. Do not treat older, unrelated discussion items as additional instructions.

RECENT ASSISTANT PROPOSAL:
${priorAssistant?.content || 'No prior assistant proposal captured.'}

RECENT CONVERSATION CONTEXT:
${recentConversation}`;
}

function isScopedPolishRequest(message = '') {
    const text = String(message || '');
    if (!text.trim()) return false;
    const hasScopeLanguage = /\bone\s+(?:small|minor|tiny)\s+(?:local\s+)?(?:polish|clarity|wording|language|line|paragraph|beat)\b/i.test(text)
        || /\b(?:local|single)\s+(?:polish|clarity|wording|language|line|paragraph|beat)\b/i.test(text)
        || /\b(?:not\s+a\s+structural\s+issue|not\s+structural|structure\s+works|current\s+structure\s+works|only\s+a\s+(?:clarity|wording|polish)|just\s+a\s+(?:clarity|wording|polish))\b/i.test(text);
    if (!hasScopeLanguage) return false;
    return /\b(?:clarify|polish|wording|paragraph|line|phrase|word|read|land|fuzzy|cleanly)\b/i.test(text);
}

function buildScopedPolishPromptBlock(stageId, latestMessage = '') {
    const bracketedTargets = Array.from(String(latestMessage || '').matchAll(/\[([^\]]{3,140})\]/g))
        .map(match => (match[1] || '').trim())
        .filter(Boolean);
    const targets = Array.from(new Set(bracketedTargets)).slice(0, 6);
    const targetText = targets.length
        ? `The latest note explicitly names: ${targets.map(target => `[${target}]`).join(', ')}.`
        : 'The latest note does not name a bracketed artifact target; infer only from the latest note.';
    const stageSpecific = Number(stageId) === 2
        ? '\n- For Stage 2, do not propose midpoint, ending, surrender/accountability, source-fidelity, sequence-order, or structural changes unless the latest note explicitly asks for them.\n- If the latest note mentions the climax only as downstream clarity, you may name a tiny wording echo there, but do not bundle unrelated Sequence H beats.'
        : '';

    return `## LATEST MESSAGE SCOPE LOCK
The writer's latest message is a scoped polish/clarity note, not a broad revision audit. ${targetText}

Hard rules:
- Use only the latest writer message and the current saved artifact to decide the next step.
- Do not revive older checklist items, unresolved notes, prior assistant proposals, or previously discussed fixes unless they are repeated in the latest writer message.
- Do not offer a multi-part pass. If you offer execution, scope it to the explicitly named target(s) and any directly named adjacent wording dependency only.
- If the note says the current structure works or is not structural, do not propose restructuring.
- Call apply_revision only for that narrow local edit, and only when the latest message explicitly says to apply/go ahead now. Otherwise, offer that narrow edit and wait for confirmation.${stageSpecific}

`;
}

function buildToolScopedPolishPromptBlock(stageId, latestMessage = '') {
    return buildScopedPolishPromptBlock(stageId, latestMessage);
}

function isSourceLocationQuestion(message = '') {
    return /\b(page|pages|issue|source\s+(?:scene|beat|location)|where\s+in\s+the\s+source|where\s+does\b.*\bsource)\b/i.test(message)
        && /\b(source|comic|graphic novel|book|document|page|issue)\b/i.test(message);
}

function buildToolAssistantContextAdditions({ projectData, stageId, lastUserMessage = '', attachmentText = '', isInit = false }) {
    const numericStageId = Number(stageId);
    const stage4CurrentArtifactAnalysis = !isInit && numericStageId === 4 && isStage4CurrentArtifactAnalysisRequest(lastUserMessage);
    const stage6SourceComparisonAnalysis = !isInit && numericStageId === 6 && isStage6SourceComparisonRequest(lastUserMessage, Boolean(attachmentText));
    const stage6ExternalFeedbackReview = !isInit && numericStageId === 6 && isStage6ExternalFeedbackReviewRequest(lastUserMessage);
    const scopedPolishRequest = !isInit && isScopedPolishRequest(lastUserMessage);
    const sourceLocationQuestion = !isInit && isSourceLocationQuestion(lastUserMessage);

    const fragments = [];

    if (numericStageId === 4) {
        const outlineBoundary = buildStage4OutlineDiscussionBoundary(projectData);
        if (outlineBoundary) fragments.push(outlineBoundary);
    }

    if (stage4CurrentArtifactAnalysis) {
        fragments.push(`## CURRENT ARTIFACT ANALYSIS MODE
The writer is asking you to analyze the current Stage 4 beat sheet. Ignore earlier Stage 4 assistant analysis or claims because they may describe a previous regenerated version. Use only the CURRENT Stage 4 artifact, the approved Stage 2 outline, source/project memory, and the latest writer question.

When flagging a contradiction or structural drift, cite the current sequence number and beat name that supports the claim. If the current beat sheet does not support a prior claim, do not repeat it. Do not call apply_revision unless the writer explicitly asks you to apply a concrete change.`);
        const currentBeatEvidence = buildStage4CurrentBeatEvidenceBlock(projectData);
        if (currentBeatEvidence) fragments.push(currentBeatEvidence);
    }

    if (stage6SourceComparisonAnalysis) {
        fragments.push(buildSourceItemInventoryBlock(attachmentText));
        fragments.push(`## STAGE 6 SOURCE COMPARISON MODE
The writer attached a source scene breakdown and is asking for an audit against the CURRENT Stage 6 scene blueprint.

Hard rules:
- Do not treat this as revision confirmation, even if the message says changes are acceptable.
- Do not call apply_revision for this turn. Analyze and triage only.
- Ignore prior Stage 6 assistant claims or post-revision follow-up language unless the current blueprint and attached source support them.
- Use the ATTACHED FILE as source-breakdown evidence and the STAGE 6 Scene Blueprint above as the current adaptation artifact.
- Produce an exhaustive coverage-matrix comparison, not a best-highlights note.

Audit structure:
1. Project Constraint Map: briefly list the recurring entities, visual/physical identities, roles/backstories, props, protected lines/motifs, world rules, setup/payoff promises, and known adaptation inventions you inferred from the attached source and project memory.
2. Source Coverage Matrix: include one row or bullet for EVERY numbered source item in SOURCE ITEM INVENTORY. For each, give status: "covered", "compressed/relocated", "underrepresented", "missing", or "intentionally omitted", and cite closest current blueprint scene number/heading or "no clear match".
3. Constraint Drift / Canon Breaks: run explicit passes for entity identity, role/backstory, visual description, prop paths, preserved lines/motifs, setup/payoff plants, timeline/geography, and stale internal scene references.
4. Missing or underrepresented source scenes/beats: prioritize from the matrix.
5. Current blueprint scenes that may be redundant or not source-load-bearing: cite scene numbers/headings.
6. Spiritually faithful adaptation changes: name source departures that improve film flow and should probably remain.
7. Recommended next steps, separated into "discuss first" and "safe to revise later" buckets.

Before finalizing, scan the SOURCE ITEM INVENTORY again and verify every item ID appears in your response exactly once in the matrix.`);
    }

    if (stage6ExternalFeedbackReview) {
        fragments.push(`## STAGE 6 EXTERNAL FEEDBACK REVIEW MODE
The writer pasted a long note set from an external reviewer, coverage source, or another AI. Treat it as material to analyze and triage against the CURRENT Stage 6 scene blueprint, not as permission to revise.

Hard rules:
- Do not say or imply that any change was applied.
- Do not call apply_revision for this turn.
- Do not ask the revision engine to apply the whole note dump.
- Identify which notes are hard project-constraint/continuity issues, which are craft suggestions, and which require a writer decision.
- If the notes contain many fixes, recommend a small first surgical batch rather than attempting all of them at once.
- If the writer later answers one decision from your triage, keep the next response scoped to that decision or the same recommended batch.

Output shape:
1. Highest-risk findings from the feedback that appear plausible against the current blueprint.
2. Items that need writer decision before changing.
3. Items that are safe candidates for a later surgical pass.
4. One recommended first batch, with scene numbers if clear.`);
    }

    if (sourceLocationQuestion) {
        fragments.push(`## SOURCE LOCATION GROUNDING MODE
The writer is asking for a page, issue, or source-location citation. Treat this as a factual evidence request, not an editorial inference.

Hard rules:
- Only give a page number, issue number, source item ID, or "corresponds to" claim if that exact locator is visible in the current prompt, attached source text, or project memory.
- Do not infer a page number from a scene number, plot order, or a plausible memory of the story.
- If the exact locator is not available, say you cannot verify the source location from the available context. You may still cite the current project scene/beat that triggered the question, clearly labeled as the current artifact rather than the source.`);
    }

    if (scopedPolishRequest) {
        fragments.push(buildToolScopedPolishPromptBlock(numericStageId, lastUserMessage));
    }

    return {
        context: fragments.filter(Boolean).join('\n\n---\n\n'),
        latestOnly: stage4CurrentArtifactAnalysis || stage6SourceComparisonAnalysis || stage6ExternalFeedbackReview || scopedPolishRequest
    };
}

async function buildStageDataForAssistant(projectData, stageId, sceneNumber) {
    const numericStageId = Number(stageId);
    const stageName = STAGE_NAMES[numericStageId];
    let stageData = '';

    switch (numericStageId) {
        case 1:
            stageData = JSON.stringify(projectData.data?.stage1_pitch?.pitch || {}, null, 2);
            break;
        case 2:
            stageData = JSON.stringify(projectData.data?.stage2_outline?.outline || [], null, 2);
            break;
        case 3:
            stageData = JSON.stringify(projectData.data?.stage3_characters?.characters || [], null, 2);
            break;
        case 4:
            stageData = JSON.stringify(projectData.data?.stage4_beats || [], null, 2);
            break;
        case 5: {
            const t = projectData.data?.stage5_treatment || {};
            stageData = [t.title_logline_characters, t.act_1, t.act_2a, t.act_2b, t.act_3].filter(Boolean).join('\n\n---\n\n');
            break;
        }
        case 6:
            stageData = JSON.stringify(projectData.data?.stage6_scenes || [], null, 2);
            break;
        case 7: {
            const savedStyleNames = [];
            try {
                const styleFiles = await fs.readdir(STYLES_DIR);
                for (const f of styleFiles) {
                    if (!f.endsWith('-directive.md') && !f.endsWith('.md')) continue;
                    if (f.endsWith('-reference.md')) continue;
                    try {
                        const raw = await fs.readFile(path.join(STYLES_DIR, f), 'utf-8');
                        const { meta } = parseStyleFile(raw);
                        if (meta.name) savedStyleNames.push(meta.name);
                    } catch {}
                }
            } catch {}
            const styleSlug = projectData.data?.stage7_style;
            if (styleSlug) {
                try {
                    let styleContent;
                    try {
                        styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf8');
                    } catch {
                        styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf8');
                    }
                    stageData = `Current style file (${styleSlug}):\n${styleContent}`;
                } catch {
                    stageData = 'No style file loaded yet.';
                }
            } else {
                stageData = 'No style selected yet. Help the writer define their style.';
            }
            if (savedStyleNames.length) {
                stageData += `\n\nSaved styles in library: ${savedStyleNames.join(', ')}`;
            }
            const s6 = projectData.data?.stage6_scenes || [];
            if (s6.length > 0) {
                const sceneSummaries = [];
                for (const seq of s6) {
                    if (seq.scenes) for (const sc of seq.scenes) {
                        sceneSummaries.push(`Scene ${sc.scene_number}: ${sc.scene_heading || sc.slugline || ''} - ${sc.narrative_action || ''}`);
                    }
                }
                if (sceneSummaries.length) stageData += `\n\nStory scenes for context:\n${sceneSummaries.join('\n')}`;
            }
            break;
        }
        case 8: {
            const draftScenes = [];
            for (const seq of (projectData.data?.stage6_scenes || [])) {
                if (seq.scenes) draftScenes.push(...seq.scenes);
            }
            const draftScene = draftScenes.find(s => s.scene_number === sceneNumber) || draftScenes[0];
            stageData = draftScene
                ? `Scene ${draftScene.scene_number}: ${draftScene.scene_heading || draftScene.slugline || ''}\n${draftScene.humanized_draft_text || draftScene.draft_text || ''}`
                : 'No scene selected.';
            break;
        }
        case 9:
            stageData = JSON.stringify(projectData.data?.stage8_coverage || {}, null, 2);
            break;
        case 10: {
            const coverage = projectData.data?.stage8_coverage;
            const macroTodo = coverage?.macro_todo || [];
            const microTodo = coverage?.micro_todo || [];
            const priorityIdx = projectData.data?.stage9_rewrites?.priority_idx ?? 0;
            const allPriorities = [
                ...macroTodo.map((t, i) => ({ label: `MACRO TO-DO P${i + 1}`, task: t.task || t, done: i < priorityIdx })),
                ...microTodo.map((t, i) => ({ label: `MICRO TO-DO P${i + 1}`, task: t.task || t, done: (macroTodo.length + i) < priorityIdx })),
            ];
            const priorityList = allPriorities.length
                ? allPriorities.map(p => `${p.done ? '[DONE]' : '[OPEN]'} ${p.label}: ${p.task}`).join('\n')
                : 'No rewrite priorities are available yet.';
            const characters = projectData.data?.stage3_characters?.characters || [];
            const charSummary = characters.length > 0
                ? characters.map(c => `${c.name} (${c.role}, ${c.profile_tier || 'Tier 1'}): ${c.brief_summary || ''}`).join('\n')
                : '';
            const stage6Scenes = projectData.data?.stage6_scenes || [];
            const allScenes = [];
            for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);
            const working = projectData.data?.stage9_rewrites?.working || {};
            const fullScript = allScenes
                .map(s => `## SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}\n${working[s.scene_number] || s.humanized_draft_text || s.draft_text || ''}`)
                .join('\n\n---\n\n');
            const doneCount = allPriorities.filter(p => p.done).length;
            const nextPriority = allPriorities.find(p => !p.done);
            stageData = `## STAGE 10 PRIORITIES
${priorityList}

Done priorities: ${doneCount} of ${allPriorities.length}
${nextPriority ? `Next open priority: ${nextPriority.label}: ${nextPriority.task}` : 'No open priorities remain.'}
${charSummary ? `\n\n## CHARACTERS\n${charSummary}` : ''}

## FULL SCREENPLAY (current working draft)
${fullScript || JSON.stringify(working, null, 2)}`;
            break;
        }
        default:
            throw new Error(`Unknown stageId: ${stageId}`);
    }

    return { stageName, stageData };
}

function parseStageOverride(value) {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? safeParse(value, null) : value;
}

function findProjectScene(projectData, sceneNumber) {
    const sceneNum = Number(sceneNumber);
    if (!sceneNum || !Array.isArray(projectData.data?.stage6_scenes)) return null;
    for (const sequence of projectData.data.stage6_scenes) {
        const scene = (sequence.scenes || []).find(s => Number(s.scene_number) === sceneNum);
        if (scene) return scene;
    }
    return null;
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const multer = require('multer');
const ALLOWED_UPLOAD_MIMES = new Set([
    'application/pdf',
    'text/plain',
    'application/octet-stream',        // .fountain / .fdx often land here
    'text/markdown',
    'text/x-fountain',
    'application/x-fountain',
    'application/xml',
    'text/xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-word',
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB hard cap
    fileFilter(_req, file, cb) {
        const ext = (file.originalname || '').split('.').pop().toLowerCase();
        const allowed = ['pdf', 'txt', 'md', 'fountain', 'fdx', 'docx'];
        if (!allowed.includes(ext) && !ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
            return cb(new Error(`Unsupported file type: .${ext}`));
        }
        cb(null, true);
    },
});

// Initialization
async function seedBundledStyles() {
    if (path.resolve(STYLES_DIR) === path.resolve(BUNDLED_STYLES_DIR)) return;
    let files = [];
    try {
        files = await fs.readdir(BUNDLED_STYLES_DIR);
    } catch {
        return;
    }

    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const source = path.join(BUNDLED_STYLES_DIR, file);
        const target = path.join(STYLES_DIR, file);
        try {
            await fs.access(target);
        } catch {
            await fs.copyFile(source, target);
        }
    }
}

async function initDb() {
    try {
        await fs.mkdir(DATA_ROOT, { recursive: true });
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(STYLES_DIR, { recursive: true });
        await seedBundledStyles();
    } catch (err) {
        console.error("Failed to create data directory:", err);
    }
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    // CSP: allow scripts from CDNs used by index.html, fonts from Google
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net 'unsafe-inline'; " +
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
        "font-src https://fonts.gstatic.com data:; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'"
    );
    next();
});

// ─── Authentication ───────────────────────────────────────────────────────────
// Layered, each layer dormant unless configured (see utils/auth.js):
//   1. Google sign-in — when GOOGLE_CLIENT_ID/SECRET + ALLOWED_EMAILS are set,
//      a signed session cookie from an allowlisted Google account grants access.
//   2. Shared secret (break-glass) — when APP_SECRET is set, an X-Api-Key /
//      Bearer header matching it grants access (admin / CLI / maintenance).
//   3. Nothing configured — fully open (localhost dev).
function requireAuth(req, res, next) {
    if (isGoogleAuthEnabled()) {
        const email = getSessionEmail(req);
        if (email) { req.userEmail = email; return next(); }
    }
    if (APP_SECRET) {
        const header = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
        if (header && header === APP_SECRET) return next();
    }
    if (!isGoogleAuthEnabled() && !APP_SECRET) return next(); // dormant — nothing configured
    return res.status(401).json({ error: 'Unauthorized' });
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,      // 1 minute window
    max: 30,                   // max 30 AI calls per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendApiError(res, new RateLimitError('Too many requests — slow down and try again.')),
});
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendApiError(res, new RateLimitError('Too many requests — slow down and try again.')),
});

// Middleware
app.use((req, res, next) => {
    if (req.path === '/app.js') {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
    next();
});
app.use(express.static('public'));
app.use(express.json({ limit: '20mb' }));

// Auth routes (/auth/google, /api/me, /api/auth-config, /auth/logout) — public,
// must precede the /api catch-all. Google sign-in stays dormant until configured.
registerAuthRoutes(app, { APP_SECRET });

registerGenerationRoutes(app, {
    requireAuth,
    aiLimiter,
    upload,
    fs,
    isValidProjectId,
    BadRequestError,
    NotFoundError,
    ApiError,
    sendApiError,
    safeParse,
    readProjectJSONById,
    writeJSONQueued,
    getProjectFilePath,
    updateProjectJSON,
    prepareGenerationUpload,
    appendUploadedSourceBlock,
    buildSourceGenerationPacket,
    getModelConfig,
    getModelConfigWithSourcePacket,
    withAbortSignal,
    sourceResponseExtras,
    sourcePlanDataHash,
    recordSourceGenerationUsage,
    trackUsage,
    prepareGenerationProjectContext,
    finalizeGenerationEndpointArtifact,
    completeGenerationEndpoint,
    createClientAbortTracker,
    isClientAbortError,
    publicErrorDetail,
    stage2ProtectedBeatEntriesForRequest,
    applyStageRevisionPlan,
    createVerifiedGenerationRevision,
    createRevisionTransaction,
    outlineRevisionAdapter,
    characterRevisionAdapter,
    stage4RevisionAdapter,
    treatmentRevisionAdapter,
    sceneBlueprintRevisionAdapter,
    buildOutlineRevisionChecklist,
    findUndercoveredOutlineChecklistItems,
    appendMissingOutlineChecklistBeats,
    extractExplicitOutlineSequenceReplacement,
    applyExplicitOutlineSequenceReplacement,
    applyStructuralOutlinePatches,
    sanitizeOutlineMetaBeats,
    compactText,
    agent1Pitch,
    agent1Refine,
    agent2Outline,
    agent3Characters,
    agent4Beats,
    agent5Treatment,
    generateStage6Scenes,
    reviseStage6Scenes,
    generateSceneDraft,
    humanizeDraft,
    findProjectScene,
    clearSceneFacts,
    buildContinuityContext,
    buildStage8SceneLockPacket,
    loadProjectStyle,
    runContinuityCheck,
    applyCheckResult,
    resolveError,
    buildSourceAuthorityBlock,
    recordArtifactMutation
});

// --- Stage 10: Rewrite Routes --- //

function ensureStage10RewriteState(projectData) {
    projectData.data = projectData.data || {};
    const stage9 = projectData.data.stage9_rewrites || { working: {}, priority_idx: 0, approved: false };
    stage9.working = stage9.working || {};
    stage9.pending = stage9.pending || {};
    projectData.data.stage9_rewrites = stage9;
    return stage9;
}

function persistStage10PendingRewrite(projectData, {
    projectId,
    sceneNum,
    proposedText,
    note = `Pending rewrite for scene ${sceneNum}`,
    sourcePacket = null,
    sourceText = proposedText,
    sourceReason = 'single_scene_rewrite'
} = {}) {
    const stage9 = ensureStage10RewriteState(projectData);
    const beforeRewrite = JSON.parse(JSON.stringify(stage9));
    stage9.pending[sceneNum] = proposedText;
    const snapshotEntries = recordArtifactMutation(projectData, {
        projectId,
        stage: 10,
        before: beforeRewrite,
        after: stage9,
        operation: 'revision',
        note
    });
    if (sourcePacket) {
        recordSourceGenerationUsage(projectData, sourcePacket, sourceText, sourceReason);
    }
    return snapshotEntries;
}

registerRewriteRoutes(app, {
    requireAuth,
    aiLimiter,
    isValidProjectId,
    assertValidProjectId,
    assertProjectExists,
    BadRequestError,
    sendApiError,
    getProjectFilePath,
    readProjectJSONById,
    writeJSONQueued,
    updateProjectJSON,
    agent8Coverage,
    rewriteScene,
    getModelConfig,
    getModelConfigWithSourcePacket,
    buildSourceGenerationPacket,
    recordArtifactMutation,
    stampGenerated,
    recordSourceGenerationUsage,
    trackUsage,
    sourceResponseExtras,
    compactText,
    buildStage10PlannerSceneList,
    loadSkill,
    loadProjectStyle,
    buildStage10RewritePlanPrompt,
    buildStage10RewritePlannerSystemInstruction,
    buildStage10RewriteLockPacket,
    findProjectScene,
    persistStage10PendingRewrite,
    ensureStage10RewriteState,
    persistChatAttachmentToKnowledge,
    safeParse,
    generateContent
});

registerAssistantRoutes(app, {
    requireAuth,
    aiLimiter,
    isGlobalStyleAssistantStage,
    runAssistantTurn,
    buildGlobalStyleAssistantContext,
    getAssistantModelConfig,
    assertValidProjectId,
    BadRequestError,
    STAGE_NAMES,
    getProjectFilePath,
    readProjectJSONById,
    conversationKeyForAssistantStage,
    buildStageDataForAssistant,
    persistChatAttachmentToKnowledge,
    writeJSONQueued,
    buildKnowledgeContextBlock,
    memoryUsageForStage,
    updateProjectJSON,
    buildStage4CurrentEventListResponse,
    persistStageConversation,
    buildMemoryRecallResponse,
    compactText,
    buildToolAssistantContextAdditions,
    buildStage4ConfirmationBypassResponse,
    buildStage4ConfirmationRevisionBrief,
    buildNeutralMessages,
    trackUsage,
    sendApiError
});

registerStyleRoutes(app, {
    requireAuth,
    aiLimiter,
    strictLimiter,
    upload,
    safeParse,
    isValidProjectId,
    isValidSlug,
    assertValidProjectId,
    BadRequestError,
    NotFoundError,
    sendApiError,
    getProjectFilePath,
    readProjectJSONById,
    buildSourceGenerationPacket,
    getModelConfigWithSourcePacket,
    getModelConfig,
    generateStyleFile,
    generateTrainedStyle,
    parseStyleFile,
    uniqueStyleSlug,
    atomicWriteFile,
    recordArtifactMutation,
    stampGenerated,
    recordSourceGenerationUsage,
    writeJSONQueued,
    trackUsage,
    sourceResponseExtras,
    uploadFileToAttachment,
    normalizeSourceText,
    extractAttachmentText,
    loadSkill,
    generateContent,
    STYLES_DIR
});

registerProjectRoutes(app, {
    requireAuth,
    upload,
    fs,
    path,
    DATA_ROOT,
    DATA_DIR,
    SETTINGS_PATH,
    appSettings,
    RUNTIME_API_KEYS_ENABLED,
    BUILD_COMMIT,
    BUILD_DEPLOYMENT_ID,
    BUILD_TIMESTAMP,
    getBuildInfo,
    atomicWriteJSON,
    auditOrUpgradeAllProjectKnowledge,
    readProjectJSONById,
    writeJSONQueued,
    BadRequestError,
    getModelConfig,
    assertValidProjectId,
    assertProjectExists,
    updateProjectJSON,
    mergeVersionHistory,
    changedStageKeysFromUpdate,
    stageConfig,
    recordArtifactMutation,
    stampRevised,
    removeProjectSourceAssets,
    sendApiError
});

registerKnowledgeRoutes(app, {
    requireAuth,
    aiLimiter,
    upload,
    STAGE_NAMES,
    SOURCE_TYPE_OPTIONS,
    assertValidProjectId,
    assertValidSourceId,
    assertProjectExists,
    readProjectJSONById,
    updateProjectJSON,
    BadRequestError,
    ensureProjectKnowledge,
    knowledgePayloadForClient,
    compactText,
    persistChatAttachmentToKnowledge,
    boundedKnowledgePush,
    compactProjectKnowledge,
    summarizeSourceForClient,
    readKnowledgeSourceAssetForClient,
    contentDispositionFilename,
    removeKnowledgeSource,
    removeKnowledgeSourceAssets,
    updateKnowledgeSourceMetadata,
    buildKnowledgeDiagnostics,
    summarizeAuditForDecision,
    compactAuditForKnowledge,
    recordAcceptedSourceDivergence,
    buildStageDataForAssistant,
    stageDataOverrideToText,
    buildFallbackStageCuration,
    buildKnowledgeContextBlock,
    getModelConfig,
    generateContent,
    safeParse,
    trackUsage,
    sanitizeStageCurationProposal,
    applyStageCurationToKnowledge,
    refreshStageHandoff,
    updateKnowledgeReview,
    buildSourceBiblePrompt,
    formatKnowledgeItem,
    sendApiError
});

registerExportRoutes(app, {
    requireAuth,
    readProjectJSONById,
    BadRequestError,
    sendApiError,
    generatePitchDocx,
    generateBeatsDocx,
    generateScenesDocx,
    generateCoverageDocx,
    generateOutlineDocx,
    generateCharactersDocx,
    generateTreatmentDocx,
    generateDraftDocx,
    generateScreenplayPdf,
    exportStageNumber,
    recordExportSnapshot,
    writeJSONQueued,
    getProjectFilePath
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── Startup checks ───────────────────────────────────────────────────────────
async function startServer() {
    await initDb();
    await loadSettings();
    (async () => {
        try {
            const { totals } = await auditOrUpgradeAllProjectKnowledge({ write: true });
            if (totals.changed || totals.recoveredMarkdown) {
                console.log(`[knowledge] legacy upgrade checked ${totals.projects} project(s), updated ${totals.changed}, recovered ${totals.recoveredMarkdown} markdown asset(s).`);
            }
        } catch (error) {
            console.error('[knowledge] legacy upgrade skipped:', error.message);
        }

        try {
            const { changed, inspected } = await seedStage3TierOverridesForDirectory({
                dir: DATA_DIR,
                write: true,
                overwriteUnversioned: true,
                markSeedVersion: true,
                log: () => {}
            });
            if (changed) console.log(`[stage3] tier override seed updated ${changed} of ${inspected} project file(s).`);
        } catch (error) {
            console.error('[stage3] tier override seed skipped:', error.message);
        }
    })();

    const hasGemini = appSettings.geminiApiKey || process.env.GEMINI_API_KEY;
    const hasAnthropic = appSettings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!hasGemini && !hasAnthropic) {
        console.warn('[warn] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set — AI features will fail on first use.');
    }
    if (isGoogleAuthEnabled()) {
        console.log(`[auth] Google sign-in active (${(process.env.ALLOWED_EMAILS || '').split(',').filter(Boolean).length} allowlisted email(s))${APP_SECRET ? ' + APP_SECRET break-glass' : ''}.`);
    } else if (APP_SECRET) {
        console.log('[auth] APP_SECRET set — shared-secret API authentication active.');
    } else {
        console.log('[auth] No auth configured — server is open (localhost dev mode).');
    }

    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

if (require.main === module) {
    startServer().catch(error => {
        console.error('Startup failed:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    app,
    buildStage10RewritePlanPrompt,
    buildStage10RewritePlannerSystemInstruction,
    buildKnowledgeSnapshot,
    ensureProjectKnowledge,
    buildKnowledgeContextBlock,
    buildKnowledgeDiagnostics,
    buildSourceGenerationPacket,
    buildSourceReadiness,
    buildSourceReadinessGate,
    buildSourceReadinessList,
    buildSourceUsePlan,
    buildSourceAuditFixNotes,
    compactAuditForKnowledge,
    compactProjectKnowledge,
    formatSourceUsePlan,
    sourceResponseExtras,
    sourceMemoryForResponse,
    isMemoryRecallRequest,
    buildMemoryRecallResponse,
    removeKnowledgeSource,
    prepareGenerationUpload,
    persistChatAttachmentToKnowledge,
    readKnowledgeSourceAssetForClient,
    upgradeLegacyProjectKnowledge,
    auditOrUpgradeAllProjectKnowledge,
    recordAcceptedSourceDivergence,
    recordStageSourceAudit,
    recordSourcePlanUsage,
    refreshStageHandoff,
    applyStageCurationToKnowledge,
    sanitizeStageCurationProposal,
    sourceBibleSummary,
    sourceAuditHasActionableItems,
    stageSourceProfile,
    stageDataOverrideToText,
    buildStage4CurrentEventListResponse,
    stage4CurrentEventListTerm,
    buildStage4ConfirmationBypassResponse,
    isScopedPolishRequest,
    buildScopedPolishPromptBlock,
    extractNumberedSourceItems,
    buildSourceItemInventoryBlock,
    updateKnowledgeSourceMetadata,
    updateKnowledgeReview,
    ApiError,
    BadRequestError,
    NotFoundError,
    RateLimitError,
    statusCodeForError,
    sendApiError,
    startServer
};
