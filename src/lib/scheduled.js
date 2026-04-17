const DAY_MS = 24 * 60 * 60 * 1000;
import { extractMediaKeys, parseStoredTags, toBackupEntry, toBackupFolder } from './utils.js';

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

function parseBackupDateMsFromKey(key) {
    const m = String(key || '').match(/^backups\/(\d{4})-(\d{2})-(\d{2})\.json$/);
    if (!m) return 0;
    const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isFinite(ts) ? ts : 0;
}

const MAX_BACKUPS_TO_KEEP = 5;

function selectBackupKeysToDelete(objects) {
    if (!Array.isArray(objects) || objects.length <= MAX_BACKUPS_TO_KEEP) return [];

    const backups = objects
        .map((obj) => ({
            key: String(obj?.key || ''),
            ts: parseBackupDateMsFromKey(obj?.key)
        }))
        .filter((b) => b.ts > 0)
        .sort((a, b) => b.ts - a.ts);

    return backups.slice(MAX_BACKUPS_TO_KEEP).map((b) => b.key);
}

function withBackupObject(objects, key) {
    const list = Array.isArray(objects) ? objects : [];
    return list.some((obj) => String(obj?.key || '') === key)
        ? list
        : [...list, { key }];
}

import { db, bucket } from './core.js';

export async function scheduledBackup() {
    try {
        const [notesRes, foldersRes, backupObjects, tmpObjects, allMediaObjects] = await Promise.all([
            db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all(),
            db.prepare('SELECT * FROM folders ORDER BY lower(category) ASC, lower(subcategory) ASC').all(),
            listAllObjects(bucket, 'backups/'),
            listAllObjects(bucket, 'tmp/'),
            listAllObjects(bucket, '')
        ]);

        const notes = (notesRes.results || []).map(toBackupEntry);
        const folders = (foldersRes.results || []).map(toBackupFolder);
        const backupData = JSON.stringify({
            timestamp: new Date().toISOString(),
            count: notes.length,
            folderCount: folders.length,
            folders,
            notes
        });

        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `backups/${dateStr}.json`;
        await bucket.put(fileName, backupData, {
            httpMetadata: { contentType: 'application/json' }
        });

        const toDelete = selectBackupKeysToDelete(withBackupObject(backupObjects, fileName));
        if (toDelete.length > 0) {
            console.log(`Backup retention: deleting ${toDelete.length} old backups.`);
            await Promise.allSettled(toDelete.map((key) => bucket.delete(key)));
        }

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
                if (key.startsWith('backups/') || key.startsWith('tmp/')) return false;
                return !allActiveKeys.has(key);
            });

        if (toGc.length > 0) {
            console.log(`Media GC: deleting ${toGc.length} orphaned media files.`);
            await Promise.allSettled(toGc.map((key) => bucket.delete(key)));
        }
    } catch (e) {
        console.error('Scheduled backup failed:', e);
    }
}
