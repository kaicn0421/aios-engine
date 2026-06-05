import { readFileSync } from 'node:fs';

const EXPLICIT_FORMATS = new Set(['docx', 'pdf', 'xlsx', 'pptx', 'md']);

export function officeFormatsFromGoal(goal: string): string[] {
  const match = goal.match(/"formats"\s*:\s*\[([\s\S]*?)\]/);
  if (match) {
    return [...new Set([...match[1]!.matchAll(/"([a-z0-9]+)"/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((ext) => EXPLICIT_FORMATS.has(ext)))];
  }

  const compact = goal.toLowerCase().replace(/\s+/g, '');
  const formats: string[] = [];

  if (/(?:pptx?|powerpoint|slides?|presentation|幻灯片|演示文稿|汇报ppt|汇报材料|路演|演示)/i.test(compact)) {
    formats.push('pptx');
  }
  if (/(?:excel|xlsx|spreadsheet|工作簿|电子表格|台账|对账|登记表|统计表|汇总表|明细表|费用表|付款表|发票表|预算表|测算表|报价单|比价表|采购表|跟踪表|督办表|清单|报表)/i.test(compact)) {
    formats.push('xlsx');
  }
  if (/(?:word|docx|文档|报告|调研|研究|建议书|方案|计划书|纪要|请示|情况说明|通知|函|制度|合同评审|总结|简报)/i.test(compact)) {
    formats.push('docx');
  }
  if (/pdf/i.test(compact)) formats.push('pdf');

  return [...new Set(formats)];
}

export function defaultOutFileForFormat(goal: string, ext: string): string {
  const compact = goal.replace(/\s+/g, '');
  const base = /报销|费用|发票|票据/i.test(compact)
    ? '费用报销台账模板'
    : /会议|纪要|督办|待办|闭环/i.test(compact)
      ? '会议事项跟踪清单'
      : /合同/i.test(compact)
        ? '合同台账模板'
        : /资料|归档|档案/i.test(compact) && /清单|台账|登记|excel|xlsx/i.test(compact)
          ? '资料归档清单'
          : /采购|比价|报价/i.test(compact) && /表|清单|台账|excel|xlsx/i.test(compact)
            ? '采购比价台账'
            : /台账|excel|xlsx|表格|清单|报表|登记表|明细表|汇总表|统计表/i.test(compact)
              ? '办公台账模板'
              : /ppt|pptx|汇报|演示|路演/i.test(compact)
                ? '汇报材料'
                : /报告|调研|研究/i.test(compact)
                  ? '调研报告'
                  : /纪要/i.test(compact)
                    ? '会议纪要'
                    : /通知/i.test(compact)
                      ? '办公室通知'
                      : /方案|计划书|建议书/i.test(compact)
                        ? '办公方案'
                        : 'AIOS交付物';
  return `${base}.${ext}`;
}

export function officeSignatureExpectation(ext: string): string | null {
  if (ext === 'xlsx') return 'xl/workbook.xml';
  if (ext === 'docx') return 'word/document.xml';
  if (ext === 'pptx') return 'ppt/presentation.xml';
  if (ext === 'pdf') return '%PDF';
  return null;
}

export function officeFileSignatureOk(path: string, ext: string): boolean {
  const expected = officeSignatureExpectation(ext);
  if (!expected) return true;
  try {
    const data = readFileSync(path);
    if (ext === 'pdf') return data.subarray(0, 4).toString('latin1') === expected;
    return data.toString('latin1').includes(expected);
  } catch {
    return false;
  }
}

export function officePrimaryExt(requiredFormats: string[]): string | null {
  return requiredFormats.find((ext) => ['xlsx', 'pptx', 'docx', 'pdf'].includes(ext)) || null;
}
