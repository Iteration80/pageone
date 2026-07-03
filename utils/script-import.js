/**
 * script-import.js — Parse screenplay files into Stage 6 scene structure
 *
 * Supports:
 *   .fountain  → deterministic Fountain format parsing
 *   .fdx       → Final Draft XML parsing (via xml-js)
 *   .pdf       → text extraction + AI-assisted scene boundary detection
 */

const xmljs = require('xml-js');
const { parseJsonWithRepair } = require('../agents/json_parse');

// ─── Scene heading detection ────────────────────────────────────────────────

const SCENE_HEADING_RE = /^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.|EST\.)\s/i;
const FORCED_HEADING_RE = /^\./; // Fountain forced scene heading (single leading dot)

function isSceneHeading(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (SCENE_HEADING_RE.test(trimmed)) return true;
    if (FORCED_HEADING_RE.test(trimmed) && !trimmed.startsWith('..')) return true;
    return false;
}

// ─── Fountain parser ────────────────────────────────────────────────────────

function parseFountain(text) {
    const lines = text.split('\n');
    const scenes = [];
    let title = '';

    // Extract title from Fountain title page (Key: Value pairs before first blank line)
    let inTitlePage = true;
    let bodyStartIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (inTitlePage) {
            if (line === '') {
                inTitlePage = false;
                bodyStartIdx = i + 1;
                break;
            }
            const titleMatch = line.match(/^Title:\s*(.+)/i);
            if (titleMatch) title = titleMatch[1].trim();
        }
    }
    // If no title page found, start from beginning
    if (inTitlePage) bodyStartIdx = 0;

    // Split body into scenes by scene headings
    let currentHeading = '';
    let currentLines = [];

    for (let i = bodyStartIdx; i < lines.length; i++) {
        const line = lines[i];
        if (isSceneHeading(line.trim())) {
            // Save previous scene if we have one
            if (currentHeading) {
                scenes.push({
                    scene_heading: currentHeading,
                    text: (currentHeading + '\n' + currentLines.join('\n')).trim()
                });
            }
            currentHeading = line.trim().replace(/^\./, ''); // Remove forced heading marker
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    // Don't forget the last scene
    if (currentHeading) {
        scenes.push({
            scene_heading: currentHeading,
            text: (currentHeading + '\n' + currentLines.join('\n')).trim()
        });
    }

    // Number scenes sequentially
    scenes.forEach((s, i) => { s.scene_number = i + 1; });

    return { title, scenes };
}

// ─── FDX (Final Draft) parser ───────────────────────────────────────────────

function parseFdx(xmlString) {
    let parsed;
    try {
        parsed = xmljs.xml2js(xmlString, { compact: true });
    } catch (e) {
        throw new Error('Invalid FDX file: ' + e.message);
    }

    const doc = parsed?.FinalDraft;
    if (!doc) throw new Error('Invalid FDX file: missing FinalDraft root element');

    // Extract title from TitlePage if present
    let title = '';
    const titlePage = doc.TitlePage;
    if (titlePage?.Content?.Paragraph) {
        const paragraphs = Array.isArray(titlePage.Content.Paragraph)
            ? titlePage.Content.Paragraph
            : [titlePage.Content.Paragraph];
        for (const p of paragraphs) {
            const text = extractFdxText(p);
            if (text && !title) { title = text; break; }
        }
    }

    // Extract body paragraphs
    const content = doc.Content;
    if (!content?.Paragraph) throw new Error('Invalid FDX file: no content paragraphs');

    const paragraphs = Array.isArray(content.Paragraph)
        ? content.Paragraph
        : [content.Paragraph];

    const scenes = [];
    let currentHeading = '';
    let currentFountainLines = [];

    for (const p of paragraphs) {
        const type = p._attributes?.Type || '';
        const text = extractFdxText(p);

        if (type === 'Scene Heading' && text) {
            // Save previous scene
            if (currentHeading) {
                scenes.push({
                    scene_heading: currentHeading,
                    text: (currentHeading + '\n' + currentFountainLines.join('\n')).trim()
                });
            }
            currentHeading = text.toUpperCase();
            currentFountainLines = [];
        } else if (currentHeading) {
            // Convert FDX paragraph types to Fountain formatting
            const fountainLine = fdxTypeToFountain(type, text);
            if (fountainLine !== null) currentFountainLines.push(fountainLine);
        }
    }
    // Last scene
    if (currentHeading) {
        scenes.push({
            scene_heading: currentHeading,
            text: (currentHeading + '\n' + currentFountainLines.join('\n')).trim()
        });
    }

    scenes.forEach((s, i) => { s.scene_number = i + 1; });
    return { title, scenes };
}

function extractFdxText(paragraph) {
    if (!paragraph?.Text) return '';
    const texts = Array.isArray(paragraph.Text) ? paragraph.Text : [paragraph.Text];
    return texts.map(t => {
        if (typeof t === 'string') return t;
        if (t._text) return t._text;
        if (t._cdata) return t._cdata;
        return '';
    }).join('').trim();
}

function fdxTypeToFountain(type, text) {
    if (!text) return '';
    switch (type) {
        case 'Action':           return '\n' + text;
        case 'Character':        return '\n' + text.toUpperCase();
        case 'Dialogue':         return text;
        case 'Parenthetical':    return `(${text.replace(/^\(/, '').replace(/\)$/, '')})`;
        case 'Transition':       return '\n' + text.toUpperCase();
        case 'Shot':             return '\n' + text.toUpperCase();
        case 'General':          return text;
        default:                 return text;
    }
}

// ─── PDF parser (AI-assisted) ───────────────────────────────────────────────

async function parsePdfScript(pdfBuffer, modelConfig = {}) {
    const pdfParse = require('pdf-parse');
    const { generateContent } = require('../agents/ai-client');

    const pdfData = await pdfParse(pdfBuffer);
    const rawText = pdfData.text;

    if (!rawText || rawText.trim().length < 100) {
        throw new Error('PDF appears to be empty or could not be parsed');
    }

    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY
    } = modelConfig;

    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            scenes: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        scene_number: { type: 'number' },
                        scene_heading: { type: 'string' },
                        text: { type: 'string' }
                    },
                    required: ['scene_number', 'scene_heading', 'text']
                }
            }
        },
        required: ['title', 'scenes']
    };

    const response = await generateContent({
        model, geminiApiKey, anthropicApiKey,
        contents: `Parse this screenplay text into individual scenes. For each scene, extract the scene heading (slugline) and the full text of that scene including the heading. Number scenes sequentially starting from 1. Also extract the title if present.\n\nSCREENPLAY TEXT:\n${rawText}`,
        config: {
            systemInstruction: 'You are a screenplay parser. Extract scene boundaries from raw text. Scene headings typically start with INT., EXT., I/E., or EST. Return valid JSON only.',
            temperature: 0.1,
        },
        schema
    });

    const result = parseJsonWithRepair(response.text, { schema, label: 'PDF screenplay parser response' });
    return { title: result.title || '', scenes: result.scenes || [] };
}

