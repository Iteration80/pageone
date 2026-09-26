const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The Settings modal is three tabs by WHO a setting is for — Models (what runs
// your stages) · Account (you) · Admin (the deployment). 2026-09-25, after the
// modal had grown to ten stacked sections, two identical nine-row dropdown lists
// for admins, and three headings that said "API Keys". These pins hold the split:
// every section keeps its id (the fill/hide scripts did not change), only where it
// sits did. Guard breaks: a section moved out of its tab → the containment test ·
// footer Save posting keys again → the save-shape test · readout removed → the
// helper pins.

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

function panel(name) {
    const start = INDEX.indexOf(`id="settings-panel-${name}"`);
    assert.ok(start > 0, `settings-panel-${name} exists`);
    const rest = INDEX.slice(start + 1); // past this panel's own id, to the next panel's
    const next = rest.search(/id="settings-panel-(?:models|account|admin)"|id="settings-build-fingerprint"/);
    assert.ok(next > 0, `something follows settings-panel-${name}`);
    return rest.slice(0, next);
}

test('the modal has three tabs and every section sits in the tab for whom it is', () => {
    for (const tab of ['models', 'account', 'admin']) {
        assert.match(INDEX, new RegExp(`id="settings-tab-${tab}"[^>]*data-settings-tab="${tab}"`), `tab button for ${tab}`);
    }
    const models = panel('models');
    const account = panel('account');
    const admin = panel('admin');
    assert.match(models, /id="settings-stage-models"/, 'the per-stage list is on Models');
    assert.doesNotMatch(models, /id="settings-global-stage-models"/, 'the deployment defaults are NOT on Models — that was the two-identical-lists problem');
    for (const id of ['settings-account-panel', 'settings-my-keys-panel', 'settings-tokens-panel']) {
        assert.match(account, new RegExp(`id="${id}"`), `${id} is on Account`);
    }
    for (const id of ['settings-api-key-section', 'settings-api-key-managed', 'settings-global-models-panel', 'settings-admin-panel', 'settings-models-panel']) {
        assert.match(admin, new RegExp(`id="${id}"`), `${id} is on Admin`);
    }
    // One "API Keys" heading is the deployment's, one is yours; the third is gone.
    assert.equal((INDEX.match(/>API Keys<\/h4>/g) || []).length, 1, 'exactly one bare "API Keys" heading (the managed-by-server note)');
    assert.match(INDEX, />Deployment API keys<\/h4>/);
    assert.match(INDEX, />Your API Keys<\/h4>/);
    // The build fingerprint survives as a footer, outside the tabs, same id.
    assert.match(INDEX, /id="settings-build-fingerprint"/);
});

test('the footer Save writes stage models only; the deployment keys have their own button', () => {
    const start = APP.indexOf("document.getElementById('saveSettingsBtn')?.addEventListener('click'");
    const end = APP.indexOf("document.getElementById('btnSaveApiKeys')?.addEventListener('click'");
    assert.ok(start > 0 && end > start, 'both handlers exist, Save first');
    const saveHandler = APP.slice(start, end);
    assert.doesNotMatch(saveHandler, /geminiApiKey|anthropicApiKey/, 'Save must not touch the deployment keys — they live on another tab');
    assert.match(saveHandler, /collectStageModels\('settings-model-stage', \{ sparse: true \}\)/, 'the personal map stays sparse');
    assert.match(INDEX, /id="btnSaveApiKeys"/);
    assert.match(APP, /document\.getElementById\('saveSettingsBtn'\)\?\.classList\.toggle\('hidden', name !== 'models'\)/, 'Save is hidden off the Models tab');
});

test('every per-stage row carries a live readout of what will actually run', () => {
    assert.match(APP, /function describeStageChoice\(stageNum, value/);
    assert.match(APP, /function stageModelRow\(num, label, select, ctx/);
    assert.match(APP, /select\.addEventListener\('change', update\)/, 'the readout follows the dropdown');
    assert.match(APP, /deprecated — still runs, but pick a current model/, 'a deprecated-but-saved model is named as such');
    assert.match(APP, /failed Verify on this stage — the stage will refuse it/);
    assert.match(APP, /label: savedModelOptionLabel\(currentModel\)/, 'a saved id outside the list says why it is odd, not just "(saved)"');
    assert.match(CSS, /\.settings-stage-runs\.is-danger/);
});

test('Auto-versus-default disagreement is surfaced on Admin with a fix that never recommends a deprecated model', () => {
    assert.match(INDEX, /id="settings-global-models-conflicts"/);
    assert.match(APP, /function renderRecommendedConflicts\(globalModels/);
    assert.match(APP, /btn\.id = 'btnAdminMatchRecommended'/);
    assert.match(APP, /if \(!row \|\| row\.enabled === false \|\| row\.deprecated\) \{\s*skipped\.push/, 'the client refuses to recommend a deprecated model — the route accepts any registry id');
    assert.match(APP, /renderRecommendedConflicts\(collectStageModels\('settings-global-model-stage'\)\)/, 're-checked after the defaults are saved');
});

test('tabs are computed from what is visible, so a house writer sees one tab and an admin three', () => {
    assert.match(APP, /function settingsTabHasContent\(name\)/);
    assert.match(APP, /function refreshSettingsTabs\(\)/);
    const open = APP.slice(APP.indexOf('async function openSettingsModal()'), APP.indexOf('function closeSettingsModal()'));
    assert.match(open, /refreshSettingsTabs\(\);\s*settingsModal\.classList\.remove\('hidden'\)/, 'tabs are refreshed after every panel has been shown or hidden, right before the modal opens');
});
