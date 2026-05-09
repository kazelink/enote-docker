import Database from 'better-sqlite3';
import fs from 'fs';
import { opendir } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

class LocalDatabase {
    constructor(dbPath) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
    }

    prepare(query) {
        return new LocalPreparedStatement(this.db, query);
    }

    async batch(statements) {
        const results = [];
        const runBatch = this.db.transaction(() => {
            for (const stmt of statements) {
                results.push(stmt.runSync());
            }
        });
        runBatch();
        return results;
    }

    exec(sql) {
        return this.db.exec(sql);
    }
}

class LocalPreparedStatement {
    constructor(db, query, params = []) {
        this.db = db;
        this.query = query;
        this.params = params;
    }

    bind(...params) {
        return new LocalPreparedStatement(this.db, this.query, params);
    }

    async all() {
        try {
            const stmt = this.db.prepare(this.query);
            let results;
            if (stmt.reader) {
                results = stmt.all(...this.params);
            } else {
                stmt.run(...this.params);
                results = [];
            }
            return { results, success: true };
        } catch (e) {
            console.error("DB all() error on query:", this.query, e);
            throw e;
        }
    }

    async first() {
        try {
            const stmt = this.db.prepare(this.query);
            if (!stmt.reader) {
                return null;
            }
            const result = stmt.get(...this.params);
            return result || null;
        } catch (e) {
            console.error("DB first() error on query:", this.query, e);
            throw e;
        }
    }

    async run() {
        return this.runSync();
    }

    iterate() {
        try {
            const stmt = this.db.prepare(this.query);
            if (!stmt.reader) {
                stmt.run(...this.params);
                return [][Symbol.iterator]();
            }
            return stmt.iterate(...this.params);
        } catch (e) {
            console.error("DB iterate() error on query:", this.query, e);
            throw e;
        }
    }

    runSync() {
        try {
            const stmt = this.db.prepare(this.query);
            if (stmt.reader) {
                 const rows = stmt.all(...this.params);
                 return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } };
            }
            const info = stmt.run(...this.params);
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        } catch (e) {
            console.error("DB run() error on query:", this.query, e);
            throw e;
        }
    }
}

// MIME type mapping for fast inference
const MIME_BY_EXT = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime'
};

function getMimeTypeFromExtension(key) {
    const ext = key.split('.').pop()?.toLowerCase();
    return ext ? (MIME_BY_EXT[ext] || 'application/octet-stream') : 'application/octet-stream';
}

class LocalStorage {
    constructor(baseDir) {
        this.baseDir = baseDir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    _getFilePath(key) {
        const safeKey = key.replace(/\.\./g, '').replace(/^\//, '');
        return path.join(this.baseDir, safeKey);
    }

    async put(key, body, options = {}) {
        const filePath = this._getFilePath(key);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            const isBlobLike =
                (typeof Blob !== 'undefined' && body instanceof Blob) ||
                (typeof File !== 'undefined' && body instanceof File);

            if (isBlobLike) {
                if (typeof body.stream === 'function') {
                    await pipeline(Readable.fromWeb(body.stream()), fs.createWriteStream(filePath));
                } else {
                    const arrayBuffer = await body.arrayBuffer();
                    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
                }
            } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
                fs.writeFileSync(filePath, body);
            } else if (body instanceof ReadableStream) {
                await pipeline(Readable.fromWeb(body), fs.createWriteStream(filePath));
            } else if (body && typeof body.pipe === 'function') {
                await pipeline(body, fs.createWriteStream(filePath));
            } else {
                fs.writeFileSync(filePath, Buffer.from(body));
            }

            // No .meta.json file needed – MIME type inferred from extension
            return { key };
        } catch (error) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            throw error;
        }
    }

    async get(key) {
        const filePath = this._getFilePath(key);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        // Infer Content-Type from file extension
        const contentType = getMimeTypeFromExtension(key);

        const nodeStream = fs.createReadStream(filePath);
        const webStream = Readable.toWeb(nodeStream);

        return {
            body: webStream,
            httpMetadata: { contentType },
            writeHttpMetadata: (headers) => {
                headers.set('Content-Type', contentType);
            },
            customMetadata: {}
        };
    }

    async *iterate({ prefix = '' } = {}) {
        const basePrefix = prefix.replace(/\.\./g, '').replace(/^\//, '');
        const searchDir = path.join(this.baseDir, basePrefix);

        if (!fs.existsSync(searchDir)) {
            return;
        }

        yield* this._iterateDir(searchDir, '', basePrefix);
    }

    async *_iterateDir(dir, currentPrefix, basePrefix) {
        const handle = await opendir(dir);

        try {
            for await (const entry of handle) {
                // Skip .meta.json files (legacy cleanup)
                if (entry.name.endsWith('.meta.json')) {
                    // Optionally delete stale .meta.json files on iteration
                    try {
                        const metaPath = path.join(dir, entry.name);
                        fs.unlinkSync(metaPath);
                    } catch {
                        // Ignore cleanup errors
                    }
                    continue;
                }

                const fullPath = path.join(dir, entry.name);
                const relativeKey = currentPrefix ? `${currentPrefix}${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    yield* this._iterateDir(fullPath, `${relativeKey}/`, basePrefix);
                    continue;
                }

                if (!entry.isFile()) continue;

                const stat = await fs.promises.stat(fullPath);
                yield {
                    key: basePrefix
                        ? path.join(basePrefix, relativeKey).replace(/\\/g, '/')
                        : relativeKey.replace(/\\/g, '/'),
                    uploaded: stat.mtime,
                    size: stat.size
                };
            }
        } finally {
            await handle.close().catch(() => {});
        }
    }

    async delete(key) {
        const filePath = this._getFilePath(key);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        // No .meta.json to delete
    }
}

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'enote.db');
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(process.cwd(), 'data', 'storage');

export const db = new LocalDatabase(DB_PATH);
export const bucket = new LocalStorage(STORAGE_PATH);

export function runBackground(promise) {
    Promise.resolve(promise).catch(e => console.error("Unhandled background task error:", e));
}
