#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_URL = 'https://pageone-production.up.railway.app';
const DEFAULT_DIR = path.join(process.cwd(), 'data', 'projects');

function parseArgs(argv) {
    const args = {
        url: process.env.PAGEONE_URL || DEFAULT_URL,
        dir: process.env.PAGEONE_PROJECTS_DIR || DEFAULT_DIR,
        dryRun: false,
        allowDuplicates: false,
        includeApiUsage: false,
        updateExisting: false,
        only: null,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--allow-duplicates') args.allowDuplicates = true;
        else if (arg === '--include-api-usage') args.includeApiUsage = true;
        else if (arg === '--update-existing') args.updateExisting = true;
        else if (arg === '--only') args.only = argv[++i];
        else if (arg === '--url') args.url = argv[++i];
        else if (arg === '--dir') args.dir = path.resolve(argv[++i]);
        else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    args.url = args.url.replace(/\/+$/, '');
    return args;
}

function printHelp() {
    console.log(`Upload local PageOne projects to the Railway deployment.

Usage:
  node scripts/upload-local-projects.js [options]

Options:
  --url <url>             PageOne deployment URL. Default: ${DEFAULT_URL}
  --dir <path>            Local projects directory. Default: data/projects
  --dry-run               List what would upload without writing remotely.
  --allow-duplicates      Upload even if a remote project has the same title.
  --include-api-usage     Preserve local apiUsage logs. By default they are stripped.
  --update-existing       Update the remote project when a title match exists.
  --only <title-or-id>     Upload/update only one local project by title or ID.

Secret:
  Set PAGEONE_APP_SECRET, APP_SECRET, or let the script prompt for it.`);
}

async function readHidden(prompt) {
    if (!process.stdin.isTTY) {
        throw new Error('APP_SECRET is required. Set PAGEONE_APP_SECRET or APP_SECRET.');
    }

    process.stdout.write(prompt);
    spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
    try {
        return await new Promise((resolve) => {
            process.stdin.resume();
            process.stdin.once('data', (chunk) => {
                process.stdin.pause();
                resolve(chunk.toString('utf8').trim());
            });
        });
    } finally {
        spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
        process.stdout.write('\n');
    }
}

async function getSecret() {
    const secret = process.env.PAGEONE_APP_SECRET || process.env.APP_SECRET;
    if (secret) return secret;
    const entered = await readHidden('Railway APP_SECRET: ');
    if (!entered) throw new Error('APP_SECRET cannot be empty.');
    return entered;
}

function authHeaders(secret, extra = {}) {
    return {
        Authorization: `Bearer ${secret}`,
        ...extra,
    };
}

async function requestJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;

    if (!res.ok) {
        const detail = body?.error ? `: ${body.error}` : '';
        throw new Error(`${options.method || 'GET'} ${url} failed with ${res.status}${detail}`);
    }

    return body;
}

async function loadLocalProjects(dir, includeApiUsage) {
    const files = (await fs.readdir(dir))
        .filter((file) => file.endsWith('.json'))
        .sort();

    const projects = [];
    for (const file of files) {
        const filePath = path.join(dir, file);
        const raw = await fs.readFile(filePath, 'utf8');
        const project = JSON.parse(raw);

        if (!project.id || !project.title || typeof project.data !== 'object') {
            throw new Error(`${filePath} does not look like a PageOne project JSON file.`);
        }

        const data = structuredClone(project.data);
        if (!includeApiUsage) delete data.apiUsage;

        projects.push({
            file,
            oldId: project.id,
            title: project.title,
            data,
        });
    }

    return projects;
}

function filterProjects(projects, only) {
    if (!only) return projects;
    const normalized = only.toLowerCase();
    return projects.filter((project) => (
        project.oldId === only ||
        project.title.toLowerCase() === normalized ||
        project.file === only
    ));
}

async function main() {
    const args = parseArgs(process.argv);
    const projects = filterProjects(
        await loadLocalProjects(args.dir, args.includeApiUsage),
        args.only
    );

    if (!projects.length) {
        console.log(`No project JSON files found in ${args.dir}`);
        return;
    }

    console.log(`Found ${projects.length} local project(s):`);
    for (const project of projects) {
        console.log(`- ${project.title} (${project.oldId})`);
    }

    if (args.dryRun) {
        console.log('\nDry run only. Nothing was uploaded.');
        return;
    }

    const secret = await getSecret();
    const remote = await requestJson(`${args.url}/api/projects`, {
        headers: authHeaders(secret),
    });
    const remoteByTitle = new Map((remote.projects || []).map((project) => [project.title, project]));
    const remoteTitles = new Set(remoteByTitle.keys());

    const uploaded = [];
    const updatedExisting = [];
    const skipped = [];

    for (const project of projects) {
        const existing = remoteByTitle.get(project.title);
        if (existing && args.updateExisting) {
            const updated = await requestJson(`${args.url}/api/projects/${existing.id}`, {
                method: 'PUT',
                headers: authHeaders(secret, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    title: project.title,
                    data: project.data,
                }),
            });

            updatedExisting.push({ oldId: project.oldId, remoteId: updated.id, title: updated.title });
            console.log(`Updated "${updated.title}" (${project.oldId} -> ${updated.id})`);
            continue;
        }

        if (existing && !args.allowDuplicates) {
            skipped.push(project);
            console.log(`Skipping "${project.title}" because it already exists on Railway.`);
            continue;
        }

        const created = await requestJson(`${args.url}/api/projects`, {
            method: 'POST',
            headers: authHeaders(secret),
        });

        const updated = await requestJson(`${args.url}/api/projects/${created.id}`, {
            method: 'PUT',
            headers: authHeaders(secret, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                title: project.title,
                data: project.data,
            }),
        });

        uploaded.push({ oldId: project.oldId, newId: updated.id, title: updated.title });
        remoteTitles.add(updated.title);
        console.log(`Uploaded "${updated.title}" (${project.oldId} -> ${updated.id})`);
    }

    console.log('\nDone.');
    console.log(`Uploaded: ${uploaded.length}`);
    console.log(`Updated: ${updatedExisting.length}`);
    console.log(`Skipped: ${skipped.length}`);
    if (uploaded.length || updatedExisting.length) {
        console.log('\nID map:');
        for (const item of uploaded) {
            console.log(`${item.oldId} -> ${item.newId}  ${item.title}`);
        }
        for (const item of updatedExisting) {
            console.log(`${item.oldId} -> ${item.remoteId}  ${item.title}`);
        }
    }
}

main().catch((err) => {
    console.error(`\nUpload failed: ${err.message}`);
    process.exit(1);
});
