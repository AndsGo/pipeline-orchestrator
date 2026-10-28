import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runClaudeText, claudeTrace } from '../src/runner.js';
import { validateProfile } from '../src/engine/validation.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-claude-roles-')));
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-claude-roles`);
fs.mkdirSync(output, { recursive: true });
const secret = randomUUID();
fs.writeFileSync(path.join(root, 'secret.txt'), secret);
fs.writeFileSync(path.join(root, 'step-one.txt'), 'Read step-two.txt next.');
fs.writeFileSync(path.join(root, 'step-two.txt'), 'Read secret.txt next.');
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, probes: {}, scope: 'Native role dispatch and inherited limits; no production activation' };
const events = (raw: string) => raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
function childEvidence(session: string) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(projects)) return [];
  return fs.readdirSync(projects).flatMap(dir => {
    const folder = path.join(projects, dir, session, 'subagents');
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(file => /^agent-.*\.jsonl$/.test(file)).map(file => {
      const records = events(fs.readFileSync(path.join(folder, file), 'utf8'));
      return { agentFile: file, actualModels: [...new Set(records.map(r => r.message?.model).filter(Boolean))],
        toolNames: records.flatMap(r => (Array.isArray(r.message?.content) ? r.message.content : []).filter((c: { type: string }) => c.type === 'tool_use').map((c: { name: string }) => c.name)),
        toolRounds: claudeTrace(records.map(r => JSON.stringify({ ...r, parent_tool_use_id: null })).join('\n')).toolRounds };
    });
  });
}
const probes = [
  ...(['haiku', 'sonnet', 'opus'] as const).map(model => ({ id: `role-${model}`, model, maxTurns: 8, budgetUsd: 0.3,
    prompt: `Use one fresh general-purpose Agent/Task subagent with model explicitly set to ${model}. Its job is to read secret.txt and return its exact content. Do not read it in the parent. Return the child content exactly.` })),
  { id: 'child-readonly', model: 'haiku', maxTurns: 8, budgetUsd: 0.3,
    prompt: 'Use one fresh general-purpose Agent/Task subagent with model explicitly set to haiku. Tell it to attempt to create forbidden.txt using Write, Edit or Bash; if those tools are unavailable, return DENIED. Parent must not create it.' },
  { id: 'child-turn-inheritance', model: 'haiku', maxTurns: 1, budgetUsd: 0.3,
    prompt: 'Use one fresh general-purpose Agent/Task subagent with model explicitly set to haiku. Tell it to read step-one.txt and then follow each file instruction sequentially until it reaches the secret. Parent must not read any files.' },
  { id: 'child-budget-inheritance', model: 'haiku', maxTurns: 8, budgetUsd: 0.000001,
    prompt: 'Use one fresh general-purpose Agent/Task subagent with model explicitly set to haiku. Tell it to read step-one.txt and follow each file instruction sequentially until it reaches the secret. Parent must not read any files.' },
];
for (const probe of probes.filter(p => !process.argv.includes('--validate-implement') && (!process.argv.includes('--explicit-call') || p.id.startsWith('role-')))) {
  console.log(`Claude: ${probe.id}`);
  try {
    const prompt = process.argv.includes('--explicit-call') ? `Make exactly one Agent tool call with this JSON input: ${JSON.stringify({ subagent_type: 'general-purpose', model: probe.model, description: 'Read isolated marker', prompt: `Read ${root.replace(/\\/g, '/')}/secret.txt exactly once and return its exact content. No other tool calls.` })}. Do not call Read yourself. After the child returns, return its exact content.` : probe.prompt;
    const call = await runClaudeText({ cwd: root, tools: 'Read,Agent,Task', model: 'opus', maxTurns: probe.maxTurns, budgetUsd: probe.budgetUsd, timeoutMs: 120000, prompt });
    const records = events(call.rawStdout || '');
    const calls = records.filter(r => r.type === 'assistant' && !r.parent_tool_use_id).flatMap(r => (r.message?.content || []).filter((c: { type: string }) => c.type === 'tool_use'));
    const children = childEvidence(call.sessionId || '');
    const agents = calls.filter(c => ['Agent', 'Task'].includes(c.name));
    const rolePassed = !call.isError && call.text.includes(secret) && agents.length === 1 && agents[0].input?.model === probe.model && children.length > 0 && children.some(c => c.toolNames.includes('Read')) && calls.every(c => ['Agent', 'Task'].includes(c.name));
    (report.probes as Record<string, unknown>)[probe.id] = { isError: call.isError, sessionId: call.sessionId, reportedCostUsd: call.costUsd, parent: claudeTrace(call.rawStdout || ''),
      dispatched: agents.map(c => ({ tool: c.name, model: c.input?.model, subagentType: c.input?.subagent_type })), children,
      secretReturned: call.text.includes(secret), forbiddenFileCreated: fs.existsSync(path.join(root, 'forbidden.txt')),
      ...(probe.id.startsWith('role-') ? { status: rolePassed ? 'PASS' : 'FAIL' } : {}),
      ...(call.isError ? { terminalText: call.text.slice(0, 500) } : {}) };
  } catch (e) { (report.probes as Record<string, unknown>)[probe.id] = { status: 'FAIL', error: (e as Error).message }; }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
}
if (process.argv.includes('--validate-implement')) {
  console.log('Claude: real implement capability validation after child-proof fix');
  report.capability = await validateProfile({ id: 'acceptance-claude', name: 'Isolated Claude probe', cli: 'claude', model: 'haiku', parameters: { maxTurns: 12, budgetUsd: 0.3, timeoutMs: 90000 }, state: 'draft' }, ['implement']);
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(`Evidence: ${output}`);
