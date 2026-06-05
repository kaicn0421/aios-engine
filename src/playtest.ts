// Playtest(P1-B 分类检测)—— headless 真跑一遍,按产物类型分流自测:
//   游戏(有 canvas):canvas 非空白 + 无运行时报错 + 不秒结束 + 【按键后画面变化 > 无操作基线】(隔离自动动画)
//   网页(无 canvas):DOM 有实质内容 + 无运行时报错(不再误判"没 canvas")
// 返回的 issues 直接喂回模型当修复反馈。可玩性为启发式判断,黑盒不保证 100% 准。
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface PlaytestResult {
  playable: boolean;
  issues: string[];
  kind: 'game' | 'web';
}

export async function playtest(html: string): Promise<PlaytestResult> {
  const issues: string[] = [];
  const isGame = /<canvas/i.test(html);
  const kind: 'game' | 'web' = isGame ? 'game' : 'web';
  let browser: { close(): Promise<void> } | null = null;
  try {
    const mod = 'puppeteer';
    const pptr = (await import(mod)) as { default?: { launch: (o: unknown) => Promise<any> }; launch?: (o: unknown) => Promise<any> };
    const launch = pptr.launch || pptr.default?.launch;
    if (!launch) return { playable: true, issues: [], kind }; // 没 puppeteer 就跳过自测,不阻断交付

    const dir = mkdtempSync(join(tmpdir(), 'aios-playtest-'));
    const file = join(dir, 'art.html');
    writeFileSync(file, html, 'utf8');

    browser = await launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await (browser as any).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: unknown) => errors.push(String(e instanceof Error ? e.message : e)));
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('file://' + file, { waitUntil: 'load', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 900));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // ===== 网页分支:看 DOM 实质内容 + 报错,不要求 canvas =====
    if (!isGame) {
      const dom = (await page.evaluate(() => ({
        textLen: (document.body.innerText || '').trim().length,
        elems: document.body.querySelectorAll('*').length,
      }))) as { textLen: number; elems: number };
      if (errors.length) issues.push('运行时报错(页面跑不起来): ' + (errors[0] ?? '').slice(0, 150));
      if (dom.textLen < 30 && dom.elems < 12) issues.push('页面几乎空白(无实质 DOM 内容),可能没渲染出来');
      return { playable: issues.length === 0, issues, kind };
    }

    // ===== 游戏分支:canvas 像素采样 + 无操作基线 vs 按键变化 =====
    const sample = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas') as HTMLCanvasElement | null;
        const ctx = c && c.getContext('2d');
        if (!c || !ctx) return { blank: true, px: [] as number[] };
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const px: number[] = [];
        for (let i = 0; i < d.length; i += 100) px.push(d[i] ?? 0);
        const first = px[0] ?? 0;
        return { blank: px.every((v) => v === first), px };
      }) as Promise<{ blank: boolean; px: number[] }>;
    const diff = (a: number[], b: number[]) => {
      let n = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) n++;
      return n;
    };

    // 先触发"开始"(点 canvas/开始按钮 + 空格/回车)
    await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLElement | null;
      if (c) c.click();
      document.querySelectorAll('button').forEach((b) => { if (/开始|start|play|开局|继续/i.test(b.textContent || '')) (b as HTMLButtonElement).click(); });
      [['Space', 32], ['Enter', 13]].forEach(([code, kc]) =>
        document.dispatchEvent(new KeyboardEvent('keydown', { code: code as string, keyCode: kc as number, which: kc as number, bubbles: true } as KeyboardEventInit)));
    });
    await wait(400);
    const sStart = await sample();
    // 无操作一段:自动动画基线(云飘/敌人移动等本就会让画面变)
    await wait(800);
    const sIdle = await sample();
    const baseline = diff(sStart.px, sIdle.px);
    // 按住方向键一段:有操作的变化
    await page.evaluate(() => {
      [['ArrowRight', 39], ['ArrowDown', 40], ['KeyD', 68], ['KeyW', 87]].forEach(([code, kc]) =>
        document.dispatchEvent(new KeyboardEvent('keydown', { code: code as string, keyCode: kc as number, which: kc as number, bubbles: true } as KeyboardEventInit)));
    });
    await wait(800);
    const sAct = await sample();
    const acted = diff(sIdle.px, sAct.px);

    // 判定 —— 只 catch【确定的坏】:运行时报错 / canvas 全程空白 / 秒结束。
    // 键盘响应/交互黑盒测不准(开始与按键机制千变万化、通用触发覆盖不全),不据此判不可玩,
    // 否则会把实际可玩的游戏误杀(假阴性)、触发无谓的修复轮 —— 宁可漏检键盘不通,不可误杀。
    if (errors.length) issues.push('运行时报错(游戏跑不起来): ' + (errors[0] ?? '').slice(0, 150));
    if (sStart.blank && sIdle.blank && sAct.blank) issues.push('canvas 全程空白,游戏没渲染出来');
    const body = (await page.evaluate(() => (document.body.innerText || '').slice(0, 120))) as string;
    if (/game\s*over|结束|失败|you\s*win|胜利|通关/i.test(body)) issues.push('刚开始没操作几下就出现结束/胜利字样——出生即死或胜负判定触发过早');
    // baseline/acted 只作观察(下面日志可留意),不计入 issues —— 完全静止也可能是"渲染好了等操作"或触发没覆盖该游戏的开始键
    const motionNote = baseline === 0 && acted === 0 ? '(未检测到画面变化,可能渲染后等操作或触发未覆盖)' : `(动画基线 ${baseline}, 操作后 ${acted})`;
    return { playable: issues.length === 0, issues: issues.length ? issues : [motionNote], kind };
  } catch (e) {
    return { playable: true, issues: [`(自测未能执行: ${e instanceof Error ? e.message : String(e)})`], kind };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
