import { readFileSync } from 'fs';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

const md = readFileSync('/Users/lee/Desktop/AIOS-行业调研报告-2026-06-08.md', 'utf8');
const body = marked.parse(md);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 18mm 20mm 18mm; }
  body { font-family: "PingFang SC",-apple-system,sans-serif; line-height:1.8; font-size:13px; color:#1a1a2e; }
  h1 { font-size:24px; color:#fff; background:linear-gradient(135deg,#4f46e5,#7c3aed); padding:16px 20px; border-radius:8px; margin:0 0 22px; }
  h2 { font-size:17px; color:#4f46e5; border-bottom:2px solid #e0e7ff; padding-bottom:6px; margin:22px 0 10px; }
  h3 { font-size:14px; color:#374151; margin:16px 0 8px; }
  table { border-collapse:collapse; width:100%; margin:10px 0 16px; font-size:12px; }
  th { background:#4f46e5; color:#fff; padding:8px 10px; text-align:left; }
  td { border:1px solid #e5e7eb; padding:7px 10px; }
  tr:nth-child(even) td { background:#f5f3ff; }
  strong { color:#4f46e5; }
  ul { margin:8px 0 10px 20px; padding:0; }
  li { margin:4px 0; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:20px 0; }
  .footer { text-align:center; color:#9ca3af; font-size:10px; margin-top:28px; border-top:1px solid #e5e7eb; padding-top:10px; }
</style></head>
<body>${body}
<div class="footer">AIOS · 0.1.2-beta.18 · 2026年6月8日</div>
</body></html>`;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.pdf({ path: '/Users/lee/Desktop/AIOS-更新日志-2026-06-08.pdf', format: 'A4', printBackground: true });
await browser.close();
console.log('✅ PDF 已生成: /Users/lee/Desktop/AIOS-更新日志-2026-06-08.pdf');
