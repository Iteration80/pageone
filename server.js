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

function publicErrorDetail(error, maxChars = 240) {
    const message = String(error?.message || '').trim();
    if (!message) return '';
    return message
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/AIza[0-9A-Za-z_-]+/g, '[redacted]')
        .slice(0, maxChars);
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
const { agent2Outline } = require('./agents/agent_2_outline');
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
const { generateContent } = require('./agents/ai-client');

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
    const convos = projectData.data.conversations || {};
    const updated = [...messages, { role: 'assistant', content: assistantMessage }];
    const MAX_HISTORY = 100;
    convos[stageKey] = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;
    projectData.data.conversations = convos;
    await writeJSONQueued(filePath, projectData);
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
        const err = new Error('Source not found');
        err.statusCode = 404;
        throw err;
    }

    if (assetKind === 'original') {
        const filePath = resolveStoredSourceAssetPath(projectId, sourceId, source.originalFile);
        if (!filePath) {
            const err = new Error('Original source file is not available.');
            err.statusCode = 404;
            throw err;
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
            const err = new Error('No readable text is available for this source.');
            err.statusCode = 404;
            throw err;
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

    const err = new Error('Unknown source asset type.');
    err.statusCode = 400;
    throw err;
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
        const err = new Error('Source not found');
        err.statusCode = 404;
        throw err;
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
        const err = new Error('Source not found');
        err.statusCode = 404;
        throw err;
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
                    beat.genre_variation_notes,
                    beat.emotional_arc,
                    beat.pacing_notes,
                    beat.detailed_action
                ].filter(Boolean).join(' ');
                return `- ${beat.beat_name || 'Unnamed beat'}: ${compactText(text, 700)}`;
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
        case 10:
            stageData = JSON.stringify(projectData.data?.stage9_rewrites?.working || {}, null, 2);
            break;
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
    res.json({ ok: true });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,      // 1 minute window
    max: 30,                   // max 30 AI calls per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down and try again.' },
});
const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down and try again.' },
});

