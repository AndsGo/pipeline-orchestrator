import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 能力地图（docs/pipeline/system-map/）的新鲜度判据。
 *
 * 地图的价值全押在「读它的人知道它有多旧」上：一份自信地过期的地图比没有地图更糟——
 * 没有地图时会话会自己去读代码，有一份看起来权威的旧地图时它会直接信。
 * 所以这里只做一件事：算出地图落后多少提交、哪些能力的代码在地图生成后被动过，
 * 把结论写进注入头。全程 git 命令，零模型成本。
 */

export const SYSTEM_MAP_DIR = path.join('docs', 'pipeline', 'system-map');

/** 注入进工单目录的地图指引（编号排在知识提示 05 之后，随工单提交，可追溯当时会话看到的是什么） */
export const MAP_HINT_FILE = '07-map-hint.md';

export interface MapCapability {
  slug: string;
  title: string;
  paths?: string[];
  lastTicket?: string;
}

export interface SystemMapMeta {
  version?: number;
  generated_at?: string;
  code_commit?: string;
  capabilities?: MapCapability[];
}

export interface MapFreshness {
  exists: boolean;
  /** 地图基线之后的提交数；无法计算时 null（基线提交不在本仓库历史里，如浅克隆或被 rebase 掉） */
  commitsBehind: number | null;
  /** 基线之后有代码变动的能力（按 map.json 的 paths 判定） */
  touched: string[];
  generatedAt?: string;
  /** 一行人类可读结论，直接进注入头 */
  headline: string;
}

function git(repo: string, cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function readMapMeta(repo: string): SystemMapMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, SYSTEM_MAP_DIR, 'map.json'), 'utf-8')) as SystemMapMeta;
  } catch {
    return null;
  }
}

export function systemMapIndex(repo: string): string {
  return path.join(repo, SYSTEM_MAP_DIR, 'index.md');
}

/** 地图相对当前 HEAD 的新鲜度。不抛异常——地图缺失/git 不可用都只是「没有结论」，不该拦住工单。 */
export function mapFreshness(repo: string): MapFreshness {
  if (!fs.existsSync(systemMapIndex(repo))) {
    return { exists: false, commitsBehind: null, touched: [], headline: '本仓库还没有能力地图' };
  }
  const meta = readMapMeta(repo);
  const base = meta?.code_commit;
  if (!base) {
    return {
      exists: true,
      commitsBehind: null,
      touched: [],
      generatedAt: meta?.generated_at,
      headline: '能力地图存在，但没记录生成时的代码基线——无法判断新鲜度，与代码冲突时以代码为准',
    };
  }
  const count = git(repo, `rev-list --count ${base}..HEAD`);
  const commitsBehind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  if (commitsBehind === null) {
    return {
      exists: true,
      commitsBehind: null,
      touched: [],
      generatedAt: meta?.generated_at,
      headline: `能力地图的基线提交 ${base.slice(0, 7)} 不在当前仓库历史里（被 rebase 或浅克隆），新鲜度无法判断`,
    };
  }
  const touched: string[] = [];
  if (commitsBehind > 0) {
    for (const cap of meta.capabilities ?? []) {
      const paths = (cap.paths ?? []).filter(Boolean);
      if (!paths.length) continue;
      const changed = git(repo, `diff --name-only ${base}..HEAD -- ${paths.map((p) => `"${p}"`).join(' ')}`);
      if (changed) touched.push(cap.title || cap.slug);
    }
  }
  return {
    exists: true,
    commitsBehind,
    touched,
    generatedAt: meta.generated_at,
    headline:
      commitsBehind === 0
        ? '能力地图与当前代码同步'
        : `能力地图落后 ${commitsBehind} 个提交` +
          (touched.length ? `，其中这些能力的代码已变动：${touched.join('、')}——这些部分以代码为准` : '，未触及任何已登记能力的核心路径'),
  };
}

/** 注入给阶段会话的地图提示头（写进工单目录，与知识提示同一形态） */
export function renderMapHint(f: MapFreshness): string {
  return [
    '# 能力地图指引（编排器注入）',
    '',
    `- 状态：${f.headline}`,
    ...(f.generatedAt ? [`- 地图生成于：${f.generatedAt}`] : []),
    `- 入口：\`${SYSTEM_MAP_DIR.replace(/\\/g, '/')}/index.md\`（索引，按需往下读能力页，不要一次全读）`,
    '- 地图与代码冲突时**以代码为准**，并把该冲突写进本阶段产物的「事实 vs 假设」。',
    '',
  ].join('\n');
}
