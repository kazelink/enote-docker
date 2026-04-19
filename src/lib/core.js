import Database from 'better-sqlite3';
import fs from 'fs';
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

        const metaPath = filePath + '.meta.json';
        const meta = {
            httpMetadata: options.httpMetadata || {},
            customMetadata: options.customMetadata || {}
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta));

        if (body instanceof Blob || body instanceof File) {
            const arrayBuffer = await body.arrayBuffer();
            fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
        } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
            fs.writeFileSync(filePath, body);
        } else if (body instanceof ReadableStream) {
            await pipeline(Readable.fromWeb(body), fs.createWriteStream(filePath));
        } else if (body && typeof body.pipe === 'function') {
            await pipeline(body, fs.createWriteStream(filePath));
        } else {
            fs.writeFileSync(filePath, Buffer.from(body));
        }
        
        return { key };
    }

    async get(key) {
        const filePath = this._getFilePath(key);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const metaPath = filePath + '.meta.json';
        let meta = { httpMetadata: {}, customMetadata: {} };
        if (fs.existsSync(metaPath)) {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }

        const nodeStream = fs.createReadStream(filePath);
        const webStream = Readable.toWeb(nodeStream);

        return {
            body: webStream,
            httpMetadata: meta.httpMetadata || {},
            writeHttpMetadata: (headers) => {
                if (meta.httpMetadata && meta.httpMetadata.contentType) {
                    headers.set('Content-Type', meta.httpMetadata.contentType);
                }
            },
            customMetadata: meta.customMetadata
        };
    }

    async list({ prefix = '' } = {}) {
        const objects = [];
        const basePrefix = prefix.replace(/\.\./g, '').replace(/^\//, '');
        const searchDir = path.join(this.baseDir, basePrefix);

        if (!fs.existsSync(searchDir)) {
            return { objects: [], truncated: false };
        }

        const walk = (dir, currentPrefix) => {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.endsWith('.meta.json')) continue;
                const fullPath = path.join(dir, entry);
                const stat = fs.statSync(fullPath);
                
                const relativeKey = currentPrefix ? `${currentPrefix}${entry}` : entry;

                if (stat.isDirectory()) {
                    walk(fullPath, `${relativeKey}/`);
                } else if (stat.isFile()) {
                    objects.push({
                        key: basePrefix ? path.join(basePrefix, relativeKey).replace(/\\/g, '/') : relativeKey.replace(/\\/g, '/'),
                        uploaded: stat.mtime,
                        size: stat.size
                    });
                }
            }
        };

        walk(searchDir, '');
        return { objects, truncated: false };
    }

    async delete(key) {
        const filePath = this._getFilePath(key);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        const metaPath = filePath + '.meta.json';
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
        }
    }
}

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'enote.db');
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(process.cwd(), 'data', 'storage');

export const db = new LocalDatabase(DB_PATH);
export const bucket = new LocalStorage(STORAGE_PATH);

export function runBackground(promise) {
    Promise.resolve(promise).catch(e => console.error("Unhandled background task error:", e));
}
