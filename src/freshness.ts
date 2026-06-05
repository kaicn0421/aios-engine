import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResult } from './types';

export interface FreshnessSource {
  url: string;
  host: string;
  title?: string;
  status?: number;
  ok: boolean;
  accessed_at: string;
}

export interface FreshnessSummary {
  schema: 'aios.engine.freshness_summary.v1';
  required: boolean;
  verified: boolean;
  current_time: string;
  reason: string;
  source_count: number;
  verified_source_count: number;
  latest_date?: string;
  max_source_age_days?: number;
  gaps: string[];
}

export interface FreshnessArtifacts {
  freshness_verified: boolean;
  freshness_summary?: FreshnessSummary;
  sources_path?: string;
  data_path?: string;
  evidence_manifest?: string;
  files: Array<{ name: string; path: string }>;
}

interface ObservedPage {
  url: string;
  status?: number;
  ok: boolean;
  title?: string;
  text: string;
  dates: string[];
  dataRows: Array<Record<string, string>>;
}

const TIME_WORDS = [
  '现在', '当前', '实时', '最新', '今日', '今天', '本周', '这周', '本月', '这个月',
  '今年', '最近', '近一周', '近一个月', '当下', '目前', '截至', '行情',
  '这礼拜', '这一周', '最近一周', '这个季度', '本季度', '今天',
  '近期', '近来', '近几天',
];
const DATA_WORDS = [
  '价格', '报价', '行情', '均价', '指数', '趋势', '走势', '数据', '调研', '分析',
  '报告', '市场', '热搜', '热榜', '讨论度', '销量', '产量', '库存', '汇率', '股价',
  '话题', '关键词', '榜单', '排名', '热度', '走势', '早报',
  '方向', '项目', '需求', '技能', '仓库', 'repo', 'github',
  '天气', '航班', '延误', '状态', '出门建议',
  '材料', '采购', '风险', '清单',
  '柴油', '汽油', '油价', '燃油', '成品油', 'diesel', 'fuel', 'petrol', 'gasoline',
];
const FRESHNESS_REPAIR_WORDS = [
  '数据滞后', '不是实时', '不是现在', '旧数据', '过期', '不新', '不准', '不对',
  '错了', '重新查', '最新数据', '当前价格', '现在价格', '实时价格', '时效', '修复版',
];
const QUERY_STOP_WORDS = new Set([
  '做', '一份', '简短', '要求', '列出', '最新', '公开', '来源', 'url', 'URL',
  'as', 'of', '日期', '样本', '不要', '长篇', '报告', '调研', '核验', '当前',
  '现在', '行情', '数据', 'DATA', 'GAP', '帮我', '一下', '做一下', '的',
]);

export function needsFreshnessEvidence(goal: string): boolean {
  const compact = goal.toLowerCase().replace(/\s+/g, '');
  if (!compact) return false;
  if (compact.includes('aios.delivery_freshness_contract.v1')) return true;
  const marketPrice = compact.includes('价格')
    && ['调研', '报告', '分析', '趋势', '走势', '行情', '市场', '核验', '来源', '清单', '报价'].some((w) => compact.includes(w));
  const freshnessRepair = FRESHNESS_REPAIR_WORDS.some((w) => compact.includes(w))
    && DATA_WORDS.some((w) => compact.includes(w));
  return freshnessRepair
    || marketPrice
    || (TIME_WORDS.some((w) => compact.includes(w)) && DATA_WORDS.some((w) => compact.includes(w)));
}

