import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SheetService } from './feishu/sheet.js';
import type { LastRun } from './followup.js';
import { collectOutbox } from './outbox.js';
import { parseCsv, planAssets } from './sheetCsv.js';

/**
 * 在线表写回（会话结束后：写回改过的页、新建页、嵌图、附件夹链接；或首次把 csv/xlsx 导成在线表）。
 *
 * 为什么单独成模块并在**子进程**里跑：2026-09-10～11 daemon 三次无声消失，全都在大批量嵌图（282 / 144 张）期间或紧随其后，
 * 第三次由外层 cmd 抓到退出码 -1073740791（0xC0000409，原生 fail-fast，无任何 JS 层报错）。根因未定位，
 * 但写回这一步崩不该带走整个 daemon（飞书长连接、在跑的工单、待答的卡）。子进程崩了就是一句「写回子进程异常」+ 附件兜底。
 */
export type SheetRef = NonNullable<LastRun['sheet']>;

export interface SheetJob {
  /** 已绑的表（续聊）；没有则走「首次导入」 */
  sheet?: SheetRef;
  /** 检查点文件：飞书侧全部写完后先把结果落盘再返回——子进程崩在收尾阶段（0xC0000409 恒在此时）也不算失败 */
  checkpoint?: string;
  sheetDir: string;
  /** 开工前导出的各页 csv（文件名 → 内容），有它才能判断改了哪页 */
  sheetBefore: Record<string, string> | null;
  outbox: string;
}

export interface SheetResult {
  sheet?: SheetRef;
  note: string;
  /** 文件清理交给父进程做：已嵌图/已上传的删掉；失败的挪到出件箱顶层按附件发（子进程只跟飞书打交道） */
  cleanup: { remove: string[]; toOutbox: string[] };
}

/** 真正的写回逻辑（在子进程里跑；单测也可直接调） */
export async function processSheet(svc: SheetService, job: SheetJob): Promise<SheetResult> {
  let sheet = job.sheet;
  const { sheetDir, sheetBefore, outbox } = job;
  if (sheet && sheetBefore) {
    // 附件：整格等于图片文件名 → 嵌进单元格；只在文字里提到 / 非图片 → 传附件夹挂链接。都不刷进群
    const assetsDir = path.join(sheetDir, 'assets');
    let assetNote = '';
    const cleanup = { remove: [] as string[], toOutbox: [] as string[] };
    const assetNames = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((n) => fs.statSync(path.join(assetsDir, n)).isFile()) : [];
    let plan = { embed: new Set<string>(), link: new Set<string>() };
    if (assetNames.length) {
      const csvRows = fs
        .readdirSync(sheetDir)
        .filter((n) => n.toLowerCase().endsWith('.csv'))
        .map((n) => parseCsv(fs.readFileSync(path.join(sheetDir, n), 'utf-8')));
      plan = planAssets(csvRows, assetNames);
      if (plan.link.size) {
        if (!sheet.assetsFolder) sheet = { ...sheet, assetsFolder: await svc.ensureAssetsFolder(sheet.title ?? sheet.token.slice(-8)) };
        const a = await svc.uploadAssetsAndLinkify(sheetDir, sheet.assetsFolder!, plan.link);
        const n = Object.keys(a.links).length;
        assetNote += `${n ? `，${n} 个附件入附件夹并挂链接` : ''}${a.failed.length ? `，${a.failed.length} 个附件上传失败（${a.failed.join('、')}）` : ''}`;
        for (const name of Object.keys(a.links)) cleanup.remove.push(path.join(assetsDir, name));
        for (const name of a.failed) cleanup.toOutbox.push(path.join(assetsDir, name)); // 失败的走出件箱兜底
      }
    }
    const w = await svc.importDir(sheet, sheetDir, sheetBefore, plan.embed);
    if (plan.embed.size) {
      const miss = [...plan.embed].filter((n) => !w.embedded.has(n));
      assetNote = `${w.embedded.size ? `，${w.embedded.size} 张图已嵌入单元格` : ''}${miss.length ? `，${miss.length} 张嵌图失败已按附件发出（${miss.join('、')}）` : ''}${assetNote}`;
      for (const name of w.embedded) cleanup.remove.push(path.join(assetsDir, name));
      for (const name of miss) if (fs.existsSync(path.join(assetsDir, name))) cleanup.toOutbox.push(path.join(assetsDir, name));
    }
    const note =
      w.updated.length || w.added.length || assetNote
        ? `📊 在线表已更新${w.updated.length ? `（改了：${w.updated.join('、')}）` : ''}${w.added.length ? `（新增页：${w.added.join('、')}）` : ''}${assetNote}：${sheet.url}`
        : '';
    return checkpointed(job, { sheet, note, cleanup });
  }
  if (!sheet) {
    const table = collectOutbox(outbox).files.find((f) => /\.(csv|xlsx)$/i.test(f));
    if (table) {
      sheet = await svc.importFile(table, path.basename(table, path.extname(table)));
      return checkpointed(job, {
        sheet,
        note: `📊 已建为在线表格（之后这次对话里的修改会直接写回它，你也可以在线改；多人同时用请在话题里聊）：${sheet.url}`,
        cleanup: { remove: [table], toOutbox: [] },
      });
    }
  }
  return { sheet, note: '', cleanup: { remove: [], toOutbox: [] } };
}

