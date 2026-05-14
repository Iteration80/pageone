#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(repoRoot, 'data'));
const backupPath = process.env.BACKUP_PATH ? path.resolve(process.env.BACKUP_PATH) : '';
const overwrite = process.env.RESTORE_OVERWRITE === 'true';

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function directoryHasEntries(target) {
    try {
        const entries = await fs.readdir(target);
        return entries.length > 0;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function copyIfExists(source, target) {
    if (!(await pathExists(source))) return false;
    await fs.cp(source, target, { recursive: true, force: true });
    return true;
}

async function main() {
    if (!backupPath) {
        throw new Error('Set BACKUP_PATH to a pageone-data-* backup directory before restoring.');
    }

    const manifestPath = path.join(backupPath, 'backup-manifest.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    if (!Array.isArray(manifest.copied)) {
        throw new Error('Backup manifest is missing copied file metadata.');
    }

    const targetHasEntries = await directoryHasEntries(dataRoot);
    if (targetHasEntries && !overwrite) {
        throw new Error(`DATA_ROOT is not empty: ${dataRoot}. Set RESTORE_OVERWRITE=true to restore over it.`);
    }
    if (targetHasEntries && overwrite) {
        await fs.rm(dataRoot, { recursive: true, force: true });
    }

    await fs.mkdir(dataRoot, { recursive: true });
    const restored = [];
    for (const name of ['projects', 'styles', 'logs', 'settings.json', 'projects-manifest.json']) {
        const source = path.join(backupPath, name);
        const target = path.join(dataRoot, name);
        if (await copyIfExists(source, target)) restored.push(name);
    }

    await fs.writeFile(path.join(dataRoot, 'restore-manifest.json'), JSON.stringify({
        restoredAt: new Date().toISOString(),
        backupPath,
        backupCreatedAt: manifest.createdAt || null,
        restored
    }, null, 2));

    console.log(`Restored ${restored.length ? restored.join(', ') : 'no data files'} to ${dataRoot}`);
}

main().catch(error => {
    console.error(`Restore failed: ${error.message}`);
    process.exit(1);
});
