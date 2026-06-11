import { readFileSync } from 'fs';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

const md = readFileSync('/Users/lee/Desktop/AIOS-HANDOFF-2026-06-08.md', 'utf8');
const body = marked.parse(md);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 16mm 18mm 16mm; }
  body { font-family: "PingFang SC",-apple-system,sans-serif; line-height:1.7; font-size:12px; color:#1a1a2e; }
  h1 { font-size:22px; color:#fff; background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:14px 18px; border-radius:8px; margin:0 0 20px; }
  h2 { font-size:16px; color:#4f46e5; border-bottom:2px solid #e0e7ff; padding-bottom:6px; margin:20px 0 10px; }
  h3 { font-size:13px; color:#374151; margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; margin:8px 0 14px; font-size:11px; }
  th { background:#4f46e5; color:#fff; padding:6px 8px; text-align:left; }
  td { border:1px solid #e5e7eb; padding:5px 8px; }
  tr:nth-child(even) td { background:#f5f3ff; }
  strong { color:#4f46e5; }
  ul, ol { margin:6px 0 8px 18px; padding:0; }
  li { margin:3px 0; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:16px 0; }
  code { background:#f3f4f6; padding:1px 4px; border-radius:3px; font-size:11px; }
  pre { background:#1e1e2e; color:#cdd6f4; padding:12px; border-radius:6px; font-size:10px; overflow-x:auto; }
  pre code { background:none; color:inherit; padding:0; }
  .footer { text-align:center; color:#9ca3af; font-size:9px; margin-top:24px; border-top:1px solid #e5e7eb; padding-top:8px; }
</style></head>
<body>${body}
<div class="footer">AIOS 项目交接 · 2026年6月8日</div>
</body></html>`;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.pdf({ path: '/Users/lee/Desktop/AIOS-P0优化详细规划.pdf', format: 'A4', printBackground: true });
await browser.close();
console.log('✅ PDF generated');