// Middleware
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
        if (projectData && sourcePacket) {
            recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'pitch_revision');
            await writeJSONQueued(getProjectFilePath(projectId), projectData);
            trackUsage(projectId, usage);
        }
        res.json({ result, ...sourceResponseExtras(sourcePacket) });
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

    const send = (data) => {
        if (streaming && !res.destroyed && !res.writableEnded) {
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
            if (!res.destroyed && !res.writableEnded) {
                res.write(': keep-alive\n\n');
            }
        }, 15000);
        heartbeat.unref?.();
    };

    try {
        const { projectId, currentBeats, notes } = req.body;
        const uploadedFile = req.file;

        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: "Missing or invalid projectId" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            return res.status(404).json({ error: "Project not found" });
        }

        const stage1 = projectData.data?.stage1_pitch?.pitch;
        if (!stage1) {
            return res.status(400).json({ error: "Project has no finalized Stage 1 Pitch" });
        }

        const parsedBeats = currentBeats ? (safeParse(currentBeats, null)) : null;
        startStream();
        send({ type: 'progress', label: notes ? 'Revising outline...' : 'Generating outline...' });

        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 2, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);

        console.log("Generating Stage 2 Outline...");
        const stage2KnowledgeSeed = `${JSON.stringify(stage1, null, 2)}\n${parsedBeats ? JSON.stringify(parsedBeats, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 2, stage2KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: outlineData, usage } = await agent2Outline(stage1, parsedBeats, notesWithUpload, uploadContext.agentFile, getModelConfigWithSourcePacket(2, sourcePacket));

        // Save to Stage 2
        projectData.data = projectData.data || {};
        projectData.data.stage2_outline = outlineData;
        notesWithUpload ? stampRevised(projectData, 'stage2_outline') : stampGenerated(projectData, 'stage2_outline');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(outlineData, null, 2), notesWithUpload ? 'revision' : 'generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        const payload = { result: outlineData, ...sourceResponseExtras(sourcePacket) };
        if (streaming) {
            send({ type: 'complete', ...payload });
        } else {
            res.json(payload);
        }
    } catch (error) {
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
        if (streaming && !res.writableEnded) res.end();
    }
});

app.post('/api/generate-characters', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentCharacters, notes } = req.body;
        const uploadedFile = req.file;

        if (!isValidProjectId(projectId)) {
            return res.status(400).json({ error: "Missing or invalid projectId" });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        let projectData;
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
        } catch (err) {
            console.error('generate-characters: failed to load project');
            return res.status(404).json({ error: "Project not found" });
        }

        const pitchData = projectData.data?.stage1_pitch?.pitch;
        const beatsData = projectData.data?.stage2_outline?.outline;

        if (!pitchData || !beatsData) {
            return res.status(400).json({ error: "Project requires Stage 1 Pitch and Stage 2 Outline to generate Characters" });
        }

        const parsedChars = currentCharacters ? safeParse(currentCharacters, null) : null;
        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 3, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);

        console.log("Generating Stage 3 Characters...");
        const stage3KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${parsedChars ? JSON.stringify(parsedChars, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 3, stage3KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: characterData, usage } = await agent3Characters(pitchData, beatsData, parsedChars, notesWithUpload, uploadContext.agentFile, getModelConfigWithSourcePacket(3, sourcePacket));

        // Save to Stage 3
        projectData.data = projectData.data || {};
        projectData.data.stage3_characters = characterData;
        notesWithUpload ? stampRevised(projectData, 'stage3_characters') : stampGenerated(projectData, 'stage3_characters');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(characterData, null, 2), notesWithUpload ? 'revision' : 'generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        res.json({ result: characterData, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Character Gen Error:', error);
        const detail = publicErrorDetail(error);
        res.status(500).json({ error: detail ? `Failed to generate characters: ${detail}` : "Failed to generate characters" });
    }
});

app.post('/api/generate-stage4-beats', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId, currentBeats, notes } = req.body || {};
    const uploadedFile = req.file;

    if (!isValidProjectId(projectId)) {
        return res.status(400).json({ error: "Missing or invalid projectId" });
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const beatsData = projectData.data?.stage2_outline?.outline;
    const charsData = projectData.data?.stage3_characters?.characters;

    if (!pitchData || !beatsData || !charsData) {
        return res.status(400).json({ error: "Project requires Stages 1-3 to generate Beats" });
    }

    const parsedCurrentBeats = currentBeats ? safeParse(currentBeats, null) : null;
    const isFullStage4Generation = !parsedCurrentBeats;

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log("Generating Stage 4 Beats...");
        const uploadContext = await prepareGenerationUpload(projectData, uploadedFile, { stageId: 4, userMessage: notes || '', forceTextBlock: true });
        const notesWithUpload = appendUploadedSourceBlock(notes, uploadContext);
        const stage4KnowledgeSeed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${JSON.stringify(charsData, null, 2)}\n${parsedCurrentBeats ? JSON.stringify(parsedCurrentBeats, null, 2) : ''}\n${notesWithUpload}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 4, stage4KnowledgeSeed, { userMessage: notesWithUpload });
        const { result: beatsResult, usage } = await agent4Beats(
            pitchData, beatsData, charsData, parsedCurrentBeats, notesWithUpload, uploadContext.agentFile,
            (label) => send({ type: 'progress', label }),
            getModelConfigWithSourcePacket(4, sourcePacket)
        );

        console.log("Beats generated successfully. Beat sheet length:", beatsResult.hybrid_beat_sheet?.length || 0);

        projectData.data = projectData.data || {};
        projectData.data.stage4_beats = beatsResult;
        if (isFullStage4Generation && projectData.data.conversations?.stage4) {
            delete projectData.data.conversations.stage4;
        }
        notesWithUpload ? stampRevised(projectData, 'stage4_beats') : stampGenerated(projectData, 'stage4_beats');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(beatsResult, null, 2), notesWithUpload ? 'revision' : 'generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        send({ type: 'complete', result: beatsResult, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Stage 4 Beats Gen Error:', error.message);
        send({ type: 'error', message: 'Failed to generate beats' });
    } finally {
        res.end();
    }
});

app.post('/api/generate-stage5-treatment', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId } = req.body || {};
    const uploadedFile = req.file;
    if (!isValidProjectId(projectId)) {
        return res.status(400).json({ error: "Missing or invalid projectId" });
    }

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitchData = projectData.data?.stage1_pitch?.pitch;
    const charactersData = projectData.data?.stage3_characters?.characters;
    const beatsData = projectData.data?.stage4_beats?.hybrid_beat_sheet;

    const { notes, currentTreatment } = req.body;
    const parsedTreatment = currentTreatment ? safeParse(currentTreatment, null) : null;

    if (!pitchData || !charactersData || !beatsData) {
        return res.status(400).json({ error: "Project requires Stages 1, 3, and 4 to generate Treatment" });
    }

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
            res.write(': keep-alive\n\n');
        }
    }, 15000);
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
            getModelConfigWithSourcePacket(5, sourcePacket)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage5_treatment = treatmentResult;
        notesWithUpload ? stampRevised(projectData, 'stage5_treatment') : stampGenerated(projectData, 'stage5_treatment');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(treatmentResult, null, 2), notesWithUpload ? 'revision' : 'generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: treatmentResult, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Stage 5 Treatment Gen Error:', error.message, error.stack);
        const detail = error?.message ? `: ${String(error.message).slice(0, 240)}` : '';
        send({ type: 'error', message: `Failed to generate treatment${detail}` });
    } finally {
        clearInterval(heartbeat);
        res.end();
    }
});

app.post('/api/generate-stage6-scenes', requireAuth, aiLimiter, async (req, res) => {
    const { projectId, notes } = req.body;
    if (!isValidProjectId(projectId)) {
        return res.status(400).json({ error: "Missing or invalid projectId" });
    }
    const generationNotes = typeof notes === 'string' ? notes.trim() : '';

    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    let projectData;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        projectData = JSON.parse(content);
    } catch (err) {
        return res.status(404).json({ error: "Project not found" });
    }

    const pitch = projectData.data?.stage1_pitch?.pitch;
    const characters = projectData.data?.stage3_characters?.characters;
    const beats = projectData.data?.stage4_beats?.hybrid_beat_sheet;
    const treatment = projectData.data?.stage5_treatment;

    if (!pitch || !characters || !beats || !treatment) {
        return res.status(400).json({ error: "Project requires Stages 1, 3, 4, and 5 to generate Scene Blueprint" });
    }

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
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
            getModelConfig(6),
            generationNotes
        );

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = allSequences;
        stampGenerated(projectData, 'stage6_scenes');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(allSequences, null, 2), 'generation');
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: allSequences, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Stage 6 Scene Gen Error:', error.message);
        send({ type: 'error', message: 'Failed to generate scene blueprint' });
    } finally {
        clearInterval(heartbeat);
        res.end();
    }
});

app.post('/api/revise-stage6', requireAuth, aiLimiter, async (req, res) => {
    let heartbeat = null;
    let streaming = false;
    const send = (data) => {
        if (streaming && !res.destroyed && !res.writableEnded) {
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
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            heartbeat = setInterval(() => {
                if (!res.destroyed && !res.writableEnded) {
                    res.write(': keep-alive\n\n');
                }
            }, 15000);
            heartbeat.unref?.();
            send({ type: 'status', message: 'Revising scene blueprint...' });
        }

        console.log("Revising Stage 6 Scene Blueprint...");
        const stage6RevisionSeed = `${JSON.stringify(currentBlueprint, null, 2)}\n${feedback}`;
        const sourcePacket = buildSourceGenerationPacket(projectData, 6, stage6RevisionSeed, { userMessage: feedback });
        const beforeHash = sourcePlanDataHash(JSON.stringify(currentBlueprint || []));
        const { result: updatedBlueprint, usage } = await reviseStage6Scenes(currentBlueprint, feedback, getModelConfigWithSourcePacket(6, sourcePacket));
        const changed = sourcePlanDataHash(JSON.stringify(updatedBlueprint || [])) !== beforeHash;

        send({ type: 'status', message: changed ? 'Saving revised blueprint...' : 'Revision returned no blueprint changes...' });
        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = updatedBlueprint;
        if (changed) stampRevised(projectData, 'stage6_scenes');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(updatedBlueprint, null, 2), 'revision');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        const payload = { result: updatedBlueprint, changed, ...sourceResponseExtras(sourcePacket) };
        if (streaming) {
            // Keep the final SSE packet small. The browser refreshes the saved
            // Stage 6 data after completion, which avoids large blueprint payloads
            // being dropped by buffering/proxy layers.
            send({ type: 'complete', changed, stageKey: 'stage6_scenes', ...sourceResponseExtras(sourcePacket) });
        } else {
            res.json(payload);
        }
    } catch (error) {
        console.error('Stage 6 Revision Error:', error.message);
        if (streaming) {
            send({ type: 'error', message: "Failed to revise scene blueprint" });
        } else {
            res.status(500).json({ error: "Failed to revise scene blueprint" });
        }
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (streaming && !res.writableEnded) res.end();
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

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const response = { result: humanizedText, ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
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

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const response = { result: humanizedText, ...(styleWarning && { styleWarning }), ...sourceResponseExtras(sourcePacket) };
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

        projectData.data = projectData.data || {};
        projectData.data.stage8_coverage = coverageResult;
        stampGenerated(projectData, 'stage8_coverage');
        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(coverageResult, null, 2), 'coverage_generation');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        res.json({ result: coverageResult, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('Stage 8 Coverage Error:', error.message);
        res.status(500).json({ error: "Failed to generate coverage" });
    }
});

// --- Stage 10: Rewrite Routes --- //

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
            projectData.data.stage9_rewrites.priority_idx = 0;
            projectData.data.stage9_rewrites.approved = false;
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
        projectData.data.stage9_rewrites = stage9;
        await writeJSONQueued(filePath, projectData);

        res.json({
            stage9_rewrites: stage9,
            macro_todo: projectData.data.stage8_coverage?.macro_todo || [],
            micro_todo:  projectData.data.stage8_coverage?.micro_todo  || [],
        });
    } catch (error) {
        console.error('init-stage9 error:', error.message);
        res.status(500).json({ error: 'Failed to initialize rewrite stage' });
    }
});

// General-purpose brainstorm: stages 1–7 chat assistant
app.post('/api/brainstorm', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, stageId, messages = [], sceneNumber, attachment, isInit = false } = req.body;
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

        let stageName, stageData;
        try {
            ({ stageName, stageData } = await buildStageDataForAssistant(projectData, stageId, sceneNumber));
        } catch {
            return res.status(400).json({ error: `Unknown stageId: ${stageId}` });
        }

        // Build prior-stage conversation context
        const savedConversations = projectData.data?.conversations || {};
        const priorStageNames = { 1: 'Pitch', 2: 'Outline', 3: 'Characters', 4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint', 7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite' };
        let priorContext = '';
        for (let s = 1; s < stageId; s++) {
            const prior = savedConversations[`stage${s}`];
            if (prior?.length) {
                priorContext += `\n--- Stage ${s} (${priorStageNames[s]}) Conversations ---\n`;
                for (const m of prior.slice(-20)) {
                    priorContext += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
                }
            }
        }

        const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
        let attachmentText = '';
        let savedSource = null;
        if (attachment) {
            const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId, userMessage: lastUserMessage, projectId });
            attachmentText = persisted.fileText;
            savedSource = persisted.savedSource;
            if (savedSource) await writeJSONQueued(filePath, projectData);
        }

        const knowledgeContext = buildKnowledgeContextBlock(projectData, {
            stageId,
            userMessage: lastUserMessage,
            stageName,
            stageData
        });
        const sourceMemory = memoryUsageForStage(projectData, stageId, stageData, lastUserMessage);
        const memoryRecall = !isInit ? buildMemoryRecallResponse(projectData, {
            stageId,
            stageName,
            userMessage: lastUserMessage,
            stageData
        }) : null;
        if (memoryRecall) {
            const result = {
                message: memoryRecall.message,
                suggest_plan: false,
                execute_immediately: false
            };
            await persistStageConversation(filePath, projectData, `stage${stageId}`, messages, result.message);
            return res.json({
                ...result,
                ...(savedSource && { savedSource }),
                ...((memoryRecall.sourceMemory || sourceMemory) && { sourceMemory: memoryRecall.sourceMemory || sourceMemory })
            });
        }

        let conversationPrompt = `## PROJECT: ${title}\n\n## STAGE ${stageId} — ${stageName}\n${stageData}\n\n---\n\n`;
        if (knowledgeContext) conversationPrompt += `${knowledgeContext}\n\n---\n\n`;
        if (Number(stageId) === 4) {
            const outlineBoundary = buildStage4OutlineDiscussionBoundary(projectData);
            if (outlineBoundary) conversationPrompt += `${outlineBoundary}\n\n---\n\n`;
        }
        if (priorContext) conversationPrompt += `## PREVIOUS STAGE CONVERSATIONS\n${priorContext}\n---\n\n`;
        if (attachmentText) {
            conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}\n\n---\n\n`;
        }
        if (isInit && stageId === 5) {
            // Stage 5 Entry Analysis — proactive editorial opening message
            conversationPrompt += `## STAGE ENTRY ANALYSIS (Mode 4)\nThe writer has just generated or loaded the treatment and is viewing it for the first time. You have the full treatment above. Analyze it as an editorial partner — identify 2-3 specific, actionable observations about pacing, character arc momentum, structural balance between acts, or missed dramatic opportunities. Reference specific sequences or moments. Do NOT summarize what the treatment contains — the writer already read it. Surface things they might not have noticed: a sagging act break, a character who disappears too long, a sequence doing heavy lifting while another coasts, a thematic thread that starts strong but gets dropped. End by asking which area the writer wants to dig into first. Be direct and editorial, not deferential. Set suggest_plan: false and execute_immediately: false.\n\n`;
        } else if (isInit && stageId === 6) {
            // Stage 6 Entry Analysis — scene blueprint review
            conversationPrompt += `## STAGE ENTRY ANALYSIS (Mode 4)\nThe writer has just generated the scene blueprint and is reviewing it for the first time. You have the full scene-by-scene breakdown above. Analyze it as a script coordinator would — identify 2-3 specific observations about:\n- Scene count balance across sequences (are some overloaded while others feel thin?)\n- Slugline consistency and geography (do locations make spatial sense? are characters teleporting between decks without transition?)\n- Dramaturgical gaps (scenes that exist only as connective tissue without their own conflict or value shift)\n- Pacing rhythm (are high-tension and breather scenes alternating effectively, or do multiple intense scenes stack without relief?)\nReference specific scene numbers and headings. Do NOT summarize the blueprint — the writer can see it. Surface what they might miss scanning 60-80 scene cards. End by asking which area they want to dig into. Be direct. Set suggest_plan: false and execute_immediately: false.\n\n`;
        } else if (isInit && stageId === 7) {
            // Stage 7 — 3-writer style suggestion based on story context
            // Load saved styles for context
            let savedStyleNames = [];
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

            conversationPrompt += `## STAGE 7 STYLE SUGGESTION (3-Writer System)\n`;
            conversationPrompt += `The writer has scenes ready and is choosing a writing style. Suggest exactly 3 specific filmmakers or screenwriters whose style would suit this story.\n\n`;
            conversationPrompt += `Rules:\n`;
            conversationPrompt += `- For each suggestion: writer name, 1-sentence style description, 1 sentence connecting it to something SPECIFIC in their scenes (reference a scene number or character moment).\n`;
            conversationPrompt += `- Suggest a range: one intense/visceral, one restrained/observational, one unexpected/wild-card.\n`;
            conversationPrompt += `- If the writer has saved styles that fit, include one as a suggestion: "You already have a [Name] style that could work here."\n`;
            if (savedStyleNames.length > 0) {
                conversationPrompt += `- Saved styles in library: ${savedStyleNames.join(', ')}\n`;
            }
            conversationPrompt += `- End with: "Pick one and I'll build the style, or describe something different."\n`;
            conversationPrompt += `- Also mention: "Or choose 'No Style' above to draft in a clean, neutral voice."\n`;
            conversationPrompt += `\nSet suggest_plan: false and execute_immediately: false.\n\n`;
        } else {
            for (const msg of messages) {
                conversationPrompt += `${msg.role === 'user' ? 'WRITER' : 'YOU'}: ${msg.content}\n\n`;
            }

            // Stage 3-specific: keep character conversations inside the character artifact boundary
            if (stageId === 3) {
                conversationPrompt += `\n## STAGE 3 CHARACTER BOUNDARY\nYou are discussing the Characters stage. Keep the conversation anchored in character-profile mechanics: ghost/wound, lie, desire, psychological need, moral need, paradox, pressure behavior, tick gates, relationship dynamics, voice tags, and downstream handoff notes.\n\nUse the outline only as context for why a character mechanic matters. Do NOT prescribe sequence-level or scene-level plot placement unless the writer explicitly asks to change the outline, beats, treatment, or scene blueprint. Avoid saying things like "put this in Sequence E" or "this should happen in Scene 12." Instead, translate timing into character-arc language such as "mid-story regression," "late Act 2 pressure peak," "climax handoff," or "profile note for downstream stages."\n\nIf a generated character profile already mentions sequence labels, discuss whether the profile needs a clearer pressure ladder or tick gate, not where to stage the beat. Stage 3 execution means updating character profiles only. If the writer asks for structural placement, flag that it belongs in Stage 4+ and ask whether they want to carry the character note forward.\n\n`;
            }

            // Stage 7-specific: tell the model what "execution" means for style generation
            if (stageId === 7) {
                conversationPrompt += `\n## STAGE 7 CONTEXT\nYou are in the Style stage. "Executing" here means generating style directives from this conversation. When the writer confirms they want a specific style (e.g., "let's go with this", "yes, use that", "generate it", "sounds good"), set suggest_plan: true AND execute_immediately: true. The system will generate the style file from the full conversation. Give a brief forward-looking acknowledgment like "On it — generating the style directives now." Do NOT describe the result.\n\n`;
            }

            // Cadence enforcement: nudge model to stop asking questions after enough exchanges
            const userExchangeCount = messages.filter(m => m.role === 'user').length;
            if (userExchangeCount >= 5) {
                conversationPrompt += `\n\n## CADENCE CHECK (MANDATORY)\nThis is exchange ${userExchangeCount}. You MUST now pause and check in. Do not ask another clarifying question unless the writer explicitly asked to keep brainstorming.\n\n1. Summarize the direction so far ONLY if you haven't already done so in this same response. Don't repeat yourself.\n2. Choose the appropriate next step based on what ACTUALLY happened:\n   - If YOU surfaced a specific improvement or issue in THIS response: ask the writer whether they want to address it before moving on. Follow through on your own observations — do NOT pivot to a generic "anything else?" when you just identified something concrete.\n   - If concrete changes were proposed or agreed on: offer to apply them ("Want me to go ahead and update the [stage output], or keep refining?"). Set suggest_plan: true.\n   - If the conversation was purely exploratory and no improvements were surfaced: ask if the writer wants to dig into another aspect or is happy with where things stand. Do NOT offer to regenerate — there is nothing to regenerate. Set suggest_plan: false.\n\n`;
            } else if (userExchangeCount >= 4) {
                conversationPrompt += `\n\n## CADENCE REMINDER\nThis is exchange ${userExchangeCount}. On your next response you will need to check in per the Clarification Cadence rule. Be aware: only offer to regenerate/update content if concrete changes were actually discussed. If the conversation has been exploratory, offer to discuss another aspect or let the writer approve as-is.\n\n`;
            }
            if (Number(stageId) === 4) {
                const currentBeatEvidence = buildStage4CurrentBeatEvidenceBlock(projectData);
                if (currentBeatEvidence) conversationPrompt += `\n\n${currentBeatEvidence}\n\n`;
            }
            conversationPrompt += 'Continue the conversation as the editorial assistant.';
        }

        const brainstormSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_brainstorm.md'), 'utf8');

        // When the last user message is the post-revision trigger, inject a short high-priority
        // override at the top of the system prompt. Prose rules buried 200 lines in lose to the
        // model's default "be helpful with context" behavior; 5 imperative lines at position 0 win.
        const lastMsg = messages[messages.length - 1];
        const isPostRevision = !isInit && lastMsg?.role === 'user' &&
            typeof lastMsg?.content === 'string' &&
            lastMsg.content.includes('[Revision applied successfully');
        const systemInstruction = isPostRevision
            ? `POST-REVISION RESPONSE — OVERRIDE ALL OTHER INSTRUCTIONS FOR THIS TURN:
1. Write ONE sentence acknowledging the specific change just applied. Name only that revision. Stop.
2. On the next line, surface the next unresolved item from earlier in the conversation, by name. If none remain, ask if there is anything else.
3. Do NOT list, recap, or reference any changes made in earlier turns. No "We've also..." or "We've now addressed X, Y, and Z."
4. Do NOT ask "Want me to go ahead?" — the writer is in an active approval flow.
5. Set suggest_plan: false and execute_immediately: false.

${brainstormSop}`
            : brainstormSop;

        const brainstormSchema = {
            type: 'object',
            properties: {
                message: { type: 'string' },
                suggest_plan: { type: 'boolean' },
                execute_immediately: { type: 'boolean' }
            },
            required: ['message', 'suggest_plan', 'execute_immediately']
        };
        const brainstormConfig = getBrainstormModelConfig(stageId);
        const response = await generateContent({
            model: brainstormConfig.model,
            geminiApiKey: brainstormConfig.geminiApiKey,
            anthropicApiKey: brainstormConfig.anthropicApiKey,
            contents: conversationPrompt,
            config: {
                systemInstruction,
                temperature: 0.7
            },
            schema: brainstormSchema
        });
        const result = JSON.parse(response.text);
        console.log(`Brainstorm stage${stageId}: suggest_plan=${result.suggest_plan} execute_immediately=${result.execute_immediately}`);
        trackUsage(projectId, response.usage);

        // Persist the full conversation (current session + new exchange) to project file
        // Skip persistence for init messages — they are ephemeral and regenerated on each visit
        if (!isInit) {
            try {
                await persistStageConversation(filePath, projectData, `stage${stageId}`, messages, result.message);
            } catch (saveErr) {
                console.error('Failed to persist conversation:', saveErr.message);
            }
        }

        res.json({ ...result, ...(savedSource && { savedSource }), ...(sourceMemory && { sourceMemory }) });
    } catch (error) {
        console.error('brainstorm error:', error);
        const detail = publicErrorDetail(error);
        res.status(500).json({ error: detail ? `Brainstorm request failed: ${detail}` : 'Brainstorm request failed' });
    }
});

