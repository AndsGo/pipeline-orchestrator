import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目流程约定 `docs/pipeline/PIPELINE.md`：一半给机器、一半给会话。
 *
 * 由来（2026-09-02，OP-002 验收实测）：流程差异只靠「配没配 Jenkins」一个二值判断。odoo-product 没有测试环境、
 * 合 develop 就是上线、另有人工审批——验收卡却让运营去点一个不存在于任何环境的筛选项，只能选「无法验证」。
 * 每个项目的测试/验收/上线方式不同，这些事实应该写在仓库里一份可读文件里，编排器读开关决定走哪条流程，
 * 各阶段会话读自己那一节当项目级提示词，而不是改代码。
 *
 * 文件格式：frontmatter 是开关（testEnv / acceptor / release），正文按 `## <阶段名>` 分节，`## 全阶段` 每个阶段都读。
 * 没有这份文件 = 沿用旧行为，完全向后兼容。
 */

export const PROFILE_FILE = 'docs/pipeline/PIPELINE.md';
/** 每阶段开工前写进工单目录的节选：全阶段 + 本阶段 */
export const STAGE_PROFILE_FILE = '07-project-profile.md';

export type ReleaseMode = 'merge-develop' | 'merge-master' | 'manual' | 'none';

export interface PipelineProfile {
  /** null = 没有测试环境：人工验收项不弹卡，转上线后补验 */
  testEnv: { url: string; note?: string } | null;
  /** 验收人是谁：决定验收卡措辞 */
  acceptor: 'ops' | 'dev';
  /** 上线方式：merge-* = 上线审批通过后编排器合并 MR；manual = 人上线后点确认；none = 不设上线环节 */
  release: ReleaseMode;
  /** 执行引擎：`engine:` 全项目默认，`engine.<stage>:` 按阶段覆盖；缺省 claude（见 src/engine/） */
  engine: { default: string | null; byStage: Record<string, string> };
  /** 浏览器 e2e：`e2e: playwright` 时验收/评审阶段带 Playwright MCP（见 src/engine/e2e.ts）；缺省无 */
  e2e: 'playwright' | null;
  /** 正文分节：小写标题 → 正文 */
  sections: Record<string, string>;
}

const RELEASE_MODES: ReleaseMode[] = ['merge-develop', 'merge-master', 'manual', 'none'];

export function parseProfile(md: string): PipelineProfile {
  const text = md.replace(/\r\n/g, '\n');
  const fm: Record<string, string> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      // 键允许点号：engine.review 这类按阶段的覆盖写成扁平键，不引入嵌套 YAML 解析
      const kv = /^\s*([A-Za-z][\w.-]*)\s*:\s*(.*?)\s*$/.exec(line);
      // 值后允许行内注释（模板就是这么写的）；引号剥掉
      if (kv) fm[kv[1]] = kv[2].replace(/\s+#.*$/, '').replace(/^#.*$/, '').replace(/^["']|["']$/g, '').trim();
    }
    body = text.slice(m[0].length);
  }
  const sections: Record<string, string> = {};
  let cur: string | null = null;
  const buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) sections[cur] = buf.join('\n').trim();
    buf.length = 0;
  };
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      cur = h[1].toLowerCase();
    } else if (cur !== null) buf.push(line);
  }
  flush();

  const env = (fm.testEnv ?? 'none').trim();
  const release = (fm.release ?? 'none').trim() as ReleaseMode;
  const byStage: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    const m = /^engine\.([A-Za-z]+)$/.exec(k);
    if (m && v) byStage[m[1].toLowerCase()] = v.toLowerCase();
  }
  return {
    testEnv: !env || /^none$/i.test(env) ? null : { url: env, note: fm.testEnvNote?.trim() || undefined },
    acceptor: fm.acceptor?.trim() === 'ops' ? 'ops' : 'dev',
    release: RELEASE_MODES.includes(release) ? release : 'none',
    engine: { default: fm.engine ? fm.engine.toLowerCase() : null, byStage },
    e2e: /^playwright$/i.test(fm.e2e ?? '') ? 'playwright' : null,
    sections,
  };
}

