'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { convertMarkdownToPdf, closeBrowser } = require('./convert');
const cleanup = require('./cleanup');

const PORT = Number(process.env.PORT) || 3011;
const TTL_MS = Number(process.env.FILE_TTL_MS) || 30 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'tmp');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ALLOWED_EXT = new Set(['.md', '.markdown', '.txt']);
const ALLOWED_MIME = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/octet-stream',
  '',
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return cb(new Error('Only .md, .markdown, or .txt files are accepted.'));
  }
  if (!ALLOWED_MIME.has((file.mimetype || '').toLowerCase())) {
    return cb(new Error('Unsupported MIME type: ' + file.mimetype));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
  fileFilter,
});

function looksBinary(buf) {
  // Reject buffers containing NUL bytes within the first 8 KB.
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function log(obj) {
  // Minimal structured log — no file contents.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

async function main() {
  await cleanup.init({ dir: TMP_DIR, ttl: TTL_MS });

  const app = express();

  // Nginx sits in front of the app and sets X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'", 'data:'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));

  // Serve static UI.
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, ttlMs: TTL_MS });
  });

  const convertLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  });

  app.post(
    '/api/convert',
    convertLimiter,
    (req, res, next) => {
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('multipart/form-data')) {
        upload.single('file')(req, res, next);
      } else {
        next();
      }
    },
    async (req, res) => {
      const started = Date.now();
      let markdown = '';
      let bytesIn = 0;
      try {
        if (req.file) {
          if (req.file.size > MAX_BYTES) {
            return res.status(413).json({ error: 'File too large (5 MB max).' });
          }
          if (looksBinary(req.file.buffer)) {
            return res.status(400).json({ error: 'File appears to be binary.' });
          }
          markdown = req.file.buffer.toString('utf8');
          bytesIn = req.file.size;
        } else if (req.body && typeof req.body.markdown === 'string') {
          markdown = req.body.markdown;
          bytesIn = Buffer.byteLength(markdown, 'utf8');
          if (bytesIn > MAX_BYTES) {
            return res.status(413).json({ error: 'Markdown too large (5 MB max).' });
          }
        } else {
          return res.status(400).json({
            error: 'Provide a .md file via `file` field or a JSON body with a `markdown` string.',
          });
        }

        if (!markdown.trim()) {
          return res.status(400).json({ error: 'Markdown is empty.' });
        }

        const pdfBuffer = await convertMarkdownToPdf(markdown);

        const id = uuidv4();
        const outPath = path.join(TMP_DIR, `${id}.pdf`);
        await fsp.writeFile(outPath, pdfBuffer);
        cleanup.register(id, outPath);

        const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

        log({
          event: 'convert',
          ip: req.ip,
          bytesIn,
          bytesOut: pdfBuffer.length,
          ms: Date.now() - started,
          id,
        });

        res.json({
          id,
          url: `/api/download/${id}`,
          expiresAt,
          bytes: pdfBuffer.length,
        });
      } catch (err) {
        log({
          event: 'convert_error',
          ip: req.ip,
          bytesIn,
          ms: Date.now() - started,
          error: err.message,
        });
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
        res.status(status).json({ error: err.message || 'Conversion failed.' });
      }
    },
  );

  app.get('/api/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9-]{10,}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    const entry = cleanup.get(id);
    if (!entry) {
      return res.status(410).json({ error: 'File expired or not found.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(entry.path)
      .on('error', () => {
        if (!res.headersSent) res.status(410).end();
      })
      .pipe(res);
  });

  // Error handler for multer / payload errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (5 MB max).' });
    }
    log({ event: 'unhandled_error', error: err.message });
    res.status(400).json({ error: err.message || 'Bad request.' });
  });

  const server = app.listen(PORT, () => {
    log({ event: 'listen', port: PORT, ttlMs: TTL_MS });
  });

  async function shutdown(signal) {
    log({ event: 'shutdown', signal });
    server.close(() => {});
    await cleanup.shutdown();
    await closeBrowser();
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});
