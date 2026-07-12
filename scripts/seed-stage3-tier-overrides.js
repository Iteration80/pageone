#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

// Honor DATA_ROOT (Railway volume) the same way server.js does, so the script
// targets the live project store on deployments without needing --dir.
const DEFAULT_DIR = process.env.DATA_ROOT
    ? path.join(path.resolve(process.env.DATA_ROOT), 'projects')
    : path.join(process.cwd(), 'data', 'projects');

const IMAGINE_TIER_OVERRIDES_VERSION = 'imagine-tier-overrides-2026-07-12';

const IMAGINE_TIER_OVERRIDES = {
    Rebecca: 1,
    Dapple: 1,
    Dave: 1,
    Terry: 1,
    Elliot: 1,
    Furdlegurr: 1,
    Blounder: 1,
    Quist: 1,
    Scott: 1,
    Robotobob: 1,
    Pono: 2,
    Moog: 2,
    'Big Doll': 2,
    Pretz: 2,
    Molly: 3,
    Dylan: 3,
    "Dylan's parents": 3,
    'Ms. Alvarado': 3,
    Carol: 3,
    Brenda: 3,
    Vance: 3,
    Gary: 3,
    Tyler: 3
};

function parseArgs(argv) {
    const args = { dir: DEFAULT_DIR, write: false, overwrite: false, only: '' };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--write') args.write = true;
        else if (arg === '--overwrite') args.overwrite = true;
        else if (arg === '--dir') args.dir = path.resolve(argv[++i]);
        else if (arg === '--only') args.only = argv[++i] || '';
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    return `Seed Stage 3 character tier overrides for saved I.M.A.G.I.N.E. projects.

Usage:
  node scripts/seed-stage3-tier-overrides.js [options]

Options:
  --dir <path>     Projects directory. Default: $DATA_ROOT/projects if DATA_ROOT is set, else data/projects
  --only <id>      Seed one project JSON file by id, without .json, even if its title is missing
  --write          Persist changes. Omitted = dry run
  --overwrite      Replace existing tier_overrides instead of filling missing names
  --help           Show this help text`;
}

function projectTitle(project = {}) {
    return String(project.title || project.data?.stage1_pitch?.pitch?.title || '').trim();
}

function isImagineProject(project = {}) {
    return /^i\.m\.a\.g\.i\.n\.e\.$/i.test(projectTitle(project));
}

function mergeOverrides(existing = {}, { overwrite = false } = {}) {
    if (overwrite) return { ...IMAGINE_TIER_OVERRIDES };
    return { ...IMAGINE_TIER_OVERRIDES, ...(existing || {}) };
}

function applyStage3TierOverrides(project = {}, { overwrite = false, overwriteUnversioned = false, markSeedVersion = false } = {}) {
    project.data = project.data || {};
    const stage3 = project.data.stage3_characters || {};
    const meta = stage3._meta || {};
    const seedVersion = meta.tier_overrides_seed_version || '';
    const effectiveOverwrite = overwrite || (overwriteUnversioned && seedVersion !== IMAGINE_TIER_OVERRIDES_VERSION);
    const nextOverrides = mergeOverrides(stage3.tier_overrides || {}, { overwrite: effectiveOverwrite });
    const nextMeta = markSeedVersion && effectiveOverwrite
        ? { ...meta, tier_overrides_seed_version: IMAGINE_TIER_OVERRIDES_VERSION }
        : meta;
    const before = JSON.stringify({
        tier_overrides: stage3.tier_overrides || {},
        seedVersion
    });
    const after = JSON.stringify({
        tier_overrides: nextOverrides,
        seedVersion: nextMeta.tier_overrides_seed_version || ''
    });
    if (before === after) return false;
    project.data.stage3_characters = {
        ...stage3,
        tier_overrides: nextOverrides,
        _meta: nextMeta
    };
    return true;
}

async function listProjectFiles(dir, only = '') {
    if (only) return [path.join(dir, `${only}.json`)];
    const names = await fs.readdir(dir);
    return names
        .filter(name => /^\d{13,14}\.json$/.test(name))
        .map(name => path.join(dir, name));
}

async function seedStage3TierOverridesForDirectory({
    dir = DEFAULT_DIR,
    write = false,
    overwrite = false,
    overwriteUnversioned = false,
    markSeedVersion = false,
    only = '',
    log = console.log
} = {}) {
    const files = await listProjectFiles(dir, only);
    let changed = 0;
    let inspected = 0;

    for (const file of files) {
        const raw = await fs.readFile(file, 'utf8');
        const project = JSON.parse(raw);
        inspected += 1;
        if (!only && !isImagineProject(project)) continue;

        if (!applyStage3TierOverrides(project, { overwrite, overwriteUnversioned, markSeedVersion })) {
            log(`unchanged ${path.basename(file)} (${projectTitle(project)})`);
            continue;
        }

        changed += 1;
        log(`${write ? 'updating' : 'would update'} ${path.basename(file)} (${projectTitle(project)})`);
        if (write) {
            await fs.writeFile(file, `${JSON.stringify(project, null, 2)}\n`);
        }
    }

    log(`${write ? 'Updated' : 'Dry run'}: ${changed} of ${inspected} project file(s) matched changes.`);
    return { changed, inspected };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(usage());
        return;
    }

    await seedStage3TierOverridesForDirectory({
        dir: args.dir,
        write: args.write,
        overwrite: args.overwrite,
        markSeedVersion: args.write && args.overwrite,
        only: args.only
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    IMAGINE_TIER_OVERRIDES,
    IMAGINE_TIER_OVERRIDES_VERSION,
    applyStage3TierOverrides,
    isImagineProject,
    mergeOverrides,
    projectTitle,
    seedStage3TierOverridesForDirectory
};
