import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUserGoal } from './goal';
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
  claim_evidence_path?: string;
  files: Array<{ name: string; path: string }>;
}

interface ClaimEvidence {
  claim: string;
  type: 'platform_source' | 'named_entity' | 'numeric_market_claim' | 'assumption_leak';
  status: 'verified' | 'unverified' | 'needs_review';
  detail: string;
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

const observationContextCache = new Map<string, Promise<string>>();

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
  '薪资', '工资', '待遇', '收入', 'wage', 'salary', 'pay',
];
const FRESHNESS_REPAIR_WORDS = [
  '数据滞后', '不是实时', '不是现在', '旧数据', '过期', '不新', '不准', '不对',
  '错了', '重新查', '最新数据', '当前价格', '现在价格', '实时价格', '时效', '修复版',
];
const RESEARCH_EVIDENCE_WORDS = [
  '调研', '市场分析', '行业分析', '竞品', '商业计划', '上市', '融资', '选址',
  '供应链', '客群', '商业模式', '财务测算', '增长', '比例', '规模', '趋势',
];
const QUERY_STOP_WORDS = new Set([
  '做', '一份', '简短', '要求', '列出', '最新', '公开', '来源', 'url', 'URL',
  'as', 'of', '日期', '样本', '不要', '长篇', '报告', '调研', '核验', '当前',
  '现在', '行情', '数据', 'DATA', 'GAP', '帮我', '一下', '做一下', '的',
]);

// 内部工作文档词:周报/月报/纪要/总结是写"自己项目"的文档,不是市场数据交付。
// "本周"(TIME_WORDS)+"项目"(DATA_WORDS)曾把《AIOS项目本周周报》误判成价格类
// 任务 → 网页取证 0 来源 → DATA_GAP 兜底空壳 docx(2026-06-11 真机 E2E)。
const INTERNAL_DOC_WORDS = [
  '周报', '月报', '日报', '季报', '工作总结', '工作汇报', '会议纪要', '纪要',
  '汇报材料', '简报', '述职', '复盘',
];
// 点名这些硬市场词的文档(如"水泥价格周报")仍是数据交付,照走取证闸。
const HARD_MARKET_WORDS = [
  '价格', '报价', '行情', '均价', '汇率', '股价', '油价', '柴油', '汽油',
  '热榜', '热搜', '销量', '产量', '库存', '天气', '航班', '薪资', '工资',
  '黄金', 'gold', 'diesel', 'fuel', '数据', '指数', 'cpi', 'gdp', 'pmi',
];

// 调研风味词:真要看外部世界的请求(热搜/话题/趋势/早报/github…)
const RESEARCH_FLAVOR_WORDS = [
  '调研', '走势', '趋势', '热搜', '热榜', '热门', '热度', '话题', '讨论',
  '榜单', '排名', '舆情', '早报', 'github',
];

export function needsFreshnessEvidence(goal: string): boolean {
  const compact = cleanUserGoal(goal).toLowerCase().replace(/\s+/g, '');
  if (!compact) return false;
  if (compact.includes('aios.delivery_freshness_contract.v1')) return true;
  if (
    INTERNAL_DOC_WORDS.some((w) => compact.includes(w))
    && !HARD_MARKET_WORDS.some((w) => compact.includes(w))
  ) {
    return false;
  }
  const marketPrice = compact.includes('价格')
    && ['调研', '报告', '分析', '趋势', '走势', '行情', '市场', '核验', '来源', '清单', '报价'].some((w) => compact.includes(w));
  // 时间词 × 触发词(硬市场 ∪ 调研风味)才进取证闸。旧规则 TIME×DATA_WORDS 的
  // DATA 泛词(材料/清单/需求/项目/风险/报告…)把"最近的采购需求清单/本月培训材料"
  // 这类内部办公文档判成价格任务,正文整篇被换成"未生成当前价格报告"(审计 4/4 实测)。
  // 产品裁决:要价格/行情证据的请求自带硬词;内部文档不进价格闸。
  const hasTrigger = HARD_MARKET_WORDS.some((w) => compact.includes(w))
    || RESEARCH_FLAVOR_WORDS.some((w) => compact.includes(w));
  const freshnessRepair = FRESHNESS_REPAIR_WORDS.some((w) => compact.includes(w)) && hasTrigger;
  return freshnessRepair
    || marketPrice
    || (TIME_WORDS.some((w) => compact.includes(w)) && hasTrigger);
}

