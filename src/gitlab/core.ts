/**
 * GitLab MR 评论触发独立 review —— 纯逻辑层（可单测）。
 * 事件解析 / 触发词判定 / 仓库映射 / review 提示词与回帖格式。
 */

export interface GitlabConfig {
  url: string; // http://gitlab.internal
  apiToken: string; // PAT，用于取 MR 信息与回帖
  webhookSecret: string; // X-Gitlab-Token 校验
  trigger: string; // 触发词，默认 @ai-review
  repoMap: Record<string, string>; // "group/proj" -> 本地仓库路径
  port: number;
}

export function gitlabConfigFromEnv(env = process.env): GitlabConfig {
  const { GITLAB_URL, GITLAB_API_TOKEN, GITLAB_WEBHOOK_SECRET, GITLAB_TRIGGER, GITLAB_REPO_MAP, GITLAB_WEBHOOK_PORT } = env;
  if (!GITLAB_URL || !GITLAB_API_TOKEN || !GITLAB_WEBHOOK_SECRET || !GITLAB_REPO_MAP) {
    throw new Error('缺少 GITLAB_URL / GITLAB_API_TOKEN / GITLAB_WEBHOOK_SECRET / GITLAB_REPO_MAP');
  }
  return {
    url: GITLAB_URL.replace(/\/$/, ''),
    apiToken: GITLAB_API_TOKEN,
    webhookSecret: GITLAB_WEBHOOK_SECRET,
    trigger: GITLAB_TRIGGER ?? '@ai-review',
    repoMap: JSON.parse(GITLAB_REPO_MAP) as Record<string, string>,
    port: Number(GITLAB_WEBHOOK_PORT ?? 8377),
  };
}

export interface MrNoteEvent {
  projectPath: string; // group/proj
  mrIid: number;
  comment: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
}

/** 解析 note webhook 事件；非 MR 评论返回 null。@bot 需自行解析评论文本（GitLab 无结构化 mention 字段） */
export function parseNoteEvent(body: unknown): MrNoteEvent | null {
  const b = body as {
    object_kind?: string;
    project?: { path_with_namespace?: string };
    object_attributes?: { note?: string; noteable_type?: string };
    merge_request?: { iid?: number; source_branch?: string; target_branch?: string };
    user?: { username?: string };
  };
  if (b?.object_kind !== 'note' || b.object_attributes?.noteable_type !== 'MergeRequest') return null;
  if (!b.project?.path_with_namespace || !b.merge_request?.iid || !b.object_attributes.note) return null;
  return {
    projectPath: b.project.path_with_namespace,
    mrIid: b.merge_request.iid,
    comment: b.object_attributes.note,
    author: b.user?.username ?? 'unknown',
    sourceBranch: b.merge_request.source_branch ?? '',
    targetBranch: b.merge_request.target_branch ?? '',
  };
}

/** 评审回帖的签名标记：含此标记的评论一律不触发（防 bot 自触发回环） */
export const REVIEW_SIGNATURE = 'ai-review-bot-comment';

export function shouldTrigger(comment: string, trigger: string, botUsername?: string): boolean {
  if (comment.includes(REVIEW_SIGNATURE)) return false;
  if (comment.includes(trigger)) return true;
  return !!botUsername && comment.includes(`@${botUsername}`);
}

export function resolveRepo(map: Record<string, string>, projectPath: string): string | null {
  return map[projectPath] ?? null;
}

/** 独立 MR review 的结构化返回 schema（顶层无 allOf，可直传 API） */
export const MR_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_SUGGESTIONS', 'BLOCK'] },
    summary: { type: 'string', maxLength: 1000 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'issue', 'scenario'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Important', 'Minor'] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          issue: { type: 'string' },
          scenario: { type: 'string', description: '失败场景：什么输入/状态下产生什么错误后果' },
        },
      },
    },
  },
} as const;

export interface MrReviewResult {
  verdict: 'PASS' | 'PASS_WITH_SUGGESTIONS' | 'BLOCK';
  summary: string;
  findings: Array<{ severity: string; file: string; line?: number | null; issue: string; scenario: string }>;
}

/** review 会话提示词：独立、无实现上下文、写不出失败场景的降级 Minor */
export function buildReviewPrompt(ev: MrNoteEvent, diffFile: string): string {
  return [
    `你是独立代码评审员，对 MR !${ev.mrIid}（${ev.sourceBranch} → ${ev.targetBranch}）做正确性与质量评审。`,
    `完整 diff 已写入文件 ${diffFile}，先读它；需要上下文时再读仓库源码，可运行只读命令与测试验证判断。`,
    `每条 finding 必须给出失败场景（什么输入/状态下产生什么错误后果）——写不出失败场景的问题降级为 Minor 建议。`,
    `关注：正确性、边界条件、安全（注入/鉴权/密钥）、并发、测试是否真的断言了行为。不要复述 diff，不要客套。`,
    `结论映射：存在 Critical/Important → BLOCK；仅 Minor → PASS_WITH_SUGGESTIONS；无 → PASS。`,
  ].join('\n');
}

/** 回帖 markdown（GitLab MR note） */
export function formatComment(r: MrReviewResult, trigger: string): string {
  const icon = r.verdict === 'PASS' ? '✅' : r.verdict === 'BLOCK' ? '⛔' : '💡';
  const lines = [`## ${icon} AI Review：${r.verdict}`, '', r.summary, ''];
  if (r.findings.length) {
    lines.push('| 级别 | 位置 | 问题 | 失败场景 |', '|---|---|---|---|');
    for (const f of r.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`| ${f.severity} | \`${loc}\` | ${f.issue.replace(/\|/g, '\\|')} | ${f.scenario.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  // 页脚绝不能包含触发词原文（bot 回帖会再次进入 note 事件，触发词 + 无签名 = 自触发死循环）
  lines.push(`<sub>由流水线独立评审生成，重新评论触发词可再次评审</sub>`, `<!-- ${REVIEW_SIGNATURE} -->`);
  return lines.join('\n');
}
