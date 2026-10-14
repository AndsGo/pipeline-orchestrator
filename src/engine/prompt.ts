import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR } from '../config.js';

export const KNOWLEDGE_FILES = ['AGENTS.md', 'docs/pipeline/PROJECT-KNOWLEDGE.md'] as const;
export function knowledgePrompt(repo: string): string {
  const parts: string[] = [];
  for (const file of KNOWLEDGE_FILES) {
    const full = path.join(repo, file);
    if (fs.existsSync(full)) parts.push(`## ${file}\n${fs.readFileSync(full, 'utf8')}`);
  }
  // Retain old project knowledge until it has been consciously migrated.
  const legacy = path.join(repo, 'CLAUDE.md');
  if (fs.existsSync(legacy)) parts.push(`## CLAUDE.md（既有项目规则；与上述新规则冲突时停止并报告）\n${fs.readFileSync(legacy, 'utf8')}`);
  return parts.length ? `以下是项目规则与知识，各 CLI 都必须遵守。冲突时报告，不自行覆盖。\n${parts.join('\n\n')}` : '';
}
export function sharedPrompt(prompt: string, cwd: string, pluginDir = PLUGIN_DIR, structured = false): string {
  const m = /^\/([a-z][\w-]*)\s*([\s\S]*)$/i.exec(prompt.trim());
  const body = m ? [
    `本次任务由 ${path.join(pluginDir, 'skills', m[1], 'SKILL.md').replace(/\\/g, '/')} 定义。先完整读取，再严格执行。`,
    `技能中的 \${PIPELINE_PLUGIN_ROOT} 和兼容别名 \${CLAUDE_PLUGIN_ROOT} 都指 ${pluginDir.replace(/\\/g, '/')}。`,
    '技能是共用规则；不得因为 CLI 不同而降低评审、子代理或交接要求。缺少必需技能或工具就停止并说明原因。',
    `参数：${m[2] || '（无）'}`,
  ].join('\n') : prompt;
  return [body, `工作根目录：${cwd.replace(/\\/g, '/')}。工件仅写在此工作目录，不能切换到主检出写文件。`, knowledgePrompt(cwd),
    structured ? '最终回复必须是符合给定 JSON Schema 的单个 JSON 对象，不要 Markdown 代码围栏。' : ''].filter(Boolean).join('\n\n');
}
