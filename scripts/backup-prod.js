#!/usr/bin/env node
/**
 * scripts/backup-prod.js — `npm run backup:prod`
 *
 * Pull every project the token can see from the deployment into a local backup
 * directory (a mirror under latest/ plus a dated snapshot). Read-only against prod.
 * Logic lives in scripts/lib/prod_sync.js so the route harness can test it.
 *
 * Config (env, or the repo's gitignored .env, or flags):
 *   PAGEONE_URL    deployment origin — default https://pageone-production.up.railway.app
 *   PAGEONE_TOKEN  a personal access token (Settings → Access Tokens; `pgo_…`)
 *   PAGEONE_BACKUP_DIR  where to write — default ./backups/prod (gitignored)
 *
 * Flags: --url <u> --token <t> --dir <d> --mine (own projects only, even as admin)
 *        --no-snapshot (mirror only)  --help
 *
 * Nothing here lives outside the repo: the token sits in .env, the backups in
 * backups/ — both gitignored, both inside COWORK, so nothing needs a row in
 * machine-dependencies.md.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { pullAll, RemoteError } = require('./lib/prod_sync');

const DEFAULT_URL = 'https://pageone-production.up.railway.app';
const DEFAULT_DIR = path.join(__dirname, '..', 'backups', 'prod');

function parseArgs(argv) {
    const args = {
        url: process.env.PAGEONE_URL || DEFAULT_URL,
        token: process.env.PAGEONE_TOKEN || '',
        dir: process.env.PAGEONE_BACKUP_DIR ? path.resolve(process.env.PAGEONE_BACKUP_DIR) : DEFAULT_DIR,
        mine: false,
        snapshot: true
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--url') args.url = argv[++i];
        else if (a === '--token') args.token = argv[++i];
        else if (a === '--dir') args.dir = path.resolve(argv[++i]);
        else if (a === '--mine') args.mine = true;
        else if (a === '--no-snapshot') args.snapshot = false;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function printHelp() {
    console.log(`Back up PageOne projects from the deployment (read-only against prod).

Usage:
  npm run backup:prod [-- --mine] [--no-snapshot] [--dir <path>] [--url <origin>] [--token <pgo_…>]

Env (or .env in the repo):
  PAGEONE_URL         default ${DEFAULT_URL}
  PAGEONE_TOKEN       personal access token from Settings → Access Tokens
  PAGEONE_BACKUP_DIR  default backups/prod

Output:
  <dir>/latest/projects/<id>.json   mirror of prod as of this pull
  <dir>/manifest.json               per-project content hash at pull time (push:prod compares against it)
  <dir>/snapshots/<timestamp>/…     a dated copy per run (omit with --no-snapshot)

An admin token pulls everyone's projects; any other token pulls its owner's. --mine narrows an admin to their own.`);
}

(async () => {
    let args;
    try {
        args = parseArgs(process.argv);
    } catch (err) {
        console.error(err.message);
        printHelp();
        process.exit(1);
    }
    try {
        const summary = await pullAll({ ...args, log: msg => console.log(msg) });
        if (summary.added.length) console.log(`  new:       ${summary.added.join(', ')}`);
        if (summary.changed.length) console.log(`  changed:   ${summary.changed.join(', ')}`);
        if (summary.removed.length) console.log(`  gone:      ${summary.removed.join(', ')} (kept in earlier snapshots)`);
        console.log(`Backup dir: ${args.dir}`);
    } catch (err) {
        if (err instanceof RemoteError && err.status === 401) {
            console.error(`Unauthorized: the token was rejected by ${args.url}. Mint one in Settings → Access Tokens and set PAGEONE_TOKEN.`);
        } else {
            console.error(err.message);
        }
        process.exit(1);
    }
})();