export function freshnessInstruction(goal: string): string {
  if (!needsFreshnessEvidence(goal)) return '';
  return [
    '',
    '【数据时效铁律】本任务是数据/价格/行情/趋势类交付。',
    '0. 如果下方出现 AIOS web observe 证据,必须优先使用证据里的 URL、日期、口径和片段;禁止凭记忆补具体价格。',
    '1. 关键数据必须给出可点击 URL、来源名称、发布日期或 as-of 日期、口径。',
    '2. 不得把旧数据冒充当前数据;没有实时源就明确写 DATA_GAP 和缺口。',
    '3. 不要只写“来源:中国水泥网/国家统计局”这种泛称,必须给 URL 或说明用户需提供数据库/API/登录。',
    '4. 结论必须区分当前数据、历史数据、推断/预测。',
  ].join('\n');
}

function contractCurrentTime(goal: string): Date {
  const match = goal.match(/"current_time"\s*:\s*"([^"]+)"/);
  const raw = match?.[1] || '';
  const parsed = raw ? new Date(raw.replace(' ', 'T')) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function uniqueUrls(text: string): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s)\]}>"'，。；、]+/gi;
  for (const m of text.matchAll(re)) {
    urls.add(m[0]!.replace(/[.,;:]+$/, ''));
  }
  return [...urls].slice(0, 40);
}

function htmlEntityDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlEntityDecode(htmlToText(m[1] || '')).slice(0, 120) : undefined;
}

function resultUrlsFromSearchHtml(html: string): string[] {
  const urls = new Set<string>();
  const hrefRe = /href=["']([^"']+)["']/gi;
  for (const m of html.matchAll(hrefRe)) {
    const raw = htmlEntityDecode(m[1] || '');
    addCandidateUrl(raw, urls);
    try {
      const parsed = new URL(raw, 'https://duckduckgo.com');
      const encoded = parsed.searchParams.get('u');
      if (encoded) addCandidateUrl(decodeBingTarget(encoded), urls);
      const ddgTarget = parsed.searchParams.get('uddg');
      if (ddgTarget) addCandidateUrl(decodeURIComponent(ddgTarget), urls);
    } catch {
      // ignore malformed search-result hrefs
    }
  }
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    addCandidateUrl(htmlEntityDecode(m[0] || ''), urls);
  }
  return [...urls].slice(0, 12);
}

function decodeBingTarget(value: string): string {
  const cleaned = value.startsWith('a1') ? value.slice(2) : value;
  try {
    return Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function addCandidateUrl(raw: string, urls: Set<string>): void {
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!raw.startsWith('http')) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  const host = parsed.host.toLowerCase();
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  if (
    host.includes('bing.com')
    || host.includes('microsoft.com')
    || host.includes('duckduckgo.com')
    || host.includes('baidu.com/link')
    || host.includes('google.com')
    || host.includes('doubleclick.net')
  ) return;
  parsed.hash = '';
  urls.add(parsed.toString().replace(/[),.，。]+$/, ''));
}

function goalKeywords(goal: string): string {
  return salientTerms(goal).join(' ');
}

function salientTerms(goal: string): string[] {
  const terms = new Set<string>();
  if (/P\.?\s*O?42\.?5/i.test(goal)) terms.add('P.O42.5');
  if (goal.includes('水泥')) terms.add('水泥');
  if (goal.includes('泰国')) { terms.add('泰国'); terms.add('Thailand'); }
  if (goal.includes('柴油')) { terms.add('柴油'); terms.add('diesel'); terms.add('diesel price'); }
  if (goal.includes('油价') || goal.includes('燃油')) { terms.add('fuel price'); }
  if (goal.includes('均价')) terms.add('均价');
  if (goal.includes('散装')) terms.add('散装');
  if (goal.includes('全国')) terms.add('全国');
  const cleaned = goal
    .replace(/AIOS\.delivery_freshness_contract\.v1[\s\S]*/i, '')
    .replace(/[^\p{Script=Han}A-Za-z0-9.]+/gu, ' ')
    .trim();
  for (const word of cleaned.split(/\s+/)) {
    if (word.length <= 1 || QUERY_STOP_WORDS.has(word)) continue;
    if (/^\d{4}$/.test(word)) continue;
    terms.add(word);
  }
  return [...terms].slice(0, 10);
}