// Conversational brainstorm: editorial assistant helps writer clarify rewrite direction
app.post('/api/brainstorm-rewrite', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, messages = [], isInit = false, attachment } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

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
        const coverage = projectData.data?.stage8_coverage;
        const macroTodo = coverage?.macro_todo || [];
        const microTodo = coverage?.micro_todo || [];
        const priorityIdx = projectData.data?.stage9_rewrites?.priority_idx ?? 0;

        const stage6Scenes = projectData.data?.stage6_scenes || [];
        const allScenes = [];
        for (const seq of stage6Scenes) { if (seq.scenes) allScenes.push(...seq.scenes); }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);
        const working = projectData.data?.stage9_rewrites?.working || {};
        const fullScript = allScenes
            .map(s => `## SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}\n${working[s.scene_number] || s.humanized_draft_text || s.draft_text || ''}`)
            .join('\n\n---\n\n');

        const allPriorities = [
            ...macroTodo.map((t, i) => ({ label: `MACRO TO-DO P${i + 1}`, task: t.task || t, done: i < priorityIdx })),
            ...microTodo.map((t, i) => ({ label: `MICRO TO-DO P${i + 1}`, task: t.task || t, done: (macroTodo.length + i) < priorityIdx })),
        ];
        const priorityList = allPriorities.map(p => `${p.done ? '[DONE]' : '[OPEN]'} ${p.label}: ${p.task}`).join('\n');
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charSummary = characters.length > 0
            ? characters.map(c => `${c.name} (${c.role}): ${c.brief_summary || ''}`).join('\n')
            : '';
        const charBlock = charSummary ? `\n\n## CHARACTERS\n${charSummary}` : '';
        const contextBlock = `## PROJECT: ${title}${charBlock}\n\n## STAGE 9 PRIORITIES\n${priorityList}\n\n## FULL SCREENPLAY (current working draft)\n${fullScript}`;

        const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
        let attachmentText = '';
        let savedSource = null;
        if (attachment && !isInit) {
            const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId: 10, userMessage: lastUserMessage, projectId });
            attachmentText = persisted.fileText;
            savedSource = persisted.savedSource;
            if (savedSource) await writeJSONQueued(filePath, projectData);
        }

        const knowledgeContext = buildKnowledgeContextBlock(projectData, {
            stageId: 10,
            userMessage: lastUserMessage,
            stageName: STAGE_NAMES[10],
            stageData: fullScript
        });
        const sourceMemory = memoryUsageForStage(projectData, 10, fullScript, lastUserMessage);
        const memoryRecall = !isInit ? buildMemoryRecallResponse(projectData, {
            stageId: 10,
            stageName: STAGE_NAMES[10],
            userMessage: lastUserMessage,
            stageData: fullScript
        }) : null;
        if (memoryRecall) {
            const result = {
                message: memoryRecall.message,
                suggest_plan: false
            };
            await persistStageConversation(filePath, projectData, 'stage9', messages, result.message);
            return res.json({
                ...result,
                ...(savedSource && { savedSource }),
                ...((memoryRecall.sourceMemory || sourceMemory) && { sourceMemory: memoryRecall.sourceMemory || sourceMemory })
            });
        }

        // Build conversation as a single prompt string
        let conversationPrompt = contextBlock + '\n\n---\n\n';
        if (knowledgeContext) conversationPrompt += `${knowledgeContext}\n\n---\n\n`;
        if (attachment && !isInit) {
            if (attachmentText) conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}\n\n---\n\n`;
        }
        if (isInit) {
            // Check for character change context (from Stage 3 re-approval → Stage 10 flow)
            const charChangeCtx = projectData.data?.characterChangeContext;
            if (charChangeCtx) {
                conversationPrompt += `[The writer just updated character profiles in Stage 3 and chose to send the changes directly to the rewrite stage. Here are the specific changes:\n${charChangeCtx}\n\nAcknowledge these character changes, briefly explain how they might affect the current draft (which scenes/moments would be most impacted), and ask if the writer wants to generate a rewrite plan focused on implementing these character updates across the screenplay. Keep it conversational and concise.]`;
                // Clear the flag so it doesn't re-trigger
                delete projectData.data.characterChangeContext;
                await writeJSONQueued(filePath, projectData);
            } else {
            const doneCount = allPriorities.filter(p => p.done).length;
            if (doneCount > 0) {
                const nextPriority = allPriorities.find(p => !p.done);
                conversationPrompt += `[The writer just completed ${doneCount} of ${allPriorities.length} rewrite priorities and approved the changes. ${nextPriority ? `The next priority is: ${nextPriority.label}: ${nextPriority.task}. Briefly acknowledge progress (mention the count, e.g. "${doneCount} of ${allPriorities.length} done"), then present the next priority using its exact label and task text. Move straight into discussing what this priority involves and which scenes are likely affected. Do NOT re-list all priorities.` : 'All priorities have been addressed.'}]`;
            } else {
                conversationPrompt += '[The writer has just entered the rewrite stage. Present the coverage priorities EXACTLY as listed below — use the same labels (MACRO TO-DO P1, P2... and MICRO TO-DO P1, P2...) and the same task descriptions verbatim. Group them under MACRO TO-DO and MICRO TO-DO headings. Mark completed items as done. Then ask the writer which priority they\'d like to tackle first.]';
            }
            }
        } else {
            for (const msg of messages) {
                const label = msg.role === 'user' ? 'WRITER' : 'YOU';
                conversationPrompt += `${label}: ${msg.content}\n\n`;
            }

            // Cadence enforcement: higher threshold for Stage 10 to accommodate Priority Deliberation
            const userExchangeCount = messages.filter(m => m.role === 'user').length;
            if (userExchangeCount >= 7) {
                conversationPrompt += `\n\n## CADENCE CHECK (MANDATORY)\nThis is exchange ${userExchangeCount}. You MUST now summarize the direction and offer to proceed with a rewrite plan. Do not ask another clarifying question unless the writer explicitly asked to keep brainstorming. Set suggest_plan: true.\n\n`;
            } else if (userExchangeCount >= 6) {
                conversationPrompt += `\n\n## CADENCE REMINDER\nThis is exchange ${userExchangeCount}. Consider whether you have enough to propose a rewrite plan. Summarize direction and offer to proceed.\n\n`;
            }

            conversationPrompt += 'Continue the conversation as the editorial assistant.';
        }

        const brainstormSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_brainstorm.md'), 'utf8');
        const brainstormSchema = {
            type: 'object',
            properties: {
                message: { type: 'string' },
                suggest_plan: { type: 'boolean' }
            },
            required: ['message', 'suggest_plan']
        };

        const brainstormConfig = getBrainstormModelConfig(10);
        const response = await generateContent({
            model: brainstormConfig.model,
            geminiApiKey: brainstormConfig.geminiApiKey,
            anthropicApiKey: brainstormConfig.anthropicApiKey,
            contents: conversationPrompt,
            config: {
                systemInstruction: brainstormSop,
                temperature: 0.7
            },
            schema: brainstormSchema
        });

        const result = JSON.parse(response.text);
        console.log(`Brainstorm: suggest_plan=${result.suggest_plan}`);
        trackUsage(projectId, response.usage);

        // Persist stage 10 conversation (data key stays stage9 — don't rename data keys)
        if (!isInit) {
            try {
                await persistStageConversation(filePath, projectData, 'stage9', messages, result.message);
            } catch (saveErr) {
                console.error('Failed to persist rewrite conversation:', saveErr.message);
            }
        }

        res.json({ ...result, ...(savedSource && { savedSource }), ...(sourceMemory && { sourceMemory }) });
    } catch (error) {
        console.error('brainstorm-rewrite error:', error);
        const detail = publicErrorDetail(error);
        res.status(500).json({ error: detail ? `Brainstorm rewrite request failed: ${detail}` : 'Brainstorm rewrite request failed' });
    }
});

