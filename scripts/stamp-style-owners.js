#!/usr/bin/env node

/**
 * One-time migration for multi-user Phase 3: stamp an `owner` email into the front
 * matter of every USER-CREATED style that does not have one.
 *
 * ⚠️ ORDERING IS LOAD-BEARING, as it was for projects. The server fails CLOSED on an
 * unowned non-bundled style — nobody signed in can see it, and a project drafting
 * with it drafts without style directives — because treating "no owner" as
 * "everyone's" is the silent hole Phase 3 closes. So on any deployment with
 * user-created styles this must run right after the Phase 3 code starts serving.
 *
 * ⚠️ WHICH FILES ARE "USER-CREATED" is decided by filename against the BUNDLED
 * styles directory (data/styles in the repo — what ships with the app and is seeded
 * into DATA_ROOT/styles at startup), NOT by the `tier:` line or the Preset badge.
 * The bundle contains two trained styles and one conversational one alongside the
 * presets; stamping by tier would privatise those three for everyone. A bundled
 * file is never stamped, so it stays shared.
 *
 * Both halves of a trained style (`-directive.md` and `-reference.md`) are stamped;
 * the reference is the analysis of the uploaded screenplays and is the more
 * sensitive of the two.
 *
 * Dry run by default. Nothing is written without --write.
 *
 * Usage:
 *   node scripts/stamp-style-owners.js --owner you@example.com          # dry run
 *   node scripts/stamp-style-owners.js --owner you@example.com --write
 *   node scripts/stamp-style-owners.js --verify                         # report only
 *
 * On Railway, DATA_ROOT points at the volume and is honoured automatically, so
 * `npm run migrate:style-owners -- --owner you@example.com --write` targets the live
 * store with no --dir.
 */

const fs = require('fs/promises');
const path = require('path');
const { parseStyleFile, stampStyleFrontMatter } = require('../agents/agent_7_style');
const { slugFromFileName } = require('../utils/style_store');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUNDLED_DIR = path.join(REPO_ROOT, 'data', 'styles');
const DEFAULT_DIR = process.env.DATA_ROOT
    ? path.join(path.resolve(process.env.DATA_ROOT), 'styles')
    : DEFAULT_BUNDLED_DIR;

function parseArgs(argv) {
    const args = { dir: DEFAULT_DIR, bundledDir: DEFAULT_BUNDLED_DIR, owner: '', write: false, verify: false, reassign: false };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--write') args.write = true;
        else if (arg === '--verify') args.verify = true;
        else if (arg === '--reassign') args.reassign = true;
        else if (arg === '--owner') args.owner = String(argv[++i] || '').trim().toLowerCase();
        else if (arg === '--dir') args.dir = path.resolve(argv[++i]);
        else if (arg === '--bundled-dir') args.bundledDir = path.resolve(argv[++i]);
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    return `Stamp an owner email on user-created styles that have none (multi-user Phase 3).

Usage:
  node scripts/stamp-style-owners.js --owner <email> [--write]

Options:
  --owner <email>       Email to stamp. Required unless --verify
  --dir <path>          Styles directory. Default: $DATA_ROOT/styles if DATA_ROOT is set, else data/styles
  --bundled-dir <path>  The app's bundled styles (never stamped). Default: <repo>/data/styles
  --verify              Report ownership coverage and exit non-zero if any user style is unowned
  --reassign            Also overwrite user styles that ALREADY have a different owner (dangerous; not the migration)
  --write               Persist changes. Omitted = dry run
  --help                Show this help text`;
}

function styleOwner(meta) {
    return String(meta?.owner || '').trim().toLowerCase();
}

async function bundledSlugSet(bundledDir) {
    try {
        return new Set((await fs.readdir(bundledDir)).map(slugFromFileName).filter(Boolean));
    } catch {
        return new Set();
    }
}