function freshnessSearchQueries(goal: string, now: Date): string[] {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const kw = goalKeywords(goal);
  const queries = new Set<string>();
  if (/水泥|P\.?O?42\.?5/i.test(goal)) {
    queries.add(`${year}年${month}月 P.O42.5 水泥 价格 全国 均价 最新`);
    queries.add(`${year} 水泥价格指数 P.O42.5 行情 周报`);
    queries.add(`中国水泥网 ${year} 水泥价格指数 周报`);
    queries.add(`百年建筑网 ${year} P.O42.5 水泥价格`);
  }
  if (/泰国|thailand/i.test(goal) && /柴油|diesel|燃油|油价/i.test(goal)) {
    queries.add(`Thailand diesel price ${year} ${month} official`);
    queries.add(`Thailand retail diesel price baht litre ${year}`);
    queries.add(`泰国 柴油 价格 ${year} ${month} 最新`);
    queries.add(`EPPO Thailand diesel price ${year}`);
  }
  queries.add(`${kw} ${year}年${month}月 最新 价格 行情`);
  queries.add(`${kw} ${year} 最新 报价 数据`);
  return [...queries].filter(Boolean).slice(0, 4);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<{ status?: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AIOS/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    });
    const text = await res.text();
    return { status: res.status, ok: res.status >= 200 && res.status < 400, text };
  } catch {
    return { ok: false, text: '' };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchResultUrls(query: string): Promise<string[]> {
  const urls = new Set<string>();
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ddg = await fetchWithTimeout(ddgUrl, 9000);
  if (ddg.ok && ddg.text) {
    for (const url of resultUrlsFromSearchHtml(ddg.text)) urls.add(url);
  }
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US&mkt=en-US`;
  const res = await fetchWithTimeout(searchUrl, 9000);
  if (res.ok && res.text) {
    for (const url of resultUrlsFromSearchHtml(res.text)) urls.add(url);
  }
  return [...urls].slice(0, 12);
}

async function observePage(url: string): Promise<ObservedPage> {
  const res = await fetchWithTimeout(url, 9000);
  const text = htmlToText(res.text);
  return {
    url,
    status: res.status,
    ok: res.ok,
    title: extractTitle(res.text),
    text,
    dates: extractDates(text),
    dataRows: extractDataRows(text),
  };
}

function pageRelevantToGoal(page: ObservedPage, goal: string): boolean {
  const haystack = `${page.url} ${page.title || ''} ${page.text.slice(0, 1600)}`.toLowerCase();
  if (/水泥|P\.?O?42\.?5/i.test(goal)) {
    return /水泥|p\.?\s*o?42\.?5|ccement|100njz|mysteel|cement/i.test(haystack);
  }
  if (/泰国|thailand/i.test(goal) && /柴油|diesel|燃油|油价/i.test(goal)) {
    const place = /thailand|thai|泰国|ประเทศไทย/.test(haystack);
    const subject = /\b(diesel|fuel|petrol|gasoline|eppo|baht|litre|liter)\b|oil price|retail price|energy policy|น้ำมัน|ดีเซล|บาท/.test(haystack);
    return place && subject;
  }
  return salientTerms(goal).some((term) => haystack.includes(term.toLowerCase()));
}

function observedPageScore(page: ObservedPage, goal: string): number {
  let score = page.ok ? 3 : 0;
  score += Math.min(page.dates.length, 4);
  score += Math.min(page.dataRows.length * 2, 8);
  if (pageRelevantToGoal(page, goal)) score += 6;
  if (/水泥|价格|行情|指数|报价|P\.?O?42\.?5|diesel|fuel|oil price|baht|litre|liter|retail price|柴油|油价/i.test(`${page.title || ''} ${page.text.slice(0, 500)}`)) score += 3;
  if (/eppo\.go\.th|globalpetrolprices\.com|dailyfuels\.com|bangchak\.co\.th|d-gis\.com/i.test(page.url)) score += 8;
  return score;
}

export async function freshnessObservationContext(goal: string): Promise<string> {
  if (!needsFreshnessEvidence(goal)) return '';
  const now = contractCurrentTime(goal);
  const queries = freshnessSearchQueries(goal, now);
  const resultUrls: string[] = [];
  for (const query of queries) {
    const found = await searchResultUrls(query);
    resultUrls.push(...found);
    if (new Set(resultUrls).size >= 32) break;
  }
  const unique = [...new Set(resultUrls)].slice(0, 24);
  const pages = (await Promise.all(unique.map((url) => observePage(url))))
    .filter((page) => pageRelevantToGoal(page, goal))
    .sort((a, b) => observedPageScore(b, goal) - observedPageScore(a, goal))
    .slice(0, 6);
  if (!pages.length) {
    return [
      '# AIOS web observe 已执行',
      `OBSERVE_TIME: ${now.toISOString()}`,
      `SEARCH_QUERIES: ${queries.join(' | ')}`,
      'OBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。最终报告必须写 DATA_GAP,禁止输出未经验证的当前价格。',
    ].join('\n');
  }
  const chunks = pages.map((p, i) => {
    const rows = p.dataRows.slice(0, 5).map((row) => JSON.stringify(row)).join('\n');
    return [
      `## OBSERVED_SOURCE_${i + 1}`,
      `URL: ${p.url}`,
      `HTTP_STATUS: ${p.status || 'fetch_failed'}`,
      `TITLE: ${p.title || '(no title)'}`,
      `DATES: ${p.dates.slice(-8).join(', ') || '(none parsed)'}`,
      `PRICE_ROWS: ${rows || '(none parsed)'}`,
      `TEXT_EXCERPT: ${p.text.slice(0, 1800)}`,
    ].join('\n');
  });
  return [
    '# AIOS web observe 已执行',
    `OBSERVE_TIME: ${now.toISOString()}`,
    `SEARCH_QUERIES: ${queries.join(' | ')}`,
    '使用规则: 只能把 OBSERVED_SOURCE 中有 URL + 日期/as-of + 价格片段支撑的数据写成当前数据;证据不足时写 DATA_GAP。不要凭记忆输出具体价格。',
    ...chunks,
  ].join('\n\n');
}

