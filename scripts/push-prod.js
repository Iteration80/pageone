#!/usr/bin/env node
/**
 * scripts/push-prod.js — `npm run push:prod -- <projectId>`
 *
 * Upload ONE project from the local backup (backups/prod/latest/, or --file) to
 * the deployment. Refuses to overwrite a project that has changed on prod since
 * your last `backup:prod` — that is the whole point of the tool — unless --force.
 * Never creates a project; never touches anything but that one id.
 * Logic lives in scripts/lib/prod_sync.js so the route harness can test it.
 *
 * Config as for backup-prod.js (PAGEONE_URL, PAGEONE_TOKEN, PAGEONE_BACKUP_DIR).
 * Flags: --file <path> (push this JSON instead of latest/projects/<id>.json)
 *        --force (overwrite even if prod changed or was never pulled)
 *        --url --token --dir --help
 *
 * Exit codes: 0 pushed or already identical · 2 refused (message says why) · 1 error.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { pushOne, RemoteError, Refusal } = require('./lib/prod_sync');

const DEFAULT_URL = 'https://pageone-production.up.railway.app';
const DEFAULT_DIR = path.join(__dirname, '..', 'backups', 'prod');

function parseArgs(argv) {
    const args = {
        url: process.env.PAGEONE_URL || DEFAULT_URL,
        token: process.env.PAGEONE_TOKEN || '',
        dir: process.env.PAGEONE_BACKUP_DIR ? path.resolve(process.env.PAGEONE_BACKUP_DIR) : DEFAULT_DIR,
        projectId: null,
        file: null,
        force: false
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--url') args.url = argv[++i];
        else if (a === '--token') args.token = argv[++i];
        else if (a === '--dir') args.dir = path.resolve(argv[++i]);
        else if (a === '--file') args.file = argv[++i];
        else if (a === '--force') args.force = true;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
        else if (/^\d+$/.test(a) && !args.projectId) args.projectId = a;
        else throw new Error(`Unknown argument: ${a}`);
    }
    if (!args.projectId) throw new Error('A project id is required.');
    return args;
}

function printHelp() {
    console.log(`Push ONE project from the local backup to the deployment.

Usage:
  npm run push:prod -- <projectId> [--file <path>] [--force] [--dir <path>] [--url <origin>] [--token <pgo_…>]

Refuses (exit 2) when prod's copy changed since your last backup:prod, when the id
was never pulled, or when prod has no such project for this token. --force overrides
the first two; nothing overrides the third (push never creates).

Note: the server merges the project's top-level data keys, so a key you deleted
locally survives on prod — push restores and overwrites, it does not prune.`);
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
        await pushOne({ ...args, log: msg => console.log(msg) });
    } catch (err) {
        if (err instanceof Refusal) {
            console.error(`Refused (${err.code}): ${err.message}`);
            process.exit(2);
        }
        if (err instanceof RemoteError && err.status === 401) {
            console.error(`Unauthorized: the token was rejected by ${args.url}. Mint one in Settings → Access Tokens and set PAGEONE_TOKEN.`);
        } else {
            console.error(err.message);
        }
        process.exit(1);
    }
})();
