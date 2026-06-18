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

function getBrainstormModelConfig(stageNum = 1) {
    const config = getModelConfig(stageNum);
    const explicitModel = appSettings.brainstormModel || process.env.BRAINSTORM_MODEL;
    if (explicitModel) return { ...config, model: explicitModel };
    if (config.geminiApiKey) return { ...config, model: 'gemini-3-flash-preview' };
    if (config.anthropicApiKey && (!config.model || String(config.model).startsWith('gemini-'))) {
        return { ...config, model: 'claude-sonnet-4-6' };
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
const { generateContent } = require('./agents/ai-client');
const { runAssistantTurn, buildNeutralMessages } = require('./agents/assistant');

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
        res.status(400).json({ error: invalidProjectMessage });
        return null;
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        if (notFoundLog) console.error(notFoundLog);
        res.status(404).json({ error: notFoundMessage });
        return null;
    }

    if (validate) {
        const validationError = validate(projectData);
        if (validationError) {
            res.status(400).json({ error: validationError });
            return null;
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

// ─── Authentication (shared secret) ──────────────────────────────────────────
// Dormant by default. Activate by setting APP_SECRET in .env.
// When set, every /api/* request must include:  X-Api-Key: <APP_SECRET>
function requireAuth(req, res, next) {
    if (!APP_SECRET) return next(); // dormant — no secret configured
    const header = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!header || header !== APP_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        commit: BUILD_COMMIT,
        deploymentId: BUILD_DEPLOYMENT_ID,
        buildTimestamp: BUILD_TIMESTAMP
    });
});

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

// API route
app.post('/api/execute', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { prompt, projectId } = req.body;
        const uploadedFile = req.file;
        let projectData = null;
        let sourcePacket = null;
        let uploadContext = null;

        if (projectId) {
            if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
            const content = await fs.readFile(getProjectFilePath(projectId), 'utf-8');
            projectData = JSON.parse(content);
            uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 1, userMessage: prompt || 'Generate pitch options.' });
            const stage1Prompt = appendUploadedSourceBlock(prompt, uploadContext);
            const stage1Seed = `${stage1Prompt || 'Generate pitch options.'}\n${uploadContext?.attachment?.name || ''}`;
            sourcePacket = buildSourceGenerationPacket(projectData, 1, stage1Seed, { userMessage: stage1Prompt || prompt || '' });
        } else {
            uploadContext = await prepareGenerationUpload(null, uploadedFile);
        }

        // Validation intentionally omitted — allows random pitch generation with no input

        console.log("Generating pitch options...");
        const promptWithUpload = appendUploadedSourceBlock(prompt, uploadContext);
        const { result, usage } = await agent1Pitch(
            promptWithUpload,
            uploadContext?.agentFile || null,
            sourcePacket ? getModelConfigWithSourcePacket(1, sourcePacket) : getModelConfig(1)
        );
        if (projectData && sourcePacket) {
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'pitch_generation');
            await writeJSONQueued(getProjectFilePath(projectId), projectData);
            trackUsage(projectId, usage);
        }
        res.json({ result, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error("Error executing agent:", error);
        res.status(500).json({ error: "Failed to generate pitch" });
    }
});

app.post('/api/refine-pitch', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { currentPitch, userNote, projectId } = req.body || {};
        const uploadedFile = req.file;

        if (!currentPitch || !userNote) {
            return res.status(400).json({ error: "Missing currentPitch or userNote" });
        }

        // currentPitch might be a string if sent via FormData
        const parsedPitch = safeParse(currentPitch);
        if (!parsedPitch) return res.status(400).json({ error: "Invalid currentPitch JSON" });
        let projectData = null;
        let sourcePacket = null;
        let uploadContext = null;
        if (projectId) {
            if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
            const content = await fs.readFile(getProjectFilePath(projectId), 'utf-8');
            projectData = JSON.parse(content);
            uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 1, userMessage: userNote, forceTextBlock: true });
            const userNoteWithUpload = appendUploadedSourceBlock(userNote, uploadContext);
            const stage1Seed = `${JSON.stringify(parsedPitch, null, 2)}\n${userNoteWithUpload}\n${uploadContext?.attachment?.name || ''}`;
            sourcePacket = buildSourceGenerationPacket(projectData, 1, stage1Seed, { userMessage: userNoteWithUpload });
        } else {
            uploadContext = await prepareGenerationUpload(null, uploadedFile, { forceTextBlock: true });
        }
        const userNoteWithUpload = appendUploadedSourceBlock(userNote, uploadContext);

        console.log("Revising pitch...");
        const { result, usage } = await agent1Refine(
            JSON.stringify(parsedPitch),
            userNoteWithUpload,
            uploadContext?.agentFile || null,
            sourcePacket ? getModelConfigWithSourcePacket(1, sourcePacket) : getModelConfig(1)
        );
        const changed = sourcePlanDataHash(JSON.stringify(parsedPitch)) !== sourcePlanDataHash(JSON.stringify(result || {}));
        if (projectData && sourcePacket) {
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'pitch_revision');
            await writeJSONQueued(getProjectFilePath(projectId), projectData);
            trackUsage(projectId, usage);
        }
        res.json({ result, changed, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error("Error executing refine agent:", error);
        res.status(500).json({ error: "Failed to refine pitch" });
    }
});

