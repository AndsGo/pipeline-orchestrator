// 分类失败诊断：把 runClaudeJson 的完整信封打出来，看清是异常、超轮次、还是没给结构化输出
//   npx tsx scripts/classify-debug.ts sonnet "用户原话"
import { buildClassifyPrompt, COMMAND_SCHEMA } from '../src/commands.js';
import { runClaudeJson } from '../src/runner.js';

const model = process.argv[2] ?? 'sonnet';
const text =
  process.argv[3] ??
  '生产上发布了当前分支，但是工具连mcp时连接不上：lakeghost项目存在一个问题，上线后 https://lakeghost.hbo-erp.com/mcp/sse?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc 连接不上，一直转圈';

const contexts = [
  { ticket: 'LS-002', stage: 'acceptance', runState: '进行中', pending: [], halted: undefined },
  { ticket: 'LS-005', stage: 'compound', runState: '进行中', pending: [], halted: undefined },
];

const { envelope } = await runClaudeJson({
  cwd: process.cwd(),
  prompt: buildClassifyPrompt(text, contexts),
  tools: 'Read',
  model,
  maxTurns: 3,
  budgetUsd: 0.2,
  schema: COMMAND_SCHEMA,
});

console.log('is_error        :', envelope.is_error);
console.log('num_turns       :', envelope.num_turns);
console.log('cost            :', envelope.total_cost_usd);
console.log('structured_output:', JSON.stringify(envelope.structured_output));
console.log('result          :', (envelope.result ?? '').slice(0, 600));
