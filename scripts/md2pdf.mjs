import { readFileSync } from 'fs';
import puppeteer from 'puppeteer';

const md = readFileSync('/Users/lee/Desktop/AI/aios-app/release/AIOS-beta6-vs-beta14-对比报告.md', 'utf8');

// Simple markdown → basic HTML conversion (avoiding marked import issues)
function md2html(md) {
  let html = md
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Tables
    .replace(/^\|(.+)\|$/gm, (line) => {
      if (line.includes('---')) return '';
      const cells = line.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    // Code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Blockquotes
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // Lists (keep as-is, wrap later)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Paragraphs (double newlines)
    .replace(/\n\n/g, '</p><p>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>(?:\s*<li>.*?<\/li>)*)/gs, '<ul>$1</ul>');
  
  return `<p>${html}</p>`;
}

const body = md2html(md);

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 14mm 20mm 14mm; }
  body { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; line-height: 1.75; font-size: 13px; color: #1a1a2e; max-width: 800px; margin: 0 auto; padding: 10px; }
  h1 { font-size: 24px; color: #fff; background: linear-gradient(135deg, #1f4e78, #2b6da8); padding: 16px 20px; border-radius: 6px; margin: 0 0 22px; }
  h2 { font-size: 17px; color: #1f4e78; border-bottom: 2px solid #2b6da8; padding-bottom: 6px; margin: 26px 0 12px; }
  h3 { font-size: 14px; color: #374151; margin: 18px 0 8px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; font-size: 12px; }
  th { background: #1f4e78; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; }
  td { border: 1px solid #d1d5db; padding: 7px 10px; }
  strong { color: #1f4e78; }
  code { background: #eef2f7; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  hr { border: none; border-top: 2px solid #e5e7eb; margin: 24px 0; }
  blockquote { border-left: 4px solid #2b6da8; background: #f0f5fb; padding: 10px 14px; margin: 12px 0; color: #374151; font-size: 14px; }
  ul { margin: 8px 0 12px 24px; padding: 0; }
  li { margin: 4px 0; }
  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  .highlight { background: #fef3c7; padding: 2px 8px; border-radius: 3px; }
</style></head>
<body>${body}
<div class="footer">AIOS · 2026年6月8日 · 版本对比报告 · beta.6 → beta.14</div>
</body></html>`;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
const outPath = '/Users/lee/Desktop/AI/aios-app/release/AIOS-beta6-vs-beta14-对比报告.pdf';
await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '20mm', left: '14mm', right: '14mm' } });
await browser.close();
console.log('PDF: ' + outPath);
const { statSync } = await import('fs');
console.log('Size: ' + (statSync(outPath).size / 1024).toFixed(1) + ' KB');