export function needsResearchEvidence(goal: string): boolean {
  const compact = cleanUserGoal(goal).toLowerCase().replace(/\s+/g, '');
  if (!compact || needsFreshnessEvidence(goal)) return false;
  const wantsReport = /(报告|方案|计划|计划书|pdf|word|docx|ppt|pptx|文档)/i.test(compact);
  const hasResearchIntent = RESEARCH_EVIDENCE_WORDS.some((w) => compact.includes(w.toLowerCase()));
  const hasBusinessDomain = /(餐饮|泰餐|餐厅|门店|中铁|办公室|工程|合同|fidic|采购|建材|aios|软件|agent)/i.test(compact);
  return wantsReport && hasResearchIntent && hasBusinessDomain;
}

function needsEvidenceArtifacts(goal: string): boolean {
  return needsFreshnessEvidence(goal) || needsResearchEvidence(goal);
}

function needsLocalBusinessClaimAudit(goal: string): boolean {
  const compact = cleanUserGoal(goal).replace(/\s+/g, '');
  const local = /(宁波|上海|北京|广州|深圳|杭州|成都|武汉|泰国|曼谷|浙江|中国|本地|城市)/i.test(compact);
  const business = /(餐饮|泰餐|餐厅|门店|开店|商业计划|竞品|市场分析|上市|融资|选址|供应链|客群|品牌)/i.test(compact);
  return needsResearchEvidence(goal) && local && business;
}

export function requiresStructuredDataRows(goal: string): boolean {
  const compact = cleanUserGoal(goal).toLowerCase().replace(/\s+/g, '');
  return /(价格|报价|行情|均价|指数|汇率|股价|薪资|工资|热榜|热搜|排名|榜单|销量|产量|库存|天气|航班|机票|油价|柴油|汽油|diesel|fuel|gold|黄金)/i
    .test(compact);
}

