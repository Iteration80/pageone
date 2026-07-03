#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

// Honor DATA_ROOT (Railway volume) the same way server.js does, so the script
// targets the live project store on deployments without needing --dir.
const DEFAULT_DIR = process.env.DATA_ROOT
    ? path.join(path.resolve(process.env.DATA_ROOT), 'projects')
    : path.join(process.cwd(), 'data', 'projects');

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

async function listProjectFiles(dir, only = '') {
    if (only) return [path.join(dir, `${only}.json`)];
    const names = await fs.readdir(dir);
    return names
        .filter(name => /^\d{13,14}\.json$/.test(name))
        .map(name => path.join(dir, name));
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(usage());
        return;
    }

    const files = await listProjectFiles(args.dir, args.only);
    let changed = 0;
    let inspected = 0;

    for (const file of files) {
        const raw = await fs.readFile(file, 'utf8');
        const project = JSON.parse(raw);
        inspected += 1;
        if (!args.only && !isImagineProject(project)) continue;

        project.data = project.data || {};
        const stage3 = project.data.stage3_characters || {};
        const before = JSON.stringify(stage3.tier_overrides || {});
        const nextOverrides = mergeOverrides(stage3.tier_overrides || {}, { overwrite: args.overwrite });
        const after = JSON.stringify(nextOverrides);
        if (before === after) {
            console.log(`unchanged ${path.basename(file)} (${projectTitle(project)})`);
            continue;
        }

        changed += 1;
        console.log(`${args.write ? 'updating' : 'would update'} ${path.basename(file)} (${projectTitle(project)})`);
        if (args.write) {
            project.data.stage3_characters = { ...stage3, tier_overrides: nextOverrides };
            await fs.writeFile(file, `${JSON.stringify(project, null, 2)}\n`);
        }
    }

    console.log(`${args.write ? 'Updated' : 'Dry run'}: ${changed} of ${inspected} project file(s) matched changes.`);
}

main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
});