/** Every style file in `dir`, with its slug and whether the slug is bundled. */
async function listStyleFiles(dir, bundledDir) {
    const bundled = await bundledSlugSet(bundledDir);
    const names = await fs.readdir(dir);
    return names
        .map(name => ({ name, slug: slugFromFileName(name) }))
        .filter(entry => entry.slug)
        .map(entry => ({ ...entry, file: path.join(dir, entry.name), bundled: bundled.has(entry.slug) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function stampStyleOwners({
    dir = DEFAULT_DIR,
    bundledDir = DEFAULT_BUNDLED_DIR,
    owner = '',
    write = false,
    reassign = false,
    log = console.log
} = {}) {
    if (path.resolve(dir) === path.resolve(bundledDir)) {
        log(`Styles directory IS the bundled directory (${dir}) — every style is shared; nothing to stamp.`);
        return { stamped: 0, alreadyOwned: 0, bundled: 0, total: 0, owners: {} };
    }

    const files = await listStyleFiles(dir, bundledDir);
    let stamped = 0;
    let alreadyOwned = 0;
    let bundledCount = 0;
    const owners = new Map();

    for (const entry of files) {
        if (entry.bundled) {
            bundledCount += 1;
            continue; // shared library — never stamped, never listed as unowned
        }
        const raw = await fs.readFile(entry.file, 'utf8');
        const { meta } = parseStyleFile(raw);
        const existing = styleOwner(meta);
        const name = meta.name || entry.slug;

        if (existing && !(reassign && existing !== owner)) {
            alreadyOwned += 1;
            owners.set(existing, (owners.get(existing) || 0) + 1);
            log(`unchanged ${entry.name} — "${name}" already owned by ${existing}`);
            continue;
        }

        stamped += 1;
        const action = existing
            ? `${write ? 'reassigning' : 'would reassign'} from ${existing} to ${owner}`
            : `${write ? 'stamping' : 'would stamp'} ${owner}`;
        log(`${action} — ${entry.name} "${name}"`);
        if (write) {
            await fs.writeFile(entry.file, stampStyleFrontMatter(raw, { owner }));
        }
    }

    log(`${write ? 'Updated' : 'Dry run'}: ${stamped} style file(s) ${write ? 'stamped' : 'would be stamped'}, ${alreadyOwned} already owned, ${bundledCount} bundled (shared, untouched), ${files.length} total.`);
    return { stamped, alreadyOwned, bundled: bundledCount, total: files.length, owners: Object.fromEntries(owners) };
}

/**
 * Report coverage without touching anything. "0 unowned" is the only safe state on
 * a deployment with user-created styles, because unowned ones are hidden from
 * everyone and drafts that use them silently lose their style.
 */
async function verifyStyleOwners({ dir = DEFAULT_DIR, bundledDir = DEFAULT_BUNDLED_DIR, log = console.log } = {}) {
    if (path.resolve(dir) === path.resolve(bundledDir)) {
        log(`Styles directory IS the bundled directory (${dir}) — every style is shared; 0 unowned.`);
        return { total: 0, bundled: 0, unowned: [], owners: {} };
    }
    const files = await listStyleFiles(dir, bundledDir);
    const unowned = [];
    const owners = new Map();
    let bundledCount = 0;

    for (const entry of files) {
        if (entry.bundled) { bundledCount += 1; continue; }
        const { meta } = parseStyleFile(await fs.readFile(entry.file, 'utf8'));
        const owner = styleOwner(meta);
        if (!owner) unowned.push(`${entry.name} "${meta.name || entry.slug}"`);
        else owners.set(owner, (owners.get(owner) || 0) + 1);
    }

    log(`${files.length} style file(s); ${bundledCount} bundled (shared); ${unowned.length} unowned.`);
    for (const [owner, count] of owners) log(`  ${owner}: ${count}`);
    if (unowned.length) {
        log('\nUNOWNED — hidden from every signed-in user until stamped:');
        unowned.forEach(entry => log(`  ${entry}`));
    }
    return { total: files.length, bundled: bundledCount, unowned, owners: Object.fromEntries(owners) };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(usage());
        return;
    }

    if (args.verify) {
        const { unowned } = await verifyStyleOwners({ dir: args.dir, bundledDir: args.bundledDir });
        if (unowned.length) process.exitCode = 1;
        return;
    }

    if (!args.owner || !args.owner.includes('@')) {
        throw new Error('--owner <email> is required (or use --verify to report coverage)');
    }

    await stampStyleOwners({
        dir: args.dir,
        bundledDir: args.bundledDir,
        owner: args.owner,
        write: args.write,
        reassign: args.reassign
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = { stampStyleOwners, verifyStyleOwners };
