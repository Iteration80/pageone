#!/usr/bin/env node

/**
 * One-time migration for multi-user Phase 2: stamp an `owner` email on every
 * project that does not have one.
 *
 * ⚠️ ORDERING IS LOAD-BEARING. The server fails CLOSED on unowned projects — a
 * project with no `owner` is denied to every signed-in user, because treating
 * "no owner" as "everyone's" is the silent hole Phase 2 exists to close. So on any
 * deployment with existing data this must run BEFORE (or immediately after) the
 * Phase 2 code starts serving traffic, or every project 404s until it does.
 *
 * Dry run by default, like scripts/seed-stage3-tier-overrides.js. Nothing is
 * written without --write.
 *
 * Usage:
 *   node scripts/stamp-project-owners.js --owner you@example.com          # dry run
 *   node scripts/stamp-project-owners.js --owner you@example.com --write
 *   node scripts/stamp-project-owners.js --verify                         # report only
 *
 * On Railway, DATA_ROOT points at the volume and is honoured automatically, so
 * `npm run migrate:project-owners -- --owner you@example.com --write` targets the
 * live store with no --dir.
 */

const fs = require('fs/promises');
const path = require('path');

// Honour DATA_ROOT (Railway volume) the same way server.js does.
const DEFAULT_DIR = process.env.DATA_ROOT
    ? path.join(path.resolve(process.env.DATA_ROOT), 'projects')
    : path.join(process.cwd(), 'data', 'projects');

function parseArgs(argv) {
    const args = { dir: DEFAULT_DIR, owner: '', write: false, verify: false, reassign: false };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--write') args.write = true;
        else if (arg === '--verify') args.verify = true;
        else if (arg === '--reassign') args.reassign = true;
        else if (arg === '--owner') args.owner = String(argv[++i] || '').trim().toLowerCase();
        else if (arg === '--dir') args.dir = path.resolve(argv[++i]);
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    return `Stamp an owner email on projects that have none (multi-user Phase 2).

Usage:
  node scripts/stamp-project-owners.js --owner <email> [--write]

Options:
  --owner <email>  Email to stamp. Required unless --verify
  --dir <path>     Projects directory. Default: $DATA_ROOT/projects if DATA_ROOT is set, else data/projects
  --verify         Report ownership coverage and exit non-zero if any project is unowned
  --reassign       Also overwrite projects that ALREADY have a different owner (dangerous; not the migration)
  --write          Persist changes. Omitted = dry run
  --help           Show this help text`;
}

function projectOwner(project) {
    return String(project?.owner || '').trim().toLowerCase();
}

async function listProjectFiles(dir) {
    const names = await fs.readdir(dir);
    return names.filter(name => /^\d{13,14}\.json$/.test(name)).map(name => path.join(dir, name));
}

async function stampProjectOwners({
    dir = DEFAULT_DIR,
    owner = '',
    write = false,
    reassign = false,
    log = console.log
} = {}) {
    const files = await listProjectFiles(dir);
    let stamped = 0;
    let alreadyOwned = 0;
    const owners = new Map();

    for (const file of files) {
        const project = JSON.parse(await fs.readFile(file, 'utf8'));
        const existing = projectOwner(project);
        const title = project.title || '(untitled)';

        if (existing && !(reassign && existing !== owner)) {
            alreadyOwned += 1;
            owners.set(existing, (owners.get(existing) || 0) + 1);
            log(`unchanged ${path.basename(file)} — "${title}" already owned by ${existing}`);
            continue;
        }

        stamped += 1;
        const action = existing
            ? `${write ? 'reassigning' : 'would reassign'} from ${existing} to ${owner}`
            : `${write ? 'stamping' : 'would stamp'} ${owner}`;
        log(`${action} — ${path.basename(file)} "${title}"`);
        if (write) {
            project.owner = owner;
            await fs.writeFile(file, `${JSON.stringify(project, null, 2)}\n`);
        }
    }

    log(`${write ? 'Updated' : 'Dry run'}: ${stamped} project file(s) ${write ? 'stamped' : 'would be stamped'}, ${alreadyOwned} already owned, ${files.length} total.`);
    return { stamped, alreadyOwned, total: files.length, owners: Object.fromEntries(owners) };
}

/**
 * Report coverage without touching anything. This is the gate to check before
 * deploying Phase 2 to a deployment that already holds data: "0 unowned" is the
 * only safe state, because unowned projects are denied to everyone.
 */
async function verifyProjectOwners({ dir = DEFAULT_DIR, log = console.log } = {}) {
    const files = await listProjectFiles(dir);
    const unowned = [];
    const owners = new Map();

    for (const file of files) {
        const project = JSON.parse(await fs.readFile(file, 'utf8'));
        const owner = projectOwner(project);
        if (!owner) unowned.push(`${path.basename(file)} "${project.title || '(untitled)'}"`);
        else owners.set(owner, (owners.get(owner) || 0) + 1);
    }

    log(`${files.length} project(s); ${unowned.length} unowned.`);
    for (const [owner, count] of owners) log(`  ${owner}: ${count}`);
    if (unowned.length) {
        log('\nUNOWNED — these are denied to every signed-in user until stamped:');
        unowned.forEach(entry => log(`  ${entry}`));
    }
    return { total: files.length, unowned, owners: Object.fromEntries(owners) };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(usage());
        return;
    }

    if (args.verify) {
        const { unowned } = await verifyProjectOwners({ dir: args.dir });
        // Non-zero exit so this can gate a deploy step rather than merely inform one.
        if (unowned.length) process.exitCode = 1;
        return;
    }

    if (!args.owner || !args.owner.includes('@')) {
        throw new Error('--owner <email> is required (or use --verify to report coverage)');
    }

    await stampProjectOwners({
        dir: args.dir,
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

module.exports = { stampProjectOwners, verifyProjectOwners, projectOwner };