app.post('/api/generate-outline', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const wantsStream = req.body?.stream === true ||
        req.body?.stream === 'true' ||
        /\btext\/event-stream\b/i.test(req.headers.accept || '');
    let streaming = false;
    let heartbeat = null;
    const abortTracker = wantsStream ? createClientAbortTracker(res, 'Stage 2 outline stream') : null;

    const send = (data) => {
        if (streaming && !abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    const startStream = () => {
        if (!wantsStream || streaming) return;
        streaming = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        heartbeat = setInterval(() => {
            if (!abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                res.write(': keep-alive\n\n');
            }
        }, 15000);
        heartbeat.unref?.();
    };

    try {
        const { projectId, currentBeats, notes } = req.body;
        const uploadedFile = req.file;

        const context = await prepareGenerationProjectContext(req, res, {
            projectId,
            validate: (project) => project.data?.stage1_pitch?.pitch
                ? null
                : 'Project has no finalized Stage 1 Pitch'
        });
        if (!context) return;
        const { filePath, projectData } = context;
        const stage1 = projectData.data?.stage1_pitch?.pitch;

        const parsedBeats = currentBeats ? (safeParse(currentBeats, null)) : null;
        const activeProtectedBeatEntries = stage2ProtectedBeatEntriesForRequest(projectData, req.body?.protectedBeats);
        const activeProtectedBeats = activeProtectedBeatEntries.map(beat => beat.label);
        const beforeOutlineForChangeCheck = parsedBeats || projectData.data?.stage2_outline?.outline || {};
        const beforeOutlineHash = sourcePlanDataHash(JSON.stringify(beforeOutlineForChangeCheck));
        startStream();
        send({ type: 'progress', label: notes ? 'Revising outline...' : 'Generating outline...' });

        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 2, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);

        if (notesWithUpload && !uploadedFile) {
            const deterministicRevision = applyStageRevisionPlan({
                stageId: 'stage2_outline',
                artifact: beforeOutlineForChangeCheck,
                notes: notesWithUpload,
                protectedBeats: activeProtectedBeatEntries
            });
            if (deterministicRevision?.plan?.canApplyDirectly && !deterministicRevision?.receipt?.verified) {
                const failures = deterministicRevision.receipt?.failures || [];
                const failureList = failures
                    .map(failure => failure.newLabel || failure.oldLabel || failure.reason || failure.type || 'requested edit')
                    .filter(Boolean)
                    .slice(0, 5)
                    .join('; ');
                throw new Error(`Stage 2 deterministic outline revision failed verification${failureList ? `: ${failureList}` : ''}`);
            }
            if (deterministicRevision?.receipt?.verified && deterministicRevision.plan?.canApplyDirectly) {
                abortTracker?.throwIfAborted();
                const existingStage2 = projectData.data?.stage2_outline || {};
                const outlineData = {
                    title: existingStage2.title || stage1.title || projectData.title || 'Untitled',
                    genre: existingStage2.genre || stage1.genre || '',
                    logline: existingStage2.logline || stage1.logline || '',
                    ...existingStage2,
                    outline: deterministicRevision.after,
                    protected_beats: activeProtectedBeats
                };
                deterministicRevision.receipt.changed = deterministicRevision.changed;
                const afterOutlineHash = sourcePlanDataHash(JSON.stringify(outlineData.outline || {}));
                const { snapshotIds } = await finalizeGeneratedStageArtifact({
                    projectId,
                    filePath,
                    projectData,
                    stage: 2,
                    stageKey: 'stage2_outline',
                    result: outlineData,
                    before: { outline: beforeOutlineForChangeCheck },
                    operation: 'revision',
                    note: notesWithUpload,
                    revisionReceipt: deterministicRevision.receipt,
                    changed: true,
                    afterSave: async ({ filePath }) => {
                        const savedContent = await fs.readFile(filePath, 'utf-8');
                        const savedProjectData = JSON.parse(savedContent);
                        const savedOutlineHash = sourcePlanDataHash(JSON.stringify(savedProjectData.data?.stage2_outline?.outline || {}));
                        if (savedOutlineHash !== afterOutlineHash) {
                            throw new Error('Stage 2 deterministic outline save verification failed: saved project JSON does not match revised outline.');
                        }
                    }
                });

                const payload = {
                    result: outlineData,
                    changed: deterministicRevision.changed || deterministicRevision.receipt.verified,
                    saveVerified: true,
                    revisionReceipt: deterministicRevision.receipt,
                    snapshotIds,
                    deterministicRevision: true
                };
                if (streaming) {
                    send({ type: 'complete', ...payload });
                } else {
                    res.json(payload);
                }
                return;
            }
        }

        console.log("Generating Stage 2 Outline...");
        const stage2KnowledgeSeed = `${JSON.stringify(stage1, null, 2)}\n${parsedBeats ? JSON.stringify(parsedBeats, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 2, stage2KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: outlineData, usage } = await agent2Outline(
            stage1,
            parsedBeats,
            notesWithUpload,
            uploadContext.agentFile,
            withAbortSignal(getModelConfigWithSourcePacket(2, sourcePacket), abortTracker?.signal)
        );
        abortTracker?.throwIfAborted();
        outlineData.protected_beats = activeProtectedBeats;
        const revisionChecklist = notesWithUpload ? buildOutlineRevisionChecklist(notesWithUpload) : [];
        const explicitSequenceReplacement = notesWithUpload ? extractExplicitOutlineSequenceReplacement(notesWithUpload) : null;
        if (explicitSequenceReplacement) {
            applyExplicitOutlineSequenceReplacement(outlineData, explicitSequenceReplacement);
        }
        let structuralOutlinePatch = null;
        if (notesWithUpload && outlineData?.outline) {
            structuralOutlinePatch = applyStructuralOutlinePatches(outlineData.outline, notesWithUpload);
        }
        let missingChecklistItems = revisionChecklist.length
            ? findUndercoveredOutlineChecklistItems(revisionChecklist, outlineData)
            : [];
        if (missingChecklistItems.length) {
            appendMissingOutlineChecklistBeats(outlineData, missingChecklistItems);
            missingChecklistItems = findUndercoveredOutlineChecklistItems(revisionChecklist, outlineData);
        }
        if (missingChecklistItems.length) {
            throw new Error(`Stage 2 outline revision did not satisfy required checklist item(s): ${missingChecklistItems.map(item => `"${compactText(item, 180)}"`).join('; ')}`);
        }
        const afterOutlineHash = sourcePlanDataHash(JSON.stringify(outlineData?.outline || {}));
        const revisionTransaction = notesWithUpload
            ? createRevisionTransaction({
                stageId: 'stage2_outline',
                before: beforeOutlineForChangeCheck,
                after: outlineData?.outline || {},
                notes: notesWithUpload,
                structuralPatch: structuralOutlinePatch,
                adapter: outlineRevisionAdapter
            })
            : null;
        assertRevisionTransactionVerified(revisionTransaction, 'Stage 2 outline');
        const changed = !notesWithUpload || revisionTransaction.changed;
        const operation = notesWithUpload ? 'revision' : 'generation';
        const { snapshotIds } = await finalizeGeneratedStageArtifact({
            projectId,
            filePath,
            projectData,
            stage: 2,
            stageKey: 'stage2_outline',
            result: outlineData,
            before: { outline: beforeOutlineForChangeCheck },
            operation,
            note: notesWithUpload || '',
            revisionReceipt: revisionTransaction?.receipt || null,
            changed,
            sourcePacket,
            usage,
            sourceReason: operation,
            afterSave: async ({ filePath }) => {
                const savedContent = await fs.readFile(filePath, 'utf-8');
                const savedProjectData = JSON.parse(savedContent);
                const savedOutlineHash = sourcePlanDataHash(JSON.stringify(savedProjectData.data?.stage2_outline?.outline || {}));
                if (savedOutlineHash !== afterOutlineHash) {
                    throw new Error('Stage 2 outline save verification failed: saved project JSON does not match generated outline.');
                }
            }
        });

        const payload = {
            result: outlineData,
            changed,
            saveVerified: true,
            revisionReceipt: revisionTransaction?.receipt,
            snapshotIds,
            checklistVerified: revisionChecklist.length > 0,
            ...sourceResponseExtras(sourcePacket)
        };
        if (streaming) {
            send({ type: 'complete', ...payload });
        } else {
            res.json(payload);
        }
    } catch (error) {
        if (isClientAbortError(error)) {
            console.warn('Stage 2 outline stream stopped after client disconnect.');
            return;
        }
        console.error('Outline Gen Error:', error);
        const detail = publicErrorDetail(error);
        const message = detail ? `Failed to generate outline: ${detail}` : "Failed to generate outline";
        if (streaming) {
            send({ type: 'error', message });
        } else {
            res.status(500).json({ error: message });
        }
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        abortTracker?.markComplete();
        if (streaming && !res.destroyed && !res.writableEnded) res.end();
    }
});

app.post('/api/generate-characters', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentCharacters, notes, tierOverrides } = req.body;
        const uploadedFile = req.file;

        const context = await prepareGenerationProjectContext(req, res, {
            projectId,
            notFoundLog: 'generate-characters: failed to load project',
            validate: (project) => {
                const pitchData = project.data?.stage1_pitch?.pitch;
                const beatsData = project.data?.stage2_outline?.outline;
                return (!pitchData || !beatsData)
                    ? 'Project requires Stage 1 Pitch and Stage 2 Outline to generate Characters'
                    : null;
            }
        });
        if (!context) return;
        const { filePath, projectData } = context;
        const pitchData = projectData.data?.stage1_pitch?.pitch;
        const beatsData = projectData.data?.stage2_outline?.outline;

        const parsedChars = currentCharacters ? safeParse(currentCharacters, null) : null;
        const parsedTierOverrides = tierOverrides ? safeParse(tierOverrides, null) : null;
        const activeTierOverrides = parsedTierOverrides && typeof parsedTierOverrides === 'object' && !Array.isArray(parsedTierOverrides)
            ? parsedTierOverrides
            : (projectData.data?.stage3_characters?.tier_overrides || {});
        const beforeCharactersForRevision = parsedChars || projectData.data?.stage3_characters?.characters || [];
        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 3, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);

        console.log("Generating Stage 3 Characters...");
        const stage3KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${parsedChars ? JSON.stringify(parsedChars, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 3, stage3KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: characterData, usage } = await agent3Characters(
            pitchData,
            beatsData,
            parsedChars,
            notesWithUpload,
            uploadContext.agentFile,
            {
                ...getModelConfigWithSourcePacket(3, sourcePacket),
                tierOverrides: activeTierOverrides
            }
        );
        characterData.tier_overrides = activeTierOverrides;
        const revisionTransaction = notesWithUpload
            ? createRevisionTransaction({
                stageId: 'stage3_characters',
                before: beforeCharactersForRevision,
                after: characterData?.characters || [],
                notes: notesWithUpload,
                adapter: characterRevisionAdapter
            })
            : null;
        assertRevisionTransactionVerified(revisionTransaction, 'Stage 3 characters');
        const changed = !notesWithUpload || revisionTransaction.changed;
        const operation = notesWithUpload ? 'revision' : 'generation';
        const { snapshotIds } = await finalizeGeneratedStageArtifact({
            projectId,
            filePath,
            projectData,
            stage: 3,
            stageKey: 'stage3_characters',
            result: characterData,
            before: { characters: beforeCharactersForRevision },
            operation,
            note: notesWithUpload || '',
            revisionReceipt: revisionTransaction?.receipt || null,
            changed,
            sourcePacket,
            usage,
            sourceReason: operation
        });

        res.json({ result: characterData, changed, revisionReceipt: revisionTransaction?.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Character Gen Error:', error);
        const detail = publicErrorDetail(error);
        res.status(500).json({ error: detail ? `Failed to generate characters: ${detail}` : "Failed to generate characters" });
    }
});

app.post('/api/generate-stage4-beats', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId, currentBeats, notes } = req.body || {};
    const uploadedFile = req.file;

    const context = await prepareGenerationProjectContext(req, res, {
        projectId,
        validate: (project) => {
            const pitchData = project.data?.stage1_pitch?.pitch;
            const beatsData = project.data?.stage2_outline?.outline;
            const charsData = project.data?.stage3_characters?.characters;
            return (!pitchData || !beatsData || !charsData)
                ? 'Project requires Stages 1-3 to generate Beats'
                : null;
        }
    });
    if (!context) return;
    const { filePath, projectData } = context;
    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const beatsData = projectData.data?.stage2_outline?.outline;
    const charsData = projectData.data?.stage3_characters?.characters;

    const parsedCurrentBeats = currentBeats ? safeParse(currentBeats, null) : null;
    const isFullStage4Generation = !parsedCurrentBeats;
    const beforeStage4ForRevision = parsedCurrentBeats || projectData.data?.stage4_beats || {};

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const abortTracker = createClientAbortTracker(res, 'Stage 4 beats stream');

    const send = (data) => {
        if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            res.flush?.();
        }
    };
    const heartbeat = setInterval(() => {
        send({ type: 'heartbeat', label: parsedCurrentBeats ? 'Still revising beats...' : 'Still generating beats...' });
    }, 10000);
    heartbeat.unref?.();

    try {
        console.log("Generating Stage 4 Beats...");
        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 4, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);
        const stage4KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${JSON.stringify(charsData, null, 2)}\n${parsedCurrentBeats ? JSON.stringify(parsedCurrentBeats, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 4, stage4KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: beatsResult, usage } = await agent4Beats(
            pitchData, beatsData, charsData, parsedCurrentBeats, notesWithUpload, uploadContext.agentFile,
            (label) => send({ type: 'progress', label }),
            withAbortSignal(getModelConfigWithSourcePacket(4, sourcePacket), abortTracker.signal)
        );
        abortTracker.throwIfAborted();

        console.log("Beats generated successfully. Beat sheet length:", beatsResult.hybrid_beat_sheet?.length || 0);
        const revisionTransaction = notesWithUpload && !isFullStage4Generation
            ? createRevisionTransaction({
                stageId: 'stage4_beats',
                before: beforeStage4ForRevision,
                after: beatsResult || {},
                notes: notesWithUpload,
                adapter: stage4RevisionAdapter
            })
            : null;
        assertRevisionTransactionVerified(revisionTransaction, 'Stage 4 beats');
        const changed = isFullStage4Generation || revisionTransaction?.changed === true;
        const operation = notesWithUpload ? 'revision' : 'generation';
        const { snapshotIds } = await finalizeGeneratedStageArtifact({
            projectId,
            filePath,
            projectData,
            stage: 4,
            stageKey: 'stage4_beats',
            result: beatsResult,
            before: beforeStage4ForRevision,
            operation,
            note: notesWithUpload || '',
            revisionReceipt: revisionTransaction?.receipt || null,
            changed,
            sourcePacket,
            usage,
            sourceReason: operation,
            beforeSave: (projectData) => {
                if (isFullStage4Generation && projectData.data.conversations?.stage4) {
                    delete projectData.data.conversations.stage4;
                }
            }
        });

        send({ type: 'complete', result: beatsResult, changed, revisionReceipt: revisionTransaction?.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        if (isClientAbortError(error)) {
            console.warn('Stage 4 beats stream stopped after client disconnect.');
            return;
        }
        console.error('Stage 4 Beats Gen Error:', error.message);
        const detail = publicErrorDetail(error);
        send({ type: 'error', message: detail ? `Failed to generate beats: ${detail}` : 'Failed to generate beats' });
    } finally {
        clearInterval(heartbeat);
        abortTracker.markComplete();
        if (!res.destroyed && !res.writableEnded) res.end();
    }
});

app.post('/api/generate-stage5-treatment', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId } = req.body || {};
    const uploadedFile = req.file;
    const context = await prepareGenerationProjectContext(req, res, {
        projectId,
        validate: (project) => {
            const pitchData = project.data?.stage1_pitch?.pitch;
            const charactersData = project.data?.stage3_characters?.characters;
            const beatsData = project.data?.stage4_beats?.hybrid_beat_sheet;
            return (!pitchData || !charactersData || !beatsData)
                ? 'Project requires Stages 1, 3, and 4 to generate Treatment'
                : null;
        }
    });
    if (!context) return;
    const { filePath, projectData } = context;

    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const charactersData = projectData.data?.stage3_characters?.characters;
    const beatsData = projectData.data?.stage4_beats?.hybrid_beat_sheet;

    const { notes, currentTreatment } = req.body;
    const parsedTreatment = currentTreatment ? safeParse(currentTreatment, null) : null;
    const comparableCurrentTreatment = parsedTreatment && typeof parsedTreatment === 'object'
        ? Object.fromEntries(Object.entries(parsedTreatment).filter(([key]) => key !== 'notes'))
        : parsedTreatment;
    const beforeStage5ForRevision = comparableCurrentTreatment || projectData.data?.stage5_treatment || {};

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const abortTracker = createClientAbortTracker(res, 'Stage 5 treatment stream');

    const send = (data) => {
        if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            res.flush?.();
        }
    };
    const heartbeat = setInterval(() => {
        send({ type: 'heartbeat', label: 'Still generating scene blueprint...' });
    }, 10000);
    heartbeat.unref?.();

    try {
        console.log("Generating Stage 5 Chained Treatment...");
        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 5, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);
        const stage5KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(charactersData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${parsedTreatment ? JSON.stringify(parsedTreatment, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 5, stage5KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: treatmentResult, usageList } = await agent5Treatment(
            pitchData, charactersData, beatsData, parsedTreatment, notesWithUpload,
            (step, total, label) => send({ type: 'progress', step, total, label }),
            withAbortSignal(getModelConfigWithSourcePacket(5, sourcePacket), abortTracker.signal)
        );
        abortTracker.throwIfAborted();
        const revisionTransaction = notesWithUpload
            ? createRevisionTransaction({
                stageId: 'stage5_treatment',
                before: beforeStage5ForRevision,
                after: treatmentResult || {},
                notes: notesWithUpload,
                adapter: treatmentRevisionAdapter
            })
            : null;
        assertRevisionTransactionVerified(revisionTransaction, 'Stage 5 treatment');
        const changed = !notesWithUpload || revisionTransaction.changed;
        const operation = notesWithUpload ? 'revision' : 'generation';
        const { snapshotIds } = await finalizeGeneratedStageArtifact({
            projectId,
            filePath,
            projectData,
            stage: 5,
            stageKey: 'stage5_treatment',
            result: treatmentResult,
            before: beforeStage5ForRevision,
            operation,
            note: notesWithUpload || '',
            revisionReceipt: revisionTransaction?.receipt || null,
            changed,
            sourcePacket,
            usage: usageList,
            sourceReason: operation
        });

        send({ type: 'complete', result: treatmentResult, changed, revisionReceipt: revisionTransaction?.receipt, snapshotIds, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        if (isClientAbortError(error)) {
            console.warn('Stage 5 treatment stream stopped after client disconnect.');
            return;
        }
        console.error('Stage 5 Treatment Gen Error:', error.message, error.stack);
        const detail = error?.message ? `: ${String(error.message).slice(0, 240)}` : '';
        send({ type: 'error', message: `Failed to generate treatment${detail}` });
    } finally {
        clearInterval(heartbeat);
        abortTracker.markComplete();
        if (!res.destroyed && !res.writableEnded) res.end();
    }
});

app.post('/api/generate-stage6-scenes', requireAuth, aiLimiter, async (req, res) => {
    const { projectId, notes } = req.body;
    const generationNotes = typeof notes === 'string' ? notes.trim() : '';

    const context = await prepareGenerationProjectContext(req, res, {
        projectId,
        validate: (project) => {
            const pitch = project.data?.stage1_pitch?.pitch;
            const characters = project.data?.stage3_characters?.characters;
            const beats = project.data?.stage4_beats?.hybrid_beat_sheet;
            const treatment = project.data?.stage5_treatment;
            return (!pitch || !characters || !beats || !treatment)
                ? 'Project requires Stages 1, 3, 4, and 5 to generate Scene Blueprint'
                : null;
        }
    });
    if (!context) return;
    const { filePath, projectData } = context;
    const pitch = projectData.data?.stage1_pitch?.pitch;
    const characters = projectData.data?.stage3_characters?.characters;
    const beats = projectData.data?.stage4_beats?.hybrid_beat_sheet;
    const treatment = projectData.data?.stage5_treatment;

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const abortTracker = createClientAbortTracker(res, 'Stage 6 scene generation stream');

    const send = (data) => {
        if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };
    const heartbeat = setInterval(() => {
        if (!abortTracker.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(': keep-alive\n\n');
        }
    }, 15000);
    heartbeat.unref?.();

    try {
        console.log("Generating Stage 6 Scene Blueprint (Sequential Chain)...");
        send({ type: 'status', message: generationNotes ? 'Preparing fresh blueprint with your notes...' : 'Preparing fresh blueprint...' });
        const sourceAuthorityBlock = buildSourceAuthorityBlock(projectData, 'stage6_scenes');
        if (sourceAuthorityBlock) {
            console.log("Stage 6: upstream revisions detected, injecting source authority block.");
        }
        const stage6KnowledgeSeed = `${JSON.stringify(pitch, null, 2)}\n${JSON.stringify(characters, null, 2)}\n${JSON.stringify(beats, null, 2)}\n${JSON.stringify(treatment, null, 2)}\n${generationNotes}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 6, stage6KnowledgeSeed, { userMessage: generationNotes });
        const combinedSourceBlock = [sourceAuthorityBlock, sourcePacket.contextBlock].filter(Boolean).join('\n\n---\n\n');

        const { result: allSequences, usageList } = await generateStage6Scenes(
            pitch, characters, beats, treatment,
            (current, total) => send({ type: 'progress', current, total }),
            combinedSourceBlock,
            withAbortSignal(getModelConfig(6), abortTracker.signal),
            generationNotes
        );
        abortTracker.throwIfAborted();
        const { snapshotIds } = await finalizeGeneratedStageArtifact({
            projectId,
            filePath,
            projectData,
            stage: 6,
            stageKey: 'stage6_scenes',
            result: allSequences,
            before: projectData.data?.stage6_scenes || [],
            operation: 'generation',
            note: generationNotes,
            sourcePacket,
            usage: usageList,
            sourceReason: 'generation'
        });

        send({ type: 'complete', result: allSequences, snapshotIds, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        if (isClientAbortError(error)) {
            console.warn('Stage 6 scene generation stream stopped after client disconnect.');
            return;
        }
        console.error('Stage 6 Scene Gen Error:', error.message);
        const detail = publicErrorDetail(error);
        send({ type: 'error', message: detail ? `Failed to generate scene blueprint: ${detail}` : 'Failed to generate scene blueprint' });
    } finally {
        clearInterval(heartbeat);
        abortTracker.markComplete();
        if (!res.destroyed && !res.writableEnded) res.end();
    }
});

app.post('/api/revise-stage6', requireAuth, aiLimiter, async (req, res) => {
    let heartbeat = null;
    let streaming = false;
    let abortTracker = null;
    const send = (data) => {
        if (streaming && !abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };
    try {
        const { projectId, feedback, stream } = req.body;
        if (!isValidProjectId(projectId) || !feedback) {
            return res.status(400).json({ error: "Missing or invalid projectId, or missing feedback" });
        }
        streaming = stream === true || /\btext\/event-stream\b/i.test(req.headers.accept || '');

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        const currentBlueprint = projectData.data?.stage6_scenes;
        if (!currentBlueprint) {
            return res.status(400).json({ error: "No current Stage 6 blueprint found to revise" });
        }

        if (streaming) {
            abortTracker = createClientAbortTracker(res, 'Stage 6 revision stream');
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            heartbeat = setInterval(() => {
                if (!abortTracker?.signal.aborted && !res.destroyed && !res.writableEnded) {
                    res.write(': keep-alive\n\n');
                }
            }, 15000);
            heartbeat.unref?.();
            send({ type: 'status', message: 'Revising scene blueprint...' });
        }

        console.log("Revising Stage 6 Scene Blueprint...");
        const stage6RevisionSeed = `${JSON.stringify(currentBlueprint, null, 2)}\n${feedback}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 6, stage6RevisionSeed, { userMessage: feedback });
        const { result: updatedBlueprint, usage } = await reviseStage6Scenes(
            currentBlueprint,
            feedback,
            withAbortSignal(getModelConfigWithSourcePacket(6, sourcePacket), abortTracker?.signal)
        );
        abortTracker?.throwIfAborted();
        const revisionTransaction = createRevisionTransaction({
            stageId: 'stage6_scenes',
            before: currentBlueprint || [],
            after: updatedBlueprint || [],
            notes: feedback,
            adapter: sceneBlueprintRevisionAdapter
        });
        assertRevisionTransactionVerified(revisionTransaction, 'Stage 6 scene blueprint');
        const changed = revisionTransaction.changed;
        const snapshotEntries = recordArtifactMutation(projectData, {
            projectId,
            stage: 6,
            before: currentBlueprint || [],
            after: updatedBlueprint || [],
            operation: 'revision',
            note: feedback,
            revisionReceipt: revisionTransaction.receipt
        });

        send({ type: 'status', message: changed ? 'Saving revised blueprint...' : 'Revision returned no blueprint changes...' });
        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = updatedBlueprint;
        if (changed) stampRevised(projectData, 'stage6_scenes');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(updatedBlueprint, null, 2), 'revision');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        const payload = { result: updatedBlueprint, changed, revisionReceipt: revisionTransaction.receipt, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) };
        if (streaming) {
            // Keep the final SSE packet small. The browser refreshes the saved
            // Stage 6 data after completion, which avoids large blueprint payloads
            // being dropped by buffering/proxy layers.
            send({ type: 'complete', changed, stageKey: 'stage6_scenes', ...sourceResponseExtras(sourcePacket) });
        } else {
            res.json(payload);
        }
    } catch (error) {
        if (isClientAbortError(error)) {
            console.warn('Stage 6 revision stream stopped after client disconnect.');
            return;
        }
        console.error('Stage 6 Revision Error:', error.message);
        const errorMessage = error.code === 'NO_BLUEPRINT_CHANGES'
            ? error.message
            : "Failed to revise scene blueprint";
        if (streaming) {
            send({ type: 'error', message: errorMessage });
        } else {
            res.status(500).json({ error: errorMessage });
        }
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        abortTracker?.markComplete();
        if (streaming && !res.destroyed && !res.writableEnded) res.end();
    }
});

app.post('/api/generate-draft', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, sceneNumber } = req.body;
        const sceneNum = parseInt(sceneNumber, 10);
        if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || sceneNum > 10000) {
            return res.status(400).json({ error: "Missing or invalid projectId or sceneNumber" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data || !projectData.data.stage6_scenes) {
            return res.status(400).json({ error: "Stage 6 Scene Blueprint not found" });
        }
        const beforeDraftSnapshot = JSON.parse(JSON.stringify(projectData.data.stage6_scenes || []));

        // Find the scene in the sequences
        let targetedScene = null;
        for (const sequence of projectData.data.stage6_scenes) {
            const scene = sequence.scenes.find(s => s.scene_number === sceneNum);
            if (scene) {
                targetedScene = scene;
                break;
            }
        }

        if (!targetedScene) {
            return res.status(404).json({ error: `Scene ${sceneNum} not found in blueprint` });
        }
        const beforeDraftHash = sourcePlanDataHash(targetedScene.humanized_draft_text || targetedScene.draft_text || '');

        const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: `Scene missing required fields: ${missingFields.join(', ')}` });
        }

        const projectContext = {
            synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
            characters: projectData.data.stage3_characters?.characters || []
        };

        clearSceneFacts(projectData, sceneNum);
        const continuityCtx = buildContinuityContext(projectData, sceneNum, targetedScene);
        const sceneLockPacket = buildStage8SceneLockPacket(projectData, sceneNum, targetedScene);

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Generating draft for Scene ${sceneNum}...`);
        const draftKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(targetedScene, null, 2)}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 8, draftKnowledgeSeed);
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, null, getModelConfigWithSourcePacket(8, sourcePacket), styleContent, continuityCtx, sceneLockPacket);

        console.log(`Humanizing draft for Scene ${sceneNum}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText, styleContent);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(targetedScene, null, 2), 'generation');

        console.log(`Running continuity check for Scene ${sceneNum}...`);
        const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
            humanizedText || draftText, targetedScene, projectData,
            { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
        );
        applyCheckResult(projectData, checkResult, checkUsage);
        const snapshotEntries = recordArtifactMutation(projectData, {
            projectId,
            stage: 8,
            before: beforeDraftSnapshot,
            after: projectData.data.stage6_scenes,
            operation: 'generation',
            note: `Scene ${sceneNum} draft`
        });

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const changed = beforeDraftHash !== sourcePlanDataHash(humanizedText || draftText || '');
        const response = { result: humanizedText, changed, snapshotIds: snapshotEntries.map(entry => entry.id), ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
        if (checkResult.errors?.length > 0) response.continuityErrors = checkResult.errors;
        if (checkResult.warnings?.length > 0) response.continuityWarnings = checkResult.warnings;
        res.json(response);
    } catch (error) {
        console.error('Stage 8 Draft Generation Error:', error.message);
        res.status(500).json({ error: "Failed to generate scene draft" });
    }
});

app.post('/api/revise-draft', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, sceneNumber, feedback } = req.body;
        const sceneNum = parseInt(sceneNumber, 10);
        if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || sceneNum > 10000 || !feedback) {
            return res.status(400).json({ error: "Missing or invalid projectId, sceneNumber, or feedback" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data?.stage6_scenes) {
            return res.status(400).json({ error: "Stage 6 Scene Blueprint not found" });
        }
        const beforeDraftSnapshot = JSON.parse(JSON.stringify(projectData.data.stage6_scenes || []));

        let targetedScene = null;
        for (const sequence of projectData.data.stage6_scenes) {
            const scene = sequence.scenes.find(s => s.scene_number === sceneNum);
            if (scene) { targetedScene = scene; break; }
        }

        if (!targetedScene) {
            return res.status(404).json({ error: `Scene ${sceneNum} not found in blueprint` });
        }

        const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(f => !targetedScene[f]);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: `Scene missing required fields: ${missingFields.join(', ')}` });
        }

        const projectContext = {
            synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || "",
            characters: projectData.data.stage3_characters?.characters || []
        };

        clearSceneFacts(projectData, sceneNum);
        const continuityCtx = buildContinuityContext(projectData, sceneNum, targetedScene);
        const sceneLockPacket = buildStage8SceneLockPacket(projectData, sceneNum, targetedScene);

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Revising draft for Scene ${sceneNum}...`);
        const draftKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(targetedScene, null, 2)}\n${feedback}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 8, draftKnowledgeSeed, { userMessage: feedback });
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, feedback, getModelConfigWithSourcePacket(8, sourcePacket), styleContent, continuityCtx, sceneLockPacket);

        console.log(`Humanizing revised draft for Scene ${sceneNum}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText, styleContent);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;
        targetedScene.locked = false;
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(targetedScene, null, 2), 'revision');

        console.log(`Running continuity check for Scene ${sceneNum}...`);
        const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
            humanizedText || draftText, targetedScene, projectData,
            { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
        );
        applyCheckResult(projectData, checkResult, checkUsage);
        const snapshotEntries = recordArtifactMutation(projectData, {
            projectId,
            stage: 8,
            before: beforeDraftSnapshot,
            after: projectData.data.stage6_scenes,
            operation: 'revision',
            note: `Scene ${sceneNum} draft revision: ${feedback || ''}`
        });

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const response = { result: humanizedText, snapshotIds: snapshotEntries.map(entry => entry.id), ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
        if (checkResult.errors?.length > 0) response.continuityErrors = checkResult.errors;
        if (checkResult.warnings?.length > 0) response.continuityWarnings = checkResult.warnings;
        res.json(response);
    } catch (error) {
        console.error('Stage 8 Draft Revision Error:', error.message);
        res.status(500).json({ error: "Failed to revise scene draft" });
    }
});

// --- Continuity: Resolve flagged error --- //

app.post('/api/continuity/resolve', requireAuth, async (req, res) => {
    try {
        const { projectId, factId, resolution, newValue } = req.body;
        if (!isValidProjectId(projectId) || !factId || !resolution) {
            return res.status(400).json({ error: 'Missing projectId, factId, or resolution' });
        }
        if (!['intentional_change', 'dismiss', 'fix_prompt'].includes(resolution)) {
            return res.status(400).json({ error: 'Invalid resolution type' });
        }
        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const projectData = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        resolveError(projectData, factId, resolution, newValue);
        await writeJSONQueued(filePath, projectData);
        res.json({ success: true });
    } catch (error) {
        console.error('Continuity resolve error:', error.message);
        res.status(500).json({ error: 'Failed to resolve continuity issue' });
    }
});

// --- Stage 9: Coverage --- //

app.post('/api/generate-coverage', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, source } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: "Missing or invalid projectId" });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        if (!projectData.data?.stage7_approved) {
            return res.status(400).json({ error: "Stage 8 Draft must be approved before generating coverage" });
        }

        let fullScriptText;

        // When triggered from Stage 10 loopback, use the rewritten working copy
        if (source === 'stage10' && projectData.data?.stage9_rewrites?.working) {
            const working = projectData.data.stage9_rewrites.working;
            fullScriptText = Object.keys(working)
                .map(n => parseInt(n))
                .sort((a, b) => a - b)
                .map(n => (working[n] || '').trim())
                .filter(t => t && t !== '[SCENE DELETED]')
                .join('\n\n');
        } else {
            const stage6Scenes = projectData.data?.stage6_scenes;
            if (!stage6Scenes) {
                return res.status(400).json({ error: "No scene blueprint found" });
            }

            // Assemble full script from all scenes in order
            const allScenes = [];
            for (const seq of stage6Scenes) {
                if (seq.scenes) allScenes.push(...seq.scenes);
            }
            allScenes.sort((a, b) => a.scene_number - b.scene_number);

            fullScriptText = allScenes
                .map(s => (s.humanized_draft_text || s.draft_text || '').trim())
                .filter(Boolean)
                .join('\n\n');
        }

        if (!fullScriptText) {
            return res.status(400).json({ error: "No draft text found in scenes. Generate scene drafts first." });
        }

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const projectContext = {
            title:    pitch?.title || projectData.title || 'Untitled',
            genre:    pitch?.genre || '',
            logline:  pitch?.logline || '',
            synopsis: pitch?.synopsis || '',
            characters: projectData.data?.stage3_characters?.characters || []
        };

        console.log(`Generating Stage 9 Coverage for project ${projectId}...`);
        const coverageKnowledgeSeed = `${JSON.stringify(projectContext, null, 2)}\n${compactText(fullScriptText, 24_000)}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 9, coverageKnowledgeSeed, { userMessage: 'Generate screenplay coverage against approved project memory.' });
        const { result: coverageResult, usageList } = await agent8Coverage(fullScriptText, projectContext, getModelConfigWithSourcePacket(9, sourcePacket));
        const snapshotEntries = recordArtifactMutation(projectData, {
            projectId,
            stage: 9,
            before: projectData.data?.stage8_coverage || null,
            after: coverageResult,
            operation: 'generation',
            note: source === 'stage10' ? 'Coverage from Stage 10 rewrite' : 'Coverage generation'
        });

        projectData.data = projectData.data || {};
        projectData.data.stage8_coverage = coverageResult;
        stampGenerated(projectData, 'stage8_coverage');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(coverageResult, null, 2), 'coverage_generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        res.json({ result: coverageResult, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Stage 8 Coverage Error:', error.message);
        res.status(500).json({ error: "Failed to generate coverage" });
    }
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

