import { readFileSync } from 'fs';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

const md = readFileSync('/Users/lee/Desktop/AI/aios-app/release/AIOS-beta6-vs-beta14-对比报告-v2.md', 'utf8');
const body = marked.parse(md);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 20mm 18mm 22mm 18mm; }
  body { font-family: "PingFang SC", "STHeiti", "Microsoft YaHei", -apple-system, sans-serif; line-height: 1.9; font-size: 14px; color: #1a1a2e; }
  h1 { font-size: 26px; color: #fff; background: #1f4e78; padding: 18px 22px; border-radius: 6px; margin: 0 0 26px; }
  h2 { font-size: 19px; color: #1f4e78; border-bottom: 3px solid #1f4e78; padding-bottom: 8px; margin: 30px 0 14px; }
  h3 { font-size: 15px; color: #374151; margin: 20px 0 10px; }
  p { margin: 10px 0; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0 20px; font-size: 13px; }
  th { background: #1f4e78; color: #fff; padding: 10px 12px; text-align: left; }
  td { border: 1px solid #d1d5db; padding: 9px 12px; }
  tr:nth-child(even) td { background: #f7f9fc; }
  strong { color: #1f4e78; }
  blockquote { border-left: 5px solid #1f4e78; background: #eef3f8; padding: 12px 16px; margin: 16px 0; color: #2d3a4a; font-size: 15px; }
  ul { margin: 10px 0 14px 24px; padding: 0; }
  li { margin: 6px 0; }
  hr { border: none; border-top: 2px solid #e5e7eb; margin: 28px 0; }
  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 34px; border-top: 1px solid #e5e7eb; padding-top: 14px; }
</style></head>
<body>${body}
<div class="footer">AIOS · 2026年6月8日</div>
</body></html>`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
const outPath = '/Users/lee/Desktop/AI/aios-app/release/AIOS-beta6-vs-beta14-对比报告.pdf';
await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '22mm', left: '18mm', right: '18mm' } });
await browser.close();
import { statSync } from 'fs';
console.log('PDF: ' + outPath + ' (' + (statSync(outPath).size / 1024).toFixed(1) + ' KB)');
