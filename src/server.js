import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import cron from 'node-cron';
import app from './index.js';
import { scheduledBackup } from './lib/scheduled.js';
import { ensureSchema } from './lib/schema.js';
import { db } from './lib/core.js';

async function startup() {
    await ensureSchema();
    
    // Schedule cron job
    cron.schedule('0 2 * * *', () => {
        console.log('Running scheduled backup...');
        scheduledBackup().catch(console.error);
    });

    const mainApp = new Hono();

    mainApp.use('/*', serveStatic({ root: './public' }));

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
