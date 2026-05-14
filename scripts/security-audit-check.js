const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const { buildContentSecurityPolicy } = require('../server');

function assertNoRuntimeScriptCdn() {
    const index = read('public/index.html');
    assert.doesNotMatch(index, /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|@latest/, 'index.html should not load runtime script CDNs or @latest URLs');
}

function assertNoInlineEventHandlers() {
    const frontend = `${read('public/index.html')}\n${read('public/app.js')}`;
    assert.doesNotMatch(frontend, /<[^>]+\son[a-z]+\s*=/i, 'frontend should not use inline event handlers');
}

function assertCsp() {
    const csp = buildContentSecurityPolicy();
    assert.match(csp, /script-src 'self'(?:;|$)/, 'CSP script-src should be self-only');
    assert.match(csp, /script-src-attr 'none'/, 'CSP should block inline event-handler attributes');
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'CSP script-src must not allow unsafe-inline');
    assert.doesNotMatch(csp, /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|@latest/, 'CSP should not allow third-party script CDNs');
    assert.match(csp, /object-src 'none'/, 'CSP should block plugin/object embeds');
    assert.match(csp, /frame-ancestors 'none'/, 'CSP should prevent clickjacking embeds');
}

function assertAdminGates() {
    const server = read('server.js');
    const gates = [
        "app.get('/api/settings', requireAuth, requireAdmin",
        "app.post('/api/settings', requireAuth, requireAdmin",
        "app.post('/api/import-script', requireAuth, requireAdmin",
        "app.delete('/api/projects/:id', requireAuth, requireAdmin",
        "app.get('/api/export/docx/:projectId', requireAuth, requireAdmin",
        "app.get('/api/export/pdf/:projectId', requireAuth, requireAdmin",
        "app.put('/api/styles/:slug', requireAuth, requireAdmin",
        "app.delete('/api/styles/:slug', requireAuth, requireAdmin"
    ];

    for (const gate of gates) {
        assert.ok(server.includes(gate), `missing admin gate: ${gate}`);
    }
}

function assertOpsScripts() {
    const pkg = JSON.parse(read('package.json'));
    for (const scriptName of ['smoke:private', 'backup:data', 'restore:data', 'drill:backup']) {
        assert.ok(pkg.scripts?.[scriptName], `missing package script: ${scriptName}`);
    }
}

function run() {
    assertNoRuntimeScriptCdn();
    assertNoInlineEventHandlers();
    assertCsp();
    assertAdminGates();
    assertOpsScripts();
    console.log('Security audit checks passed.');
}

run();