// Lightweight source alignment check for the current stage output.
app.post('/api/source-audit-stage', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, stageId, stageDataOverride, sceneNumber } = req.body;
        const numericStageId = Number(stageId);
        if (!isValidProjectId(projectId) || !numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Missing or invalid projectId or stageId' });
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const builtStage = await buildStageDataForAssistant(projectData, numericStageId, sceneNumber);
        const stageName = builtStage.stageName;
        const overrideText = stageDataOverrideToText(stageDataOverride);
        const stageData = overrideText === null ? builtStage.stageData : overrideText;
        const knowledge = ensureProjectKnowledge(projectData);
        const bibleSummary = sourceBibleSummary(knowledge);
        const sourceCount = knowledge.source_registry?.length || 0;
        const acceptedDivergenceCount = knowledge.accepted_divergences?.length || 0;
        const hasKnowledge = sourceCount || bibleSummary || knowledge.continuity_watchlist?.length || knowledge.decision_log?.length || acceptedDivergenceCount;

        if (!hasKnowledge) {
            return res.json({
                stageId: numericStageId,
                stageName,
                sourceCount: 0,
                acceptedDivergenceCount: 0,
                checkedAt: new Date().toISOString(),
                sourceReadiness: buildSourceReadiness(projectData, numericStageId, stageData),
                knowledge: knowledgePayloadForClient(knowledge, projectData),
                aligned_items: [],
                possible_source_mismatches: [],
                missing_source_elements: [],
                recommended_fixes: ['Add a source document through the stage chat attachment flow, then run the check again.']
            });
        }

        const knowledgeContext = buildKnowledgeContextBlock(projectData, {
            stageId: numericStageId,
            userMessage: `Audit Stage ${numericStageId} against persistent source material.`,
            stageName,
            stageData,
            maxChars: 18_000
        });
        const auditReferences = relevantSourceSegments(
            knowledge,
            `Audit Stage ${numericStageId} ${stageName}\n${compactText(stageData, 8_000)}`,
            6
        ).map(sourceReferenceForSegment);
        const auditSchema = {
            type: 'object',
            properties: {
                aligned_items: { type: 'array', items: { type: 'string' } },
                possible_source_mismatches: { type: 'array', items: { type: 'string' } },
                missing_source_elements: { type: 'array', items: { type: 'string' } },
                recommended_fixes: { type: 'array', items: { type: 'string' } }
            },
            required: ['aligned_items', 'possible_source_mismatches', 'missing_source_elements', 'recommended_fixes']
        };
        const prompt = `${knowledgeContext}

---

## CURRENT STAGE OUTPUT
Stage ${numericStageId}: ${stageName}
${compactText(stageData, 45_000)}

---

Compare the current stage output against the persistent source material above.
Be conservative: only flag a mismatch when the source context gives a concrete reason.
Do not flag a conflict that is already covered by an accepted source divergence in project memory.
When possible, include the source document name or id in each mismatch, missing element, or recommended fix.
Return concise, actionable findings.`;

        const modelCfg = getModelConfig(numericStageId);
        const response = await generateContent({
            model: modelCfg.model,
            geminiApiKey: modelCfg.geminiApiKey,
            anthropicApiKey: modelCfg.anthropicApiKey,
            contents: prompt,
            config: {
                systemInstruction: 'You are a source alignment editor for a screenplay development pipeline. Compare generated stage output against provided persistent source material. Do not invent canon that is not in the source context.',
                temperature: 0.2
            },
            schema: auditSchema
        });

        const audit = safeParse(response.text, null);
        if (!audit) throw new Error('Audit response was not valid JSON');
        const checkedAt = new Date().toISOString();
        const auditPayload = {
            stageId: numericStageId,
            stageName,
            sourceCount,
            acceptedDivergenceCount,
            checkedAt,
            source_references: auditReferences,
            aligned_items: audit.aligned_items || [],
            possible_source_mismatches: audit.possible_source_mismatches || [],
            missing_source_elements: audit.missing_source_elements || [],
            recommended_fixes: audit.recommended_fixes || []
        };
        recordStageSourceAudit(projectData, numericStageId, stageName, stageData, auditPayload, auditReferences, {
            sourceCount,
            acceptedDivergenceCount
        });
        const sourceReadiness = buildSourceReadiness(projectData, numericStageId, stageData);
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, response.usage);
        res.json({
            ...auditPayload,
            sourceReadiness,
            knowledge: knowledgePayloadForClient(ensureProjectKnowledge(projectData), projectData)
        });
    } catch (error) {
        console.error('source-audit-stage error:', error.message);
        res.status(500).json({ error: 'Failed to check stage against source material' });
    }
});