// Initialize stage9_rewrites from Stage 8 humanized text
app.post('/api/init-stage9', requireAuth, async (req, res) => {
    try {
        const { projectId, reset } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let content;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            return res.status(404).json({ error: 'Project not found' });
        }
        const projectData = JSON.parse(content);

        // Return existing state if already initialized (unless reset requested)
        if (projectData.data?.stage9_rewrites && !reset) {
            return res.json({
                stage9_rewrites: projectData.data.stage9_rewrites,
                macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
                micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
            });
        }

        // If resetting an existing session, preserve the working copy but restart priority_idx
        if (projectData.data?.stage9_rewrites && reset) {
            const beforeRewrite = JSON.parse(JSON.stringify(projectData.data.stage9_rewrites));
            projectData.data.stage9_rewrites.priority_idx = 0;
            projectData.data.stage9_rewrites.approved = false;
            recordArtifactMutation(projectData, {
                projectId,
                stage: 10,
                before: beforeRewrite,
                after: projectData.data.stage9_rewrites,
                operation: 'reset',
                note: 'Restart rewrite priorities'
            });
            await writeJSONQueued(filePath, projectData);
            return res.json({
                stage9_rewrites: projectData.data.stage9_rewrites,
                macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
                micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
            });
        }

        // Build working copy from all scene humanized/draft texts
        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) {
            if (seq.scenes) allScenes.push(...seq.scenes);
        }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);

        const working = {};
        for (const s of allScenes) {
            working[s.scene_number] = (s.humanized_draft_text || s.draft_text || '').trim();
        }

        const stage9 = { working, priority_idx: 0, approved: false };
        projectData.data = projectData.data || {};
        const snapshotEntries = recordArtifactMutation(projectData, {
            projectId,
            stage: 10,
            before: projectData.data.stage9_rewrites || null,
            after: stage9,
            operation: 'generation',
            note: 'Initialize rewrite working copy'
        });
        projectData.data.stage9_rewrites = stage9;
        await writeJSONQueued(filePath, projectData);

        res.json({
            stage9_rewrites: stage9,
            snapshotIds: snapshotEntries.map(entry => entry.id),
            macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
            micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
        });
    } catch (error) {
        console.error('init-stage9 error:', error.message);
        res.status(500).json({ error: 'Failed to initialize rewrite stage' });
    }
});