function evidenceOnlyText(results: AgentResult[]): string {
  return results
    .map((r) => r.evidenceText || '')
    .filter(Boolean)
    .join('\n\n');
}

function extractDates(text: string): string[] {
  const dates = new Set<string>();
  const months: Record<string, string> = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };
  for (const m of text.matchAll(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g)) {
    const [, y, mo, d] = m;
    dates.add(`${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/\b(0?[1-9]|[12]\d|3[01])[-\s]([A-Za-z]{3,9})[-,\s]+(20\d{2})\b/g)) {
    const [, d, moRaw, y] = m;
    const mo = months[(moRaw || '').toLowerCase()];
    if (mo) dates.add(`${y}-${mo}-${d!.padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\s+(0?[1-9]|[12]\d|3[01]),?\s+(20\d{2})\b/g)) {
    const [, moRaw, d, y] = m;
    const mo = months[(moRaw || '').toLowerCase()];
    if (mo) dates.add(`${y}-${mo}-${d!.padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/(20\d{2})年\s*(1[0-2]|0?[1-9])月\s*([12]\d|3[01]|0?[1-9])日/g)) {
    const [, y, mo, d] = m;
    dates.add(`${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/(20\d{2})年\s*(1[0-2]|0?[1-9])月/g)) {
    const [, y, mo] = m;
    dates.add(`${y}-${mo!.padStart(2, '0')}-01`);
  }
  return [...dates].sort();
}

function extractDataRows(text: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const sentences = text.split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (!isDataSentence(sentence)) continue;
    if (/(搜索词|查询词|SEARCH_QUERIES|OBSERVE_|PRICE_ROWS|\{"context"|""context""|如“|例如|建议使用|要求列出|DATA_GAP|data gap)/i.test(sentence)) continue;
    const valueMatch = sentence.match(/(?<![A-Za-z0-9.])(\d{1,5}(?:\.\d+)?)\s*(元\s*\/\s*吨|元每吨|元\/t|yuan\/t|baht\s*\/\s*lit(?:re|er)|baht\s+per\s+lit(?:re|er)|thb\s*\/\s*l(?:itre|iter)?|thb\s+per\s+lit(?:re|er)|บาท\s*\/\s*ลิตร|บาทต่อลิตร|usd\s*\/\s*lit(?:re|er)|us\$\s*\/\s*lit(?:re|er)|\$\s*\/\s*lit(?:re|er))(?![A-Za-z0-9.])/i)
      || sentence.match(/\b(THB|Baht|USD|US\$|\$|฿)\s*(\d{1,5}(?:\.\d+)?)\s*(?:per\s+lit(?:re|er)|\/\s*lit(?:re|er)|\/\s*l)\b/i);
    if (!valueMatch) continue;
    const unitFirst = /^(THB|Baht|USD|US\$|\$|฿)$/i.test(valueMatch[1] || '');
    const value = Number(unitFirst ? valueMatch[2] : valueMatch[1]);
    const unit = unitFirst ? normalizeCurrencyLiterUnit(valueMatch[1] || '') : normalizeUnit(valueMatch[2] || '');
    if (!validValueForUnit(value, unit)) continue;
    const dates = extractDates(sentence);
    rows.push({
      context: sentence.slice(0, 180),
      date_text: dates.at(-1) || '',
      value: unitFirst ? (valueMatch[2] || '') : (valueMatch[1] || ''),
      unit,
    });
    if (rows.length >= 80) break;
  }
  return rows;
}

function isDataSentence(sentence: string): boolean {
  return /(水泥|P\.?\s*O?42\.?5|均价|价格|报价|行情|指数|柴油|汽油|油价|燃油|成品油|diesel|fuel|petrol|gasoline|oil price|retail price|price|บาท|ลิตร|ดีเซล)/i.test(sentence);
}

function normalizeUnit(raw: string): string {
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/元\/吨|元每吨|元\/t|yuan\/t/i.test(compact)) return '元/吨';
  if (/baht\/lit(?:re|er)|bahtperlit(?:re|er)|thb\/l|thb\/lit(?:re|er)?|thbperlit(?:re|er)|บาท\/ลิตร|บาทต่อลิตร/i.test(compact)) return 'baht/litre';
  if (/usd\/lit(?:re|er)|us\$\/lit(?:re|er)|\$\/lit(?:re|er)/i.test(compact)) return 'USD/litre';
  return raw.replace(/\s+/g, '');
}

