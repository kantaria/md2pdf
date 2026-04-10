'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const puppeteer = require('puppeteer');

// Load CSS once at module load.
const rootDir = path.join(__dirname, '..');
const templateHtml = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const markdownCss = fs.readFileSync(
  path.join(rootDir, 'node_modules/github-markdown-css/github-markdown-light.css'),
  'utf8',
);
const highlightCss = fs.readFileSync(
  path.join(rootDir, 'node_modules/highlight.js/styles/github.css'),
  'utf8',
);

const md = new MarkdownIt({
  html: false, // escape raw HTML — untrusted input
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        );
      } catch (_) {
        // fall through
      }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  },
});

let browserPromise = null;

function launchBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--font-render-hinting=none',
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (_) {
    // ignore
  } finally {
    browserPromise = null;
  }
}

function renderHtml(markdown, { title = 'Document' } = {}) {
  const content = md.render(markdown || '');
  return templateHtml
    .replace('{{markdownCss}}', markdownCss)
    .replace('{{highlightCss}}', highlightCss)
    .replace('{{title}}', escapeHtml(title))
    .replace('{{content}}', content);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a markdown string to a PDF buffer.
 * Renders in an isolated Puppeteer page with JavaScript disabled and all
 * network requests blocked, to neutralize SSRF / exfiltration via user markdown.
 */
async function convertMarkdownToPdf(markdown, options = {}) {
  const html = renderHtml(markdown, options);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      // Allow only the initial document set via setContent and inline data: URLs.
      if (url.startsWith('data:') || url === 'about:blank') {
        req.continue();
      } else {
        req.abort();
      }
    });

    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    return pdfBuffer;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  convertMarkdownToPdf,
  renderHtml,
  launchBrowser,
  closeBrowser,
};