export function freshnessInstruction(goal: string): string {
  if (needsResearchEvidence(goal)) {
    return [
      '',
      '【调研证据铁律】本任务是商业/行业/市场调研型交付。',
      '0. 如果下方出现 AIOS web observe 证据,必须优先使用证据里的 URL、标题、日期和片段。',
      '1. 市场规模、增长率、客群、竞品、政策、融资和上市路径等结论必须有来源或明确写“待核验”。',
      '2. 没有公开来源支撑的具体数字,只能写成假设/测算口径,不能写成已知事实。',
      '3. 具体门店/品牌/机构名必须逐项有来源;没有来源时只能放入“待核验清单”,不得写成当地竞品事实。',
      '4. 最终报告必须保留“来源与数据缺口”章节,区分公开事实、行业假设、后续实地核验事项。',
    ].join('\n');
  }
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
  if (/泰国|thailand/i.test(goal) && /黄金|gold|金价/i.test(goal)) {
    queries.add(`site:goldtraders.or.th ราคาทองวันนี้ ${year}`);
    queries.add(`daily-gold.goldtraders.or.th ราคาทองวันนี้ ${year}`);
    queries.add(`Thailand gold price today baht weight ${year}`);
    queries.add(`泰国 黄金 价格 今日 ${year}`);
  }
  if (needsResearchEvidence(goal)) {
    if (/宁波|餐饮|泰餐|餐厅|上市|融资/i.test(goal)) {
      queries.add(`宁波 餐饮 市场 消费 趋势 ${year}`);
      queries.add(`宁波 餐饮 行业 统计 报告 ${year}`);
      queries.add(`泰餐 中国 市场 餐厅 连锁 商业计划 ${year}`);
      queries.add(`餐饮 企业 上市 招股书 连锁 餐饮 ${year}`);
    }
    queries.add(`${kw} 行业 报告 来源 数据 ${year}`);
    queries.add(`${kw} 案例 竞品 商业模式 ${year}`);
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
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US&mkt=en-US`;
  const [ddg, res] = await Promise.all([
    fetchWithTimeout(ddgUrl, 9000),
    fetchWithTimeout(searchUrl, 9000),
  ]);
  if (ddg.ok && ddg.text) {
    for (const url of resultUrlsFromSearchHtml(ddg.text)) urls.add(url);
  }
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
  if (needsResearchEvidence(goal)) {
    const business = /餐饮|餐厅|泰餐|门店|连锁|商业计划|上市|融资|消费|市场|行业|food|restaurant|catering|ipo/i.test(haystack);
    const local = /宁波|浙江|长三角|ningbo|zhejiang/i.test(haystack);
    return business && (local || salientTerms(goal).some((term) => haystack.includes(term.toLowerCase())));
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

// 返修轮强制重取证:缓存 key 是 cleanUserGoal,同进程返修会命中第一轮失败取证(审计实证)
export function invalidateFreshnessObservation(goal: string): void {
  const key = cleanUserGoal(goal);
  observationContextCache.delete(`fresh:${key}`);
  observationContextCache.delete(`research:${key}`);
}

export async function freshnessObservationContext(goal: string): Promise<string> {
  const isResearch = needsResearchEvidence(goal);
  const isFreshness = needsFreshnessEvidence(goal);
  if (!isFreshness && !isResearch) return '';
  const cacheKey = `${isResearch ? 'research' : 'fresh'}:${cleanUserGoal(goal)}`;
  const cached = observationContextCache.get(cacheKey);
  if (cached) return cached;
  const promise = buildFreshnessObservationContextWithTimeout(goal, isResearch);
  observationContextCache.set(cacheKey, promise);
  return promise;
}

function observationTimeoutMs(): number {
  const fromEnv = Number(process.env.AIOS_ENGINE_OBSERVATION_TIMEOUT_MS || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) return fromEnv;
  return 20_000;
}

function observationTimeoutContext(goal: string, isResearch: boolean, timeoutMs: number): string {
  const now = contractCurrentTime(goal);
  const queries = freshnessSearchQueries(goal, now);
  return [
    '# AIOS web observe 已执行但超时',
    `OBSERVE_TIME: ${now.toISOString()}`,
    `SEARCH_QUERIES: ${queries.join(' | ')}`,
    `OBSERVE_RESULT: 取证步骤超过 ${Math.round(timeoutMs / 1000)} 秒,AIOS 已停止等待网页抓取并继续生成,避免任务卡死。`,
    isResearch
      ? 'SOURCE_GAP: 最终报告必须把市场数字、竞品、门店案例、融资/上市判断标注为待核验,禁止写成已证实事实。'
      : 'DATA_GAP: 最终报告必须标注缺少实时数据来源,禁止输出未经验证的当前价格。',
  ].join('\n');
}

async function buildFreshnessObservationContextWithTimeout(goal: string, isResearch: boolean): Promise<string> {
  const timeoutMs = observationTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(observationTimeoutContext(goal, isResearch, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([buildFreshnessObservationContext(goal, isResearch), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildFreshnessObservationContext(goal: string, isResearch: boolean): Promise<string> {
  const now = contractCurrentTime(goal);
  const queries = freshnessSearchQueries(goal, now);
  const resultUrls: string[] = [];
  const batches = await Promise.all(queries.map((query) => searchResultUrls(query)));
  for (const found of batches) {
    resultUrls.push(...found);
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
      isResearch
        ? 'OBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。最终报告必须写 SOURCE_GAP,禁止把具体市场数字写成已证实事实。'
        : 'OBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。最终报告必须写 DATA_GAP,禁止输出未经验证的当前价格。',
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
    isResearch
      ? '使用规则: 只能把 OBSERVED_SOURCE 中有 URL/标题/日期/片段支撑的信息写成公开事实;证据不足的市场规模、增长率、竞品数据必须写成假设或 SOURCE_GAP。'
      : '使用规则: 只能把 OBSERVED_SOURCE 中有 URL + 日期/as-of + 价格片段支撑的数据写成当前数据;证据不足时写 DATA_GAP。不要凭记忆输出具体价格。',
    ...chunks,
  ].join('\n\n');
}

function evidenceOnlyText(results: AgentResult[]): string {
  return results
    .map((r) => r.evidenceText || '')
    .filter(Boolean)
    .join('\n\n');
}

function outputOnlyText(results: AgentResult[]): string {
  return results
    .map((r) => r.output || '')
    .filter(Boolean)
    .join('\n\n');
}

function normalizeForEvidence(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function sourceHostText(sources: FreshnessSource[]): string {
  return sources.map((s) => `${s.url} ${s.host} ${s.title || ''}`).join('\n');
}

function platformEvidenceClaims(outputText: string, evidenceText: string, sources: FreshnessSource[]): ClaimEvidence[] {
  const claims: ClaimEvidence[] = [];
  const combinedEvidence = normalizeForEvidence(`${evidenceText}\n${sourceHostText(sources)}`);
  const platformRules: Array<{ label: string; pattern: RegExp; evidence: RegExp; aliases: string[] }> = [
    { label: '大众点评', pattern: /大众点评|点评宁波站|dianping/i, evidence: /dianping|大众点评|点评/i, aliases: ['大众点评'] },
    { label: '美团', pattern: /美团|meituan/i, evidence: /meituan|美团/i, aliases: ['美团'] },
    { label: '实地走访', pattern: /实地走访|走访|到店调研/i, evidence: /实地走访|走访记录|访谈纪要|照片|到店/i, aliases: ['实地走访'] },
  ];
  for (const rule of platformRules) {
    if (!rule.pattern.test(outputText)) continue;
    const platformLines = outputText
      .split(/\n+/)
      .filter((line) => rule.pattern.test(line));
    const evidenceClaimLines = platformLines
      .filter((line) => /(数据来源|来源|证据|根据|依据|爬取|抓取|搜索|评分|榜单|平台数据|调研数据)/.test(line));
    if (!evidenceClaimLines.length) continue;
    const onlyAsRequirement = platformLines.length > 0
      && platformLines.every((line) => /(需|需要|必须|待|后续|补充|手动|抓取|采集|核验|清单)/.test(line));
    const ok = rule.evidence.test(combinedEvidence);
    claims.push({
      claim: `报告声称使用${rule.label}证据`,
      type: 'platform_source',
      status: ok ? 'verified' : onlyAsRequirement ? 'needs_review' : 'unverified',
      detail: ok
        ? '证据区出现对应平台/记录信号'
        : onlyAsRequirement
          ? `仅作为后续补充/核验要求出现,不视为已使用${rule.label}证据`
          : `sources/evidence 中没有${rule.label}可核验证据`,
    });
  }
  return claims;
}

function inlineCompetitorCandidates(text: string): string[] {
  const entities = new Set<string>();
  const patterns = [
    /竞品[ABCＤ]?[：:]\s*([^（\(\n,，。；;]{2,20})/g,
    /(迷你椰[\u4e00-\u9fa5A-Za-z0-9·]{0,10})/g,
    /(曼谷厨房|泰式小馆)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] || '').trim();
      if (!raw || raw.length < 2 || raw.length > 24) continue;
      if (/(泰餐市场|泰餐品类|泰国香料|泰国菜|泰餐门店|泰餐品牌|泰式风味|泰鲜|泰味|泰国风味|泰国原产|泰餐高端|泰餐及|泰融合|品质|东南亚菜|香料|风情|融合)/.test(raw)) continue;
      if (/[等的]初创|等连锁|等品牌|等门店|等竞品|等/.test(raw)) continue;
      entities.add(raw);
    }
  }
  return [...entities];
}

function namedEntityEvidenceClaims(outputText: string, evidenceText: string, sources: FreshnessSource[]): ClaimEvidence[] {
  const evidence = normalizeForEvidence(`${evidenceText}\n${sourceHostText(sources)}`);
  const candidates = [...new Set(inlineCompetitorCandidates(outputText))]
    .filter((name) => /[\u4e00-\u9fa5]/.test(name))
    .slice(0, 30);
  return candidates.map((name) => {
    const ok = evidence.includes(normalizeForEvidence(name));
    const lines = outputText.split(/\n+/).filter((line) => line.includes(name));
    const onlyAsExampleOrAssumption = lines.length > 0
      && lines.every((line) => /(如|例如|假设|参照|待核验|待补充|候选|不可写成|不得写成)/.test(line));
    return {
      claim: name,
      type: 'named_entity' as const,
      status: ok ? 'verified' as const : onlyAsExampleOrAssumption ? 'needs_review' as const : 'unverified' as const,
      detail: ok
        ? '证据区包含该名称'
        : onlyAsExampleOrAssumption
          ? '仅作为示例/假设/待核验对象出现,不视为已核验竞品'
          : '证据区未出现该具体品牌/门店名,不得写成已核验竞品',
    };
  });
}

function numericMarketClaims(outputText: string, evidenceText: string): ClaimEvidence[] {
  const claims: ClaimEvidence[] = [];
  const evidence = normalizeForEvidence(evidenceText);
  const sentences = outputText.split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/^#{1,6}\s*\d/.test(sentence)) continue;
    if (isInstructionalOrTemplateLine(sentence)) continue;
    if (!/(门店|市场规模|增速|增长率|占比|人均|评分|约|达到|预计|年增)/.test(sentence)) continue;
    if (!/\d/.test(sentence)) continue;
    if (/(假设|估计|估算|测算|待核验|模型假设|敏感性)/.test(sentence)) continue;
    const compact = normalizeForEvidence(sentence).slice(0, 80);
    const digits = [...sentence.matchAll(/\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?%?/g)].map((m) => m[0]).slice(0, 4);
    const ok = digits.length > 0 && digits.some((d) => evidence.includes(d.toLowerCase()));
    const approximateOrPlanning = /(约|预计|规划|目标|模型|测算|窗口期|路径|里程碑|误差|≤|>=|≥|第\d|年|㎡|元|门店数)/.test(sentence)
      && !/(已知事实|数据来源|来源[:：]|根据|依据|实测|已验证)/.test(sentence);
    claims.push({
      claim: sentence.slice(0, 120),
      type: 'numeric_market_claim',
      status: ok ? 'needs_review' : approximateOrPlanning ? 'needs_review' : 'unverified',
      detail: ok
        ? '证据区出现相同数字,仍需人工确认口径覆盖'
        : approximateOrPlanning
          ? `规划/估算数字需保留为模型假设或待核验:${compact}`
          : `证据区没有覆盖该数字主张: ${compact}`,
    });
    if (claims.length >= 20) break;
  }
  return claims;
}

function isInstructionalOrTemplateLine(sentence: string): boolean {
  return /(标准|规范|字段|模板|评分维度|满分|评审依据|交付内容|产出内容|需通过|必须列出|至少|来源：OBSERVED_SOURCE|OBSERVED_SOURCE_\d|待核验|假设|敏感性|口径|模块\d|由其他Agent负责|所有数字|须标注|检查清单|可复制模型|Excel|Python|自行调整|保荐人|审计师|勾稽|手工计算|逻辑错误|问卷\d+份|需问卷|须有|需与历史趋势一致|未来\d+-\d+年|任务书|验收|质量|评分|错误|正确|示例|表头|字段名|公式)/i.test(sentence);
}

function assumptionLeakClaims(outputText: string): ClaimEvidence[] {
  const claims: ClaimEvidence[] = [];
  const sentences = outputText.split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (!/(假设|实地走访（假设）|假设人物|假设品牌|基于.*假设)/.test(sentence)) continue;
    const safeAssumptionLine = /(假设区|待核验|待核验数据|测算口径|敏感性|假设依据|来源级别|行业假设|模型假设|不能写成|不得写成|假设公式|可复制模型|自行调整假设|须有|需核验|需问卷|问卷\d+份|检查清单|竞品清单必须来自|后续实地|补充调研)/.test(sentence);
    const formal = !safeAssumptionLine && /(核心发现|竞品|SWOT|优势|威胁|已知事实|数据来源|团队|创始人|上市路径|财务)/.test(sentence);
    claims.push({
      claim: sentence.slice(0, 120),
      type: 'assumption_leak',
      status: formal ? 'unverified' : 'needs_review',
      detail: formal ? '假设内容进入正式事实/竞品/团队/财务叙述' : '假设内容需要保留在假设区或待核验区',
    });
    if (claims.length >= 20) break;
  }
  return claims;
}

function buildClaimEvidence(goal: string, results: AgentResult[], evidenceText: string, sources: FreshnessSource[]): ClaimEvidence[] {
  if (!needsLocalBusinessClaimAudit(goal)) return [];
  const outputText = outputOnlyText(results);
  const claims = [
    ...platformEvidenceClaims(outputText, evidenceText, sources),
    ...namedEntityEvidenceClaims(outputText, evidenceText, sources),
    ...numericMarketClaims(outputText, evidenceText),
    ...assumptionLeakClaims(outputText),
  ];
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.type}:${claim.claim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
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
  for (const m of text.matchAll(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](25\d{2})\b/g)) {
    const [, d, mo, buddhistYear] = m;
    const y = String(Number(buddhistYear) - 543);
    dates.add(`${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/(25\d{2})年\s*(1[0-2]|0?[1-9])月\s*([12]\d|3[01]|0?[1-9])日/g)) {
    const [, buddhistYear, mo, d] = m;
    const y = String(Number(buddhistYear) - 543);
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
    if (/(黄金|金价|gold|ทอง|ราคาทอง|ขายออก|รับซื้อ)/i.test(sentence)) {
      let acceptedGoldRow = false;
      const candidates = [
        ...[...sentence.matchAll(/(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(บาท)(?![A-Za-z0-9.])/gi)]
          .map((match) => ({ value: match[1] || '', unit: normalizeUnit(match[2] || '', sentence) })),
        ...[...sentence.matchAll(/(?:฿|THB)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/gi)]
          .map((match) => ({ value: match[1] || '', unit: 'THB/gold-unit' })),
      ];
      for (const candidate of candidates) {
        const value = Number(String(candidate.value || '').replace(/,/g, ''));
        const unit = candidate.unit;
        if (!validValueForUnit(value, unit)) continue;
        const dates = extractDates(sentence);
        rows.push({
          context: sentence.slice(0, 180),
          date_text: dates.at(-1) || '',
          value: candidate.value || '',
          unit,
        });
        acceptedGoldRow = true;
        if (rows.length >= 80) break;
      }
      if (acceptedGoldRow) continue;
    }
    const valueMatch = sentence.match(/(?<![A-Za-z0-9.])(\d{1,5}(?:\.\d+)?)\s*(元\s*\/\s*吨|元每吨|元\/t|yuan\/t|baht\s*\/\s*lit(?:re|er)|baht\s+per\s+lit(?:re|er)|thb\s*\/\s*l(?:itre|iter)?|thb\s+per\s+lit(?:re|er)|บาท\s*\/\s*ลิตร|บาทต่อลิตร|usd\s*\/\s*lit(?:re|er)|us\$\s*\/\s*lit(?:re|er)|\$\s*\/\s*lit(?:re|er))(?![A-Za-z0-9.])/i)
      || sentence.match(/\b(THB|Baht|USD|US\$|\$|฿)\s*(\d{1,5}(?:\.\d+)?)\s*(?:per\s+lit(?:re|er)|\/\s*lit(?:re|er)|\/\s*l)\b/i)
      || sentence.match(/(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(บาท)(?![A-Za-z0-9.])/i);
    if (!valueMatch) continue;
    const unitFirst = /^(THB|Baht|USD|US\$|\$|฿)$/i.test(valueMatch[1] || '');
    const rawValue = unitFirst ? valueMatch[2] : valueMatch[1];
    const value = Number(String(rawValue || '').replace(/,/g, ''));
    const unit = unitFirst ? normalizeCurrencyLiterUnit(valueMatch[1] || '') : normalizeUnit(valueMatch[2] || '', sentence);
    if (!validValueForUnit(value, unit)) continue;
    const dates = extractDates(sentence);
    rows.push({
      context: sentence.slice(0, 180),
      date_text: dates.at(-1) || '',
      value: rawValue || '',
      unit,
    });
    if (rows.length >= 80) break;
  }
  return rows;
}

function isDataSentence(sentence: string): boolean {
  return /(水泥|P\.?\s*O?42\.?5|均价|价格|报价|行情|指数|柴油|汽油|油价|燃油|成品油|黄金|金价|gold|ทอง|ราคาทอง|ขายออก|รับซื้อ|diesel|fuel|petrol|gasoline|oil price|retail price|price|บาท|ลิตร|ดีเซล)/i.test(sentence);
}

function normalizeUnit(raw: string, context = ''): string {
  const compact = raw.toLowerCase().replace(/\s+/g, '');
  if (/元\/吨|元每吨|元\/t|yuan\/t/i.test(compact)) return '元/吨';
  if (/baht\/lit(?:re|er)|bahtperlit(?:re|er)|thb\/l|thb\/lit(?:re|er)?|thbperlit(?:re|er)|บาท\/ลิตร|บาทต่อลิตร/i.test(compact)) return 'baht/litre';
  if (/usd\/lit(?:re|er)|us\$\/lit(?:re|er)|\$\/lit(?:re|er)/i.test(compact)) return 'USD/litre';
  if (/บาท/i.test(raw) && /(黄金|金价|gold|ทอง|ราคาทอง|ขายออก|รับซื้อ|baht weight|บาททองคำ)/i.test(context)) return 'baht/baht-weight';
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
  if (unit === 'baht/baht-weight') return value >= 10_000 && value <= 200_000;
  if (unit === 'THB/gold-unit') return value >= 1_000 && value <= 10_000_000;
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
  if (!needsEvidenceArtifacts(goal)) {
    return { freshness_verified: true, files: [] };
  }
  const researchEvidence = needsResearchEvidence(goal);
  const strictDataRows = needsFreshnessEvidence(goal) && requiresStructuredDataRows(goal);
  mkdirSync(dir, { recursive: true });
  const now = contractCurrentTime(goal);
  const accessedAt = now.toISOString();
  const text = evidenceOnlyText(results);
  const urls = uniqueUrls(text);
  const sources = await Promise.all(urls.map((url) => verifyUrl(url, accessedAt)));
  const claimEvidence = buildClaimEvidence(goal, results, text, sources);
  const unverifiedClaims = claimEvidence.filter((claim) => claim.status === 'unverified');
  const dates = extractDates(text);
  const sourceRows = sources.map((s) => JSON.stringify(s)).join('\n') + (sources.length ? '\n' : '');
  const sourcesPath = join(dir, 'sources.jsonl');
  writeFileSync(sourcesPath, sourceRows, 'utf8');

  const dataRows = extractDataRows(text);
  const hasLiveRowWithoutExplicitDate = dataRows.some((row) => /today|current|live|วันนี้|ราคาทองวันนี้|ล่าสุด|今日|今天/i.test(row.context));
  const latestDate = dates.at(-1) || (hasLiveRowWithoutExplicitDate ? accessedAt.slice(0, 10) : undefined);
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
  if (!summaryLatestDate && strictDataRows) gaps.push('没有可解析的数据发布日期/as-of 日期');
  if (typeof maxSourceAgeDays === 'number' && maxSourceAgeDays > 120) gaps.push(`最新可解析日期距当前 ${maxSourceAgeDays} 天,疑似不满足当前/实时口径`);
  if (!usableDataRows.length && strictDataRows) gaps.push('没有抽取到可复核的价格/指标数据行');
  if (researchEvidence && !verifiedSourceCount) gaps.push('调研型交付缺少可校验来源,不能把市场数字写成确定事实');
  if (needsLocalBusinessClaimAudit(goal) && verifiedSourceCount < 3) {
    gaps.push(`本地商业计划至少需要 3 条可校验来源,当前只有 ${verifiedSourceCount} 条`);
  }
  if (unverifiedClaims.length) {
    gaps.push(`存在 ${unverifiedClaims.length} 条未绑定来源的关键主张/门店/数据`);
  }

  const verified = strictDataRows
    ? verifiedSourceCount > 0
      && Boolean(summaryLatestDate)
      && typeof maxSourceAgeDays === 'number'
      && maxSourceAgeDays <= 120
      && usableDataRows.length > 0
    : needsLocalBusinessClaimAudit(goal)
      ? verifiedSourceCount >= 3 && unverifiedClaims.length === 0
      : verifiedSourceCount > 0;
  const summary: FreshnessSummary = {
    schema: 'aios.engine.freshness_summary.v1',
    required: true,
    verified,
    current_time: accessedAt,
    reason: researchEvidence ? 'research_evidence_delivery' : 'time_sensitive_data_delivery',
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
    claim_evidence: claimEvidence,
    data_rows: usableDataRows.slice(0, 100),
    rejected_data_rows: verified ? [] : dataRows.slice(0, 100),
  }, null, 2), 'utf8');
  const claimEvidencePath = join(dir, 'claim_evidence.json');
  writeFileSync(claimEvidencePath, JSON.stringify({
    schema: 'aios.engine.claim_evidence.v1',
    required: needsLocalBusinessClaimAudit(goal),
    verified: unverifiedClaims.length === 0,
    claims: claimEvidence,
  }, null, 2), 'utf8');
  return {
    freshness_verified: verified,
    freshness_summary: summary,
    sources_path: sourcesPath,
    data_path: dataPath,
    evidence_manifest: evidencePath,
    claim_evidence_path: claimEvidencePath,
    files: [
      { name: 'sources.jsonl', path: sourcesPath },
      { name: 'data.csv', path: dataPath },
      { name: 'freshness_summary.json', path: summaryPath },
      { name: 'evidence_manifest.json', path: evidencePath },
      { name: 'claim_evidence.json', path: claimEvidencePath },
    ],
  };
}

export const __freshnessTest = {
  extractDates,
  extractDataRows,
  freshnessSearchQueries,
  needsResearchEvidence,
  buildClaimEvidence,
  needsLocalBusinessClaimAudit,
};
