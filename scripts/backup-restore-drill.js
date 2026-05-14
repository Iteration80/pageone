#!/usr/bin/env node

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const drillRoot = path.join(os.tmpdir(), `pageone-restore-drill-${Date.now()}`);
const sourceRoot = path.join(drillRoot, 'source-data');
const backupRoot = path.join(drillRoot, 'backups');
const restoreRoot = path.join(drillRoot, 'restored-data');
const projectId = '1779000000000';

function runNode(script, env) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, script)], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        encoding: 'utf-8'
    });
    if (result.status !== 0) {
        throw new Error(`${script} failed:\n${result.stdout || ''}${result.stderr || ''}`);
    }
    return result.stdout;
}

async function writeFixture() {
    await fs.mkdir(path.join(sourceRoot, 'projects'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, 'styles'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, 'logs'), { recursive: true });
    const project = {
        id: projectId,
        title: 'Restore Drill',
        data: {
            stage1_pitch: {
                pitch: {
                    title: 'Restore Drill',
                    logline: 'A tiny project proves backups can come home.'
                }
            }
        }
    };
    await fs.writeFile(path.join(sourceRoot, 'projects', `${projectId}.json`), JSON.stringify(project, null, 2));
    await fs.writeFile(path.join(sourceRoot, 'styles', 'restore-drill.md'), '# Restore Drill Style\n');
    await fs.writeFile(path.join(sourceRoot, 'logs', 'pageone.jsonl'), JSON.stringify({ event: 'restore_drill' }) + '\n');
    await fs.writeFile(path.join(sourceRoot, 'settings.json'), JSON.stringify({ stageModels: { stage1: 'gemini-3-flash-preview' } }, null, 2));
    await fs.writeFile(path.join(sourceRoot, 'projects-manifest.json'), JSON.stringify({
        version: 1,
        rebuiltAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projects: [{ id: projectId, title: 'Restore Drill' }]
    }, null, 2));
}

async function latestBackupPath() {
    const entries = await fs.readdir(backupRoot);
    const backups = entries
        .filter(name => name.startsWith('pageone-data-'))
        .map(name => path.join(backupRoot, name))
        .sort();
    if (!backups.length) throw new Error('No backup directory was created during the drill.');
    return backups[backups.length - 1];
}

async function verifyRestore() {
    const restoredProjectPath = path.join(restoreRoot, 'projects', `${projectId}.json`);
    const restoredProject = JSON.parse(await fs.readFile(restoredProjectPath, 'utf-8'));
    if (restoredProject.title !== 'Restore Drill') {
        throw new Error('Restored project title did not match the fixture.');
    }
    if (!fsSync.existsSync(path.join(restoreRoot, 'styles', 'restore-drill.md'))) {
        throw new Error('Restored styles directory is missing fixture style.');
    }
    if (!fsSync.existsSync(path.join(restoreRoot, 'logs', 'pageone.jsonl'))) {
        throw new Error('Restored logs directory is missing fixture log.');
    }
    if (!fsSync.existsSync(path.join(restoreRoot, 'restore-manifest.json'))) {
        throw new Error('Restore manifest was not written.');
    }
}

async function main() {
    await writeFixture();
    runNode('scripts/backup-data-root.js', {
        DATA_ROOT: sourceRoot,
        BACKUP_ROOT: backupRoot
    });
    const backupPath = await latestBackupPath();
    runNode('scripts/restore-data-root.js', {
        DATA_ROOT: restoreRoot,
        BACKUP_PATH: backupPath,
        RESTORE_OVERWRITE: 'true'
    });
    await verifyRestore();
    console.log(`Backup restore drill passed: ${backupPath} -> ${restoreRoot}`);
}

main().catch(error => {
    console.error(`Backup restore drill failed: ${error.message}`);
    process.exit(1);
});
