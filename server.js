require('dotenv').config();
const { setGlobalDispatcher, Agent } = require('undici');
setGlobalDispatcher(new Agent({ headersTimeout: 300_000, bodyTimeout: 300_000 }));
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
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
        if (mime === 'text/plain' || name.endsWith('.txt')) {
            return buf.toString('utf8');
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
const { stampGenerated, stampRevised, buildSourceAuthorityBlock } = require('./utils/stageMetadata');

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

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const multer = require('multer');
const ALLOWED_UPLOAD_MIMES = new Set([
    'application/pdf',
    'text/plain',
    'application/octet-stream',        // .fountain / .fdx often land here
    'text/x-fountain',
    'application/x-fountain',
    'application/xml',
    'text/xml',
    'application/vnd.ms-word',
]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB hard cap
    fileFilter(_req, file, cb) {
        const ext = (file.originalname || '').split('.').pop().toLowerCase();
        const allowed = ['pdf', 'txt', 'fountain', 'fdx', 'docx'];
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
        const { prompt } = req.body;
        const pdfFile = req.file;

        // Validation intentionally omitted — allows random pitch generation with no input

        console.log("Generating pitch options...");
        const { result, usage } = await agent1Pitch(prompt, pdfFile, getModelConfig(1));
        res.json({ result });
    } catch (error) {
        console.error("Error executing agent:", error);
        res.status(500).json({ error: "Failed to generate pitch" });
    }
});

app.post('/api/refine-pitch', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { currentPitch, userNote } = req.body || {};
        const pdfFile = req.file;

        if (!currentPitch || !userNote) {
            return res.status(400).json({ error: "Missing currentPitch or userNote" });
        }

        // currentPitch might be a string if sent via FormData
        const parsedPitch = safeParse(currentPitch);
        if (!parsedPitch) return res.status(400).json({ error: "Invalid currentPitch JSON" });

        console.log("Revising pitch...");
        const { result, usage } = await agent1Refine(JSON.stringify(parsedPitch), userNote, pdfFile, getModelConfig(1));
        res.json({ result });
    } catch (error) {
        console.error("Error executing refine agent:", error);
        res.status(500).json({ error: "Failed to refine pitch" });
    }
});

app.post('/api/generate-outline', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentBeats, notes } = req.body;
        const pdfFile = req.file;

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

        console.log("Generating Stage 2 Outline...");
        const { result: outlineData, usage } = await agent2Outline(stage1, parsedBeats, notes, pdfFile, getModelConfig(2));

        // Save to Stage 2
        projectData.data = projectData.data || {};
        projectData.data.stage2_outline = outlineData;
        notes ? stampRevised(projectData, 'stage2_outline') : stampGenerated(projectData, 'stage2_outline');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        res.json({ result: outlineData });
    } catch (error) {
        console.error('Outline Gen Error:', error);
        res.status(500).json({ error: "Failed to generate outline" });
    }
});

app.post('/api/generate-characters', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    try {
        const { projectId, currentCharacters, notes } = req.body;
        const pdfFile = req.file;

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

        console.log("Generating Stage 3 Characters...");
        const { result: characterData, usage } = await agent3Characters(pitchData, beatsData, parsedChars, notes, pdfFile, getModelConfig(3));

        // Save to Stage 3
        projectData.data = projectData.data || {};
        projectData.data.stage3_characters = characterData;
        notes ? stampRevised(projectData, 'stage3_characters') : stampGenerated(projectData, 'stage3_characters');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        res.json({ result: characterData });
    } catch (error) {
        console.error('Character Gen Error:', error);
        res.status(500).json({ error: "Failed to generate characters" });
    }
});

app.post('/api/generate-stage4-beats', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId, currentBeats, notes } = req.body || {};
    const pdfFile = req.file;

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

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log("Generating Stage 4 Beats...");
        const { result: beatsResult, usage } = await agent4Beats(
            pitchData, beatsData, charsData, parsedCurrentBeats, notes, pdfFile,
            (label) => send({ type: 'progress', label }),
            getModelConfig(4)
        );

        console.log("Beats generated successfully. Beat sheet length:", beatsResult.hybrid_beat_sheet?.length || 0);

        projectData.data = projectData.data || {};
        projectData.data.stage4_beats = beatsResult;
        notes ? stampRevised(projectData, 'stage4_beats') : stampGenerated(projectData, 'stage4_beats');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        send({ type: 'complete', result: beatsResult });
    } catch (error) {
        console.error('Stage 4 Beats Gen Error:', error.message);
        send({ type: 'error', message: 'Failed to generate beats' });
    } finally {
        res.end();
    }
});

