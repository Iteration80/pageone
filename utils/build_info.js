'use strict';

function normalizeTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return new Date().toISOString();

    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) {
            const millis = raw.length <= 10 ? numeric * 1000 : numeric;
            const date = new Date(millis);
            if (!Number.isNaN(date.getTime())) return date.toISOString();
        }
    }

    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return raw;
}

const BUILD_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null;
const BUILD_DEPLOYMENT_ID = process.env.RAILWAY_DEPLOYMENT_ID || process.env.VERCEL_DEPLOYMENT_ID || null;
const BUILD_TIMESTAMP = normalizeTimestamp(
    process.env.BUILD_TIMESTAMP ||
    process.env.BUILD_TIME ||
    process.env.SOURCE_DATE_EPOCH ||
    process.env.RAILWAY_DEPLOYMENT_CREATED_AT ||
    process.env.VERCEL_DEPLOYMENT_CREATED_AT
);

function getBuildInfo() {
    return {
        commit: BUILD_COMMIT,
        deploymentId: BUILD_DEPLOYMENT_ID,
        buildTimestamp: BUILD_TIMESTAMP
    };
}

function formatBuildFingerprint(info = getBuildInfo()) {
    const commit = info.commit || 'local';
    const timestamp = info.buildTimestamp || 'unknown';
    return `commit=${commit}; buildTimestamp=${timestamp}`;
}

module.exports = {
    BUILD_COMMIT,
    BUILD_DEPLOYMENT_ID,
    BUILD_TIMESTAMP,
    formatBuildFingerprint,
    getBuildInfo,
    normalizeTimestamp
};
