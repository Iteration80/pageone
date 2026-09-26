#!/usr/bin/env node
/**
 * Check the three price sources and update the model registry — from a Claude Code
 * session, not from the app (2026-09-26). Locally DATA_ROOT is the repo's data/ so
 * this edits data/models.json (the bundle) directly; commit it and deploy, and the
 * app merges it at boot. Rules and sources: utils/model_updates.js.
 *
 *   npm run models:check              # apply agreed prices and new models to the bundle
 *   npm run models:check -- --dry-run # report only
 *   MODEL_UPDATES_FIXTURE_DIR=<dir> node scripts/models-check.js   # from captured payloads
 */
const modelUpdates = require('../utils/model_updates');

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const { plan, applied, state } = await modelUpdates.checkForUpdates({ apply: !dryRun, by: 'models:check' });
    const src = Object.entries(state.sources || {}).map(([n, s]) => `${n}: ${s.ok ? `ok (${s.models})` : `FAILED — ${s.error}`}`).join('\n  ');
    console.log(`Sources\n  ${src}`);
    if (plan.tooFewSources) {
        console.log('\nFewer than two sources answered — nothing written.');
        process.exitCode = 2;
        return;
    }
    const list = (label, items) => console.log(`\n${label}${items.length ? '' : ': none'}` + items.map(i => `\n  ${i}`).join(''));
    list('Bundle rows missing on this store', plan.bundleAdds.map(r => r.id));
    list(`New models with an agreed price${dryRun ? ' (would add)' : ' (added)'}`, plan.added.map(r => `${r.id}  $${r.pricing.inputPerMTok}/$${r.pricing.outputPerMTok}  ${r.pricing.source.split(' — ')[0]}`));
    list(`Prices that moved${dryRun ? ' (would update)' : ' (updated)'}`, plan.priced.map(p => `${p.id}  $${p.from.inputPerMTok}/$${p.from.outputPerMTok} → $${p.to.inputPerMTok}/$${p.to.outputPerMTok}${p.skipped ? `  (skipped: ${p.skipped})` : ''}`));
    list('Conflicts — sources disagree, nothing written', plan.conflicts.map(c => `${c.id}: ${c.values.map(v => `${v.source} $${v.inputPerMTok}/$${v.outputPerMTok}`).join(', ')}`));
    list('Known to one source only', plan.awaitingSecondSource.map(a => `${a.id} (${a.source})`));
    list('Retirements in use (set the successor as default and tell Carsten)', plan.retirements.map(r => `${r.id} → ${r.successor}: ${r.stages.length} stage default(s), Auto on ${r.autoStages.length}`));
    if (applied?.errors?.length) {
        console.log('\nErrors');
        for (const e of applied.errors) console.log(`  ${e.id}: ${e.error}`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
});