app.post('/api/source-readiness-stage', requireAuth, async (req, res) => {
    try {
        const { projectId, stageId, stageDataOverride, sceneNumber } = req.body || {};
        const numericStageId = Number(stageId);
        if (!isValidProjectId(projectId) || !numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Missing or invalid projectId or stageId' });
        }

        const content = await fs.readFile(getProjectFilePath(projectId), 'utf-8');
        const projectData = JSON.parse(content);
        const builtStage = await buildStageDataForAssistant(projectData, numericStageId, sceneNumber);
        const overrideText = stageDataOverrideToText(stageDataOverride);
        const stageData = overrideText === null ? builtStage.stageData : overrideText;
        const readiness = buildSourceReadiness(projectData, numericStageId, stageData);
        const gate = buildSourceReadinessGate(readiness);
        const knowledge = ensureProjectKnowledge(projectData);
        const audit = knowledge.stage_source_audits?.[sourcePlanCacheKey(numericStageId)] || null;

        res.json({
            stageId: numericStageId,
            stageName: builtStage.stageName,
            sourceReadiness: readiness,
            gate,
            sourceAudit: sourceAuditForClient(audit, readiness),
            knowledge: knowledgePayloadForClient(knowledge, projectData)
        });
    } catch (error) {
        console.error('source-readiness-stage error:', error.message);
        res.status(500).json({ error: 'Failed to inspect source readiness' });
    }
});

app.post('/api/source-plan-stage', requireAuth, async (req, res) => {
    try {
        const { projectId, stageId, stageDataOverride, sceneNumber } = req.body || {};
        const numericStageId = Number(stageId);
        if (!isValidProjectId(projectId) || !numericStageId || !STAGE_NAMES[numericStageId]) {
            return res.status(400).json({ error: 'Missing or invalid projectId or stageId' });
        }

        const content = await fs.readFile(getProjectFilePath(projectId), 'utf-8');
        const projectData = JSON.parse(content);
        const builtStage = await buildStageDataForAssistant(projectData, numericStageId, sceneNumber);
        const overrideText = stageDataOverrideToText(stageDataOverride);
        const stageData = overrideText === null ? builtStage.stageData : overrideText;
        const plan = buildSourceUsePlan(projectData, numericStageId, stageData);
        res.json({
            ...plan,
            sourceUsePlanText: formatSourceUsePlan(plan)
        });
    } catch (error) {
        console.error('source-plan-stage error:', error.message);
        res.status(500).json({ error: 'Failed to build source use plan' });
    }
});

app.post('/api/source-revise-stage', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, stageId, audit, stageDataOverride, sceneNumber, userInstruction } = req.body || {};
        const numericStageId = Number(stageId);
        const supportedStages = new Set([2, 3, 4, 5, 6, 8]);
        if (!isValidProjectId(projectId) || !supportedStages.has(numericStageId)) {
            return res.status(400).json({ error: 'Missing or unsupported projectId or stageId' });
        }
        if (!sourceAuditHasActionableItems(audit)) {
            return res.status(400).json({ error: 'Source audit has no actionable mismatch, missing element, or recommended fix' });
        }

        const filePath = getProjectFilePath(projectId);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const builtStage = await buildStageDataForAssistant(projectData, numericStageId, sceneNumber);
        const stageName = builtStage.stageName;
        const overrideText = stageDataOverrideToText(stageDataOverride);
        const stageData = overrideText === null ? builtStage.stageData : overrideText;
        const overrideData = parseStageOverride(stageDataOverride);
        const fixNotes = buildSourceAuditFixNotes(audit, {
            stageId: numericStageId,
            stageName,
            userInstruction
        });
        const sourcePacket = buildSourceGenerationPacket(projectData, numericStageId, `${stageData}\n${fixNotes}`, { userMessage: fixNotes });

        projectData.data = projectData.data || {};
        let result;
        let stageKey;
        let usagePayload;

        if (numericStageId === 2) {
            const pitchData = projectData.data.stage1_pitch?.pitch;
            if (!pitchData) return res.status(400).json({ error: 'Stage 1 Pitch is required before revising Stage 2' });
            const currentOutline = overrideData?.outline || projectData.data.stage2_outline?.outline || [];
            const seed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(currentOutline, null, 2)}\n${fixNotes}`;
            const generated = await agent2Outline(pitchData, currentOutline, fixNotes, null, getModelConfigWithSourcePacket(2, sourcePacket));
            result = generated.result;
            usagePayload = generated.usage;
            stageKey = 'stage2_outline';
            projectData.data.stage2_outline = result;
            stampRevised(projectData, stageKey);
        } else if (numericStageId === 3) {
            const pitchData = projectData.data.stage1_pitch?.pitch;
            const beatsData = projectData.data.stage2_outline?.outline;
            if (!pitchData || !beatsData) return res.status(400).json({ error: 'Stages 1 and 2 are required before revising Stage 3' });
            const currentCharacters = overrideData?.characters || projectData.data.stage3_characters?.characters || [];
            const seed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${JSON.stringify(currentCharacters, null, 2)}\n${fixNotes}`;
            const generated = await agent3Characters(pitchData, beatsData, currentCharacters, fixNotes, null, getModelConfigWithSourcePacket(3, sourcePacket));
            result = generated.result;
            usagePayload = generated.usage;
            stageKey = 'stage3_characters';
            projectData.data.stage3_characters = result;
            stampRevised(projectData, stageKey);
        } else if (numericStageId === 4) {
            const pitchData = projectData.data.stage1_pitch?.pitch;
            const beatsData = projectData.data.stage2_outline?.outline;
            const charsData = projectData.data.stage3_characters?.characters;
            if (!pitchData || !beatsData || !charsData) return res.status(400).json({ error: 'Stages 1-3 are required before revising Stage 4' });
            const currentBeats = overrideData || projectData.data.stage4_beats || null;
            const seed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${JSON.stringify(charsData, null, 2)}\n${JSON.stringify(currentBeats, null, 2)}\n${fixNotes}`;
            const generated = await agent4Beats(
                pitchData, beatsData, charsData, currentBeats, fixNotes, null,
                () => {},
                getModelConfigWithSourcePacket(4, sourcePacket)
            );
            result = generated.result;
            usagePayload = generated.usage;
            stageKey = 'stage4_beats';
            projectData.data.stage4_beats = result;
            stampRevised(projectData, stageKey);
        } else if (numericStageId === 5) {
            const pitchData = projectData.data.stage1_pitch?.pitch;
            const charactersData = projectData.data.stage3_characters?.characters;
            const beatsData = projectData.data.stage4_beats?.hybrid_beat_sheet;
            if (!pitchData || !charactersData || !beatsData) return res.status(400).json({ error: 'Stages 1, 3, and 4 are required before revising Stage 5' });
            const currentTreatment = overrideData || projectData.data.stage5_treatment || null;
            const seed = `${JSON.stringify(pitchData, null, 2)}\n${JSON.stringify(charactersData, null, 2)}\n${JSON.stringify(beatsData, null, 2)}\n${JSON.stringify(currentTreatment, null, 2)}\n${fixNotes}`;
            const generated = await agent5Treatment(
                pitchData, charactersData, beatsData, currentTreatment, fixNotes,
                () => {},
                getModelConfigWithSourcePacket(5, sourcePacket)
            );
            result = generated.result;
            usagePayload = generated.usageList;
            stageKey = 'stage5_treatment';
            projectData.data.stage5_treatment = result;
            stampRevised(projectData, stageKey);
        } else if (numericStageId === 6) {
            const currentBlueprint = overrideData || projectData.data.stage6_scenes;
            if (!currentBlueprint) return res.status(400).json({ error: 'Stage 6 Scene Blueprint is required before source revision' });
            const seed = `${JSON.stringify(currentBlueprint, null, 2)}\n${fixNotes}`;
            const generated = await reviseStage6Scenes(currentBlueprint, fixNotes, getModelConfigWithSourcePacket(6, sourcePacket));
            result = generated.result;
            usagePayload = generated.usage;
            stageKey = 'stage6_scenes';
            projectData.data.stage6_scenes = result;
            stampRevised(projectData, stageKey);
        } else if (numericStageId === 8) {
            const sceneNum = parseInt(sceneNumber, 10);
            if (!sceneNum) return res.status(400).json({ error: 'sceneNumber is required for Stage 8 source revision' });
            const targetedScene = findProjectScene(projectData, sceneNum);
            if (!targetedScene) return res.status(404).json({ error: `Scene ${sceneNum} not found in blueprint` });

            const overrideScene = Array.isArray(overrideData)
                ? overrideData.find(scene => Number(scene.scene_number) === sceneNum)
                : null;
            if (overrideScene?.draft_text) {
                targetedScene.draft_text = overrideScene.draft_text;
                targetedScene.humanized_draft_text = overrideScene.draft_text;
            }

            const missingFields = ['scene_heading', 'narrative_action', 'dramaturgical_function'].filter(field => !targetedScene[field]);
            if (missingFields.length > 0) {
                return res.status(400).json({ error: `Scene missing required fields: ${missingFields.join(', ')}` });
            }

            const projectContext = {
                synopsis: projectData.data.stage1_pitch?.pitch?.synopsis || '',
                characters: projectData.data.stage3_characters?.characters || []
            };
            clearSceneFacts(projectData, sceneNum);
            const continuityCtx = buildContinuityContext(projectData, sceneNum, targetedScene);
            const sceneLockPacket = buildStage8SceneLockPacket(projectData, sceneNum, targetedScene);
            const { styleContent, styleWarning } = await loadProjectStyle(projectData);
            const seed = `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(targetedScene, null, 2)}\n${fixNotes}`;
            const generated = await generateSceneDraft(targetedScene, projectContext, fixNotes, getModelConfigWithSourcePacket(8, sourcePacket), styleContent, continuityCtx, sceneLockPacket);
            const humanized = await humanizeDraft(generated.result, styleContent);
            targetedScene.draft_text = generated.result;
            targetedScene.humanized_draft_text = humanized.result;
            targetedScene.locked = false;
            const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
                humanized.result || generated.result,
                targetedScene,
                projectData,
                { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
            );
            applyCheckResult(projectData, checkResult, checkUsage);
            result = {
                scene_number: sceneNum,
                draft_text: generated.result,
                humanized_draft_text: humanized.result,
                continuityErrors: checkResult.errors || [],
                continuityWarnings: checkResult.warnings || [],
                ...(styleWarning && { styleWarning })
            };
            usagePayload = [generated.usage, humanized.usage, checkUsage].filter(Boolean);
            stageKey = 'stage6_scenes';
        }

        recordSourceGenerationUsage(projectData, sourcePacket, JSON.stringify(result, null, 2), 'source_audit_revision');
        const knowledge = ensureProjectKnowledge(projectData);
        const now = new Date().toISOString();
        boundedKnowledgePush(knowledge.decision_log, {
            at: now,
            type: 'source_audit_fixes_applied',
            stageId: numericStageId,
            stageName,
            summary: `Applied source audit fixes to ${stageName}: ${summarizeAuditForDecision(audit)}`,
            audit: compactAuditForKnowledge(audit)
        }, 120);
        const sourceReadiness = buildSourceReadiness(projectData, numericStageId);

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usagePayload);

        res.json({
            ok: true,
            stageId: numericStageId,
            stageName,
            stageKey,
            result,
            sourceFixSummary: summarizeAuditForDecision(audit),
            ...sourceResponseExtras(sourcePacket),
            sourceReadiness,
            knowledge: knowledgePayloadForClient(knowledge, projectData)
        });
    } catch (error) {
        console.error('source-revise-stage error:', error.message);
        res.status(500).json({ error: 'Failed to apply source audit fixes' });
    }
});

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
    return `${sourceBlock ? `${sourceBlock}\n---\n\n` : ''}## PROJECT\nTitle: ${title}${charBlock}${styleNote}\n\n## REWRITE TASK\n${priorityTask}${feedbackSection}${contextSection}\n\n## SCENE LIST\n${sceneList}`;
}

