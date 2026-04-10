'use strict';

/**
 * Smoke test: render sample.md to a PDF and assert it is > 1 KB.
 * Run with: npm run test-convert
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { convertMarkdownToPdf, closeBrowser } = require('../src/convert');

const ROOT = path.join(__dirname, '..');
const INPUT = path.join(ROOT, 'sample.md');
const OUTPUT = path.join(ROOT, 'tmp', 'sample.pdf');

async function main() {
  const markdown = await fs.readFile(INPUT, 'utf8');
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  const started = Date.now();
  const pdf = await convertMarkdownToPdf(markdown, { title: 'Sample' });
  await fs.writeFile(OUTPUT, pdf);
  const ms = Date.now() - started;
  console.log(`OK  wrote ${OUTPUT} (${pdf.length} bytes, ${ms} ms)`);
  if (pdf.length < 1024) {
    throw new Error(`PDF too small: ${pdf.length} bytes`);
  }
  const header = Buffer.from(pdf.slice(0, 4)).toString('ascii');
  if (header !== '%PDF') {
    throw new Error('Output is not a PDF (missing %PDF header, got: ' + header + ')');
  }
  await closeBrowser();
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
