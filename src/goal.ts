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



// 宿主(Rust 端)拼进 goal 的契约/返修/偏好上下文:从首个 marker 起整段截出。
// cleanUserGoal 在入口剥掉它们后,返修上下文/质量契约曾全程无人消费=自动返修断链
// (审计实证:模型看不到要修什么,manifest 无任何 repair 痕迹)。
export function hostContextSlices(goal: string): string {
  const raw = String(goal || '');
  let first = -1;
  for (const marker of CONTEXT_MARKERS) {
    const idx = raw.indexOf(marker);
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  if (first < 0) return '';
  return raw.slice(first).trim().slice(0, 2400);
}

export function hasRepairContext(goal: string): boolean {
  const raw = String(goal || '');
  return raw.includes('# AIOS 自动返修上下文') || raw.includes('# 上一版失败/需修复上下文');
}