function normalizeCurrencyLiterUnit(raw: string): string {
  if (/^(THB|Baht|฿)$/i.test(raw)) return 'baht/litre';
  return 'USD/litre';
}

function validValueForUnit(value: number, unit: string): boolean {
  if (!Number.isFinite(value) || Math.abs(value - 42.5) < 0.01) return false;
  if (unit === '元/吨') return value >= 80 && value <= 2000;
  if (unit === 'baht/litre') return value >= 1 && value <= 80;
  if (unit === 'USD/litre') return value >= 0.1 && value <= 10;
  return value > 0;
}

async function verifyUrl(url: string, accessedAt: string): Promise<FreshnessSource> {
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    return { url, host, status: res.status, ok: res.status >= 200 && res.status < 400, accessed_at: accessedAt };
  } catch {
    return { url, host, ok: false, accessed_at: accessedAt };
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

function csvEscape(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export async function buildFreshnessArtifacts(goal: string, results: AgentResult[], dir: string): Promise<FreshnessArtifacts> {
  if (!needsFreshnessEvidence(goal)) {
    return { freshness_verified: true, files: [] };
  }
  mkdirSync(dir, { recursive: true });
  const now = contractCurrentTime(goal);
  const accessedAt = now.toISOString();
  const text = evidenceOnlyText(results);
  const urls = uniqueUrls(text);
  const sources = await Promise.all(urls.map((url) => verifyUrl(url, accessedAt)));
  const dates = extractDates(text);
  const latestDate = dates.at(-1);
  const sourceRows = sources.map((s) => JSON.stringify(s)).join('\n') + (sources.length ? '\n' : '');
  const sourcesPath = join(dir, 'sources.jsonl');
  writeFileSync(sourcesPath, sourceRows, 'utf8');

  const dataRows = extractDataRows(text);
  const verifiedSourceCount = sources.filter((s) => s.ok).length;
  const gaps: string[] = [];
  if (!sources.length) gaps.push('没有可点击 URL 来源');
  if (!verifiedSourceCount) gaps.push('没有通过 HTTP 校验的来源 URL');
  const usableDataRows = verifiedSourceCount > 0 ? dataRows : [];
  const rowDates = usableDataRows.map((row) => row.date_text).filter(Boolean).sort();
  const summaryLatestDate = usableDataRows.length ? (rowDates.at(-1) || latestDate) : undefined;
  const latestDateObj = summaryLatestDate ? new Date(summaryLatestDate) : undefined;
  const maxSourceAgeDays = latestDateObj && !Number.isNaN(latestDateObj.getTime())
    ? daysBetween(now, latestDateObj)
    : undefined;
  if (!summaryLatestDate) gaps.push('没有可解析的数据发布日期/as-of 日期');
  if (typeof maxSourceAgeDays === 'number' && maxSourceAgeDays > 120) gaps.push(`最新可解析日期距当前 ${maxSourceAgeDays} 天,疑似不满足当前/实时口径`);
  if (!usableDataRows.length) gaps.push('没有抽取到可复核的价格/指标数据行');

  const verified = verifiedSourceCount > 0
    && Boolean(summaryLatestDate)
    && typeof maxSourceAgeDays === 'number'
    && maxSourceAgeDays <= 120
    && usableDataRows.length > 0;
  const summary: FreshnessSummary = {
    schema: 'aios.engine.freshness_summary.v1',
    required: true,
    verified,
    current_time: accessedAt,
    reason: 'time_sensitive_data_delivery',
    source_count: sources.length,
    verified_source_count: verifiedSourceCount,
    latest_date: summaryLatestDate,
    max_source_age_days: maxSourceAgeDays,
    gaps,
  };
  const summaryPath = join(dir, 'freshness_summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  const dataPath = join(dir, 'data.csv');
  const header = ['context', 'date_text', 'value', 'unit'];
  const csv = [
    header.join(','),
    ...usableDataRows.map((row) => header.map((h) => csvEscape(row[h] || '')).join(',')),
  ].join('\n') + '\n';
  writeFileSync(dataPath, csv, 'utf8');
  const evidencePath = join(dir, 'evidence_manifest.json');
  writeFileSync(evidencePath, JSON.stringify({
    summary,
    sources,
    data_rows: usableDataRows.slice(0, 100),
    rejected_data_rows: verified ? [] : dataRows.slice(0, 100),
  }, null, 2), 'utf8');
  return {
    freshness_verified: verified,
    freshness_summary: summary,
    sources_path: sourcesPath,
    data_path: dataPath,
    evidence_manifest: evidencePath,
    files: [
      { name: 'sources.jsonl', path: sourcesPath },
      { name: 'data.csv', path: dataPath },
      { name: 'freshness_summary.json', path: summaryPath },
      { name: 'evidence_manifest.json', path: evidencePath },
    ],
  };
}

export const __freshnessTest = {
  extractDataRows,
  freshnessSearchQueries,
};
