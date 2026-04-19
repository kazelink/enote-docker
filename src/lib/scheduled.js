const DAY_MS = 24 * 60 * 60 * 1000;
import { extractMediaKeys, toBackupEntry, toBackupFolder } from './utils.js';

function uploadedAtMs(obj) {
    const ts = obj?.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(String(obj?.uploaded || ''));
    return Number.isFinite(ts) ? ts : 0;
}

async function listAllObjects(bucket, prefix) {
    const objects = [];
    let cursor = undefined;
    while (true) {
        const listed = await bucket.list({ prefix, cursor });
        if (Array.isArray(listed?.objects) && listed.objects.length > 0) {
            objects.push(...listed.objects);
        }
        if (!listed?.truncated || !listed?.cursor) break;
        cursor = listed.cursor;
    }
    return objects;
}

import { db, bucket } from './core.js';

export async function scheduledGc() {
    try {
        const [notesRes, tmpObjects, allMediaObjects] = await Promise.all([
            db.prepare('SELECT content FROM notes').all(),
            listAllObjects(bucket, 'tmp/'),
            listAllObjects(bucket, '')
        ]);

        const cutoff = Date.now() - DAY_MS;
        const staleTmp = tmpObjects.filter((obj) => {
            const ts = uploadedAtMs(obj);
            return ts > 0 && ts < cutoff;
        });
        if (staleTmp.length > 0) {
            await Promise.allSettled(staleTmp.map((obj) => bucket.delete(obj.key)));
        }

        const allActiveKeys = new Set();
        if (notesRes.results) {
            for (const row of notesRes.results) {
                const keys = extractMediaKeys(row.content);
                keys.forEach((key) => allActiveKeys.add(key));
            }
        }

        const toGc = allMediaObjects
            .map((obj) => obj.key)
            .filter((key) => {
                if (key.startsWith('tmp/')) return false;
                if (key.startsWith('backups/')) return false; // Exclude user's manual backups if they exist in bucket
                return !allActiveKeys.has(key);
            });

        if (toGc.length > 0) {
            console.log(`Media GC: deleting ${toGc.length} orphaned media files.`);
            await Promise.allSettled(toGc.map((key) => bucket.delete(key)));
        }
    } catch (e) {
        console.error('Scheduled GC failed:', e);
    }
}