/** 飞书侧做完先落检查点再返回：随后的任何崩溃都不该把「已经写回」变成「失败」 */
function checkpointed(job: SheetJob, r: SheetResult): SheetResult {
  if (job.checkpoint) {
    try {
      fs.writeFileSync(job.checkpoint, JSON.stringify(r), 'utf-8');
    } catch {
      /* 落不下检查点只是失去这层保险 */
    }
  }
  return r;
}

/** 父进程执行子进程开出的清理清单 */
export function applyCleanup(r: SheetResult, outbox: string): void {
  for (const f of r.cleanup.remove) fs.rmSync(f, { force: true });
  for (const f of r.cleanup.toOutbox) if (fs.existsSync(f)) fs.renameSync(f, path.join(outbox, path.basename(f)));
}

const WORKER_TIMEOUT_MS = 25 * 60_000;

/**
 * 在子进程里跑 processSheet：任务写临时 JSON，子进程读它、干活、把结果 JSON 打到 stdout 最后一行。
 * 子进程崩/超时 → 抛错，由调用方退回「按附件发」。返回值里带子进程的 stderr 尾巴便于排障
 */
export function runSheetWorker(job: SheetJob, log: (m: string) => void): Promise<SheetResult> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argsFile = path.join(os.tmpdir(), `sheet-job-${process.pid}-${Date.now()}.json`);
  const checkpoint = `${argsFile}.done`;
  fs.writeFileSync(argsFile, JSON.stringify({ ...job, checkpoint } satisfies SheetJob), 'utf-8');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(root, 'scripts', 'sheet-writeback.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, script, argsFile], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`写回子进程超时（${WORKER_TIMEOUT_MS / 60_000} 分钟）`));
    }, WORKER_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf-8');
      if (err.length > 20_000) err = err.slice(-20_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(argsFile, { force: true });
      // 检查点在 = 飞书侧已全部写完，崩在收尾（三次真机都是这样）不算失败
      let done: SheetResult | null = null;
      try {
        if (fs.existsSync(checkpoint)) done = JSON.parse(fs.readFileSync(checkpoint, 'utf-8')) as SheetResult;
      } catch {
        /* 检查点损坏当没有 */
      }
      fs.rmSync(checkpoint, { force: true });
      // 子进程的进度行（[sheet] 嵌图进度…）转进 daemon 日志，排障时才看得到走到哪
      for (const l of err.split('\n')) if (/\[sheet\]/.test(l)) log(`  ${l.trim().slice(0, 160)}`);
      const last = out.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const r = JSON.parse(last) as { ok: boolean; result?: SheetResult; error?: string };
        if (r.ok && r.result) return resolve(r.result);
        return reject(new Error(r.error ?? `写回子进程失败（code ${code}）`));
      } catch {
        if (done) {
          log(`  写回子进程收尾时退出 code=${code}，但检查点显示飞书侧已写完，按成功处理`);
          return resolve(done);
        }
        // 没有结果行也没有检查点 = 子进程没走到输出就死了（崩溃码在 code 里）
        reject(new Error(`写回子进程异常退出 code=${code}${code && code < 0 ? `（0x${(code >>> 0).toString(16).toUpperCase()}）` : ''}：${err.trim().split('\n').pop()?.slice(0, 160) ?? ''}`));
      }
    });
  });
}