// Tool-calling stage assistant.
// Two-leg tool turns: a response of {type:'tool_call', turnState} means the browser
// must execute the revision via its existing executeRevision machinery and POST the
// result back with the same turnState so the model sees the real receipt.
// Stage/global chat surfaces now route here.
app.post('/api/assistant', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, stageId, messages = [], sceneNumber, attachment, isInit = false, turnState = null, toolResults = null } = req.body;
        if (isGlobalStyleAssistantStage(stageId)) {
            const result = await runAssistantTurn({
                stageId: 'style_global',
                contextBlock: turnState ? '' : await buildGlobalStyleAssistantContext(),
                history: messages,
                isInit,
                turnState,
                toolResults,
                modelConfig: getBrainstormModelConfig(7)
            });
            console.log(`Assistant style_global: type=${result.type}${result.toolCalls ? ` tools=${result.toolCalls.map(c => c.name).join(',')}` : ''}`);
            return res.json({
                type: result.type,
                message: result.message,
                ...(result.toolCalls && { toolCalls: result.toolCalls }),
                ...(result.turnState && { turnState: result.turnState })
            });
        }

        if (!isValidProjectId(projectId) || !stageId) return res.status(400).json({ error: 'Missing or invalid projectId or stageId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let content;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            return res.status(404).json({ error: 'Project not found' });
        }
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const modelConfig = getBrainstormModelConfig(stageId);
        let savedSource = null;
        let sourceMemory = null;
        let contextBlock = '';
        let historyForTurn = messages;
        const conversationKey = conversationKeyForAssistantStage(stageId);

        // Context is only needed on the first leg of a turn; resumed tool turns
        // carry their full message list in turnState.
        if (!turnState) {
            let stageName, stageData;
            try {
                ({ stageName, stageData } = await buildStageDataForAssistant(projectData, stageId, sceneNumber));
            } catch {
                return res.status(400).json({ error: `Unknown stageId: ${stageId}` });
            }

            const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
            let attachmentText = '';
            if (attachment) {
                const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId, userMessage: lastUserMessage, projectId });
                attachmentText = persisted.fileText;
                savedSource = persisted.savedSource;
                if (savedSource) await writeJSONQueued(filePath, projectData);
            }

            const knowledgeContext = buildKnowledgeContextBlock(projectData, { stageId, userMessage: lastUserMessage, stageName, stageData });
            sourceMemory = memoryUsageForStage(projectData, stageId, stageData, lastUserMessage);
            let stage10InitContext = '';
            if (isInit && Number(stageId) === 10 && projectData.data?.characterChangeContext) {
                stage10InitContext = `## CHARACTER CHANGE CONTEXT
The writer just updated character profiles in Stage 3 and chose to send the changes directly to the rewrite stage. Specific changes:
${projectData.data.characterChangeContext}`;
                delete projectData.data.characterChangeContext;
                await updateProjectJSON(projectId, (freshProject) => {
                    if (freshProject.data) delete freshProject.data.characterChangeContext;
                    return freshProject;
                });
            }

            const deterministicStage4EventList = !isInit && Number(stageId) === 4
                ? buildStage4CurrentEventListResponse(projectData, lastUserMessage)
                : null;
            if (deterministicStage4EventList) {
                await persistStageConversation(filePath, projectData, conversationKey, messages.filter(m => m.role === 'user').slice(-1), deterministicStage4EventList.message);
                return res.json({
                    type: 'message',
                    message: deterministicStage4EventList.message,
                    ...(savedSource && { savedSource }),
                    ...(sourceMemory && { sourceMemory })
                });
            }

            const memoryRecall = !isInit ? buildMemoryRecallResponse(projectData, {
                stageId,
                stageName,
                userMessage: lastUserMessage,
                stageData
            }) : null;
            if (memoryRecall) {
                await persistStageConversation(filePath, projectData, conversationKey, messages, memoryRecall.message);
                return res.json({
                    type: 'message',
                    message: memoryRecall.message,
                    ...(savedSource && { savedSource }),
                    ...((memoryRecall.sourceMemory || sourceMemory) && { sourceMemory: memoryRecall.sourceMemory || sourceMemory })
                });
            }

            const savedConversations = projectData.data?.conversations || {};
            let priorContext = '';
            const lastPriorStage = Number(stageId) === 10 ? 8 : Number(stageId) - 1;
            for (let s = 1; s <= lastPriorStage; s++) {
                const prior = savedConversations[`stage${s}`];
                if (prior?.length) {
                    priorContext += `\n--- Stage ${s} (${STAGE_NAMES[s]}) Conversations ---\n`;
                    for (const m of prior.slice(-20)) {
                        priorContext += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
                    }
                }
            }

            contextBlock = `## PROJECT: ${title}\n\n## STAGE ${stageId} — ${stageName}\n${stageData}`;
            if (stage10InitContext) contextBlock += `\n\n---\n\n${stage10InitContext}`;
            if (knowledgeContext) contextBlock += `\n\n---\n\n${knowledgeContext}`;
            if (priorContext) contextBlock += `\n\n---\n\n## PREVIOUS STAGE CONVERSATIONS\n${priorContext}`;
            if (attachmentText) contextBlock += `\n\n---\n\n## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}`;

            const contextAdditions = buildToolAssistantContextAdditions({
                projectData,
                stageId,
                lastUserMessage,
                attachmentText,
                isInit
            });
            if (contextAdditions.context) contextBlock += `\n\n---\n\n${contextAdditions.context}`;
            if (contextAdditions.latestOnly) {
                historyForTurn = messages.filter(m => m.role === 'user').slice(-1);
            }

            const stage4ConfirmationBypass = !isInit && Number(stageId) === 4
                ? buildStage4ConfirmationBypassResponse(messages)
                : null;
            if (stage4ConfirmationBypass) {
                const toolCall = {
                    id: `server_stage4_confirmation_${Date.now()}`,
                    name: 'apply_revision',
                    input: { revision_brief: buildStage4ConfirmationRevisionBrief(messages) }
                };
                const neutralMessages = buildNeutralMessages({
                    contextBlock,
                    history: historyForTurn,
                    isInit: false,
                    stageId: Number(stageId)
                });
                neutralMessages.push({
                    role: 'assistant',
                    text: stage4ConfirmationBypass.message,
                    toolCalls: [toolCall]
                });
                return res.json({
                    type: 'tool_call',
                    message: stage4ConfirmationBypass.message,
                    toolCalls: [toolCall],
                    turnState: JSON.stringify(neutralMessages),
                    ...(savedSource && { savedSource }),
                    ...(sourceMemory && { sourceMemory })
                });
            }
        }

        const result = await runAssistantTurn({
            stageId: Number(stageId),
            contextBlock,
            history: historyForTurn,
            isInit,
            turnState,
            toolResults,
            modelConfig
        });
        console.log(`Assistant stage${stageId}: type=${result.type}${result.toolCalls ? ` tools=${result.toolCalls.map(c => c.name).join(',')}` : ''}`);
        trackUsage(projectId, result.usageList);

        // Persist conversation only when the turn produced a final message.
        // Tool-turn acknowledgment text lives in turnState and reaches the writer's
        // screen, but only the closing message is added to saved history.
        if (!isInit && result.type === 'message') {
            try {
                await persistStageConversation(filePath, projectData, conversationKey, historyForTurn, result.message);
            } catch (saveErr) {
                console.error('Failed to persist assistant conversation:', saveErr.message);
            }
        }

        res.json({
            type: result.type,
            message: result.message,
            ...(result.toolCalls && { toolCalls: result.toolCalls }),
            ...(result.turnState && { turnState: result.turnState }),
            ...(savedSource && { savedSource }),
            ...(sourceMemory && { sourceMemory })
        });
    } catch (error) {
        console.error('assistant error:', error);
        const detail = publicErrorDetail(error);
        res.status(500).json({ error: detail ? `Assistant request failed: ${detail}` : 'Assistant request failed' });
    }
});

app.post('/api/plan-rewrite', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, priorityTask, userFeedback, conversationContext } = req.body;
        if (!isValidProjectId(projectId) || !priorityTask) return res.status(400).json({ error: 'Missing or invalid projectId or priorityTask' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const working = projectData.data?.stage9_rewrites?.working || {};
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);

        const sceneList = buildStage10PlannerSceneList(allScenes, working);

        const plannerSop = loadSkill('skill_stage10_planner');
        const feedbackSection = userFeedback ? `\n\n## WRITER NOTES ON SCOPE\n${userFeedback}` : '';
        // Trim conversation context to last ~4000 chars to keep prompt manageable
        const trimmedContext = conversationContext && conversationContext.length > 4000
            ? '...\n' + conversationContext.slice(-4000)
            : conversationContext;
        const contextSection = trimmedContext ? `\n\n## BRAINSTORM CONTEXT\n${trimmedContext}` : '';
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charBlock = characters.length > 0
            ? `\n\n## CHARACTERS\n${characters.map(c => {
                const tier = c.profile_tier || 'Tier 1';
                const tierText = String(tier).toLowerCase();
                if (/\b3\b|cameo|utility/.test(tierText)) {
                    return `${c.name} (${c.role}, ${tier}): scene purpose=${c.cameo_profile?.scene_purpose || c.brief_summary || 'unknown'}`;
                }
                if (/\b2\b|functional/.test(tierText)) {
                    return `${c.name} (${c.role}, ${tier}): narrative function=${c.functional_profile?.narrative_function || c.brief_summary || 'unknown'}, emotional truth=${c.functional_profile?.emotional_truth || 'unknown'}, comic/tension=${c.functional_profile?.comic_or_tension_function || 'unknown'}, pressure behavior=${c.functional_profile?.pressure_behavior || 'unknown'}, voice flavor=${c.functional_profile?.voice_flavor || 'unknown'}`;
                }
                return `${c.name} (${c.role}, ${tier}): arc=${c.arc?.direction || 'unknown'}, drive=${c.arc?.core_drive || 'unknown'}`;
            }).join('\n')}`
            : '';
        const { styleContent: plannerStyleContent, referenceContent: plannerRefContent } = await loadProjectStyle(projectData);
        let styleNote = '';
        if (plannerStyleContent && plannerRefContent) {
            styleNote = `\n\n## STYLE CONTEXT\nThis project has a trained style (Tier 3) derived from screenplay analysis. The rewrite agent will automatically perform style-compliance checking using the full reference. Do not add style tasks to the plan unless the rewrite task explicitly raises style drift as an issue.`;
        } else if (plannerStyleContent) {
            styleNote = `\n\n## STYLE CONTEXT\nThis project has a writing style set. The rewrite agent will maintain this style during execution. Do not treat the style itself as a problem to fix — it is an intentional choice. Only flag style-related issues if the rewrite task explicitly raises them.`;
        }
        const sourcePlanSeed = `${priorityTask}\n${userFeedback || ''}\n${sceneList}\n${trimmedContext || ''}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });
        const prompt = buildStage10RewritePlanPrompt({
            sourceContext: sourcePacket.contextBlock,
            title,
            charBlock,
            styleNote,
            priorityTask,
            feedbackSection,
            contextSection,
            sceneList
        });

        const plannerSchema = {
            type: 'object',
            properties: {
                rationale:       { type: 'string' },
                affected_scenes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            scene_number:   { type: 'integer' },
                            slugline:       { type: 'string' },
                            reason:         { type: 'string' },
                            planned_change: { type: 'string' },
                        },
                        required: ['scene_number', 'slugline', 'reason', 'planned_change'],
                    },
                },
            },
            required: ['rationale', 'affected_scenes'],
        };

        const { generateContent } = require('./agents/ai-client');
        const modelCfg = getModelConfig(10);
        console.log(`plan-rewrite: model=${modelCfg.model}, prompt=${prompt.length} chars, context=${(trimmedContext||'').length} chars`);

        const t0 = Date.now();
        const response = await generateContent({
            model: modelCfg.model,
            geminiApiKey: modelCfg.geminiApiKey,
            anthropicApiKey: modelCfg.anthropicApiKey,
            contents: prompt,
            config: {
                systemInstruction: buildStage10RewritePlannerSystemInstruction(plannerSop),
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseSchema: plannerSchema,
            },
        });
        console.log(`plan-rewrite succeeded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

        const plan = JSON.parse(response.text);
        console.log(`Stage 10 plan: ${plan.affected_scenes.length} scenes affected.`);
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(plan, null, 2), 'rewrite_plan');
        await writeJSONQueued(filePath, projectData);
        if (response.usage) trackUsage(projectId, response.usage);
        res.json({ ...plan, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('plan-rewrite error:', error.message);
        res.status(500).json({ error: 'Failed to generate rewrite plan' });
    }
});

