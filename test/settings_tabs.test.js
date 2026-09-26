const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Settings, after the 2026-09-26 simplification: a writer picks ONE model per
// project from the sidebar; the Models tab is one sentence plus (for admins) one
// default select; Admin holds deployment keys, people and budgets, and a compact
// model list whose only action is "Check this model works". Everything an operator
// wanted — per-stage lists, the Auto editor, the registry editor, Discover, the
// updates banner — is gone from the app; model curation happens in the repo.
// Guard breaks: a per-stage list creeping back → test 1 · the sidebar picker or its
// save path removed → test 2 · the footer Save returning → test 1 · a registry
// editor returning → test 3.

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function panel(name) {
    const start = INDEX.indexOf(`id="settings-panel-${name}"`);
    assert.ok(start > 0, `settings-panel-${name} exists`);
    const rest = INDEX.slice(start + 1);
    const next = rest.search(/id="settings-panel-(?:models|account|admin)"|id="settings-build-fingerprint"/);
    assert.ok(next > 0);
    return rest.slice(0, next);
}

test('three tabs; the Models tab is one sentence and one default select; no per-stage list anywhere; no footer Save', () => {
    for (const tab of ['models', 'account', 'admin']) {
        assert.match(INDEX, new RegExp(`id="settings-tab-${tab}"[^>]*data-settings-tab="${tab}"`));
    }
    const models = panel('models');
    assert.match(models, /id="settings-model-note"/);
    assert.match(models, /id="settings-default-model"/);
    assert.match(models, /id="btnSaveDefaultModel"/);
    for (const gone of ['settings-stage-models', 'settings-global-stage-models', 'settings-global-models-panel', 'settings-model-stage', 'settings-recommended', 'settings-models-updates', 'settings-model-new-id', 'btnAdminDiscoverModels', 'btnAdminCheckUpdates', 'btnSaveGlobalModels', 'saveSettingsBtn']) {
        assert.doesNotMatch(INDEX, new RegExp(gone), `${gone} must not come back`);
    }
    const account = panel('account');
    for (const id of ['settings-account-panel', 'settings-my-keys-panel', 'settings-tokens-panel']) assert.match(account, new RegExp(`id="${id}"`));
    const admin = panel('admin');
    for (const id of ['settings-api-key-section', 'settings-admin-panel', 'settings-models-panel', 'settings-models-list']) assert.match(admin, new RegExp(`id="${id}"`));
    assert.match(INDEX, /id="cancelSettingsBtn"[^>]*>Close</);
    assert.match(INDEX, /id="settings-build-fingerprint"/);
});

test('the sidebar picker: one model per project, saved on change, with an admin-only Make default', () => {
    assert.match(INDEX, /id="projectModelSelect"/);
    assert.match(INDEX, /id="btnMakeDefaultModel"[^>]*class="[^"]*hidden/);
    assert.match(APP, /async function renderProjectModelPicker\(data/);
    assert.match(APP, /renderProjectModelPicker\(projectDetails\.data\)/, 'filled when a project opens');
    assert.match(APP, /fetch\(`\/api\/projects\/\$\{activeProjectId\}\/model`, \{\s*method: 'PUT'/, 'the picker saves through the project-model route');
    assert.match(APP, /async function saveDeploymentDefault\(modelId\)/);
    assert.match(APP, /STAGE_MODEL_LABELS\.forEach\(\(\[n\]\) => \{ stageModels\[`stage\$\{n\}`\] = modelId; \}\)/, 'the default is one model written to every stage');
    assert.match(APP, /MODEL_OPTIONS\.some\(opt => opt\.value === currentModel\)/, 'a saved model outside the list is still shown, never silently replaced');
    assert.match(APP, /\.filter\(m => m\.enabled && !m\.deprecated && !m\.successor\)/, 'retired and superseded models are not offered');
    assert.match(APP, /a\.order \?\? 1e9\) - \(b\.order \?\? 1e9\)/, 'the list follows the bundle\'s curated order');
});

test('Admin → Models is a status list with one action; the operator machinery is gone from the client', () => {
    assert.match(APP, /function modelStatusRow\(model\)/);
    assert.match(APP, /verifyBtn\.textContent = 'Check this model works'/);
    assert.match(APP, /\/api\/admin\/models\/\$\{encodeURIComponent\(model\.id\)\}\/verify/);
    for (const gone of ['describeStageChoice', 'stageModelRow', 'renderRecommendedConflicts', 'renderModelUpdates', 'btnAdminAddModel', 'btnAdminDiscoverModels', 'btnAdminSaveRecommended', 'btnAdminCheckUpdates', 'collectStageModels', 'saveSettingsBtn', 'settings-model-stage', 'Auto \\(recommended']) {
        assert.doesNotMatch(APP, new RegExp(gone), `${gone} must not come back to app.js`);
    }
    assert.match(APP, /function refreshSettingsTabs\(\)/);
    const open = APP.slice(APP.indexOf('async function openSettingsModal()'), APP.indexOf('function closeSettingsModal()'));
    assert.match(open, /renderDefaultModelSection\(settings\);\s*refreshSettingsTabs\(\);\s*settingsModal\.classList\.remove\('hidden'\)/);
});
