import { setImmediate as waitImmediate } from 'timers/promises';
import { extractMediaKeys } from './utils.js';
import { db, bucket } from './core.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MEDIA_BATCH_SIZE = 250;
const LOOP_YIELD_EVERY = 200;

function uploadedAtMs(obj) {
    const ts = obj?.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj?.uploaded || ''));
    return Number.isFinite(ts) ? ts : 0;
}

async function maybeYield(iterationCount) {
    if (iterationCount > 0 && iterationCount % LOOP_YIELD_EVERY === 0) {
        await waitImmediate();
    }
}

async function rebuildActiveMediaIndex() {
    db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS gc_active_media (
            key TEXT PRIMARY KEY
        );
        DELETE FROM gc_active_media;
    `);

    const insertActiveKey = db.db.prepare('INSERT OR IGNORE INTO gc_active_media (key) VALUES (?)');
    const flushPendingKeys = db.db.transaction((keys) => {
        for (const key of keys) {
            insertActiveKey.run(key);
        }
    });

    const pendingKeys = new Set();
    let noteCount = 0;

    for (const row of db.prepare('SELECT content FROM notes').iterate()) {
        noteCount += 1;

        const keys = extractMediaKeys(row?.content);
        for (const key of keys) {
            pendingKeys.add(key);
            if (pendingKeys.size >= ACTIVE_MEDIA_BATCH_SIZE) {
                flushPendingKeys([...pendingKeys]);
                pendingKeys.clear();
            }
        }

        await maybeYield(noteCount);
    }

    if (pendingKeys.size > 0) {
        flushPendingKeys([...pendingKeys]);
    }

    return db.db.prepare('SELECT 1 FROM gc_active_media WHERE key = ? LIMIT 1');
}

async function cleanupStaleTmpObjects(cutoff) {
    let scanned = 0;
    let deleted = 0;

    for await (const obj of bucket.iterate({ prefix: 'tmp/' })) {
        scanned += 1;
        const ts = uploadedAtMs(obj);
        if (ts > 0 && ts < cutoff) {
            await bucket.delete(obj.key);
            deleted += 1;
        }
        await maybeYield(scanned);
    }

    return { scanned, deleted };
}

async function cleanupOrphanedMedia(hasActiveKey) {
    let scanned = 0;
    let deleted = 0;

    for await (const obj of bucket.iterate()) {
        scanned += 1;
        const key = obj.key;

        if (key.startsWith('tmp/') || key.startsWith('backups/')) {
            await maybeYield(scanned);
            continue;
        }

        const inUse = !!hasActiveKey.get(key);
        if (!inUse) {
            await bucket.delete(key);
            deleted += 1;
        }

        await maybeYield(scanned);
    }

    return { scanned, deleted };
}

export async function scheduledGc() {
    try {
        const cutoff = Date.now() - DAY_MS;
        const hasActiveKey = await rebuildActiveMediaIndex();

        const tmpStats = await cleanupStaleTmpObjects(cutoff);
        if (tmpStats.deleted > 0) {
            console.log(`Media GC: deleted ${tmpStats.deleted} stale tmp files out of ${tmpStats.scanned} scanned.`);
        }

        const mediaStats = await cleanupOrphanedMedia(hasActiveKey);
        if (mediaStats.deleted > 0) {
            console.log(`Media GC: deleted ${mediaStats.deleted} orphaned media files out of ${mediaStats.scanned} scanned.`);
        }
    } catch (e) {
        console.error('Scheduled GC failed:', e);
    } finally {
        try {
            db.exec('DELETE FROM gc_active_media');
        } catch {
            // Ignore cleanup failures when the temp table was never created.
        }
    }
}
