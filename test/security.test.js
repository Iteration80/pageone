const test = require('node:test');
const assert = require('node:assert/strict');

const {
    issueAuthSession,
    verifyAuthSessionToken,
    parseAccessKeys,
    hasAdminRole,
    summarizeDailyAiUsage,
    aiDailyLimitReasons,
    buildContentSecurityPolicy
} = require('../server');

test('auth sessions are signed and tamper-resistant', () => {
    const issued = issueAuthSession({ label: 'private-tester', role: 'tester' });
    const verified = verifyAuthSessionToken(issued.token);

    assert.equal(verified.type, 'session');
    assert.equal(verified.sessionId, issued.sessionId);
    assert.equal(verified.label, 'private-tester');
    assert.equal(verified.role, 'tester');
    assert.equal(hasAdminRole(verified), false);
    assert.ok(verified.expiresAt > Date.now());

    const tampered = issued.token.replace(/.$/, char => (char === 'a' ? 'b' : 'a'));
    assert.equal(verifyAuthSessionToken(tampered), null);
});

test('access key config supports labeled tester and admin keys', () => {
    const records = parseAccessKeys(JSON.stringify([
        { label: 'tester-1', key: 'tester-key-0000000000000000' },
        { label: 'carsten', key: 'admin-key-00000000000000000', role: 'admin' }
    ]));

    assert.equal(records[0].label, 'tester-1');
    assert.equal(records[0].role, 'tester');
    assert.equal(records[1].role, 'admin');

    const adminSession = verifyAuthSessionToken(issueAuthSession(records[1]).token);
    assert.equal(hasAdminRole(adminSession), true);
});

test('daily AI usage summary counts only the current UTC day', () => {
    const now = Date.now();
    const sinceMs = now - 60 * 60 * 1000;
    const project = {
        data: {
            apiUsage: [
                { timestamp: sinceMs + 1000, model: 'gemini-3-flash-preview', inputTokens: 100, outputTokens: 50 },
                { timestamp: sinceMs - 1000, model: 'gemini-3-flash-preview', inputTokens: 999, outputTokens: 999 },
                { timestamp: now, model: 'claude-opus-4-7', inputTokens: 10, outputTokens: 5 }
            ]
        }
    };

    const summary = summarizeDailyAiUsage(project, { sinceMs });

    assert.equal(summary.calls, 2);
    assert.equal(summary.inputTokens, 110);
    assert.equal(summary.outputTokens, 55);
    assert.equal(summary.totalTokens, 165);
    assert.ok(summary.estimatedCostUsd > 0);
});

test('daily AI limit reasons trigger when usage is far above configured defaults', () => {
    const summary = {
        calls: 10,
        inputTokens: 2_000_000_000,
        outputTokens: 2_000_000_000,
        totalTokens: 4_000_000_000,
        estimatedCostUsd: 10_000
    };

    const reasons = aiDailyLimitReasons(summary);

    assert.ok(reasons.some(reason => reason.includes('token limit')));
    assert.ok(reasons.some(reason => reason.includes('estimated cost limit')));
});

test('content security policy blocks inline and third-party scripts', () => {
    const csp = buildContentSecurityPolicy();

    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(?:;|$)/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|@latest/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
});
