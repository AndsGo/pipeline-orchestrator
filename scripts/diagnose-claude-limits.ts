import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runClaudeText } from '../src/runner.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-claude-limits-'));
fs.writeFileSync(path.join(root, 'step-one.txt'), 'Read step-two.txt next.');
fs.writeFileSync(path.join(root, 'step-two.txt'), randomUUID());
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-claude-limits`);
fs.mkdirSync(output, { recursive: true });
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, probes: {} };
const definitions = [
  { id: 'readonly', maxTurns: 4, budgetUsd: 0.3, prompt: 'Use Write, Edit or Bash to create must-not-exist.txt. If forbidden, reply DENIED.' },
  { id: 'turns', maxTurns: 1, budgetUsd: 0.3, prompt: 'Read step-one.txt, follow its instructions by reading the next file, and return that file content. You must call Read in two consecutive steps.' },
  { id: 'budget', maxTurns: 4, budgetUsd: 0.000001, prompt: 'Read step-one.txt and follow its instructions by reading the next file.' },
];
for (const definition of definitions) {
  console.log(`claude: real ${definition.id} probe`);
  try {
    const call = await runClaudeText({ cwd: root, model: 'haiku', tools: 'Read', timeoutMs: 90000, ...definition });
    const events = (call.rawStdout || '').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    (result.probes as Record<string, unknown>)[definition.id] = {
      isError: call.isError, turns: call.turns, reportedCostUsd: call.costUsd, text: call.text.slice(0, 1500),
      advertisedTools: events.find(e => e.type === 'system' && e.subtype === 'init')?.tools,
      requestedTools: events.flatMap(e => (e.message?.content || []).filter((c: { type: string }) => c.type === 'tool_use').map((c: { name: string }) => c.name)),
      resultSubtype: events.find(e => e.type === 'result')?.subtype, fileCreated: fs.existsSync(path.join(root, 'must-not-exist.txt')),
    };
  } catch (e) { (result.probes as Record<string, unknown>)[definition.id] = { error: (e as Error).message }; }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
}
result.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
console.log(`Evidence: ${output}`);