// ─── Build Stage 6 structure from parsed scenes ────────────────────────────

const LINES_PER_PAGE = 55; // Rough Fountain estimate

function buildStage6FromScenes(scenes) {
    // Estimate page counts
    scenes.forEach(s => {
        const lineCount = (s.text || '').split('\n').length;
        s.estimated_page_count = Math.max(1, Math.round(lineCount / LINES_PER_PAGE * 10) / 10);
    });

    // Group scenes into ~8 sequences (roughly equal page distribution)
    const totalPages = scenes.reduce((sum, s) => sum + s.estimated_page_count, 0);
    const targetPagesPerSeq = totalPages / 8;

    const sequences = [];
    let currentSeq = { scenes: [], pages: 0 };

    for (const scene of scenes) {
        currentSeq.scenes.push(scene);
        currentSeq.pages += scene.estimated_page_count;

        // Start a new sequence if we've hit the target (but don't exceed 8 sequences)
        if (currentSeq.pages >= targetPagesPerSeq && sequences.length < 7) {
            sequences.push(currentSeq);
            currentSeq = { scenes: [], pages: 0 };
        }
    }
    // Push remaining scenes
    if (currentSeq.scenes.length > 0) {
        sequences.push(currentSeq);
    }

    // Build Stage 6 array
    return sequences.map((seq, idx) => ({
        sequence_number: idx + 1,
        sequence_title: `Sequence ${idx + 1}`,
        total_estimated_pages: Math.round(seq.pages * 10) / 10,
        scenes: seq.scenes.map(s => ({
            scene_number: s.scene_number,
            scene_heading: s.scene_heading,
            narrative_action: '',
            dramaturgical_function: '',
            estimated_page_count: s.estimated_page_count,
            draft_text: s.text,
            humanized_draft_text: s.text
        }))
    }));
}

module.exports = { parseFountain, parseFdx, parsePdfScript, buildStage6FromScenes };