// Run the rewrite agent only on planned (affected) scenes
app.post('/api/rewrite-for-priority', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, priorityTask, affectedSceneNumbers } = req.body;
        if (!isValidProjectId(projectId) || !priorityTask) return res.status(400).json({ error: 'Missing or invalid projectId or priorityTask' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const working = projectData.data?.stage9_rewrites?.working || {};
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) {
            if (seq.scenes) allScenes.push(...seq.scenes);
        }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);

        // Filter to only affected scenes if planner provided a list
        const scopedScenes = affectedSceneNumbers?.length
            ? allScenes.filter(s => affectedSceneNumbers.includes(s.scene_number))
            : allScenes;

        const { styleContent, referenceContent } = await loadProjectStyle(projectData);
        console.log(`Stage 10: rewriting ${scopedScenes.length} scene(s) for task: "${priorityTask.slice(0, 60)}..."${referenceContent ? ' [with style compliance]' : ''}`);
        const sourcePlanSeed = `${priorityTask}\n${scopedScenes.map(s => {
            const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
            return `Scene ${s.scene_number}: ${s.scene_heading || s.slugline || ''}\n${s.narrative_action || ''}\n${compactText(sceneText, 1_200)}`;
        }).join('\n\n')}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });

        const results = await Promise.allSettled(
            scopedScenes.map(s => {
                const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                const scenePacket = buildSourceGenerationPacket(projectData, 10, `${priorityTask}\n${sceneText}\n${s.narrative_action || ''}`, { userMessage: priorityTask });
                const rewriteModelConfig = getModelConfigWithSourcePacket(10, scenePacket);
                const blueprint = buildStage10RewriteLockPacket(projectData, s.scene_number, s, sceneText, priorityTask);
                return rewriteScene(sceneText, priorityTask, {
                    title,
                    sceneNumber: s.scene_number,
                    slugline: s.slugline || s.scene_heading || '',
                    blueprint
                }, '', rewriteModelConfig, styleContent, referenceContent).then(({ result: proposed, usage }) => ({ scene_number: s.scene_number, original_text: sceneText, proposed_text: proposed, usage }));
            })
        );

        const scenes = results.map((r, i) => {
            if (r.status === 'fulfilled') {
                const { scene_number, original_text, proposed_text } = r.value;
                return { scene_number, original_text, proposed_text, modified: proposed_text.trim() !== original_text.trim() };
            }
            const s = scopedScenes[i];
            const fallback = working[s.scene_number] || '';
            return { scene_number: s.scene_number, original_text: fallback, proposed_text: fallback, modified: false };
        });

        const usages = results.filter(r => r.status === 'fulfilled' && r.value.usage).map(r => r.value.usage);
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(scenes, null, 2), 'rewrite_generation');
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usages);

        res.json({ scenes, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('rewrite-for-priority error:', error.message);
        res.status(500).json({ error: 'Failed to rewrite scenes for priority' });
    }
});

// Rewrite a single scene for a planned priority task
app.post('/api/rewrite-single-scene', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, sceneNumber, priorityTask, plannedChange } = req.body;
        const sceneNum = parseInt(sceneNumber, 10);
        if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || !priorityTask) {
            return res.status(400).json({ error: 'Missing or invalid projectId, sceneNumber, or priorityTask' });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const working = projectData.data?.stage9_rewrites?.working || {};
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        // Find scene metadata from stage 6
        const stage6Scenes = projectData.data?.stage6_scenes || [];
        let sceneMeta = null;
        for (const seq of stage6Scenes) {
            if (seq.scenes) {
                sceneMeta = seq.scenes.find(s => s.scene_number === sceneNum);
                if (sceneMeta) break;
            }
        }

        const sceneText = working[sceneNum] || sceneMeta?.humanized_draft_text || sceneMeta?.draft_text || '';
        const slugline = sceneMeta?.slugline || sceneMeta?.scene_heading || '';

        // Short-circuit: if the plan says to delete/remove/omit this scene, skip the LLM
        const deletionPattern = /\b(delete|remove|omit|cut|eliminate)\b.*\b(scene|entirely|completely)\b/i;
        if (plannedChange && deletionPattern.test(plannedChange)) {
            console.log(`Stage 10: deleting scene ${sceneNum} (per plan)`);
            const deletionPacket = buildSourceGenerationPacket(projectData, 10, `${priorityTask}\n${plannedChange || ''}\n${sceneText}`, { userMessage: priorityTask });
            let snapshotEntries = [];
            await updateProjectJSON(projectId, (freshProject) => {
                snapshotEntries = persistStage10PendingRewrite(freshProject, {
                    projectId,
                    sceneNum,
                    proposedText: '',
                    note: `Pending delete for scene ${sceneNum}`,
                    sourcePacket: deletionPacket,
                    sourceText: '',
                    sourceReason: 'single_scene_delete'
                });
                return freshProject;
            });
            return res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: '', modified: true, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(deletionPacket) });
        }

        const { styleContent, referenceContent } = await loadProjectStyle(projectData);
        console.log(`Stage 10: rewriting scene ${sceneNumber} for task: "${priorityTask.slice(0, 60)}..."${referenceContent ? ' [with style compliance]' : ''}`);

        // Build character context for this scene
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charProfiles = characters.length > 0
            ? characters.map(c => {
                const dp = c._deep_profile || {};
                const tier = c.profile_tier || 'Tier 1';
                const tierText = String(tier).toLowerCase();
                if (/\b3\b|cameo|utility/.test(tierText)) {
                    return `${c.name} (${c.role}, ${tier}): scene purpose=${c.cameo_profile?.scene_purpose || c.brief_summary || 'unknown'}, playable behavior=${c.cameo_profile?.playable_behavior || 'unknown'}${c.cameo_profile?.line_style_example ? `\nLine style example: ${c.cameo_profile.line_style_example}` : ''}`;
                }
                if (/\b2\b|functional/.test(tierText)) {
                    return `${c.name} (${c.role}, ${tier}): narrative function=${c.functional_profile?.narrative_function || c.brief_summary || 'unknown'}, emotional truth=${c.functional_profile?.emotional_truth || 'unknown'}, comic/tension=${c.functional_profile?.comic_or_tension_function || 'unknown'}, pressure behavior=${c.functional_profile?.pressure_behavior || 'unknown'}, voice flavor=${c.functional_profile?.voice_flavor || 'unknown'}`;
                }
                return `${c.name} (${c.role}, ${tier}): voice=${c.voice_and_behavior?.voice_tag || 'unknown'}, pressure=${c.voice_and_behavior?.pressure_tag || 'unknown'}${dp.dialogue_fingerprint ? `\nDialogue rules: ${dp.dialogue_fingerprint}` : ''}`;
            }).join('\n\n')
            : '';

        const sourcePlanSeed = `${priorityTask}\n${plannedChange || ''}\n${sceneText}\n${sceneMeta?.narrative_action || ''}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: priorityTask });
        const blueprint = buildStage10RewriteLockPacket(projectData, sceneNum, sceneMeta, sceneText, plannedChange || priorityTask);
        const { result: proposed, usage } = await rewriteScene(
            sceneText, priorityTask,
            { title, sceneNumber: sceneNum, slugline, characters: charProfiles, blueprint },
            plannedChange || '',
            getModelConfigWithSourcePacket(10, sourcePacket),
            styleContent,
            referenceContent
        );

        const modified = proposed.trim() !== sceneText.trim();
        let snapshotEntries = [];

        if (modified) {
            await updateProjectJSON(projectId, (freshProject) => {
                snapshotEntries = persistStage10PendingRewrite(freshProject, {
                    projectId,
                    sceneNum,
                    proposedText: proposed,
                    note: `Pending rewrite for scene ${sceneNum}`,
                    sourcePacket,
                    sourceText: proposed,
                    sourceReason: 'single_scene_rewrite'
                });
                return freshProject;
            });
        } else {
            await updateProjectJSON(projectId, (freshProject) => {
                recordSourceGenerationUsage(freshProject, sourcePacket, proposed, 'single_scene_rewrite');
                return freshProject;
            });
        }

        trackUsage(projectId, usage);
        res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: proposed, modified, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('rewrite-single-scene error:', error.message);
        res.status(500).json({ error: 'Failed to rewrite scene' });
    }
});

app.post('/api/save-stage10-pending', requireAuth, async (req, res) => {
    try {
        const { projectId, sceneNumber, proposedText } = req.body;
        const sceneNum = parseInt(sceneNumber, 10);
        if (!isValidProjectId(projectId) || isNaN(sceneNum) || sceneNum < 1 || typeof proposedText !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid projectId, sceneNumber, or proposedText' });
        }

        let snapshotEntries = [];
        const updatedProject = await updateProjectJSON(projectId, (freshProject) => {
            const stage9 = ensureStage10RewriteState(freshProject);
            if (stage9.pending?.[sceneNum] === proposedText) return freshProject;
            snapshotEntries = persistStage10PendingRewrite(freshProject, {
                projectId,
                sceneNum,
                proposedText,
                note: `Manual pending rewrite edit for scene ${sceneNum}`,
                sourcePacket: null
            });
            return freshProject;
        });

        res.json({ success: true, stage9_rewrites: updatedProject.data.stage9_rewrites, snapshotIds: snapshotEntries.map(entry => entry.id) });
    } catch (error) {
        console.error('save-stage10-pending error:', error.message);
        res.status(500).json({ error: 'Failed to save pending rewrite' });
    }
});

// Save approved pending changes and advance priority index
app.post('/api/approve-rewrite-priority', requireAuth, async (req, res) => {
    try {
        const { projectId, pendingScenes, newPriorityIdx } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

        let snapshotEntries = [];
        const updatedProject = await updateProjectJSON(projectId, (projectData) => {
            const stage9 = ensureStage10RewriteState(projectData);
            const beforeRewrite = JSON.parse(JSON.stringify(stage9));
            if (pendingScenes && typeof pendingScenes === 'object') {
                for (const [sceneNum, text] of Object.entries(pendingScenes)) {
                    if (typeof text === 'string') stage9.working[sceneNum] = text;
                }
            }
            stage9.pending = {};  // Clear pending — now merged into working
            if (newPriorityIdx !== undefined) stage9.priority_idx = newPriorityIdx;
            snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 10,
                before: beforeRewrite,
                after: stage9,
                operation: 'revision',
                note: 'Approve rewrite priority'
            });
            projectData.data.stage9_rewrites = stage9;
            return projectData;
        });

        res.json({ stage9_rewrites: updatedProject.data.stage9_rewrites, snapshotIds: snapshotEntries.map(entry => entry.id) });
    } catch (error) {
        console.error('approve-rewrite-priority error:', error.message);
        res.status(500).json({ error: 'Failed to approve rewrite priority' });
    }
});

// Rewrite a single scene using the priority task + user feedback
app.post('/api/rewrite-scene-feedback', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, sceneNumber, priorityTask, userFeedback, currentText, attachment } = req.body;
        if (!isValidProjectId(projectId) || !priorityTask || !currentText) return res.status(400).json({ error: 'Missing required fields' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        let savedSource = null;
        let attachmentText = '';
        if (attachment) {
            const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId: 10, userMessage: userFeedback || priorityTask, projectId });
            attachmentText = persisted.fileText;
            savedSource = persisted.savedSource;
            if (savedSource) await writeJSONQueued(filePath, projectData);
        }

        const feedbackParts = [];
        if (attachmentText) feedbackParts.push(`## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}`);
        if (userFeedback) feedbackParts.push(userFeedback);
        const enrichedFeedback = feedbackParts.join('\n\n---\n\n') || userFeedback;
        const sourcePlanSeed = `${priorityTask}\n${enrichedFeedback || ''}\n${currentText}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 10, sourcePlanSeed, { userMessage: enrichedFeedback || priorityTask });
        const sceneNum = Number(sceneNumber);
        const sceneMeta = Number.isFinite(sceneNum) ? findProjectScene(projectData, sceneNum) : null;
        const blueprint = sceneMeta ? buildStage10RewriteLockPacket(projectData, sceneNum, sceneMeta, currentText, enrichedFeedback || priorityTask) : '';

        const { result: proposed_text, usage } = await rewriteScene(
            currentText,
            priorityTask,
            { title, sceneNumber, blueprint },
            enrichedFeedback,
            getModelConfigWithSourcePacket(10, sourcePacket),
        );
        let snapshotEntries = [];
        await updateProjectJSON(projectId, (freshProject) => {
            if (Number.isFinite(sceneNum) && sceneNum > 0) {
                snapshotEntries = persistStage10PendingRewrite(freshProject, {
                    projectId,
                    sceneNum,
                    proposedText: proposed_text,
                    note: `Pending feedback rewrite for scene ${sceneNum}`,
                    sourcePacket,
                    sourceText: proposed_text,
                    sourceReason: 'rewrite_feedback'
                });
            } else {
                recordSourceGenerationUsage(freshProject, sourcePacket, proposed_text, 'rewrite_feedback');
            }
            return freshProject;
        });
        trackUsage(projectId, usage);
        res.json({ proposed_text, snapshotIds: snapshotEntries.map(entry => entry.id), ...(savedSource && { savedSource }), ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('rewrite-scene-feedback error:', error.message);
        res.status(500).json({ error: 'Failed to rewrite scene with feedback' });
    }
});

// Mark Stage 10 as approved/finalized
app.post('/api/finalize-stage10', requireAuth, async (req, res) => {
    try {
        const { projectId } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

        await updateProjectJSON(projectId, (projectData) => {
            if (projectData.data?.stage9_rewrites) {
                const beforeRewrite = JSON.parse(JSON.stringify(projectData.data.stage9_rewrites));
                projectData.data.stage9_rewrites.approved = true;
                recordArtifactMutation(projectData, {
                    projectId,
                    stage: 10,
                    before: beforeRewrite,
                    after: projectData.data.stage9_rewrites,
                    operation: 'approval',
                    note: 'Finalize Stage 10'
                });
            }
            return projectData;
        });
        res.json({ success: true });
    } catch (error) {
        console.error('finalize-stage10 error:', error.message);
        res.status(500).json({ error: 'Failed to finalize stage 10' });
    }
});

// --- Stage 7: Style Routes --- //

// Generate a style skill file from chat/form input
app.post('/api/generate-stage7-style', requireAuth, aiLimiter, upload.array('sampleFiles', 5), async (req, res) => {
    try {
        const { projectId, description, conversationHistory: convRaw } = req.body;
        const conversationHistory = convRaw ? (safeParse(convRaw, []) || []) : [];

        // Load project context if projectId provided (optional for Landing Page creation)
        let projectData = null, filePath = null;
        if (projectId) {
            assertValidProjectId(projectId, 'Invalid projectId');
            filePath = getProjectFilePath(projectId);
            projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
        }

        // Build scene summaries for context
        let sceneSummaries = '';
        if (projectData) {
            const s6 = projectData.data?.stage6_scenes || [];
            if (s6.length > 0) {
                const lines = [];
                for (const seq of s6) {
                    if (seq.scenes) for (const sc of seq.scenes) {
                        lines.push(`Scene ${sc.scene_number}: ${sc.scene_heading || sc.slugline || ''} — ${sc.narrative_action || ''}`);
                    }
                }
                sceneSummaries = lines.join('\n');
            }
        }

        console.log(`Generating Stage 7 Style${projectId ? ` for project ${projectId}` : ' (standalone)'}...`);
        const styleKnowledgeSeed = `${description || ''}\n${sceneSummaries}\n${conversationHistory.map(m => m.content).join('\n')}`;
        const sourcePacket = projectData
            ? buildSourceGenerationPacket(projectData, 7, styleKnowledgeSeed, { userMessage: description || '' })
            : null;
        const styleModelConfig = projectData
            ? getModelConfigWithSourcePacket(7, sourcePacket)
            : getModelConfig(7);
        const { result: styleContent, usage } = await generateStyleFile({
            description: description || '',
            sceneSummaries,
            conversationHistory
        }, styleModelConfig);

        // Parse the generated style to extract metadata
        const { meta } = parseStyleFile(styleContent);
        const slug = await uniqueStyleSlug(meta.slug || meta.name || 'custom-style');

        // Save as directive file (new naming convention)
        await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), styleContent);

        let snapshotEntries = [];
        // Update project if within project context
        if (projectData && filePath) {
            snapshotEntries = recordArtifactMutation(projectData, {
                projectId,
                stage: 7,
                before: projectData.data?.stage7_style || null,
                after: slug,
                operation: 'generation',
                note: description || ''
            });
            projectData.data = projectData.data || {};
            projectData.data.stage7_style = slug;
            stampGenerated(projectData, 'stage7_style');
            recordSourceGenerationUsage(projectData, sourcePacket, styleContent, 'generation');
            await writeJSONQueued(filePath, projectData);
            if (projectId) trackUsage(projectId, usage);
        }

        res.json({ slug, content: styleContent, meta, snapshotIds: snapshotEntries.map(entry => entry.id), ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('generate-stage7-style error:', error.message);
        sendApiError(res, error, 'Failed to generate style');
    }
});

// Preview a scene drafted in a specific style
app.post('/api/preview-style-scene', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, styleSlug, sceneIndex = 0 } = req.body;
        if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) throw new BadRequestError('Missing or invalid projectId or styleSlug');

        const filePath = getProjectFilePath(projectId);
        const projectData = await readProjectJSONById(projectId);

        // Load style file — try new naming first, fall back to legacy
        let styleContent;
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
        } catch {
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
            } catch {
                throw new NotFoundError(`Style "${styleSlug}" not found`);
            }
        }

        // Get the target scene
        const allScenes = [];
        for (const seq of (projectData.data?.stage6_scenes || [])) {
            if (seq.scenes) allScenes.push(...seq.scenes);
        }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);
        const scene = allScenes[sceneIndex] || allScenes[0];
        if (!scene) throw new BadRequestError('No scenes found in project');

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const projectContext = {
            synopsis: pitch?.synopsis || '',
            characters: projectData.data?.stage3_characters?.characters || []
        };
        const previewPacket = buildSourceGenerationPacket(projectData, 7, `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(scene, null, 2)}`, { userMessage: 'Preview this scene in the selected style.' });

        // Use the Draft agent with style directives injected
        const draftSop = loadSkill('skill_stage8_draft');
        const prompt = `${draftSop}