app.post('/api/generate-stage5-treatment', requireAuth, aiLimiter, upload.single('pdfFile'), async (req, res) => {
    const { projectId } = req.body || {};
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
        const { result: treatmentResult, usageList } = await agent5Treatment(
            pitchData, charactersData, beatsData, parsedTreatment, notes,
            (step, total, label) => send({ type: 'progress', step, total, label }),
            getModelConfig(5)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage5_treatment = treatmentResult;
        notes ? stampRevised(projectData, 'stage5_treatment') : stampGenerated(projectData, 'stage5_treatment');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: treatmentResult });
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
    const { projectId } = req.body;
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

    try {
        console.log("Generating Stage 6 Scene Blueprint (Sequential Chain)...");
        const sourceAuthorityBlock = buildSourceAuthorityBlock(projectData, 'stage6_scenes');
        if (sourceAuthorityBlock) {
            console.log("Stage 6: upstream revisions detected, injecting source authority block.");
        }

        const { result: allSequences, usageList } = await generateStage6Scenes(
            pitch, characters, beats, treatment,
            (current, total) => send({ type: 'progress', current, total }),
            sourceAuthorityBlock,
            getModelConfig(6)
        );

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = allSequences;
        stampGenerated(projectData, 'stage6_scenes');
        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        send({ type: 'complete', result: allSequences });
    } catch (error) {
        console.error('Stage 6 Scene Gen Error:', error.message);
        send({ type: 'error', message: 'Failed to generate scene blueprint' });
    } finally {
        res.end();
    }
});

