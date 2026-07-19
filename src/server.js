import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import cron from 'node-cron';
import app from './index.js';
import { scheduledGc } from './lib/scheduled.js';
import { ensureSchema } from './lib/schema.js';
import { db } from './lib/core.js';

async function startup() {
    await ensureSchema();

    // Schedule cron job
    cron.schedule('0 2 * * *', () => {
        console.log('Running scheduled garbage collection...');
        scheduledGc().catch(console.error);
    });

    const mainApp = new Hono();

    // Compress text responses (HTML/JSON/JS/CSS). Media streams are skipped by
    // the middleware's compressible content-type check. Registered first so it
    // wraps both API routes and static files.
    mainApp.use('/*', compress());

    // Cache-Control middleware
    const IMMUTABLE_RE = /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|css)$/i;
    const JS_MODULE_RE = /\.(js|mjs)$/i;

    mainApp.use('/*', async (c, next) => {
        await next();
        const p = c.req.path;
        // Long-immutable for fonts/images/css that are versioned via filename or rarely change.
        if (IMMUTABLE_RE.test(p) || p.startsWith('/assets/')) {
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        // JS modules: never immutable. ES module graphs share state by URL, and stale cached
        // modules cause hard-to-debug "missing export" failures when any module's shape changes.
        // Allow short caching with mandatory revalidation so updates roll out reliably.
        else if (JS_MODULE_RE.test(p)) {
            c.header('Cache-Control', 'no-cache');
        }
        else if (p.endsWith('.html') || p === '/') {
            c.header('Cache-Control', 'no-cache');
        }
        else {
            c.header('Cache-Control', 'no-store');
        }
    });

    // index: serve app.html for "/" directly (saves the /app.html redirect round trip).
    // precompressed: serve build-time .gz files with zero runtime CPU when present.
    mainApp.use('/*', serveStatic({ root: './public', index: 'app.html', precompressed: true }));

    mainApp.route('/', app);

    const port = process.env.PORT || 3000;
    const server = serve({
        fetch: mainApp.fetch,
        port
    }, (info) => {
        console.log(`Server is running on http://localhost:${info.port}`);
    });

    // Graceful shutdown handling
    const shutdown = () => {
        console.log('Shutting down server gracefully...');
        server.close(async () => {
            console.log('HTTP server closed.');
            if (db && typeof db.db?.close === 'function') {
                try {
                    db.db.close();
                    console.log('SQLite database connection closed safely.');
                } catch (err) {
                    console.error('Error closing SQLite database:', err);
                }
            }
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

startup().catch(console.error);
