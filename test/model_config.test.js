const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('assistant Anthropic fallback uses the current Sonnet model', () => {
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.match(serverJs, /model: 'claude-sonnet-5'/);
    assert.doesNotMatch(serverJs, /model: 'claude-sonnet-4-6'/);
});
