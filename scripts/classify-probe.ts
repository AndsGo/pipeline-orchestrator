// 意图识别实测：同一批语句在两个模型上跑，用数据决定 PIPELINE_CLASSIFY_MODEL 该配谁。
//   npx tsx scripts/classify-probe.ts              # 对比 haiku / sonnet
//   npx tsx scripts/classify-probe.ts haiku        # 只跑一个
import { classifyCommand, type Command } from '../src/commands.js';

interface Case {
  text: string;
  kind: Command['kind'];
  sideEffect?: boolean;
  why: string;
}

/** 判错代价越高的越要覆盖：把部署判成只读查询 = 无确认直接推线上 */
const CASES: Case[] = [
  { text: '这个仓库的鉴权中间件在哪', kind: 'run', sideEffect: false, why: '纯查询' },
  { text: '跑一下前端测试', kind: 'run', sideEffect: false, why: '本地测试，无对外影响' },
  { text: '看下 docker-push 这个命令都干了什么', kind: 'run', sideEffect: false, why: '只是读命令文件' },
  { text: '帮我把前端镜像推到仓库', kind: 'run', sideEffect: true, why: '推远端仓库' },
  { text: '将LS-008对应的worktree 合并到master后删除', kind: 'run', sideEffect: true, why: '合并主干+删worktree（2026-08-18 实测漏判）' },
  { text: '把这个项目部署一下', kind: 'run', sideEffect: true, why: '部署' },
  { text: '发个版本上去', kind: 'run', sideEffect: true, why: '发布' },
  // 需求池（拍板 2026-09-23）：描述新功能/改进默认进池；明确说建单才直接建
  { text: '给 /mcp 端点加限流', kind: 'req', why: '描述一个改进、没说建单 → 进需求池' },
  { text: '湖灵的数据域里有没有一个功能，我想知道勾选的几十张表里哪些没在权限规则里设权限', kind: 'req', why: '业务提需求（09-01 真机原话）' },
  { text: '能不能在刊登页加一个批量改价的按钮', kind: 'req', why: '想要新功能' },
  { text: '给 /mcp 端点加限流，直接建个工单', kind: 'new', why: '明确要求建单' },
  { text: '导出一份8月份之后缺listing信息的SPU清单', kind: 'run', sideEffect: false, why: '查数导出不改代码（OP-001 曾被误建成工单）' },
  { text: '查一下 queue_job 为什么积压', kind: 'run', sideEffect: false, why: '诊断' },
  { text: '需求池里现在有什么', kind: 'pool', why: '看需求池' },
  { text: 'LS-005 现在跑到哪了', kind: 'status', why: '查进度' },
];

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['haiku', 'sonnet'];

for (const model of models) {
  console.log(`\n===== ${model} =====`);
  let ok = 0;
  for (const c of CASES) {
    const { command, confidence } = await classifyCommand(c.text, [], process.cwd(), model);
    const se = command.kind === 'run' ? (command as { sideEffect?: boolean }).sideEffect === true : undefined;
    const kindOk = command.kind === c.kind;
    const seOk = c.sideEffect === undefined || se === c.sideEffect;
    const pass = kindOk && seOk;
    if (pass) ok++;
    console.log(
      `${pass ? '✓' : '✗'} 「${c.text}」→ ${command.kind}${se === undefined ? '' : `/side_effect=${se}`}` +
        ` （期望 ${c.kind}${c.sideEffect === undefined ? '' : `/side_effect=${c.sideEffect}`}，${c.why}，把握 ${(confidence * 100).toFixed(0)}%）`,
    );
  }
  console.log(`${model}: ${ok}/${CASES.length} 正确`);
}
