import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeDeliverable } from '../src/build';

const outDir = join(process.cwd(), 'output', `stress-office-50-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

function longMarkdown(title: string): string {
  const sections: string[] = [`# ${title}`, '', '## 执行摘要', '本文件用于 AIOS 大任务压力验收,验证 50 页级正式办公交付不会中途停住。'];
  for (let i = 1; i <= 50; i++) {
    sections.push(
      '',
      `## 第${i}页: 交付能力验证 ${i}`,
      '',
      `本页模拟正式办公材料第 ${i} 页,包含业务背景、执行动作、风险控制和下一步安排。AIOS 必须保持结构完整、格式可打开、内容不截断。`,
      '',
      `| 序号 | 工作项 | 责任人 | 验收点 | 状态 |`,
      `|---|---|---|---|---|`,
      `| ${i}.1 | 资料收集 | 办公室 | 来源可追溯 | 完成 |`,
      `| ${i}.2 | 内容整理 | 经办人 | 章节完整 | 完成 |`,
      `| ${i}.3 | 质量复核 | 负责人 | 文件可打开 | 完成 |`,
      '',
      '- 关键结论: 长任务必须持续推进,不能等待用户反复输入继续。',
      '- 风险控制: 若转换器或模型静默,必须有进度心跳和可恢复状态。',
      '- 下一步: 完成后自动打开推荐文件并展示可点击文件卡片。',
    );
  }
  return sections.join('\n');
}

function slideMarkdown(title: string): string {
  const pages: string[] = [`# ${title}`, ''];
  for (let i = 1; i <= 50; i++) {
    pages.push(
      `## 第${i}页: 大任务验收 ${i}`,
      `- 本页验证 AIOS 能生成第 ${i} 张正式汇报页。`,
      '- 一页一个观点,避免把长文堆成一页。',
      '- 保持页码、标题、要点和商务风格一致。',
      '- 输出文件必须是真 PPTX,不是 HTML 或假扩展名。',
      '',
    );
  }
  return pages.join('\n');
}

function assertFile(path: string, minBytes: number): void {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  const size = statSync(path).size;
  if (size < minBytes) throw new Error(`file too small: ${path} ${size}B`);
}

function unzipText(path: string, inner: string): string {
  return execFileSync('unzip', ['-p', path, inner], { encoding: 'utf8', timeout: 15000 });
}

function pptSlideCount(path: string): number {
  const list = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', timeout: 15000 });
  return list.split('\n').filter((line) => /^ppt\/slides\/slide\d+\.xml$/.test(line)).length;
}

function pdfPageCount(path: string): number {
  const out = execFileSync('pdfinfo', [path], { encoding: 'utf8', timeout: 15000 });
  const m = out.match(/^Pages:\s+(\d+)/m);
  return Number(m?.[1] || 0);
}

try {
  const docx = await writeDeliverable(longMarkdown('AIOS 50页 Word 压力验收'), 'AIOS-50页-Word-压力验收.docx', outDir);
  const pdf = await writeDeliverable(longMarkdown('AIOS 50页 PDF 压力验收'), 'AIOS-50页-PDF-压力验收.pdf', outDir);
  const pptx = await writeDeliverable(slideMarkdown('AIOS 50页 PPT 压力验收'), 'AIOS-50页-PPT-压力验收.pptx', outDir);

  assertFile(docx, 6_000);
  assertFile(pdf, 80_000);
  assertFile(pptx, 40_000);

  const docxText = unzipText(docx, 'word/document.xml').replace(/<[^>]+>/g, '');
  const docxMarkers = (docxText.match(/第\d+页/g) || []).length;
  const pdfPages = pdfPageCount(pdf);
  const pptSlides = pptSlideCount(pptx);

  if (docxMarkers < 50) throw new Error(`docx content incomplete: markers=${docxMarkers}`);
  if (pdfPages < 50) throw new Error(`pdf pages incomplete: pages=${pdfPages}`);
  if (pptSlides < 50) throw new Error(`pptx slides incomplete: slides=${pptSlides}`);

  console.log(JSON.stringify({
    ok: true,
    mode: 'office50-stress',
    outDir,
    docx: { path: docx, markers: docxMarkers, bytes: statSync(docx).size },
    pdf: { path: pdf, pages: pdfPages, bytes: statSync(pdf).size },
    pptx: { path: pptx, slides: pptSlides, bytes: statSync(pptx).size },
  }, null, 2));
} finally {
  if (process.env.AIOS_CLEAN_STRESS_OUTPUT === '1') {
    rmSync(outDir, { recursive: true, force: true });
  }
}
