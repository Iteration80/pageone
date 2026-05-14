#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(repoRoot, 'data'));
const backupRoot = path.resolve(process.env.BACKUP_ROOT || path.join(repoRoot, 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const targetRoot = path.join(backupRoot, `pageone-data-${stamp}`);

async function copyIfExists(source, target) {
    try {
        await fs.cp(source, target, {
            recursive: true,
            force: false,
            errorOnExist: true
        });
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    return true;
}

async function writeManifest(copied) {
    await fs.writeFile(path.join(targetRoot, 'backup-manifest.json'), JSON.stringify({
        createdAt: new Date().toISOString(),
        dataRoot,
        copied
    }, null, 2));
}

async function main() {
    await fs.mkdir(targetRoot, { recursive: true });
    const copied = [];

    for (const name of ['projects', 'styles', 'logs', 'settings.json', 'projects-manifest.json']) {
        const source = path.join(dataRoot, name);
        const target = path.join(targetRoot, name);
        if (await copyIfExists(source, target)) copied.push(name);
    }

    await writeManifest(copied);
    console.log(`Backed up ${copied.length ? copied.join(', ') : 'no data files'} to ${targetRoot}`);
}

main().catch(error => {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
});