${previewPacket.contextBlock ? `## PROJECT SOURCE CANON\n${previewPacket.contextBlock}\n` : ''}

## STYLE DIRECTIVES
Apply the following style to this scene:
${styleContent}

## PROJECT CONTEXT
SYNOPSIS: ${projectContext.synopsis || 'Not provided'}
CHARACTER PROFILES: ${JSON.stringify(projectContext.characters, null, 2)}

## SCENE BLUEPRINT
SCENE NUMBER: ${scene.scene_number}
SLUGLINE: ${scene.scene_heading || scene.slugline || ''}
NARRATIVE ACTION: ${scene.narrative_action || ''}
DRAMATURGICAL FUNCTION: ${scene.dramaturgical_function || ''}

## INSTRUCTIONS
Write a preview draft of this scene using the style directives above.
Output ONLY the raw Fountain-formatted text. No code blocks, no introductory text.`;

        const { generateContent } = require('./agents/ai-client');
        const mc = getModelConfig(7);
        const response = await generateContent({
            model: mc.model, geminiApiKey: mc.geminiApiKey, anthropicApiKey: mc.anthropicApiKey,
            contents: prompt,
            config: { temperature: 0.7 }
        });

        recordSourceGenerationUsage(projectData, previewPacket, response.text, 'style_preview');
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, response.usage);
        res.json({ sceneNumber: scene.scene_number, previewText: response.text, ...sourceResponseExtras(previewPacket) });
    } catch (error) {
        console.error('preview-style-scene error:', error.message);
        sendApiError(res, error, 'Failed to preview style scene');
    }
});

// List all available styles
app.get('/api/styles', requireAuth, async (req, res) => {
    try {
        let files;
        try { files = await fs.readdir(STYLES_DIR); } catch { files = []; }

        // Group files by slug: [slug]-directive.md, [slug]-reference.md, or legacy [slug].md
        const styleMap = new Map(); // slug -> { directiveFile, referenceFile }
        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const tieredMatch = file.match(/^(.+?)-(directive|reference)\.md$/);
            if (tieredMatch) {
                const [, slug, type] = tieredMatch;
                if (!styleMap.has(slug)) styleMap.set(slug, {});
                styleMap.get(slug)[type === 'directive' ? 'directiveFile' : 'referenceFile'] = file;
            } else {
                // Legacy single-file style
                const slug = file.replace(/\.md$/, '');
                if (!styleMap.has(slug)) styleMap.set(slug, {});
                styleMap.get(slug).directiveFile = file;
            }
        }

        const styles = [];
        for (const [slug, entry] of styleMap) {
            // Read the directive (primary metadata source)
            const metaFile = entry.directiveFile || entry.referenceFile;
            if (!metaFile) continue;
            try {
                const raw = await fs.readFile(path.join(STYLES_DIR, metaFile), 'utf-8');
                const { meta } = parseStyleFile(raw);
                styles.push({
                    slug,
                    name: meta.name || slug,
                    tonal_summary: meta.tonal_summary || '',
                    references: meta.references || [],
                    created: meta.created || '',
                    tier: meta.tier || 'conversational',
                    hasReference: !!entry.referenceFile
                });
            } catch {
                styles.push({ slug, name: slug, tonal_summary: '', references: [], created: '', tier: 'conversational', hasReference: false });
            }
        }
        res.json({ styles });
    } catch (error) {
        console.error('list styles error:', error.message);
        sendApiError(res, error, 'Failed to list styles');
    }
});

// Select an existing style for a project
app.post('/api/select-style', requireAuth, async (req, res) => {
    try {
        const { projectId, styleSlug } = req.body;
        if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) throw new BadRequestError('Missing or invalid projectId or styleSlug');

        // Verify style exists — try new naming first, fall back to legacy
        let styleContent = null;
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
        } catch {
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
            } catch {
                throw new NotFoundError(`Style "${styleSlug}" not found`);
            }
        }

        const filePath = getProjectFilePath(projectId);
        const projectData = await readProjectJSONById(projectId);

        projectData.data = projectData.data || {};
        projectData.data.stage7_style = styleSlug;
        stampGenerated(projectData, 'stage7_style');
        await writeJSONQueued(filePath, projectData);

        const { meta } = parseStyleFile(styleContent);
        res.json({ slug: styleSlug, content: styleContent, meta });
    } catch (error) {
        console.error('select-style error:', error.message);
        sendApiError(res, error, 'Failed to select style');
    }
});

// Generate a Tier 3 trained style from uploaded screenplay(s)
app.post('/api/generate-trained-style', requireAuth, strictLimiter, upload.array('screenplayFiles', 5), async (req, res) => {
    try {
        const { projectId, styleName, conversationHistory: convRaw } = req.body;
        const conversationHistory = convRaw ? (safeParse(convRaw, []) || []) : [];

        // Extract text from uploaded screenplay files
        const screenplayTexts = [];
        const screenplayTitles = [];
        if (req.files?.length) {
            for (const file of req.files) {
                const title = file.originalname.replace(/\.[^.]+$/, '');
                screenplayTitles.push(title);
                const attachment = uploadFileToAttachment(file);
                const extractedText = normalizeSourceText(await extractAttachmentText(attachment));
                if (extractedText) screenplayTexts.push(extractedText);
            }
        }

        if (screenplayTexts.length === 0) throw new BadRequestError('At least one screenplay file is required for trained style generation');

        let projectData = null;
        let filePath = null;
        let sourcePacket = null;
        if (projectId) {
            assertValidProjectId(projectId, 'Invalid projectId');
            filePath = getProjectFilePath(projectId);
            projectData = await readProjectJSONById(projectId, { invalidMessage: 'Invalid projectId' });
            const styleKnowledgeSeed = `${styleName || ''}\n${screenplayTitles.join('\n')}\n${conversationHistory.map(m => m.content).join('\n')}`;
            sourcePacket = buildSourceGenerationPacket(projectData, 7, styleKnowledgeSeed, { userMessage: styleName || 'Generate trained style.' });
        }

        console.log(`Generating Tier 3 trained style from ${screenplayTexts.length} screenplay(s)...`);
        const { reference, directive, usageList } = await generateTrainedStyle({
            styleName: styleName || '',
            screenplayTexts,
            screenplayTitles,
            conversationHistory
        }, sourcePacket ? getModelConfigWithSourcePacket(7, sourcePacket) : getModelConfig(7));

        // Extract slug from reference metadata
        const { meta: refMeta } = parseStyleFile(reference);
        const slug = await uniqueStyleSlug(refMeta.slug || refMeta.name || styleName || 'trained-style');

        // Save both files atomically
        await atomicWriteFile(path.join(STYLES_DIR, `${slug}-reference.md`), reference);
        await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), directive);

        // Update project if within project context
        if (projectData && filePath) {
            projectData.data = projectData.data || {};
            projectData.data.stage7_style = slug;
            stampGenerated(projectData, 'stage7_style');
            recordSourceGenerationUsage(projectData, sourcePacket, directive, 'trained_style_generation');
            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, usageList);
        }

        const { meta } = parseStyleFile(directive);
        res.json({ slug, content: directive, directive, reference, meta, tier: 'trained', ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('generate-trained-style error:', error.message);
        sendApiError(res, error, 'Failed to generate trained style');
    }
});

// Get full style content (directive + reference if exists)
app.get('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
        let directive = null, reference = null;

        // Try new naming first, fall back to legacy
        try {
            directive = await fs.readFile(path.join(STYLES_DIR, `${slug}-directive.md`), 'utf-8');
        } catch {
            try {
                directive = await fs.readFile(path.join(STYLES_DIR, `${slug}.md`), 'utf-8');
            } catch {
                throw new NotFoundError(`Style "${slug}" not found`);
            }
        }

        // Load reference if it exists (Tier 3 only)
        try {
            reference = await fs.readFile(path.join(STYLES_DIR, `${slug}-reference.md`), 'utf-8');
        } catch { /* no reference = Tier 2 */ }

        const { meta, body } = parseStyleFile(directive);
        const tier = reference ? 'trained' : (meta.tier || 'conversational');

        res.json({ slug, directive, reference, meta, body, tier });
    } catch (error) {
        console.error('get-style error:', error.message);
        sendApiError(res, error, 'Failed to load style');
    }
});

// Update a style's directive content
app.put('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        const { content } = req.body;
        if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
        if (!content) throw new BadRequestError('Missing content');

        // Verify the file exists first
        let filePath;
        try {
            filePath = path.join(STYLES_DIR, `${slug}-directive.md`);
            await fs.access(filePath);
        } catch {
            try {
                filePath = path.join(STYLES_DIR, `${slug}.md`);
                await fs.access(filePath);
            } catch {
                throw new NotFoundError(`Style "${slug}" not found`);
            }
        }

        await atomicWriteFile(filePath, content);
        const { meta } = parseStyleFile(content);
        res.json({ slug, meta });
    } catch (error) {
        console.error('update-style error:', error.message);
        sendApiError(res, error, 'Failed to update style');
    }
});

// Delete a style (removes both directive and reference files)
app.delete('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!isValidSlug(slug)) throw new BadRequestError('Invalid slug');
        let deleted = false;

        // Delete all possible files for this slug
        for (const suffix of ['-directive.md', '-reference.md', '.md']) {
            try {
                await fs.unlink(path.join(STYLES_DIR, `${slug}${suffix}`));
                deleted = true;
            } catch { /* file doesn't exist, that's fine */ }
        }

        if (!deleted) throw new NotFoundError('Style not found');
        res.json({ deleted: true, slug });
    } catch (error) {
        console.error('delete-style error:', error.message);
        sendApiError(res, error, 'Failed to delete style');
    }
});

// --- Settings Routes --- //

app.get('/api/settings', requireAuth, (req, res) => {
        res.json({
            geminiApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.geminiApiKey ? '***' : '',
            anthropicApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.anthropicApiKey ? '***' : '',
            stageModels: appSettings.stageModels || {},
            runtimeApiKeysEnabled: RUNTIME_API_KEYS_ENABLED,
            apiKeysManagedByServer: !RUNTIME_API_KEYS_ENABLED,
            build: getBuildInfo()
        });
});

app.post('/api/settings', requireAuth, async (req, res) => {
    try {
        const { geminiApiKey, anthropicApiKey, stageModels } = req.body;
        // Only update keys that were actually changed (don't overwrite with masked placeholder)
        if (RUNTIME_API_KEYS_ENABLED && geminiApiKey && geminiApiKey !== '***') appSettings.geminiApiKey = geminiApiKey;
        if (RUNTIME_API_KEYS_ENABLED && anthropicApiKey && anthropicApiKey !== '***') appSettings.anthropicApiKey = anthropicApiKey;
        if (stageModels) appSettings.stageModels = stageModels;

        await fs.mkdir(DATA_ROOT, { recursive: true });
        await atomicWriteJSON(SETTINGS_PATH, appSettings);
        res.json({ ok: true });
    } catch (err) {
        console.error('Failed to save settings:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// --- Project Management Routes --- //

app.get('/api/maintenance/legacy-projects/audit', requireAuth, async (_req, res) => {
    try {
        res.json(await auditOrUpgradeAllProjectKnowledge({ write: false }));
    } catch (error) {
        console.error('legacy project audit error:', error.message);
        res.status(500).json({ error: 'Failed to audit legacy projects' });
    }
});

app.post('/api/maintenance/legacy-projects/upgrade', requireAuth, async (_req, res) => {
    try {
        res.json(await auditOrUpgradeAllProjectKnowledge({ write: true }));
    } catch (error) {
        console.error('legacy project upgrade error:', error.message);
        res.status(500).json({ error: 'Failed to upgrade legacy projects' });
    }
});

// GET all projects
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const files = await fs.readdir(DATA_DIR);
        const projects = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(DATA_DIR, file);
                const content = await fs.readFile(filePath, 'utf-8');
                const projectData = JSON.parse(content);
                projects.push({ id: projectData.id, title: projectData.title });
            }
        }

        // Sort newest first based on ID (which is a timestamp)
        projects.sort((a, b) => b.id - a.id);
        res.json({ projects });
    } catch (error) {
        console.error("Error reading projects:", error);
        sendApiError(res, error, 'Failed to load projects');
    }
});

// GET single project
app.get('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        res.json(await readProjectJSONById(id));
    } catch (error) {
        console.error("Error reading project:", error);
        sendApiError(res, error, 'Failed to load project details');
    }
});

// POST new project
app.post('/api/projects', requireAuth, async (req, res) => {
    try {
        const id = Date.now().toString();
        const newProject = {
            id,
            title: "New Project",
            data: {}
        };

        const filePath = path.join(DATA_DIR, `${id}.json`);
        await writeJSONQueued(filePath, newProject);

        res.status(201).json(newProject);
    } catch (error) {
        console.error("Error creating project:", error);
        sendApiError(res, error, 'Failed to create project');
    }
});

// POST import script → create project with Stage 6/7 pre-populated
app.post('/api/import-script', requireAuth, upload.single('scriptFile'), async (req, res) => {
    try {
        const { parseFountain, parseFdx, parsePdfScript, buildStage6FromScenes } = require('./utils/script-import');
        const file = req.file;
        if (!file) throw new BadRequestError('No file uploaded');

        const ext = (file.originalname || '').split('.').pop().toLowerCase();
        const userTitle = req.body.title?.trim() || '';

        let parsed;
        if (ext === 'fountain') {
            const text = file.buffer.toString('utf-8');
            parsed = parseFountain(text);
        } else if (ext === 'fdx') {
            const xml = file.buffer.toString('utf-8');
            parsed = parseFdx(xml);
        } else if (ext === 'pdf') {
            parsed = await parsePdfScript(file.buffer, getModelConfig(1));
        } else {
            throw new BadRequestError(`Unsupported file type: .${ext}. Use .fountain, .fdx, or .pdf`);
        }

        if (!parsed.scenes || parsed.scenes.length === 0) {
            throw new BadRequestError('No scenes found in the uploaded file');
        }

        const title = userTitle || parsed.title || 'Imported Script';
        const stage6Scenes = buildStage6FromScenes(parsed.scenes);

        const id = Date.now().toString();
        const newProject = {
            id,
            title,
            data: {
                stage6_scenes: stage6Scenes,
                stage7_style_skipped: true,
                stage7_approved: true,
                imported: true,
                importedFrom: file.originalname || 'unknown'
            }
        };

        const filePath = path.join(DATA_DIR, `${id}.json`);
        await writeJSONQueued(filePath, newProject);

        console.log(`Imported script "${title}": ${parsed.scenes.length} scenes, ${stage6Scenes.length} sequences`);
        res.status(201).json({ projectId: id, title, sceneCount: parsed.scenes.length, sequenceCount: stage6Scenes.length });
    } catch (error) {
        console.error('Import script error:', error);
        sendApiError(res, error, 'Failed to import script');
    }
});

// PUT update project
app.put('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        assertValidProjectId(id);
        const updates = req.body;
        await assertProjectExists(id);

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            // Ensure nested .data is merged properly rather than completely overwritten
            const previousData = projectData.data || {};
            let mergedData = previousData;
            if (updates.data) {
                mergedData = { ...mergedData, ...updates.data };
                if (Array.isArray(updates.data.versionHistory)) {
                    mergedData.versionHistory = mergeVersionHistory(previousData.versionHistory, updates.data.versionHistory);
                }
            }

            const nextProject = { ...projectData, ...updates, data: mergedData };
            delete nextProject.restoreVersionId;
            delete nextProject.skipSnapshots;

            if (updates.data && !Array.isArray(updates.data.versionHistory) && !updates.skipSnapshots) {
                const operation = updates.restoreVersionId ? 'restore' : 'manual_update';
                for (const key of changedStageKeysFromUpdate(updates.data)) {
                    const config = stageConfig(key);
                    if (!config) continue;
                    recordArtifactMutation(nextProject, {
                        projectId: id,
                        stage: config.stage,
                        before: previousData[key],
                        after: updates.data[key],
                        operation,
                        note: updates.restoreVersionId ? `Restore ${updates.restoreVersionId}` : `Project update: ${key}`
                    });
                }
            }

            // If the client signals a stage was revised, stamp staleness on downstream stages
            if (updates.stampRevisedStage) {
                stampRevised(nextProject, updates.stampRevisedStage);
                delete nextProject.stampRevisedStage; // Don't persist the flag itself
            }

            return nextProject;
        });

        res.json(updatedProject);
    } catch (error) {
        console.error("Error updating project:", error);
        sendApiError(res, error, 'Failed to update project');
    }
});

app.get('/api/projects/:id/knowledge', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const projectData = await readProjectJSONById(id);
        const knowledge = ensureProjectKnowledge(projectData);
        res.json({ knowledge: knowledgePayloadForClient(knowledge, projectData) });
    } catch (error) {
        console.error('knowledge load error:', error.message);
        sendApiError(res, error, 'Failed to load project knowledge');
    }
});

app.post('/api/projects/:id/knowledge/sources', requireAuth, upload.single('sourceFile'), async (req, res) => {
    try {
        const { id } = req.params;
        assertValidProjectId(id);
        if (!req.file) throw new BadRequestError('No source file uploaded');
        await assertProjectExists(id);

        const attachment = {
            name: req.file.originalname || 'Untitled source',
            mimeType: req.file.mimetype || 'application/octet-stream',
            data: req.file.buffer.toString('base64')
        };
        const sourceNote = compactText(req.body?.sourceNote || '', 800);
        let uploadResult = null;

        const updatedProject = await updateProjectJSON(id, async (projectData) => {
            const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, {
                stageId: null,
                userMessage: sourceNote,
                originTag: 'project_upload',
                projectId: id
            });
            if (!persisted.savedSource) {
                throw new BadRequestError('No readable text could be extracted from this source file');
            }
            uploadResult = persisted.savedSource;

            const knowledge = ensureProjectKnowledge(projectData);
            const now = new Date().toISOString();
            boundedKnowledgePush(knowledge.decision_log, {
                at: now,
                type: persisted.savedSource.duplicate ? 'source_referenced' : 'source_uploaded',
                sourceId: persisted.savedSource.id,
                summary: `${persisted.savedSource.duplicate ? 'Referenced existing' : 'Uploaded'} project source: ${persisted.savedSource.name}`
            }, 120);
            compactProjectKnowledge(projectData, { now });
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        const savedSource = knowledge.source_registry.find(source => source.id === uploadResult?.id);
        res.json({
            ok: true,
            savedSource: savedSource ? { ...summarizeSourceForClient(savedSource), duplicate: !!uploadResult?.duplicate } : null,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject)
        });
    } catch (error) {
        console.error('knowledge source upload error:', error.message);
        sendApiError(res, error, 'Failed to upload source');
    }
});

app.get('/api/projects/:id/knowledge/sources/:sourceId/assets/:assetKind', requireAuth, async (req, res) => {
    try {
        const { id, sourceId, assetKind } = req.params;
        assertValidProjectId(id, 'Invalid project ID or source ID');
        assertValidSourceId(sourceId, 'Invalid project ID or source ID');
        if (!['extracted', 'original', 'text'].includes(assetKind)) {
            throw new BadRequestError('Invalid source asset type');
        }

        const projectData = await readProjectJSONById(id);
        const asset = await readKnowledgeSourceAssetForClient(projectData, id, sourceId, assetKind);

        if (asset.buffer) {
            const disposition = req.query?.download === '1' ? 'attachment' : 'inline';
            res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `${disposition}; filename="${contentDispositionFilename(asset.filename, 'source')}"`);
            res.send(asset.buffer);
            return;
        }

        if (req.query?.format === 'json') {
            res.json({
                source: asset.source,
                assetKind: asset.assetKind,
                filename: asset.filename,
                mimeType: asset.mimeType,
                charCount: asset.charCount,
                content: asset.content
            });
            return;
        }

        res.setHeader('Content-Type', asset.mimeType || 'text/plain; charset=utf-8');
        res.send(asset.content || '');
    } catch (error) {
        console.error('knowledge source asset error:', error.message);
        sendApiError(res, error, 'Failed to load source asset');
    }
});

app.delete('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
    try {
        const { id, sourceId } = req.params;
        assertValidProjectId(id, 'Invalid project ID or source ID');
        assertValidSourceId(sourceId, 'Invalid project ID or source ID');
        await assertProjectExists(id);

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            removeKnowledgeSource(projectData, sourceId);
            return projectData;
        });
        await removeKnowledgeSourceAssets(id, sourceId).catch(error => {
            console.error('source asset cleanup error:', error.message);
        });
        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({
            ok: true,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject)
        });
    } catch (error) {
        console.error('knowledge source delete error:', error.message);
        sendApiError(res, error, 'Failed to delete source');
    }
});

app.patch('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
    try {
        const { id, sourceId } = req.params;
        assertValidProjectId(id, 'Invalid project ID or source ID');
        assertValidSourceId(sourceId, 'Invalid project ID or source ID');
        await assertProjectExists(id);

        const { type, tags } = req.body || {};
        if (type !== undefined && !SOURCE_TYPE_OPTIONS.has(type)) {
            throw new BadRequestError('Invalid source type');
        }

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            updateKnowledgeSourceMetadata(projectData, sourceId, { type, tags });
            return projectData;
        });
        const knowledge = ensureProjectKnowledge(updatedProject);
        const updatedSource = knowledge.source_registry.find(source => source.id === sourceId);
        res.json({
            ok: true,
            source: updatedSource ? summarizeSourceForClient(updatedSource) : null,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject),
            diagnostics: buildKnowledgeDiagnostics(updatedProject)
        });
    } catch (error) {
        console.error('knowledge source update error:', error.message);
        sendApiError(res, error, 'Failed to update source');
    }
});

app.post('/api/projects/:id/knowledge/decision', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const { type, stageId, summary, details, audit } = req.body || {};
        const numericStageId = stageId === undefined || stageId === null || stageId === '' ? null : Number(stageId);
        if (numericStageId && !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Invalid stage ID' });
        }

        const cleanType = /^[a-z0-9_-]{1,60}$/i.test(type || '') ? type : 'project_knowledge_decision';
        const cleanSummary = compactText(summary || details || summarizeAuditForDecision(audit), 1_000);
        if (!cleanSummary) return res.status(400).json({ error: 'Decision summary is required' });

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            const knowledge = ensureProjectKnowledge(projectData);
            const now = new Date().toISOString();
            const entry = {
                at: now,
                type: cleanType,
                stageId: numericStageId,
                summary: cleanSummary
            };
            if (details) entry.details = compactText(details, 2_000);
            if (audit) entry.audit = compactAuditForKnowledge(audit);

            boundedKnowledgePush(knowledge.decision_log, entry, 120);
            if (numericStageId) {
                knowledge.stage_handoffs[`stage${numericStageId}`] = {
                    at: now,
                    type: cleanType,
                    summary: cleanSummary
                };
            }
            compactProjectKnowledge(projectData, { now });
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
    } catch (error) {
        console.error('knowledge decision log error:', error.message);
        res.status(500).json({ error: 'Failed to log project knowledge decision' });
    }
});

app.post('/api/projects/:id/knowledge/accepted-divergence', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const { stageId, summary, audit } = req.body || {};
        const numericStageId = Number(stageId);
        if (!numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Invalid stage ID' });
        }

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            recordAcceptedSourceDivergence(projectData, { stageId: numericStageId, summary, audit });
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
    } catch (error) {
        console.error('accepted divergence log error:', error.message);
        res.status(500).json({ error: 'Failed to save accepted source divergence' });
    }
});

app.post('/api/projects/:id/knowledge/propose-stage-curation', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const { stageId, stageDataOverride } = req.body || {};
        const numericStageId = Number(stageId);
        if (!numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Invalid stage ID' });
        }

        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        const projectData = JSON.parse(content);
        const builtStage = await buildStageDataForAssistant(projectData, numericStageId);
        const stageName = builtStage.stageName;
        const overrideText = stageDataOverrideToText(stageDataOverride);
        const stageData = overrideText === null ? builtStage.stageData : overrideText;
        const fallback = buildFallbackStageCuration(numericStageId, stageName, stageData);

        const knowledgeContext = buildKnowledgeContextBlock(projectData, {
            stageId: numericStageId,
            userMessage: `Curate project memory after approving ${stageName}.`,
            stageName,
            stageData,
            maxChars: 14_000
        });
        const curationSchema = {
            type: 'object',
            properties: {
                handoff_summary: { type: 'string' },
                continuity_watchlist_additions: { type: 'array', items: { type: 'string' } },
                source_bible_notes: { type: 'array', items: { type: 'string' } },
                decision_summary: { type: 'string' }
            },
            required: ['handoff_summary', 'continuity_watchlist_additions', 'source_bible_notes', 'decision_summary']
        };
        const prompt = `${knowledgeContext || 'No persistent project source knowledge has been saved yet.'}

