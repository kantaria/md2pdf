# md2pdf

Minimal web service that turns a Markdown file into a styled PDF. Drop a `.md`
file (or paste into the editor), hit **Convert**, download the PDF. Files live
on disk for **30 minutes**, then vanish.

Live: **https://pdf.mkantaria.com**

## Features

- Single-page UI — drag & drop plus textarea editor with live preview
- Server-side rendering via Puppeteer + `markdown-it` + `github-markdown-css` +
  `highlight.js` syntax highlighting
- Hard limits: 5 MB payload, 20 req/min per IP, 30 minute TTL
- No raw HTML from user input (markdown-it `html: false`, page JS disabled,
  subresource requests blocked at the Puppeteer level)
- Runs under `pm2`, reverse-proxied by Nginx with Let's Encrypt

## Stack

- Node.js 20, Express 4
- [`markdown-it`](https://github.com/markdown-it/markdown-it) for parsing
- [`highlight.js`](https://highlightjs.org/) for code blocks
- [`github-markdown-css`](https://github.com/sindresorhus/github-markdown-css)
  for styles
- [`puppeteer`](https://pptr.dev/) for the HTML → PDF step
- `helmet`, `express-rate-limit`, `multer`, `uuid`

## Local development

```bash
nvm use            # Node 20
npm install        # downloads Chromium via Puppeteer (~300 MB on first install)
cp .env.example .env
npm start          # http://localhost:3011
```

Quick smoke test (renders `sample.md` into `tmp/sample.pdf`):

```bash
npm run test-convert
```

### Environment variables

| Name | Default | Purpose |
|------|---------|---------|
| `PORT` | `3011` | HTTP port |
| `NODE_ENV` | `production` | Standard Node env |
| `FILE_TTL_MS` | `1800000` | How long generated PDFs live on disk, in ms |
| `PUPPETEER_EXECUTABLE_PATH` | _(unset)_ | Use a system Chromium/Chrome instead of the bundled one |

### HTTP API

`POST /api/convert`

Two request shapes are supported:

1. JSON body: `{"markdown": "# Hello"}` with `Content-Type: application/json`
2. Multipart upload: field name `file`, a `.md` / `.markdown` / `.txt` file

Response:

```json
{
  "id": "8f1c...",
  "url": "/api/download/8f1c...",
  "expiresAt": "2026-04-10T12:34:56.000Z",
  "bytes": 23456
}
```

`GET /api/download/:id` streams the PDF. Returns `410 Gone` after TTL.

`GET /api/health` returns `{ "ok": true, "ttlMs": 1800000 }`.

### Limits

| Limit | Value |
|-------|-------|
| Upload / JSON payload | 5 MB |
| Rate limit | 20 req / min per IP (on `/api/convert`) |
| File lifetime | 30 minutes |
| Max concurrent | 1 pm2 worker (bump `instances` in `ecosystem.config.js` if needed) |

## Deployment

### Prerequisites

- A Linux VPS with Node 20, `pm2`, a reverse proxy (nginx or caddy)
- A DNS A record pointing your subdomain at the server
- (Debian/Ubuntu) install the Chromium runtime libraries:

  ```bash
  sudo apt-get update
  sudo apt-get install -y \
    libxkbcommon0 libgbm1 libnss3 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libpangocairo-1.0-0 \
    libatspi2.0-0 libxshmfence1 libasound2t64 \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk
  ```

### Clone + run

```bash
git clone https://github.com/kantaria/md2pdf.git /var/www/pdf.example.com
cd /var/www/pdf.example.com
npm ci --omit=dev
pm2 start ecosystem.config.js
pm2 save
```

### Reverse proxy — Nginx

```nginx
server {
    listen 80;
    server_name pdf.example.com;
    return 301 https://pdf.example.com$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pdf.example.com;

    ssl_certificate     /etc/letsencrypt/live/pdf.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pdf.example.com/privkey.pem;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pdf.example.com
```

### Reverse proxy — Caddy

```
pdf.example.com {
    reverse_proxy 127.0.0.1:3011
    request_body {
        max_size 6MB
    }
}
```

Caddy will issue the TLS certificate automatically.

### Updating

```bash
cd /var/www/pdf.example.com
git pull
npm ci --omit=dev
pm2 reload md2pdf
```

Logs: `pm2 logs md2pdf`.

## Security notes

- `markdown-it` is configured with `html: false`, so raw HTML in user input is
  escaped rather than rendered.
- Puppeteer runs with JavaScript disabled and intercepts every request — only
  the inline `setContent` HTML and `data:` URLs are allowed. External images /
  fonts / fetches are dropped. This prevents SSRF and data exfiltration via
  crafted markdown.
- `helmet` sets a strict CSP; static assets are served from the same origin.
- Uploads are validated by extension, MIME type, size, and a NUL-byte check.
- Trust-proxy is enabled so the rate limiter uses the real client IP forwarded
  by nginx.
- This is a public service: **never** paste sensitive content. Files are
  stored unencrypted in `tmp/` until the 30-minute sweeper removes them.

## License

[MIT](./LICENSE) © 2026 Michael Kantaria