function buildStage10RewritePlannerSystemInstruction(plannerSop) {
    return buildMemorySourceSystemInstruction(plannerSop, 'Stage 10 Rewrite Plan');
}

// Audit scope: which scenes does this task affect?
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

        const plannerSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage10_planner.md'), 'utf8');
        const feedbackSection = userFeedback ? `\n\n## WRITER NOTES ON SCOPE\n${userFeedback}` : '';
        // Trim conversation context to last ~4000 chars to keep prompt manageable
        const trimmedContext = conversationContext && conversationContext.length > 4000
            ? '...\n' + conversationContext.slice(-4000)
            : conversationContext;
        const contextSection = trimmedContext ? `\n\n## BRAINSTORM CONTEXT\n${trimmedContext}` : '';
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charBlock = characters.length > 0
            ? `\n\n## CHARACTERS\n${characters.map(c => `${c.name} (${c.role}): arc=${c.arc?.direction || 'unknown'}, drive=${c.arc?.core_drive || 'unknown'}`).join('\n')}`
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
            // Persist deletion to disk immediately
            projectData.data = projectData.data || {};
            const stage9 = projectData.data.stage9_rewrites || { working: {}, priority_idx: 0, approved: false };
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNum] = '';
            projectData.data.stage9_rewrites = stage9;
            const deletionPacket = buildSourceGenerationPacket(projectData, 10, `${priorityTask}\n${plannedChange || ''}\n${sceneText}`, { userMessage: priorityTask });
            recordSourceGenerationUsage(projectData, deletionPacket, '', 'single_scene_delete');
            await writeJSONQueued(filePath, projectData);
            return res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: '', modified: true, ...sourceResponseExtras(deletionPacket) });
        }

        const { styleContent, referenceContent } = await loadProjectStyle(projectData);
        console.log(`Stage 10: rewriting scene ${sceneNumber} for task: "${priorityTask.slice(0, 60)}..."${referenceContent ? ' [with style compliance]' : ''}`);

        // Build character context for this scene
        const characters = projectData.data?.stage3_characters?.characters || [];
        const charProfiles = characters.length > 0
            ? characters.map(c => {
                const dp = c._deep_profile || {};
                return `${c.name} (${c.role}): voice=${c.voice_and_behavior?.voice_tag || 'unknown'}, pressure=${c.voice_and_behavior?.pressure_tag || 'unknown'}${dp.dialogue_fingerprint ? `\nDialogue rules: ${dp.dialogue_fingerprint}` : ''}`;
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

        // Persist pending rewrite to disk immediately so it survives page refresh
        if (modified) {
            projectData.data = projectData.data || {};
            const stage9 = projectData.data.stage9_rewrites || { working: {}, priority_idx: 0, approved: false };
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNum] = proposed;
            projectData.data.stage9_rewrites = stage9;
        }
        recordSourceGenerationUsage(projectData, sourcePacket, proposed, 'single_scene_rewrite');
        await writeJSONQueued(filePath, projectData);

        trackUsage(projectId, usage);
        res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: proposed, modified, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('rewrite-single-scene error:', error.message);
        res.status(500).json({ error: 'Failed to rewrite scene' });
    }
});