app.post('/api/revise-stage6', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, feedback } = req.body;
        if (!isValidProjectId(projectId) || !feedback) {
            return res.status(400).json({ error: "Missing or invalid projectId, or missing feedback" });
        }

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

        console.log("Revising Stage 6 Scene Blueprint...");
        const { result: updatedBlueprint, usage } = await reviseStage6Scenes(currentBlueprint, feedback, getModelConfig(6));

        projectData.data = projectData.data || {};
        projectData.data.stage6_scenes = updatedBlueprint;
        stampRevised(projectData, 'stage6_scenes');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usage);

        res.json({ result: updatedBlueprint });
    } catch (error) {
        console.error('Stage 6 Revision Error:', error.message);
        res.status(500).json({ error: "Failed to revise scene blueprint" });
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

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Generating draft for Scene ${sceneNum}...`);
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, null, getModelConfig(8), styleContent, continuityCtx);

        console.log(`Humanizing draft for Scene ${sceneNum}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;

        console.log(`Running continuity check for Scene ${sceneNum}...`);
        const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
            humanizedText || draftText, targetedScene, projectData,
            { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
        );
        applyCheckResult(projectData, checkResult, checkUsage);

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const response = { result: humanizedText, ...(styleWarning && { styleWarning }) };
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

        const { styleContent, styleWarning } = await loadProjectStyle(projectData);
        console.log(`Revising draft for Scene ${sceneNum}...`);
        const { result: draftText, usage: draftUsage } = await generateSceneDraft(targetedScene, projectContext, feedback, getModelConfig(8), styleContent, continuityCtx);

        console.log(`Humanizing revised draft for Scene ${sceneNum}...`);
        const { result: humanizedText, usage: humanizeUsage } = await humanizeDraft(draftText);

        targetedScene.draft_text = draftText;
        targetedScene.humanized_draft_text = humanizedText;
        targetedScene.locked = false;

        console.log(`Running continuity check for Scene ${sceneNum}...`);
        const { result: checkResult, usage: checkUsage } = await runContinuityCheck(
            humanizedText || draftText, targetedScene, projectData,
            { geminiApiKey: getModelConfig(8).geminiApiKey, anthropicApiKey: getModelConfig(8).anthropicApiKey }
        );
        applyCheckResult(projectData, checkResult, checkUsage);

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, [draftUsage, humanizeUsage, checkUsage].filter(Boolean));

        const response = { result: humanizedText, ...(styleWarning && { styleWarning }) };
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
        const { result: coverageResult, usageList } = await agent8Coverage(fullScriptText, projectContext, getModelConfig(9));

        projectData.data = projectData.data || {};
        projectData.data.stage8_coverage = coverageResult;
        stampGenerated(projectData, 'stage8_coverage');

        await writeJSONQueued(filePath, projectData);
        trackUsage(projectId, usageList);

        res.json({ result: coverageResult });
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
        const content = await fs.readFile(filePath, 'utf-8');
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
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const stageNames = {
            1: 'Pitch Generation', 2: 'Outline', 3: 'Characters',
            4: 'Beats', 5: 'Treatment', 6: 'Scene Blueprint',
            7: 'Style', 8: 'Draft', 9: 'Coverage', 10: 'Rewrite'
        };

        let stageData;
        switch (stageId) {
            case 1: stageData = JSON.stringify(projectData.data?.stage1_pitch?.pitch || {}, null, 2); break;
            case 2: stageData = JSON.stringify(projectData.data?.stage2_outline?.outline || [], null, 2); break;
            case 3: stageData = JSON.stringify(projectData.data?.stage3_characters?.characters || [], null, 2); break;
            case 4: stageData = JSON.stringify(projectData.data?.stage4_beats || [], null, 2); break;
            case 5: {
                const t = projectData.data?.stage5_treatment || {};
                stageData = [t.act_1, t.act_2a, t.act_2b, t.act_3].filter(Boolean).join('\n\n---\n\n');
                break;
            }
            case 6: stageData = JSON.stringify(projectData.data?.stage6_scenes || [], null, 2); break;
            case 7: {
                // Style stage — provide current style file content if one exists
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
                    } catch { stageData = 'No style file loaded yet.'; }
                } else {
                    stageData = 'No style selected yet. Help the writer define their style.';
                }
                // Include scene summaries for context-aware suggestions
                const s6 = projectData.data?.stage6_scenes || [];
                if (s6.length > 0) {
                    const sceneSummaries = [];
                    for (const seq of s6) {
                        if (seq.scenes) for (const sc of seq.scenes) {
                            sceneSummaries.push(`Scene ${sc.scene_number}: ${sc.scene_heading || sc.slugline || ''} — ${sc.narrative_action || ''}`);
                        }
                    }
                    if (sceneSummaries.length) stageData += `\n\nStory scenes for context:\n${sceneSummaries.join('\n')}`;
                }
                break;
            }
            case 8: {
                // Draft stage — load scene text for chat context
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
            default: return res.status(400).json({ error: `Unknown stageId: ${stageId}` });
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

        let conversationPrompt = `## PROJECT: ${title}\n\n## STAGE ${stageId} — ${stageNames[stageId]}\n${stageData}\n\n---\n\n`;
        if (priorContext) conversationPrompt += `## PREVIOUS STAGE CONVERSATIONS\n${priorContext}\n---\n\n`;
        if (attachment) {
            const fileText = await extractAttachmentText(attachment);
            if (fileText?.trim()) conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${fileText.trim()}\n\n---\n\n`;
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

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: conversationPrompt,
            config: {
                systemInstruction,
                temperature: 0.7,
                responseMimeType: 'application/json',
                responseSchema: { type: 'object', properties: { message: { type: 'string' }, suggest_plan: { type: 'boolean' }, execute_immediately: { type: 'boolean' } }, required: ['message', 'suggest_plan', 'execute_immediately'] },
            },
        });
        const result = JSON.parse(response.text);
        console.log(`Brainstorm stage${stageId}: suggest_plan=${result.suggest_plan} execute_immediately=${result.execute_immediately}`);
        const brainstormUsage = {
            model: 'gemini-3-flash-preview',
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        };
        trackUsage(projectId, brainstormUsage);

        // Persist the full conversation (current session + new exchange) to project file
        // Skip persistence for init messages — they are ephemeral and regenerated on each visit
        if (!isInit) {
            try {
                const stageKey = `stage${stageId}`;
                const convos = projectData.data.conversations || {};
                const updated = [...messages, { role: 'assistant', content: result.message }];
                // Cap conversation history to prevent unbounded memory growth
                const MAX_HISTORY = 100;
                convos[stageKey] = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;
                projectData.data.conversations = convos;
                await writeJSONQueued(filePath, projectData);
            } catch (saveErr) {
                console.error('Failed to persist conversation:', saveErr.message);
            }
        }

        res.json(result);
    } catch (error) {
        console.error('brainstorm error:', error.message);
        res.status(500).json({ error: 'Brainstorm request failed' });
    }
});

// Conversational brainstorm: editorial assistant helps writer clarify rewrite direction
app.post('/api/brainstorm-rewrite', requireAuth, aiLimiter, async (req, res) => {
    try {
        const { projectId, messages = [], isInit = false, attachment } = req.body;
        if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Missing or invalid projectId' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
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

        // Build conversation as a single prompt string
        let conversationPrompt = contextBlock + '\n\n---\n\n';
        if (attachment && !isInit) {
            const fileText = await extractAttachmentText(attachment);
            if (fileText?.trim()) conversationPrompt += `## ATTACHED FILE: ${attachment.name}\n${fileText.trim()}\n\n---\n\n`;
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

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: conversationPrompt,
            config: {
                systemInstruction: brainstormSop,
                temperature: 0.7,
                responseMimeType: 'application/json',
                responseSchema: brainstormSchema,
            },
        });

        const result = JSON.parse(response.text);
        console.log(`Brainstorm: suggest_plan=${result.suggest_plan}`);
        const brainstormUsage = {
            model: 'gemini-3-flash-preview',
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        };
        trackUsage(projectId, brainstormUsage);

        // Persist stage 10 conversation (data key stays stage9 — don't rename data keys)
        if (!isInit) {
            try {
                const convos = projectData.data.conversations || {};
                const updated = [...messages, { role: 'assistant', content: result.message }];
                const MAX_HISTORY = 100;
                convos['stage9'] = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;
                projectData.data.conversations = convos;
                await writeJSONQueued(filePath, projectData);
            } catch (saveErr) {
                console.error('Failed to persist rewrite conversation:', saveErr.message);
            }
        }

        res.json(result);
    } catch (error) {
        console.error('brainstorm-rewrite error:', error.message);
        res.status(500).json({ error: 'Brainstorm rewrite request failed' });
    }
});

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

        // Send scene headings only — the planner just needs to know which scenes exist
        const sceneList = allScenes
            .map(s => `SCENE ${s.scene_number} — ${s.scene_heading || s.slugline || ''}`)
            .join('\n');

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
        const prompt = `## PROJECT\nTitle: ${title}${charBlock}${styleNote}\n\n## REWRITE TASK\n${priorityTask}${feedbackSection}${contextSection}\n\n## SCENE LIST\n${sceneList}`;

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
                systemInstruction: plannerSop,
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseSchema: plannerSchema,
            },
        });
        console.log(`plan-rewrite succeeded in ${((Date.now()-t0)/1000).toFixed(1)}s`);

        const plan = JSON.parse(response.text);
        console.log(`Stage 10 plan: ${plan.affected_scenes.length} scenes affected.`);
        if (response.usage) trackUsage(projectId, response.usage);
        res.json(plan);
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

        const results = await Promise.allSettled(
            scopedScenes.map(s => {
                const sceneText = working[s.scene_number] || s.humanized_draft_text || s.draft_text || '';
                return rewriteScene(sceneText, priorityTask, {
                    title,
                    sceneNumber: s.scene_number,
                    slugline: s.slugline || s.scene_heading || '',
                }, '', getModelConfig(10), styleContent, referenceContent).then(({ result: proposed, usage }) => ({ scene_number: s.scene_number, original_text: sceneText, proposed_text: proposed, usage }));
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
        trackUsage(projectId, usages);

        res.json({ scenes });
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
                sceneMeta = seq.scenes.find(s => s.scene_number === sceneNumber);
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
            const stage9 = projectData.data.stage9_rewrites || {};
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNum] = '';
            await writeJSONQueued(filePath, projectData);
            return res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: '', modified: true });
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

        const { result: proposed, usage } = await rewriteScene(
            sceneText, priorityTask,
            { title, sceneNumber: sceneNum, slugline, characters: charProfiles },
            plannedChange || '',
            getModelConfig(10),
            styleContent,
            referenceContent
        );

        const modified = proposed.trim() !== sceneText.trim();

        // Persist pending rewrite to disk immediately so it survives page refresh
        if (modified) {
            const stage9 = projectData.data.stage9_rewrites || {};
            stage9.pending = stage9.pending || {};
            stage9.pending[sceneNum] = proposed;
            await writeJSONQueued(filePath, projectData);
        }

        trackUsage(projectId, usage);
        res.json({ scene_number: sceneNum, original_text: sceneText, proposed_text: proposed, modified });
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
        const { projectId, sceneNumber, priorityTask, userFeedback, currentText } = req.body;
        if (!isValidProjectId(projectId) || !priorityTask || !currentText) return res.status(400).json({ error: 'Missing required fields' });

        const filePath = path.join(DATA_DIR, `${projectId}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const projectData = JSON.parse(content);
        const pitch = projectData.data?.stage1_pitch?.pitch;
        const title = pitch?.title || projectData.title || 'Untitled';

        const { result: proposed_text, usage } = await rewriteScene(currentText, priorityTask, { title, sceneNumber }, userFeedback, getModelConfig(10));
        trackUsage(projectId, usage);
        res.json({ proposed_text });
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
        const { result: styleContent, usage } = await generateStyleFile({
            description: description || '',
            sceneSummaries,
            conversationHistory
        }, getModelConfig(7));

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
            await writeJSONQueued(filePath, projectData);
            if (projectId) trackUsage(projectId, usage);
        }

        res.json({ slug, content: styleContent, meta });
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

        // Use the Draft agent with style directives injected
        const draftSop = require('fs').readFileSync(path.join(__dirname, 'skills/skill_stage8_draft.md'), 'utf8');
        const prompt = `${draftSop}

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

        trackUsage(projectId, response.usage);
        res.json({ sceneNumber: scene.scene_number, previewText: response.text });
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
                const ext = (file.originalname || '').split('.').pop().toLowerCase();
                const title = file.originalname.replace(/\.[^.]+$/, '');
                screenplayTitles.push(title);
                if (ext === 'pdf') {
                    const pdfParse = require('pdf-parse');
                    const parsed = await pdfParse(file.buffer);
                    screenplayTexts.push(parsed.text);
                } else {
                    screenplayTexts.push(file.buffer.toString('utf-8'));
                }
            }
        }

        if (screenplayTexts.length === 0) {
            return res.status(400).json({ error: 'At least one screenplay file is required for trained style generation' });
        }

        console.log(`Generating Tier 3 trained style from ${screenplayTexts.length} screenplay(s)...`);
        const { reference, directive, usageList } = await generateTrainedStyle({
            styleName: styleName || '',
            screenplayTexts,
            screenplayTitles,
            conversationHistory
        }, getModelConfig(7));

        // Extract slug from reference metadata
        const { meta: refMeta } = parseStyleFile(reference);
        const slug = await uniqueStyleSlug(refMeta.slug || refMeta.name || styleName || 'trained-style');

        // Save both files atomically
        await atomicWriteFile(path.join(STYLES_DIR, `${slug}-reference.md`), reference);
        await atomicWriteFile(path.join(STYLES_DIR, `${slug}-directive.md`), directive);

        // Update project if within project context
        if (projectId) {
            if (!isValidProjectId(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
            const filePath = path.join(DATA_DIR, `${projectId}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            const projectData = JSON.parse(content);
            projectData.data = projectData.data || {};
            projectData.data.stage7_style = slug;
            stampGenerated(projectData, 'stage7_style');
            await writeJSONQueued(filePath, projectData);
            trackUsage(projectId, usageList);
        }

        const { meta } = parseStyleFile(directive);
        res.json({ slug, directive, reference, meta, tier: 'trained' });
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

// ─────────────────────────────────────────────────────────────────────────────

// ─── Startup checks ───────────────────────────────────────────────────────────
(async () => {
    await initDb();
    await loadSettings();

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
})();
