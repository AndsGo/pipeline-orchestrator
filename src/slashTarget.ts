import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 把 `/run /docker-push` 里的 `/docker-push` 解析成"到底会执行什么"。
 *
 * 为什么要解析而不是直接弹确认卡：`/xxx` 三个字看不出爆炸半径——
 * 可能是只读的代码检查，也可能是往公司镜像仓库推 latest。
 * 确认卡上必须写清"它是什么、会跑什么"，否则人只会条件反射点确认，等于没有闸门。
 *
 * 顺带解决实测踩过的坑：名字写错（`docker_push` vs `docker-push`）时直接报"没找到 + 最接近的是谁"，
 * 而不是花钱让模型去"讨论"一个不存在的命令，还回一份看起来正常的报告。
 */

export type SlashKind = 'command' | 'skill' | 'unknown';

export interface SlashTarget {
  /** 用户写的名字（不含前导斜杠） */
  name: string;
  /** 名字后面跟的参数原文 */
  args: string;
  kind: SlashKind;
  /** 定义文件绝对路径 */
  file?: string;
  /** 来源：项目 / 个人 / 流水线插件 */
  origin?: string;
  /** 会做什么：命令取正文里的实际命令，skill 取 description */
  digest?: string;
  /** 名字写错时最接近的候选 */
  suggestion?: string;
  /** 命中的高风险动作（用于卡片高亮，不是安全保证） */
  risks?: string[];
}

/** 高风险动作：对外产生副作用、不好回滚的那些。列表故意短——它是提醒，不是白名单校验 */
const RISK_PATTERNS: Array<[RegExp, string]> = [
  [/docker\s+push/i, '推送镜像到远端仓库'],
  [/docker\s+login/i, '登录远端镜像仓库'],
  [/kubectl\s+(apply|delete|rollout|set)/i, '变更 Kubernetes 集群'],
  [/helm\s+(install|upgrade|uninstall)/i, '变更 Helm 发布'],
  [/git\s+push/i, '推送到远端仓库'],
  [/npm\s+publish|yarn\s+publish|pnpm\s+publish/i, '发布 npm 包'],
  [/terraform\s+(apply|destroy)/i, '变更云基础设施'],
  [/\brm\s+-rf\b/i, '递归删除文件'],
  [/\b(ssh|scp)\s/i, '连到远端机器执行/传输'],
  [/(drop|truncate)\s+table/i, '删表'],
];

/** 拆出前导斜杠指令名与其后参数；不是斜杠开头则 name 为空 */
export function splitSlash(text: string): { name: string; args: string } {
  const m = /^\s*\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(text);
  return m ? { name: m[1], args: m[2].trim() } : { name: '', args: '' };
}

function readIfFile(p: string): string | null {
  try {
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf-8') : null;
  } catch {
    return null;
  }
}

function listNames(dir: string, mode: 'command' | 'skill'): string[] {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    return mode === 'command'
      ? ents.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.replace(/\.md$/, ''))
      : ents.filter((e) => e.isDirectory() && readIfFile(path.join(dir, e.name, 'SKILL.md'))).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 命令文件里**真正会执行**的部分：有代码块就只取代码块。
 * 风险扫描必须基于它而不是整个文件——`docker-push.md` 的 Notes 里写着"记得先 docker login"，
 * 扫全文会把一句说明报成"会登录远端仓库"，卡片上多报一条假的，人就开始不信这张卡了。
 */
export function commandScript(body: string): string {
  const fence = /```(?:bash|sh|shell|powershell|ps1)?\s*\n([\s\S]*?)```/.exec(body);
  return fence ? fence[1] : body;
}

/** 命令正文摘要：取真实命令行，去掉续行符与注释，截断到卡片读得动的长度 */
export function commandDigest(body: string): string {
  const lines = commandScript(body)
    .split('\n')
    .map((l) => l.replace(/\s*&&\s*\\\s*$/, '').replace(/\\\s*$/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>'));
  const picked = lines.slice(0, 10);
  const more = lines.length > picked.length ? `\n…（还有 ${lines.length - picked.length} 行）` : '';
  return picked.join('\n').slice(0, 700) + more;
}

/** skill 摘要：frontmatter 的 description，退化为正文首个非空行 */
export function skillDigest(body: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(body);
  const desc = fm && /^description:\s*(.+)$/m.exec(fm[1]);
  if (desc) return desc[1].replace(/^["']|["']$/g, '').slice(0, 400);
  const rest = fm ? body.slice(fm[0].length) : body;
  return (rest.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim().slice(0, 400);
}

/** 名字规范化后比对：docker_push / DockerPush / docker-push 视为同一个 */
const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');

export function resolveSlashTarget(repo: string, text: string, pluginDir?: string): SlashTarget {
  const { name, args } = splitSlash(text);
  if (!name) return { name: '', args: '', kind: 'unknown' };

  const home = os.homedir();
  const places: Array<{ dir: string; mode: 'command' | 'skill'; origin: string }> = [
    { dir: path.join(repo, '.claude', 'commands'), mode: 'command', origin: '项目指令' },
    { dir: path.join(repo, '.claude', 'skills'), mode: 'skill', origin: '项目 skill' },
    { dir: path.join(home, '.claude', 'commands'), mode: 'command', origin: '个人指令' },
    { dir: path.join(home, '.claude', 'skills'), mode: 'skill', origin: '个人 skill' },
    ...(pluginDir ? [{ dir: path.join(pluginDir, 'skills'), mode: 'skill' as const, origin: '流水线插件 skill' }] : []),
  ];

  for (const p of places) {
    const file = p.mode === 'command' ? path.join(p.dir, `${name}.md`) : path.join(p.dir, name, 'SKILL.md');
    const body = readIfFile(file);
    if (!body) continue;
    const digest = p.mode === 'command' ? commandDigest(body) : skillDigest(body);
    const scanned = p.mode === 'command' ? commandScript(body) : body;
    const risks = RISK_PATTERNS.filter(([re]) => re.test(scanned)).map(([, label]) => label);
    return { name, args, kind: p.mode, file, origin: p.origin, digest, risks };
  }

  // 没命中：给最接近的候选，把"名字写错"和"确实没这个东西"区分开
  const all = places.flatMap((p) => listNames(p.dir, p.mode));
  const suggestion = all.find((n) => norm(n) === norm(name)) ?? all.find((n) => norm(n).includes(norm(name)));
  return { name, args, kind: 'unknown', suggestion };
}

/** 确认卡文案：它是什么、跑什么、有什么对外副作用、我拦不住什么 */
export function describeSlashTarget(t: SlashTarget, projectAlias: string): string {
  const lines = [
    `即将在 **${projectAlias}** 执行 ${t.origin ?? '指令'} \`/${t.name}\`${t.args ? ` ${t.args}` : ''}`,
  ];
  if (t.risks?.length) lines.push('', `⚠️ **会产生对外副作用**：${t.risks.join('、')}`);
  if (t.digest) lines.push('', t.kind === 'command' ? '**会执行**：' : '**说明**：', '```', t.digest, '```');
  // 流水线阶段 skill 走这条路等于绕过状态机：会真写工件、真提交，但工单进度不会更新
  if (t.origin === '流水线插件 skill') {
    lines.push('', '⚠️ 这是流水线阶段 skill：单次执行会写工件、会提交，但**工单状态不会更新**（正常应由编排器调度）');
  }
  lines.push('', '_单次执行：有 Bash 权限、不建工单、不进流水线评审。取消不会有任何改动。_');
  return lines.join('\n');
}
