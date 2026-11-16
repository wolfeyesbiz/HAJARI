import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate, seedReferenceData } from './db/migrate.js';
import { attachUser, requireAuth, requireRole } from './middleware/auth.js';
import { errorHandler } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { departmentsRouter, classesRouter, subjectsRouter, periodsRouter, assignmentsRouter } from './routes/catalog.js';
import { peopleRouter } from './routes/people.js';
import { attendanceRouter } from './routes/attendance.js';
import { dashboardRouter } from './routes/dashboard.js';
import { smsRouter } from './routes/smsAdmin.js';
import { reportsRouter, REPORT_LIST } from './routes/reports.js';
import { startOutboxWorker, stopOutboxWorker } from './services/sms.js';
import { main as seedMain } from './scripts/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  await migrate();
  await seedReferenceData();

  const app = express();
  const allowedOrigins = new Set([
    'https://localhost',
    'http://localhost',
    'capacitor://localhost',
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (origin && !allowedOrigins.has(origin)) {
        return res.sendStatus(403);
      }
      return res.sendStatus(204);
    }

    next();
  });
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'attendease', time: new Date().toISOString() }));

  app.use('/api/auth', authRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/subjects', subjectsRouter);
  app.use('/api/periods', periodsRouter);
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/people', peopleRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/sms', smsRouter);
  app.use('/api/reports', reportsRouter);
  app.get('/api/report-catalog', requireAuth, (_req, res) => res.json({ reports: REPORT_LIST }));
  app.get('/api/me/export-scope', requireAuth, requireRole('admin', 'hod', 'teacher'), (_req, res) =>
    res.json({ allowed: true }),
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api).*/, (_req, res, next) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => (err ? next() : undefined));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } }));
  app.use(errorHandler);

  startOutboxWorker();
  return app;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('server.js');
if (isDirectRun) {
  createApp()
    .then((app) => {
      const server = app.listen(config.port, () => {
        console.log(`[attendease] listening on http://localhost:${config.port}`);
        seedMain().catch(err => console.error('[seed] failed', err));
      });
      const shutdown = () => {
        stopOutboxWorker();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[attendease] failed to start', err);
      process.exit(1);
    });
}   