// Save approved pending changes and advance priority index
app.post('/api/approve-rewrite-priority', requireAuth, async (req, res) => {
    try {
        const { projectId, pendingScenes, newPriorityIdx } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        const stage9 = projectData.data?.stage9_rewrites || { working: {}, priority_idx: 0, approved: false };
        if (pendingScenes) {
            for (const [sceneNum, text] of Object.entries(pendingScenes)) {
                stage9.working[sceneNum] = text;
            }
        }
        stage9.pending = {};  // Clear pending — now merged into working
        stage9.priority_idx = newPriorityIdx;
        projectData.data.stage9_rewrites = stage9;
        await writeJSONQueued(filePath, projectData);

        res.json({ stage9_rewrites: stage9 });
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
        recordSourceGenerationUsage(projectData, sourcePacket, proposed_text, 'rewrite_feedback');
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);
        res.json({ proposed_text, ...(savedSource && { savedSource }), ...sourceResponseExtras(sourcePacket) });
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

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        if (projectData.data?.stage9_rewrites) {
            projectData.data.stage9_rewrites.approved = true;
        }
        await writeJSONQueued(filePath, projectData);
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
            if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
            filePath = path.join(DATA_DIR, `${projectId}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
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

        // Update project if within project context
        if (projectData && filePath) {
            projectData.data = projectData.data || {};
            projectData.data.stage7_style = slug;
            stampGenerated(projectData, 'stage7_style');
            recordSourceGenerationUsage(projectData, sourcePacket, styleContent, 'generation');
            await writeJSONQueued(filePath, projectData);
            if (projectId) trackUsage(projectId, usage);
        }

        res.json({ slug, content: styleContent, meta, ...sourceResponseExtras(sourcePacket) });
    } catch (error) {
        console.error('generate-stage7-style error:', error.message);
        res.status(500).json({ error: 'Failed to generate style' });
    }
});

// Preview a scene drafted in a specific style
app.post('/api/preview-style-scene', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, styleSlug, sceneIndex = 0 } = req.body;
        if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) return res.status(400).json({ error: 'Missing or invalid projectId or styleSlug' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        // Load style file — try new naming first, fall back to legacy
        let styleContent;
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
        } catch {
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
            } catch {
                return res.status(404).json({ error: `Style "${styleSlug}" not found` });
            }
        }

        // Get the target scene
        const allScenes = [];
        for (const seq of (projectData.data?.stage6_scenes || [])) {
            if (seq.scenes) allScenes.push(...seq.scenes);
        }
        allScenes.sort((a, b) => a.scene_number - b.scene_number);
        const scene = allScenes[sceneIndex] || allScenes[0];
        if (!scene) return res.status(400).json({ error: 'No scenes found in project' });

        const pitch = projectData.data?.stage1_pitch?.pitch;
        const projectContext = {
            synopsis: pitch?.synopsis || '',
            characters: projectData.data?.stage3_characters?.characters || []
        };
        const previewPacket = buildSourceGenerationPacket(projectData, 7, `${JSON.stringify(projectContext, null, 2)}\n${JSON.stringify(scene, null, 2)}`, { userMessage: 'Preview this scene in the selected style.' });

        // Use the Draft agent with style directives injected
        const draftSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage8_draft.md'), 'utf8');
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
        res.status(500).json({ error: 'Failed to preview style scene' });
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
        res.status(500).json({ error: 'Failed to list styles' });
    }
});

// Select an existing style for a project
app.post('/api/select-style', requireAuth, async (req, res) => {
    try {
        const { projectId, styleSlug } = req.body;
        if (!isValidProjectId(projectId) || !isValidSlug(styleSlug)) return res.status(400).json({ error: 'Missing or invalid projectId or styleSlug' });

        // Verify style exists — try new naming first, fall back to legacy
        let styleContent = null;
        try {
            styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}-directive.md`), 'utf-8');
        } catch {
            try {
                styleContent = await fs.readFile(path.join(STYLES_DIR, `${styleSlug}.md`), 'utf-8');
            } catch {
                return res.status(404).json({ error: `Style "${styleSlug}" not found` });
            }
        }

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);

        projectData.data = projectData.data || {};
        projectData.data.stage7_style = styleSlug;
        stampGenerated(projectData, 'stage7_style');
        await writeJSONQueued(filePath, projectData);

        const { meta } = parseStyleFile(styleContent);
        res.json({ slug: styleSlug, content: styleContent, meta });
    } catch (error) {
        console.error('select-style error:', error.message);
        res.status(500).json({ error: 'Failed to select style' });
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

        if (screenplayTexts.length === 0) {
            return res.status(400).json({ error: 'At least one screenplay file is required for trained style generation' });
        }

        let projectData = null;
        let filePath = null;
        let sourcePacket = null;
        if (projectId) {
            if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
            filePath = path.join(DATA_DIR, `${projectId}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            projectData = JSON.parse(content);
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
        res.status(500).json({ error: 'Failed to generate trained style' });
    }
});

// Get full style content (directive + reference if exists)
app.get('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
        let directive = null, reference = null;

        // Try new naming first, fall back to legacy
        try {
            directive = await fs.readFile(path.join(STYLES_DIR, `${slug}-directive.md`), 'utf-8');
        } catch {
            try {
                directive = await fs.readFile(path.join(STYLES_DIR, `${slug}.md`), 'utf-8');
            } catch {
                return res.status(404).json({ error: `Style "${slug}" not found` });
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
        res.status(500).json({ error: 'Failed to load style' });
    }
});

// Update a style's directive content
app.put('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        const { content } = req.body;
        if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
        if (!content) return res.status(400).json({ error: 'Missing content' });

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
                return res.status(404).json({ error: `Style "${slug}" not found` });
            }
        }

        await atomicWriteFile(filePath, content);
        const { meta } = parseStyleFile(content);
        res.json({ slug, meta });
    } catch (error) {
        console.error('update-style error:', error.message);
        res.status(500).json({ error: 'Failed to update style' });
    }
});

// Delete a style (removes both directive and reference files)
app.delete('/api/styles/:slug', requireAuth, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!isValidSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
        let deleted = false;

        // Delete all possible files for this slug
        for (const suffix of ['-directive.md', '-reference.md', '.md']) {
            try {
                await fs.unlink(path.join(STYLES_DIR, `${slug}${suffix}`));
                deleted = true;
            } catch { /* file doesn't exist, that's fine */ }
        }

        if (!deleted) return res.status(404).json({ error: 'Style not found' });
        res.json({ deleted: true, slug });
    } catch (error) {
        console.error('delete-style error:', error.message);
        res.status(500).json({ error: 'Failed to delete style' });
    }
});

// Lightweight brainstorm chat for style creation outside project context
app.post('/api/style-chat', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { messages, isInit } = req.body;
        const styleSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage7_style.md'), 'utf8');
        const brainstormSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_brainstorm.md'), 'utf8');

        let systemPrompt = `${brainstormSop}\n\n## STYLE SOP\n${styleSop}\n\n`;
        systemPrompt += `You are helping a writer create a style for their screenplay projects. You are NOT in a project context — there are no scenes to reference. Help them describe the style they want, then generate a directive when they're ready.

## RESPONSE FORMAT
Your response is structured JSON with these fields:
- message: Your conversational reply (string)
- suggest_plan: Set true when you have enough information to generate a style (boolean)
- execute_immediately: Set true ONLY when the writer has explicitly confirmed they want to generate. Agreement IS confirmation — "yes", "let's do it", "sounds good" after you offer to generate = true. Never set true on your own initiative without the writer's go-ahead.

When you have enough info to generate, ask: "Ready to generate this style?" (or similar). When the writer confirms, set both suggest_plan: true and execute_immediately: true. The system will auto-trigger generation — do NOT narrate the generation yourself.\n`;

        if (isInit) {
            systemPrompt += `\nThis is the start of the conversation. Open with: "Who do you want to write like? Name a writer, describe a vibe, or if you have a screenplay you'd like me to analyze, we can do that on the style detail page after creation."`;
        }

        // Load list of existing styles for context
        let existingStyles = [];
        try {
            const files = await fs.readdir(STYLES_DIR);
            for (const file of files) {
                if (!file.endsWith('-directive.md') && !file.endsWith('.md')) continue;
                if (file.endsWith('-reference.md')) continue;
                try {
                    const raw = await fs.readFile(path.join(STYLES_DIR, file), 'utf-8');
                    const { meta } = parseStyleFile(raw);
                    existingStyles.push(meta.name || file.replace(/-(directive)?\.md$/, ''));
                } catch {}
            }
        } catch {}

        if (existingStyles.length > 0) {
            systemPrompt += `\n\nExisting styles in the library: ${existingStyles.join(', ')}`;
        }

        // Load all project pitches for context
        let projectContext = '';
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
                projectContext = `\n\n## WRITER'S PROJECTS\nThe writer has these active projects:\n${pitches.join('\n')}\nIf they mention a project by name, tailor the style to that story.\n`;
                systemPrompt += projectContext;
            }
        } catch {}

        // For init, send a starter message so Gemini has content to respond to
        const contents = (isInit || !messages || messages.length === 0)
            ? 'Start the conversation. Introduce yourself and ask about their style needs.'
            : messages;

        const mc = getModelConfig(7);
        const { generateContent } = require('./agents/ai-client');
        const response = await generateContent({
            model: mc.model, geminiApiKey: mc.geminiApiKey, anthropicApiKey: mc.anthropicApiKey,
            contents,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.7,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        suggest_plan: { type: 'boolean' },
                        execute_immediately: { type: 'boolean' }
                    },
                    required: ['message', 'suggest_plan', 'execute_immediately']
                },
            }
        });

        const result = JSON.parse(response.text);
        console.log(`style-chat: suggest_plan=${result.suggest_plan} execute_immediately=${result.execute_immediately}`);
        res.json({ reply: result.message, execute_immediately: result.execute_immediately, usage: response.usage });
    } catch (error) {
        console.error('style-chat error:', error.message);
        res.status(500).json({ error: 'Style chat request failed' });
    }
});

// --- Settings Routes --- //

app.get('/api/settings', requireAuth, (req, res) => {
    res.json({
        geminiApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.geminiApiKey ? '***' : '',
        anthropicApiKey: RUNTIME_API_KEYS_ENABLED && appSettings.anthropicApiKey ? '***' : '',
        stageModels: appSettings.stageModels || {},
        runtimeApiKeysEnabled: RUNTIME_API_KEYS_ENABLED,
        apiKeysManagedByServer: !RUNTIME_API_KEYS_ENABLED
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
        res.status(500).json({ error: "Failed to load projects" });
    }
});

// GET single project
app.get('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });
        const filePath = path.join(DATA_DIR, `${id}.json`);

        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        const content = await fs.readFile(filePath, 'utf-8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Error reading project:", error);
        res.status(500).json({ error: "Failed to load project details" });
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
        res.status(500).json({ error: "Failed to create project" });
    }
});

