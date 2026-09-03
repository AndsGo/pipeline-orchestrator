import { readProfile } from '../profile.js';
import type { Stage } from '../types.js';
import { claudeEngine } from './claude.js';
import { codexEngine } from './codex.js';
import type { Engine } from './types.js';

export type { Engine, TextResult } from './types.js';

const REGISTRY: Record<string, Engine> = { claude: claudeEngine, codex: codexEngine };
const warned = new Set<string>();

export function engineNamed(name: string | null | undefined): Engine {
  const key = (name ?? 'claude').trim().toLowerCase();
  const e = REGISTRY[key];
  if (e) return e;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[engine] 未知引擎「${name}」，按 claude 跑（可选：${Object.keys(REGISTRY).join(' / ')}）`);
  }
  return claudeEngine;
}

/**
 * 按仓库的流程约定选引擎：`engine.<stage>` 优先，其次 `engine`，缺省 claude。
 * 读的是 PIPELINE.md，改完不用重启，下一阶段生效——和其它开关一个口径。
 */
export function engineFor(repo: string | undefined, stage?: Stage | string): Engine {
  if (!repo) return claudeEngine;
  const p = readProfile(repo);
  if (!p) return claudeEngine;
  const name = (stage && p.engine.byStage[stage.toLowerCase()]) || p.engine.default;
  return engineNamed(name);
}