/** 读仓库里的约定；不存在或读不了 → null（= 旧行为） */
export function readProfile(repo: string): PipelineProfile | null {
  const f = path.join(repo, PROFILE_FILE);
  try {
    return fs.existsSync(f) ? parseProfile(fs.readFileSync(f, 'utf-8')) : null;
  } catch {
    return null;
  }
}

/** 给某阶段会话看的节选：全阶段 + 本阶段；两者都没有 → null（不写空文件） */
export function stageBrief(p: PipelineProfile, stage: string): string | null {
  const all = p.sections['全阶段'] ?? p.sections['all'];
  const own = p.sections[stage.toLowerCase()];
  if (!all && !own) return null;
  return [
    `# 本项目的流程约定（节选自 ${PROFILE_FILE}，本阶段先读；与通用流程冲突时以此为准——项目事实优先）`,
    '',
    `- 测试环境：${p.testEnv ? `${p.testEnv.url}${p.testEnv.note ? `（${p.testEnv.note}）` : ''}` : '无（人工验收项将转上线后补验，不要假装可验）'}`,
    `- 验收人：${p.acceptor === 'ops' ? '运营（措辞面向业务，不要出现分支/模块版本等研发词）' : '研发'}`,
    `- 上线方式：${describeRelease(p.release)}`,
    ...(p.e2e && (stage === 'acceptance' || stage === 'review')
      ? [`- 浏览器 e2e：可用（Playwright MCP）。页面类检查项先在${p.testEnv ? ` ${p.testEnv.url} ` : '测试环境'}实测并记录证据，判不了的才留给人`]
      : []),
    ...(all ? ['', '## 全阶段', all] : []),
    ...(own ? ['', `## ${stage}`, own] : []),
    '',
  ].join('\n');
}

export function describeRelease(mode: ReleaseMode): string {
  return {
    'merge-develop': '合入 develop 即上线（上线审批通过后由编排器合并 MR）',
    'merge-master': '合入 master 即上线（上线审批通过后由编排器合并 MR）',
    manual: '人工上线（编排器发上线清单，人完成后点确认）',
    none: '本流水线不设上线环节',
  }[mode];
}

/** 合并目标分支；非 merge-* 模式 → null */
export function releaseTargetBranch(mode: ReleaseMode): string | null {
  return mode === 'merge-develop' ? 'develop' : mode === 'merge-master' ? 'master' : null;
}

/** 接入项目时没有约定文件就生成模板；已有则不动。返回是否新建 */
export function ensureProfileTemplate(repo: string, alias: string): boolean {
  const f = path.join(repo, PROFILE_FILE);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, profileTemplate(alias), 'utf-8');
  return true;
}

/** /addproject 与向导生成的模板：开关给保守默认，正文留提示让人填 */
export function profileTemplate(alias: string): string {
  return `---
# 流程开关（编排器读）。改完不用重启 daemon，下一阶段生效。
testEnv: none            # none = 没有测试环境；否则填地址，如 http://10.0.0.5:8080
testEnvNote:             # 可选：登录方式、账号在哪、注意事项（会原样出现在验收卡上）
acceptor: dev            # ops = 运营验收（卡片用业务措辞）/ dev = 研发验收
release: none            # merge-develop / merge-master = 审批后自动合并 MR；manual = 人上线后点确认；none = 不设上线环节
# engine: claude         # 执行引擎：claude（默认）/ codex；按阶段覆盖写 engine.review: codex（异构评审对冲非确定性）
# e2e: playwright        # 验收/评审阶段带浏览器（Playwright MCP），页面类验收项先实测再留人工；需 testEnv 在跑
---
# ${alias} 流水线项目约定

> 每个阶段开工前，编排器把「全阶段」+ 该阶段一节抄进工单目录的 07-project-profile.md，会话先读它。
> 写事实与硬约束，不写单个工单的流水账；单个工单的知识由 compound 沉淀到知识库。

## 全阶段

（所有阶段都读。例：测试库怎么建、哪些目录不许碰、术语口径。）

## implement

（例：跑测试的命令模板、不能全新安装的原因与替代做法、已知存量红灯清单在哪。）

## review

（例：必须核查的共享入口、评审时可用的只读数据源。）

## acceptance

（例：验收样例数据在哪、人工项怎么做、哪些项注定只能上线后补验。）

## release

（例：上线前还要过谁的审批、合并后要不要手动升级模块、上线后去哪看效果。）
`;
}
