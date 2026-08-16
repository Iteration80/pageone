/**
 * utils/style_store.js — the style library's ownership chokepoint (multi-user Phase 3).
 *
 * Styles are `.md` files in STYLES_DIR (`<slug>-directive.md`, an optional
 * `<slug>-reference.md` for trained styles, or a legacy `<slug>.md`). Before this
 * module every route and helper resolved those paths itself — fourteen call sites
 * across server.js and routes/styles.js — and every one of them served every style
 * to every signed-in user. Same shape as the project problem Phase 2 closed, and the
 * same fix: put the check where the file is resolved, so a route cannot forget it.
 *
 * Two kinds of style, one discriminator:
 *
 *   SHARED   — bundled with the app (BUNDLED_STYLES_DIR, seeded into STYLES_DIR at
 *              startup). Read-only for every signed-in person, visible to all.
 *   PRIVATE  — created by a person. Carries `owner: <email>` in its front matter,
 *              stamped by the server at creation. Visible to, and editable by, its
 *              owner only.
 *
 * ⚠️ "Bundled" is decided by FILENAME in BUNDLED_STYLES_DIR, not by the `tier:`
 * front-matter line or the Preset badge. The bundle ships two trained styles and one
 * conversational one alongside the presets, and a tier is a claim the model authors.
 * A migration that stamped owners by tier would either privatise those three for
 * everyone or leave a stamped preset hidden from every tester.
 *
 * ⚠️ AN UNOWNED PRIVATE STYLE FAILS CLOSED, exactly like an unowned project. A style
 * created before Phase 3 has no owner line; treating "no owner" as "everyone's" is
 * the silent hole this phase closes. So on any deployment with user-created styles
 * the migration (`npm run migrate:style-owners`, or the admin maintenance route)
 * must run right after deploy — until it does those styles are invisible and any
 * project drafting with one drafts without it. Loud and reversible, not a leak.
 *
 * Read refusals are 404, never 403 — a 403 confirms a private style exists, and a
 * slug is guessable. Bundled styles are visible to everyone, so a write refusal
 * there is an honest 403.
 *
 * Break-glass (`secret`) and open dev mode carry no scoped identity and see and
 * edit everything, as they do for projects (utils/request_identity.js).
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { hasScopedIdentity, currentUserEmail } = require('./request_identity');
const { parseStyleFile, stampStyleFrontMatter } = require('../agents/agent_7_style');

/** Front-matter fields the server owns. A PUT may rewrite the body; never these. */
const PROVENANCE_FIELDS = ['slug', 'owner', 'created', 'project_id'];

function normaliseEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/** Slug of a style file name, or null when the name is not a style file. */
function slugFromFileName(file) {
    if (!file.endsWith('.md')) return null;
    const tiered = file.match(/^(.+?)-(directive|reference)\.md$/);
    return tiered ? tiered[1] : file.replace(/\.md$/, '');
}

