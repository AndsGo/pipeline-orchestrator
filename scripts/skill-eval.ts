// skill 评估集运行器（评估驱动开发）：改 skill / 换模型后必须回归。
//   npx tsx scripts/skill-eval.ts --all
//   npx tsx scripts/skill-eval.ts review-blocks-missed-ac
// 场景定义在 pipeline-plugin/evals/<场景>/：expect.json + shared/（工作区）+ 可选 base/、head/（构造 diff）。
// 用 sonnet 降费执行——评估的是 skill 文本的约束力，不是模型天花板。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR, STAGES } from '../src/config.js';
import { runClaudeJson } from '../src/runner.js';
import { wireSchema } from '../src/schema.js';
import type { Stage } from '../src/types.js';

interface Expect {
  skill: Exclude<Stage, 'ci'>;
  why: string;
  extraArgs: string;
  assert: { status?: string[]; verdict?: string; axes_spec_failed_min?: number };
}

const EVALS_DIR = path.join(PLUGIN_DIR, 'evals');
const list = fs.readdirSync(EVALS_DIR).filter((d) => fs.existsSync(path.join(EVALS_DIR, d, 'expect.json')));
const args = process.argv.slice(2);
const picked = args.includes('--all') ? list : list.filter((d) => args.includes(d));
if (!picked.length) {
  console.error(`用法: npx tsx scripts/skill-eval.ts --all | <场景名>\n可用场景: ${list.join('、')}`);
  process.exit(1);
}

const schema = JSON.parse(wireSchema()) as object; // 线上版：API 不吃顶层 allOf，条件校验由回程补足
const git = (cwd: string, cmd: string): string => execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();

let failed = 0;
let cost = 0;
for (const id of picked) {
  const dir = path.join(EVALS_DIR, id);
  const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf-8')) as Expect;
  // 不用 os.tmpdir()：其 8.3 短路径（ADMINI~1）会被工具权限系统当可疑路径拦掉会话的产物写入
  const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.eval-tmp');
  fs.mkdirSync(evalRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(evalRoot, 'run-'));
  fs.cpSync(path.join(dir, 'shared'), tmp, { recursive: true });
  if (fs.existsSync(path.join(dir, 'base'))) fs.cpSync(path.join(dir, 'base'), tmp, { recursive: true });
  git(tmp, 'init -q');
  git(tmp, 'config user.email eval@local');
  git(tmp, 'config user.name eval');
  git(tmp, 'add -A');
  git(tmp, 'commit -qm base');
  const baseSha = git(tmp, 'rev-parse HEAD');
  if (fs.existsSync(path.join(dir, 'head'))) {
    fs.cpSync(path.join(dir, 'head'), tmp, { recursive: true });
    git(tmp, 'add -A');
    git(tmp, 'commit -qm head');
  }
  const extra = exp.extraArgs.replace('{BASE_SHA}', baseSha);
  console.log(`▶ ${id}（${exp.skill}）…`);
  const { envelope } = await runClaudeJson({
    cwd: tmp,
    prompt: `/pipeline-${exp.skill} T-1${extra ? ` ${extra}` : ''}`,
    tools: STAGES[exp.skill].tools,
    model: 'sonnet',
    maxTurns: STAGES[exp.skill].maxTurns,
    budgetUsd: 3,
    schema,
    pluginDir: PLUGIN_DIR,
  });
  cost += envelope.total_cost_usd ?? 0;
  const so = envelope.structured_output;
  const errs: string[] = [];
  if (envelope.is_error || !so) {
    errs.push(`会话异常：${(envelope.result ?? '无结构化返回').slice(0, 150)}`);
  } else {
    if (exp.assert.status && !exp.assert.status.includes(so.status)) errs.push(`status=${so.status}，期望 ${exp.assert.status.join('/')}`);
    if (exp.assert.verdict && so.verdict !== exp.assert.verdict) errs.push(`verdict=${so.verdict ?? '无'}，期望 ${exp.assert.verdict}`);
    if (exp.assert.axes_spec_failed_min != null && (so.axes?.spec.failed ?? 0) < exp.assert.axes_spec_failed_min) {
      errs.push(`axes.spec.failed=${so.axes?.spec.failed ?? '无'}，期望 ≥${exp.assert.axes_spec_failed_min}`);
    }
  }
  if (errs.length) {
    failed++;
    console.log(`✗ ${id}\n   ${errs.join('\n   ')}\n   （${exp.why}）`);
    if (so?.blocked_reason) console.log(`   blocked_reason: ${so.blocked_reason.slice(0, 300)}`);
    if (so?.summary_for_card) console.log(`   summary: ${so.summary_for_card.slice(0, 200)}`);
  } else {
    console.log(`✓ ${id}（${so?.verdict ?? so?.status}，$${(envelope.total_cost_usd ?? 0).toFixed(2)}，${envelope.num_turns} 轮）`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${picked.length - failed}/${picked.length} 通过，合计 $${cost.toFixed(2)}`);
process.exit(failed ? 1 : 0);
