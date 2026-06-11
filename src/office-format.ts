import { readFileSync } from 'node:fs';
import { cleanUserGoal } from './goal';

const EXPLICIT_FORMATS = new Set(['docx', 'pdf', 'xlsx', 'pptx', 'md']);

function formatsFromJsonText(text: string): string[] {
  const match = text.match(/"formats"\s*:\s*\[([\s\S]*?)\]/);
  if (match) {
    return [...new Set([...match[1]!.matchAll(/"([a-z0-9]+)"/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((ext) => EXPLICIT_FORMATS.has(ext)))];
  }
  return [];
}

function officeContractSlice(goal: string): string {
  const marker = '# AIOS 办公交付物质量契约';
  const idx = goal.indexOf(marker);
  if (idx < 0) return '';
  const after = goal.slice(idx + marker.length);
  const nextMarkers = [
    '\n# AIOS 自动返修上下文',
    '\n# 数据时效/证据契约',
    '\n# 客户长期偏好/背景',
    '\n# 上一版交付物上下文',
    '\n# 上一版失败/需修复上下文',
    '\n# 用户拖入的文件/文件夹',
    '\n执行要求:',
  ]
    .map((m) => after.indexOf(m))
    .filter((idx) => idx >= 0);
  const end = nextMarkers.length ? Math.min(...nextMarkers) : after.length;
  return after.slice(0, end);
}

export function officeFormatsFromGoal(goal: string): string[] {
  const contractFormats = formatsFromJsonText(officeContractSlice(goal));
  if (contractFormats.length) return contractFormats;

  const userGoal = cleanUserGoal(goal);
  const explicitFormats = formatsFromJsonText(userGoal);
  if (explicitFormats.length) return explicitFormats;

  const compact = userGoal.toLowerCase().replace(/\s+/g, '');
  const formats: string[] = [];

  if (/(?:pptx?|powerpoint|slides?|presentation|幻灯片|演示文稿|汇报ppt|汇报材料|路演|演示)/i.test(compact)) {
    formats.push('pptx');
  }
  if (/(?:excel|xlsx|spreadsheet|工作簿|电子表格|台账|对账|登记表|统计表|汇总表|明细表|费用表|付款表|发票表|预算表|测算表|报价单|比价表|采购表|跟踪表|督办表|清单|报表)/i.test(compact)) {
    formats.push('xlsx');
  }
  if (/(?:word|docx|文档|报告|调研|研究|建议书|方案|计划|计划书|商业计划|上市计划|纪要|请示|情况说明|通知|函|制度|合同评审|总结|简报)/i.test(compact)) {
    formats.push('docx');
  }
  if (/(?:fidic|菲迪克|工程合同|合同雷达|索赔|time-?bar|notice|daab|dab|工程师决定|变更指令|eot|工期索赔|付款申请|boq)/i.test(compact)) {
    formats.push('docx', 'xlsx');
  }
  if (
    /pdf/i.test(compact)
    || /(?:商业计划|上市计划|餐饮项目|泰餐|餐厅|融资|上市).*(?:计划|方案|报告|材料)|(?:计划|方案|报告|材料).*(?:上市|融资|餐饮|泰餐|餐厅)/i.test(compact)
  ) formats.push('pdf');

  return [...new Set(formats)];
}

export function defaultOutFileForFormat(goal: string, ext: string): string {
  const compact = cleanUserGoal(goal).replace(/\s+/g, '');
  const base = /(餐饮|泰餐|餐厅|饭店|商业计划|上市|融资)/i.test(compact)
    ? '餐饮项目商业计划书'
    : /合同/i.test(compact)
        ? '合同台账模板'
    : /报销|费用|发票|票据/i.test(compact)
    ? '费用报销台账模板'
    : /FIDIC|fidic|菲迪克|合同雷达|工程合同|索赔|Notice|notice|TimeBar|time-?bar|DAAB|DAB|EOT/i.test(compact)
      ? (ext === 'xlsx' ? 'FIDIC合同雷达台账' : 'FIDIC合同雷达报告')
      : /周报|本周完成|下周计划|领导协调|问题风险/i.test(compact)
        ? '项目周报'
      : /月报|月度工作|月度总结/i.test(compact)
        ? '项目月报'
      : /会议|纪要|督办|待办|闭环/i.test(compact)
      ? '会议事项跟踪清单'
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
