import fs from 'node:fs';
import path from 'node:path';
import { readEnvVar, upsertEnvVar } from '../onboarding.js';
import { loadProjects } from '../projects.js';
import type { DaemonContext } from './context.js';

/** /bind 与 /addproject 共用的 PIPELINE_PROJECTS 读写：.env 里全是真凭据，改法只此一处 */

/** 读 .env 原文与当前 PIPELINE_PROJECTS 值；值缺失返回 null，由调用方给出各自的提示 */
export function readProjectsEnv(envFile: string): { envText: string; current: string | null } {
  const envText = fs.readFileSync(envFile, 'utf-8');
  return { envText, current: readEnvVar(envText, 'PIPELINE_PROJECTS') };
}

/** 写回：.env 整份备份进 backups/ 后精确改一行，再内存热加载项目表（原地替换，引用不变） */
export function commitProjectsEnv(ctx: DaemonContext, envText: string, next: string): void {
  const backup = path.resolve(path.dirname(ctx.envFile), 'backups', `env-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(ctx.envFile, backup);
  fs.writeFileSync(ctx.envFile, upsertEnvVar(envText, 'PIPELINE_PROJECTS', next), 'utf-8');
  process.env.PIPELINE_PROJECTS = next;
  ctx.projects.splice(0, ctx.projects.length, ...loadProjects());
}
