#!/usr/bin/env node

const { spawnSync } = require('child_process');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const smokeConfigured = !!(process.env.SMOKE_BASE_URL || process.env.BASE_URL)
    && !!(process.env.SMOKE_ACCESS_KEY || process.env.APP_SECRET);

function run(label, command, args, options = {}) {
    console.log(`\n==> ${label}`);
    const result = spawnSync(command, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
        shell: false,
        ...options
    });
    if (result.status !== 0) {
        throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
    }
}

function main() {
    run('Static security audit', npmCmd, ['run', 'audit:security']);
    run('Unit and regression tests', npmCmd, ['test']);
    run('Backup/restore drill', npmCmd, ['run', 'drill:backup']);

    if (smokeConfigured) {
        run('Private deployment smoke', npmCmd, ['run', 'smoke:private']);
    } else {
        console.log('\n==> Private deployment smoke');
        console.log('Skipped. Set SMOKE_BASE_URL and SMOKE_ACCESS_KEY to smoke-test a deployed private instance.');
    }

    console.log('\nPrivate beta preflight passed.');
}

main();