---

## APPROVED STAGE OUTPUT
Stage ${numericStageId}: ${stageName}
${compactText(stageData, 42_000)}

---

Propose compact project-memory updates for downstream screenplay stages.
Rules:
- The handoff_summary should tell later assistants what creative facts and decisions this approved stage establishes.
- continuity_watchlist_additions should include only concrete items worth tracking later.
- source_bible_notes are project adaptation notes derived from this stage; do not rewrite source canon or invent source facts.
- Keep every item concise and actionable.`;

        try {
            const modelCfg = getModelConfig(numericStageId);
            const response = await generateContent({
                model: modelCfg.model,
                geminiApiKey: modelCfg.geminiApiKey,
                anthropicApiKey: modelCfg.anthropicApiKey,
                contents: prompt,
                config: {
                    systemInstruction: 'You are a screenplay project memory curator. Propose compact handoff and continuity memory updates from an approved stage. Never overwrite source canon; distinguish project adaptation choices from source facts.',
                    temperature: 0.2,
                    maxOutputTokens: 5000
                },
                schema: curationSchema
            });
            const proposal = safeParse(response.text, null);
            if (!proposal) throw new Error('Curation response was not valid JSON');
            trackUsage(id, response.usage);
            return res.json({
                stageId: numericStageId,
                stageName,
                proposal: sanitizeStageCurationProposal(proposal, { stageId: numericStageId, stageName, stageData })
            });
        } catch (aiError) {
            console.warn('stage curation proposal fell back:', aiError.message);
            return res.json({
                stageId: numericStageId,
                stageName,
                fallback: true,
                proposal: fallback
            });
        }
    } catch (error) {
        console.error('stage curation proposal error:', error.message);
        res.status(500).json({ error: 'Failed to propose project memory updates' });
    }
});

app.post('/api/projects/:id/knowledge/apply-stage-curation', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const { stageId, proposal } = req.body || {};
        const numericStageId = Number(stageId);
        if (!numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Invalid stage ID' });
        }

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            applyStageCurationToKnowledge(projectData, { stageId: numericStageId, proposal });
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({ ok: true, knowledge: knowledgePayloadForClient(knowledge, updatedProject) });
    } catch (error) {
        console.error('stage curation apply error:', error.message);
        res.status(500).json({ error: 'Failed to apply project memory updates' });
    }
});

app.post('/api/projects/:id/knowledge/refresh-stage-handoff', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const { stageId, stageDataOverride } = req.body || {};
        const numericStageId = Number(stageId);
        if (!numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Invalid stage ID' });
        }

        const updatedProject = await updateProjectJSON(id, async (projectData) => {
            const builtStage = await buildStageDataForAssistant(projectData, numericStageId);
            const overrideText = stageDataOverrideToText(stageDataOverride);
            const stageData = overrideText === null ? builtStage.stageData : overrideText;
            refreshStageHandoff(projectData, numericStageId, stageData);
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({
            ok: true,
            handoff: knowledge.stage_handoffs[`stage${numericStageId}`] || null,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject)
        });
    } catch (error) {
        console.error('stage handoff refresh error:', error.message);
        res.status(500).json({ error: 'Failed to refresh stage handoff' });
    }
});

app.get('/api/projects/:id/knowledge/diagnostics', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        const projectData = JSON.parse(content);
        res.json({ diagnostics: buildKnowledgeDiagnostics(projectData) });
    } catch (error) {
        console.error('knowledge diagnostics error:', error.message);
        res.status(500).json({ error: 'Failed to inspect project knowledge' });
    }
});

app.post('/api/projects/:id/knowledge/compact', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            compactProjectKnowledge(projectData, {
                recordDecision: true,
                reason: 'project_memory_compacted'
            });
            return projectData;
        });
        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({
            ok: true,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject),
            diagnostics: buildKnowledgeDiagnostics(updatedProject)
        });
    } catch (error) {
        console.error('knowledge compact error:', error.message);
        res.status(500).json({ error: 'Failed to compact project memory' });
    }
});

app.put('/api/projects/:id/knowledge/review', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            updateKnowledgeReview(projectData, req.body || {});
            return projectData;
        });

        const knowledge = ensureProjectKnowledge(updatedProject);
        res.json({
            ok: true,
            knowledge: knowledgePayloadForClient(knowledge, updatedProject),
            diagnostics: buildKnowledgeDiagnostics(updatedProject)
        });
    } catch (error) {
        console.error('knowledge review update error:', error.message);
        res.status(500).json({ error: 'Failed to update project memory review' });
    }
});

app.post('/api/projects/:id/knowledge/rebuild-source-bible', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        const projectData = JSON.parse(content);
        const knowledge = ensureProjectKnowledge(projectData);
        if (!knowledge.source_registry.length) {
            return res.status(400).json({ error: 'No source documents saved yet' });
        }

        const sourceMaterial = buildSourceBiblePrompt(knowledge);
        const sourceBibleSchema = {
            type: 'object',
            properties: {
                summary: { type: 'string' },
                canon_facts: { type: 'array', items: { type: 'string' } },
                characters: { type: 'array', items: { type: 'string' } },
                settings: { type: 'array', items: { type: 'string' } },
                timeline: { type: 'array', items: { type: 'string' } },
                rules: { type: 'array', items: { type: 'string' } },
                must_keep_elements: { type: 'array', items: { type: 'string' } },
                continuity_watchlist: { type: 'array', items: { type: 'string' } },
                open_questions: { type: 'array', items: { type: 'string' } }
            },
            required: ['summary', 'canon_facts', 'characters', 'settings', 'timeline', 'rules', 'must_keep_elements', 'continuity_watchlist', 'open_questions']
        };
        const modelCfg = getModelConfig(3);
        const response = await generateContent({
            model: modelCfg.model,
            geminiApiKey: modelCfg.geminiApiKey,
            anthropicApiKey: modelCfg.anthropicApiKey,
            contents: `Build a compact source bible for this project from the saved source documents below.