function createStyleStore({ STYLES_DIR, BUNDLED_STYLES_DIR, NotFoundError, ForbiddenError }) {
    if (!STYLES_DIR || !BUNDLED_STYLES_DIR) throw new Error('createStyleStore: STYLES_DIR and BUNDLED_STYLES_DIR are required');
    if (!NotFoundError || !ForbiddenError) throw new Error('createStyleStore: error classes are required');

    // The bundle is part of the deployed code, so it is fixed for the life of the
    // process. Read once; `isBundledSlug` is on the hot path of every listing.
    let bundledSlugs = new Set();
    try {
        bundledSlugs = new Set(fsSync.readdirSync(BUNDLED_STYLES_DIR).map(slugFromFileName).filter(Boolean));
    } catch {
        bundledSlugs = new Set();
    }

    function isBundledSlug(slug) {
        return bundledSlugs.has(String(slug));
    }

    function styleOwner(meta) {
        return normaliseEmail(meta?.owner);
    }

    /** Whether the current caller may READ this style. */
    function callerMayAccess(slug, meta) {
        if (!hasScopedIdentity()) return true;   // system call, break-glass, open dev
        if (isBundledSlug(slug)) return true;    // shared library
        return styleOwner(meta) === currentUserEmail();
    }

    /**
     * Whether the current caller may EDIT or DELETE this style: everything they may
     * read, minus the shared library. Defined in terms of callerMayAccess on purpose
     * — an owner clause repeated here would be unreachable (every write path reads
     * first) and therefore untestable.
     */
    function callerMayModify(slug, meta) {
        if (!callerMayAccess(slug, meta)) return false;
        if (!hasScopedIdentity()) return true;
        return !isBundledSlug(slug);             // shared and read-only
    }

    /**
     * The owner to stamp on a style the current caller is creating, or undefined
     * outside a scoped identity (open dev / break-glass create unowned styles, which
     * only those modes can see — nobody signs in on an open server).
     */
    function ownerStampForNewStyle() {
        return hasScopedIdentity() ? currentUserEmail() : undefined;
    }

    // ── File resolution ───────────────────────────────────────────────────────

    function directiveCandidates(slug) {
        return [path.join(STYLES_DIR, `${slug}-directive.md`), path.join(STYLES_DIR, `${slug}.md`)];
    }

    function referencePath(slug) {
        return path.join(STYLES_DIR, `${slug}-reference.md`);
    }

    async function readFirstExisting(paths) {
        for (const filePath of paths) {
            try {
                return { filePath, content: await fs.readFile(filePath, 'utf-8') };
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return null;
    }

    function readFirstExistingSync(paths) {
        for (const filePath of paths) {
            try {
                return { filePath, content: fsSync.readFileSync(filePath, 'utf-8') };
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return null;
    }

    function assemble(slug, directive, reference, notFoundMessage) {
        if (!directive && !reference) throw new NotFoundError(notFoundMessage);
        // The directive is the metadata source; a reference-only slug (should not
        // happen, but a half-deleted trained style could leave one) falls back to it.
        const { meta, body } = parseStyleFile((directive || reference).content);
        if (!callerMayAccess(slug, meta)) {
            console.warn(`[ownership] denied ${currentUserEmail()} access to style ${slug} (owner: ${styleOwner(meta) || 'none'})`);
            throw new NotFoundError(notFoundMessage);
        }
        const bundled = isBundledSlug(slug);
        return {
            slug,
            directive: directive?.content || null,
            directivePath: directive?.filePath || null,
            reference: reference?.content || null,
            referencePath: reference?.filePath || null,
            meta,
            body,
            tier: reference ? 'trained' : (meta.tier || 'conversational'),
            bundled,
            editable: callerMayModify(slug, meta)
        };
    }

    /**
     * Read one style, enforcing access. Throws NotFoundError when the style does
     * not exist OR the caller may not see it — indistinguishable by design.
     */
    async function readStyle(slug, { notFoundMessage = `Style "${slug}" not found` } = {}) {
        const directive = await readFirstExisting(directiveCandidates(slug));
        const reference = await readFirstExisting([referencePath(slug)]);
        return assemble(slug, directive, reference, notFoundMessage);
    }

    /** Sync twin of readStyle, for the readiness/hash code that cannot await. */
    function readStyleSync(slug, { notFoundMessage = `Style "${slug}" not found` } = {}) {
        const directive = readFirstExistingSync(directiveCandidates(slug));
        const reference = readFirstExistingSync([referencePath(slug)]);
        return assemble(slug, directive, reference, notFoundMessage);
    }

    /** readStyle, but null instead of a NotFoundError. Other errors still throw. */
    async function tryReadStyle(slug) {
        try { return await readStyle(slug); } catch (error) {
            if (error instanceof NotFoundError) return null;
            throw error;
        }
    }

    function tryReadStyleSync(slug) {
        try { return readStyleSync(slug); } catch (error) {
            if (error instanceof NotFoundError) return null;
            throw error;
        }
    }

    /**
     * Read a style the caller intends to change. 404 if it is not theirs to see,
     * 403 if it is a shared library style — visible to all, editable by none.
     */
    async function readStyleForWrite(slug) {
        const style = await readStyle(slug);
        if (!style.editable) {
            throw new ForbiddenError(`"${style.meta.name || slug}" is a shared library style and cannot be changed.`);
        }
        return style;
    }

    /**
     * Every style the caller may see. Groups the directory by slug the way the
     * listing route always has, then applies the same access rule as readStyle.
     *
     * ⚠️ This reads the directory directly, so it carries its own copy of the
     * filter — the same discipline as the project listing in routes/projects.js.
     * The filter is `callerMayAccess`, not a re-implementation of it.
     */
    async function listStyles() {
        let files;
        try { files = await fs.readdir(STYLES_DIR); } catch { files = []; }

        const bySlug = new Map();
        for (const file of files) {
            const slug = slugFromFileName(file);
            if (!slug) continue;
            if (!bySlug.has(slug)) bySlug.set(slug, {});
            const entry = bySlug.get(slug);
            if (file.endsWith('-reference.md')) entry.referenceFile = file;
            else entry.directiveFile = file;
        }

        const styles = [];
        for (const [slug, entry] of bySlug) {
            const metaFile = entry.directiveFile || entry.referenceFile;
            if (!metaFile) continue;
            let meta = {};
            try {
                meta = parseStyleFile(await fs.readFile(path.join(STYLES_DIR, metaFile), 'utf-8')).meta;
            } catch {
                meta = {};
            }
            if (!callerMayAccess(slug, meta)) continue;
            styles.push({
                slug,
                meta,
                hasReference: Boolean(entry.referenceFile),
                bundled: isBundledSlug(slug),
                editable: callerMayModify(slug, meta)
            });
        }
        return styles;
    }

    /**
     * Replace a style's directive with client-supplied content. The client owns
     * the body; the server owns provenance — `slug`, `owner`, `created` and
     * `project_id` are re-applied from the file on disk, so an edit cannot rename a
     * style, hand it to someone else, or unstamp it.
     */
    async function writeDirective(slug, content, { atomicWriteFile }) {
        const existing = await readStyleForWrite(slug);
        const provenance = {};
        for (const key of PROVENANCE_FIELDS) {
            if (existing.meta[key] !== undefined && existing.meta[key] !== '') provenance[key] = existing.meta[key];
        }
        const stamped = stampStyleFrontMatter(content, provenance);
        // The directive path is wherever the directive lives today (tiered or legacy).
        const target = existing.directivePath || path.join(STYLES_DIR, `${slug}-directive.md`);
        await atomicWriteFile(target, stamped);
        return { ...existing, directive: stamped, meta: parseStyleFile(stamped).meta };
    }

    /** Delete every file of a style the caller may modify. */
    async function deleteStyle(slug) {
        const existing = await readStyleForWrite(slug);
        // All three possible files, as the route always has — a slug that carries
        // both a tiered directive and a legacy single file loses both.
        for (const filePath of [...directiveCandidates(slug), referencePath(slug)]) {
            try { await fs.unlink(filePath); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return existing;
    }

    return {
        PROVENANCE_FIELDS,
        isBundledSlug,
        styleOwner,
        callerMayAccess,
        callerMayModify,
        ownerStampForNewStyle,
        readStyle,
        readStyleSync,
        tryReadStyle,
        tryReadStyleSync,
        readStyleForWrite,
        listStyles,
        writeDirective,
        deleteStyle
    };
}

module.exports = { createStyleStore, slugFromFileName, PROVENANCE_FIELDS };
