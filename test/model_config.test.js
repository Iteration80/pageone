const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('assistant Anthropic fallback uses the current Sonnet model', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /model: 'claude-sonnet-5'/);
    assert.doesNotMatch(serverJs, /model: 'claude-sonnet-4-6'/);
});

// Route modules receive `appSettings` by reference at registration time, which runs
// before loadSettings(). Reassigning the binding leaves those routes holding a stale
// empty object: GET /api/settings then reports no stageModels, the Settings modal
// falls back to its hardcoded default for every dropdown, and the next Save rewrites
// all ten stages to that default and drops any stored BYOK keys. Observed 2026-07-30.
test('appSettings is never rebound — loadSettings must mutate it in place', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /const appSettings = \{\};/,
        'appSettings must be declared const so it cannot be rebound');
    assert.doesNotMatch(serverJs, /\blet appSettings\b/,
        'appSettings must not be declared with let');
    assert.doesNotMatch(serverJs, /^\s*appSettings\s*=/m,
        'appSettings must never be reassigned — mutate via replaceAppSettings()');
});
