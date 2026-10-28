import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaudeText, claudeTrace } from '../src/runner.js';
if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const short = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-claude-write-'));
const canonical = fs.realpathSync.native(short);
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-claude-write`);
fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), probes: {} };
for (const [kind, cwd] of [['short', short], ['canonical', canonical]]) {
  console.log(`Claude Write: ${kind}`);
  const file = `proof-${kind}.txt`;
  try {
    const r = await runClaudeText({ cwd, tools: 'Write', model: 'haiku', maxTurns: 3, budgetUsd: 0.3, timeoutMs: 30000,
      prompt: `Use Write exactly once to create ${cwd.replace(/\\/g, '/')}/${file} containing exactly PROOF. Then reply DONE. Do not read any file.` });
    const events = (r.rawStdout || '').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    (report.probes as Record<string, unknown>)[kind] = { cwd, isError: r.isError, sessionId: r.sessionId, trace: claudeTrace(r.rawStdout || ''), costUsd: r.costUsd,
      permissionDenials: events.find(e => e.type === 'result')?.permission_denials?.map((d: { tool_name: string }) => d.tool_name),
      fileWritten: fs.existsSync(path.join(cwd, file)) && fs.readFileSync(path.join(cwd, file), 'utf8') === 'PROOF' };
  } catch (e) { (report.probes as Record<string, unknown>)[kind] = { error: (e as Error).message }; }
}
report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(`Evidence: ${output}`);