// POST import script → create project with Stage 6/7 pre-populated
app.post('/api/import-script', requireAuth, upload.single('scriptFile'), async (req, res) => {
    try {
        const { parseFountain, parseFdx, parsePdfScript, buildStage6FromScenes } = require('./utils/script-import');
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

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
            return res.status(400).json({ error: `Unsupported file type: .${ext}. Use .fountain, .fdx, or .pdf` });
        }

        if (!parsed.scenes || parsed.scenes.length === 0) {
            return res.status(400).json({ error: 'No scenes found in the uploaded file' });
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
        res.status(500).json({ error: 'Failed to import script' });
    }
});

// PUT update project
app.put('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });
        const updates = req.body;

        try {
            await fs.access(getProjectFilePath(id));
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        const updatedProject = await updateProjectJSON(id, (projectData) => {
            // Ensure nested .data is merged properly rather than completely overwritten
            let mergedData = projectData.data || {};
            if (updates.data) {
                mergedData = { ...mergedData, ...updates.data };
            }

            const nextProject = { ...projectData, ...updates, data: mergedData };

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
        res.status(500).json({ error: "Failed to update project" });
    }
});

app.get('/api/projects/:id/knowledge', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });

        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        const projectData = JSON.parse(content);
        const knowledge = ensureProjectKnowledge(projectData);
        res.json({ knowledge: knowledgePayloadForClient(knowledge, projectData) });
    } catch (error) {
        console.error('knowledge load error:', error.message);
        res.status(500).json({ error: 'Failed to load project knowledge' });
    }
});

app.post('/api/projects/:id/knowledge/sources', requireAuth, upload.single('sourceFile'), async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });
        if (!req.file) return res.status(400).json({ error: 'No source file uploaded' });

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
                const err = new Error('No readable text could be extracted from this source file');
                err.statusCode = 400;
                throw err;
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
        res.status(error.statusCode || 500).json({ error: error.statusCode === 400 ? error.message : 'Failed to upload source' });
    }
});

app.get('/api/projects/:id/knowledge/sources/:sourceId/assets/:assetKind', requireAuth, async (req, res) => {
    try {
        const { id, sourceId, assetKind } = req.params;
        if (!isValidProjectId(id) || !/^src_[a-zA-Z0-9_]+$/.test(sourceId)) {
            return res.status(400).json({ error: 'Invalid project ID or source ID' });
        }
        if (!['extracted', 'original', 'text'].includes(assetKind)) {
            return res.status(400).json({ error: 'Invalid source asset type' });
        }

        const content = await fs.readFile(getProjectFilePath(id), 'utf-8');
        const projectData = JSON.parse(content);
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
        const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
        res.status(statusCode).json({
            error: statusCode === 404
                ? error.message
                : (statusCode === 400 ? error.message : 'Failed to load source asset')
        });
    }
});

app.delete('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
    try {
        const { id, sourceId } = req.params;
        if (!isValidProjectId(id) || !/^src_[a-zA-Z0-9_]+$/.test(sourceId)) {
            return res.status(400).json({ error: 'Invalid project ID or source ID' });
        }

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
        res.status(error.statusCode || 500).json({ error: error.statusCode === 404 ? 'Source not found' : 'Failed to delete source' });
    }
});

app.patch('/api/projects/:id/knowledge/sources/:sourceId', requireAuth, async (req, res) => {
    try {
        const { id, sourceId } = req.params;
        if (!isValidProjectId(id) || !/^src_[a-zA-Z0-9_]+$/.test(sourceId)) {
            return res.status(400).json({ error: 'Invalid project ID or source ID' });
        }

        const { type, tags } = req.body || {};
        if (type !== undefined && !SOURCE_TYPE_OPTIONS.has(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
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
        res.status(error.statusCode || 500).json({ error: error.statusCode === 404 ? 'Source not found' : 'Failed to update source' });
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
        if (!isValidProjectId(id)) return res.status(400).json({ error: 'Invalid project ID' });
        const filePath = path.join(DATA_DIR, `${id}.json`);

        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: "Project not found" });
        }

        await fs.unlink(filePath);
        await removeProjectSourceAssets(id).catch(error => {
            console.error('source asset cleanup error:', error.message);
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ error: "Failed to delete project" });
    }
});

// ─── Export Endpoints ─────────────────────────────────────────────────────────

async function loadProjectData(projectId) {
    if (!isValidProjectId(projectId)) throw Object.assign(new Error('Invalid project ID'), { status: 400 });
    const filePath = path.join(DATA_DIR, `${projectId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
}

// GET /api/export/docx/:projectId?stage=outline|characters|treatment|draft|coverage
app.get('/api/export/docx/:projectId', requireAuth, async (req, res) => {
    try {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
        const stage = req.query.stage || 'coverage';
        const project = await loadProjectData(projectId);
        const data = project.data || {};
        const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
        const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let buf, filename;

        if (stage === 'pitch') {
            const pitch = data.stage1_pitch?.pitch;
            if (!pitch) return res.status(400).json({ error: 'No pitch data found' });
            buf = await generatePitchDocx(pitch);
            filename = `${safeName}_pitch.docx`;

        } else if (stage === 'coverage') {
            if (!data.stage8_coverage) return res.status(400).json({ error: 'No coverage data found' });
            buf = await generateCoverageDocx(data.stage8_coverage);
            filename = `${safeName}_coverage.docx`;

        } else if (stage === 'outline') {
            const outline = data.stage2_outline?.outline;
            if (!outline) return res.status(400).json({ error: 'No outline data found' });
            buf = await generateOutlineDocx(outline, title);
            filename = `${safeName}_outline.docx`;

        } else if (stage === 'characters') {
            const chars = data.stage3_characters?.characters;
            if (!chars || !chars.length) return res.status(400).json({ error: 'No character data found' });
            buf = await generateCharactersDocx(chars, title);
            filename = `${safeName}_characters.docx`;

        } else if (stage === 'treatment') {
            if (!data.stage5_treatment) return res.status(400).json({ error: 'No treatment data found' });
            buf = await generateTreatmentDocx(data.stage5_treatment, title);
            filename = `${safeName}_treatment.docx`;

        } else if (stage === 'beats') {
            const beats = data.stage4_beats || data.stage4_treatment;
            if (!beats?.hybrid_beat_sheet) return res.status(400).json({ error: 'No beat sheet data found' });
            buf = await generateBeatsDocx(beats, title);
            filename = `${safeName}_beats.docx`;

        } else if (stage === 'scenes') {
            const seqs = data.stage6_scenes;
            if (!seqs || !seqs.length) return res.status(400).json({ error: 'No scene blueprint data found' });
            const sequences = Array.isArray(seqs) ? seqs : (seqs.sequences || []);
            buf = await generateScenesDocx(sequences, title);
            filename = `${safeName}_scene_blueprint.docx`;

        } else if (stage === 'draft') {
            const scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            const drafted = scenes.filter(s => s.draft_text || s.humanized_draft_text);
            if (!drafted.length) return res.status(400).json({ error: 'No drafted scenes found' });
            buf = await generateDraftDocx(drafted, title);
            filename = `${safeName}_draft.docx`;

        } else if (stage === 'rewrite') {
            const working = data.stage9_rewrites?.working;
            if (!working) return res.status(400).json({ error: 'No rewrite data found' });
            // Convert working object to scene-like array for draft export
            const fakescenes = Object.entries(working).map(([, txt]) => ({ humanized_draft_text: txt }));
            buf = await generateDraftDocx(fakescenes, title);
            filename = `${safeName}_rewrite.docx`;

        } else {
            return res.status(400).json({ error: `Unknown stage: ${stage}` });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('DOCX export error:', err);
        res.status(500).json({ error: 'Export failed' });
    }
});

// GET /api/export/pdf/:projectId?stage=draft|rewrite
app.get('/api/export/pdf/:projectId', requireAuth, async (req, res) => {
    try {
        const { projectId } = req.params;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
        const stage = req.query.stage || 'draft';
        const project = await loadProjectData(projectId);
        const data = project.data || {};
        const title = data.stage1_pitch?.pitch?.title || project.title || 'Untitled';
        const safeName = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let scenes;
        if (stage === 'rewrite') {
            const working = data.stage9_rewrites?.working;
            if (!working) return res.status(400).json({ error: 'No rewrite data found' });
            scenes = Object.entries(working)
                .sort(([a], [b]) => Number(a) - Number(b))
                .filter(([, txt]) => txt && txt.trim() !== '[SCENE DELETED]')
                .map(([, txt]) => ({ humanized_draft_text: txt }));
        } else {
            scenes = (data.stage6_scenes || []).flatMap(seq => seq.scenes || []);
            scenes = scenes.filter(s => s.draft_text || s.humanized_draft_text);
        }

        if (!scenes.length) return res.status(400).json({ error: 'No scenes to export' });

        const buf = await generateScreenplayPdf(scenes, title);
        const filename = `${safeName}_${stage}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (err) {
        console.error('PDF export error:', err);
        res.status(500).json({ error: 'Export failed' });
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
    updateKnowledgeSourceMetadata,
    updateKnowledgeReview,
    startServer
};
