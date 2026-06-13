'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const skillCache = new Map();

function normalizeSkillFilename(name) {
    const raw = String(name || '').trim();
    if (!/^[A-Za-z0-9_-]+(?:\.md)?$/.test(raw)) {
        throw new Error(`Invalid skill name: ${name}`);
    }
    return raw.endsWith('.md') ? raw : `${raw}.md`;
}

function loadSkill(name) {
    const filename = normalizeSkillFilename(name);
    if (!skillCache.has(filename)) {
        skillCache.set(filename, fs.readFileSync(path.join(SKILLS_DIR, filename), 'utf8'));
    }
    return skillCache.get(filename);
}

function clearSkillCache() {
    skillCache.clear();
}

module.exports = {
    clearSkillCache,
    loadSkill,
    normalizeSkillFilename
};
