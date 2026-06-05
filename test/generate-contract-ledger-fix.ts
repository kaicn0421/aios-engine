import { writeDeliverable } from '../src/build';

const dir = '/Users/lee/Desktop/AI/aios-engine/output/aios-1780571901470';
await writeDeliverable(
  [
    '# 合同台账模板',
    '',
    '| 合同编号 | 合同名称 | 供应商 | 合同金额(元) | 履约状态 | 到期日期 | 责任部门 | 经办人 |',
    '|---|---|---|---:|---|---|---|---|',
    '| HT2026001 | 办公用品年度采购合同 | 示例供应商A | 120000 | 履约中 | 2026-12-31 | 办公室 | 张三 |',
  ].join('\n'),
  '合同台账模板.xlsx',
  dir,
);
console.log(`${dir}/合同台账模板.xlsx`);