Rules:
- Extract only facts supported by the source text.
- Keep items concise and screenplay-development useful.
- If a fact is ambiguous, put it in open_questions rather than canon_facts.
- Do not invent missing plot, character, setting, or timeline information.

SAVED SOURCE DOCUMENTS:
${sourceMaterial}`,
            config: {
                systemInstruction: 'You are a story canon archivist. Convert source documents into a compact, structured source bible for downstream screenplay generation.',
                temperature: 0.2,
                maxOutputTokens: 12000
            },
            schema: sourceBibleSchema
        });

        const extracted = safeParse(response.text, null);
        if (!extracted) throw new Error('Source bible response was not valid JSON');

        const updatedProject = await updateProjectJSON(id, (freshProject) => {
            const freshKnowledge = ensureProjectKnowledge(freshProject);
            const now = new Date().toISOString();
            const sourceIds = freshKnowledge.source_registry.map(source => source.id);
            const curatedNotes = Array.isArray(freshKnowledge.source_bible?.curated_notes)
                ? freshKnowledge.source_bible.curated_notes
                : [];
            freshKnowledge.source_bible = {
                ...extracted,
                curated_notes: curatedNotes,
                sources_summary: (freshKnowledge.source_registry || []).slice(-20).map(source => {
                    const descriptor = source.summary || compactText(source.text || source.chunks?.[0]?.text || '', 700);
                    return `- ${source.name} (${source.type || 'source'}, ${source.uploadedAt || 'unknown date'}): ${descriptor}`;
                }).join('\n'),
                updatedAt: now,
                sourceIds,
                sourceCount: sourceIds.length
            };
            const watchItems = [
                ...(freshKnowledge.continuity_watchlist || []).map(formatKnowledgeItem),
                ...(extracted.continuity_watchlist || [])
            ].filter(Boolean);
            freshKnowledge.continuity_watchlist = Array.from(new Set(watchItems)).slice(-40);
            boundedKnowledgePush(freshKnowledge.decision_log, {
                at: now,
                type: 'source_bible_rebuilt',
                summary: `Rebuilt source bible from ${sourceIds.length} source document${sourceIds.length === 1 ? '' : 's'}.`
            }, 120);
            compactProjectKnowledge(freshProject, { now });
            return freshProject;
        });

        trackUsage(id, response.usage);
        const updatedKnowledge = ensureProjectKnowledge(updatedProject);
        res.json({
            knowledge: knowledgePayloadForClient(updatedKnowledge, updatedProject)
        });
    } catch (error) {
        console.error('source bible rebuild error:', error.message);
        res.status(500).json({ error: 'Failed to rebuild source bible' });
    }
});

// DELETE project
app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        assertValidProjectId(id);
        const filePath = path.join(DATA_DIR, `${id}.json`);

        await assertProjectExists(id);

        await fs.unlink(filePath);
        await removeProjectSourceAssets(id).catch(error => {
            console.error('source asset cleanup error:', error.message);
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting project:", error);
        sendApiError(res, error, 'Failed to delete project');
    }
});

// ─── Export Endpoints ─────────────────────────────────────────────────────────

async function loadProjectData(projectId) {
    return readProjectJSONById(projectId, {
        invalidMessage: 'Invalid project ID',
        notFoundMessage: 'Project not found'
    });
}

// GET /api/export/docx/:projectId?stage=outline|characters|treatment|draft|coverage
app.get('/api/export/docx/:projectId', requireAuth, async (req, res) => {
    try {
        const { projectId } = req.params;
        const stage = req.query.stage || 'coverage';
        const project = await loadProjectData(projectId);
        const data = project.data || {};
        const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
        const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let buf, filename;

        if (stage === 'pitch') {
            const pitch = data.stage1_pitch?.pitch;
            if (!pitch) throw new BadRequestError('No pitch data found');
            buf = await generatePitchDocx(pitch);
            filename = `${safeName}_pitch.docx`;

        } else if (stage === 'coverage') {
            if (!data.stage8_coverage) throw new BadRequestError('No coverage data found');
            buf = await generateCoverageDocx(data.stage8_coverage);
            filename = `${safeName}_coverage.docx`;

        } else if (stage === 'outline') {
            const outline = data.stage2_outline?.outline;
            if (!outline) throw new BadRequestError('No outline data found');
            buf = await generateOutlineDocx(outline, title);
            filename = `${safeName}_outline.docx`;

        } else if (stage === 'characters') {
            const chars = data.stage3_characters?.characters;
            if (!chars || !chars.length) throw new BadRequestError('No character data found');
            buf = await generateCharactersDocx(chars, title);
            filename = `${safeName}_characters.docx`;

        } else if (stage === 'treatment') {
            if (!data.stage5_treatment) throw new BadRequestError('No treatment data found');
            buf = await generateTreatmentDocx(data.stage5_treatment, title);
            filename = `${safeName}_treatment.docx`;

        } else if (stage === 'beats') {
            const beats = data.stage4_beats || data.stage4_treatment;
            if (!beats?.hybrid_beat_sheet) throw new BadRequestError('No beat sheet data found');
            buf = await generateBeatsDocx(beats, title);
            filename = `${safeName}_beats.docx`;

        } else if (stage === 'scenes') {
            const seqs = data.stage6_scenes;
            if (!seqs || !seqs.length) throw new BadRequestError('No scene blueprint data found');
            const sequences = Array.isArray(seqs) ? seqs : (seqs.sequences || []);
            buf = await generateScenesDocx(sequences, title);
            filename = `${safeName}_scene_blueprint.docx`;

        } else if (stage === 'draft') {
            const scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            const drafted = scenes.filter(s => s.draft_text || s.humanized_draft_text);
            if (!drafted.length) throw new BadRequestError('No drafted scenes found');
            buf = await generateDraftDocx(drafted, title);
            filename = `${safeName}_draft.docx`;

        } else if (stage === 'rewrite') {
            const working = data.stage9_rewrites?.working;
            if (!working) throw new BadRequestError('No rewrite data found');
            // Convert working object to scene-like array for draft export
            const fakescenes = Object.entries(working).map(([, txt]) => ({ humanized_draft_text: txt }));
            buf = await generateDraftDocx(fakescenes, title);
            filename = `${safeName}_rewrite.docx`;

        } else {
            throw new BadRequestError(`Unknown stage: ${stage}`);
        }

        const exportStage = exportStageNumber(stage);
        if (exportStage) {
            recordExportSnapshot(project, projectId, exportStage, `DOCX export: ${stage}`);
            await writeJSONQueued(getProjectFilePath(projectId), project);
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('DOCX export error:', err);
        sendApiError(res, err, 'Export failed');
    }
});

// GET /api/export/pdf/:projectId?stage=draft|rewrite
app.get('/api/export/pdf/:projectId', requireAuth, async (req, res) => {
    try {
        const { projectId } = req.params;
        const stage = req.query.stage || 'draft';
        const project = await loadProjectData(projectId);
        const data = project.data || {};
        const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
        const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let scenes;
        if (stage === 'rewrite') {
            const working = data.stage9_rewrites?.working;
            if (!working) throw new BadRequestError('No rewrite data found');
            scenes = Object.entries(working)
                .sort(([a], [b]) => Number(a) - Number(b))
                .filter(([, txt]) => txt && txt.trim() !== '[SCENE DELETED]')
                .map(([, txt]) => ({ humanized_draft_text: txt }));
        } else {
            scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            scenes = scenes.filter(s => s.draft_text || s.humanized_draft_text);
        }

        if (!scenes.length) throw new BadRequestError('No scenes to export');

        const buf = await generateScreenplayPdf(scenes, title);
        const filename = `${safeName}_${stage}.pdf`;
        const exportStage = exportStageNumber(stage);
        if (exportStage) {
            recordExportSnapshot(project, projectId, exportStage, `PDF export: ${stage}`);
            await writeJSONQueued(getProjectFilePath(projectId), project);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('PDF export error:', err);
        sendApiError(res, err, 'Export failed');
    }
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── Startup checks ───────────────────────────────────────────────────────────
async function startServer() {
    await initDb();
    await loadSettings();
    auditOrUpgradeAllProjectKnowledge({ write: true })
        .then(({ totals }) => {
            if (totals.changed || totals.recoveredMarkdown) {
                console.log(`[knowledge] legacy upgrade checked ${totals.projects} project(s), updated ${totals.changed}, recovered ${totals.recoveredMarkdown} markdown asset(s).`);
            }
        })
        .catch(error => console.error('[knowledge] legacy upgrade skipped:', error.message));

    const hasGemini = appSettings.geminiApiKey || process.env.GEMINI_API_KEY;
    const hasAnthropic = appSettings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!hasGemini && !hasAnthropic) {
        console.warn('[warn] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set — AI features will fail on first use.');
    }
    if (APP_SECRET) {
        console.log('[auth] APP_SECRET set — API authentication active.');
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
