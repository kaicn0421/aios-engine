import { readFileSync } from 'fs';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

const md = readFileSync('/Users/lee/Desktop/AI/aios-app/release/AIOS-优化路线图.md', 'utf8');
const body = marked.parse(md);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 16mm 18mm 16mm; }
  body { font-family: "PingFang SC","STHeiti","Microsoft YaHei",-apple-system,sans-serif; line-height:1.8; font-size:13px; color:#1a1a2e; }
  h1 { font-size:24px; color:#fff; background:#1f4e78; padding:16px 20px; border-radius:6px; margin:0 0 22px; }
  h2 { font-size:18px; color:#1f4e78; border-bottom:3px solid #1f4e78; padding-bottom:6px; margin:26px 0 12px; }
  h3 { font-size:14px; color:#374151; margin:16px 0 8px; }
  table { border-collapse:collapse; width:100%; margin:10px 0 16px; font-size:12px; }
  th { background:#1f4e78; color:#fff; padding:8px 10px; text-align:left; }
  td { border:1px solid #d1d5db; padding:7px 10px; }
  tr:nth-child(even) td { background:#f7f9fc; }
  strong { color:#1f4e78; }
  blockquote { border-left:5px solid #1f4e78; background:#eef3f8; padding:10px 14px; margin:14px 0; font-size:14px; }
  ul { margin:8px 0 12px 22px; padding:0; }
  li { margin:5px 0; }
  hr { border:none; border-top:2px solid #e5e7eb; margin:24px 0; }
  .footer { text-align:center; color:#9ca3af; font-size:10px; margin-top:30px; border-top:1px solid #e5e7eb; padding-top:12px; }
  pre { background:#f6f8fb; padding:12px; border-radius:4px; font-size:11px; line-height:1.5; }
</style></head>
<body>${body}
<div class="footer">AIOS · 2026年6月8日 · 优化路线图</div>
</body></html>`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
const out = '/Users/lee/Desktop/AI/aios-app/release/AIOS-优化路线图.pdf';
await page.pdf({ path: out, format: 'A4', printBackground: true });
await browser.close();
import { statSync } from 'fs';
console.log('PDF: ' + out + ' (' + (statSync(out).size/1024).toFixed(1) + ' KB)');
