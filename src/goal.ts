const CONTEXT_MARKERS = [
  '# AIOS 自动返修上下文',
  '# AIOS 办公交付物质量契约',
  '# 数据时效/证据契约',
  '# 客户长期偏好/背景',
  '# 上一版交付物上下文',
  '# 上一版失败/需修复上下文',
  '# 用户拖入的文件/文件夹',
  '执行要求:',
];

export function cleanUserGoal(goal: string): string {
  let cleaned = String(goal || '').trim();
  for (const marker of CONTEXT_MARKERS) {
    const idx = cleaned.indexOf(marker);
    if (idx >= 0) cleaned = cleaned.slice(0, idx).trim();
  }
  return cleaned || String(goal || '').trim();
}

