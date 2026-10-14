import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runProcess, withProcessEvidence } from '../src/engine/process.js';
import { assertRuntimeIdentity } from '../src/engine/identity.js';
import { localAcceptanceProvider } from './acceptance-local-provider.js';
import { acceptanceTrace } from './acceptance-trace.js';

const input = process.env.PIPELINE_ACCEPTANCE_RESUME_DIR;
if (!input) throw new Error('Specify the completed owned fixture');
const root = fs.realpathSync.native(input);
if (!/^pipeline-full-ticket-[^/\\]+$/.test(path.relative(fs.realpathSync.native(os.tmpdir()), root))) throw new Error('Only an owned fixture is allowed');
const repo = fs.realpathSync.native(path.join(root, 'repo'));
const source = path.resolve(process.argv[process.argv.indexOf('--source') + 1] || '');
if (!source.startsWith(path.resolve('docs/acceptance') + path.sep) || !source.endsWith('.json')) throw new Error('Specify an existing native process evidence file');
const native = JSON.parse(fs.readFileSync(source, 'utf8'));
if (fs.realpathSync.native(native.cwd) !== repo || native.code !== 0) throw new Error('Native evidence belongs to another workspace or failed command');
const state = JSON.parse(fs.readFileSync(path.join(root, 'data/REAL-001.json'), 'utf8'));
if (state.haltedReason || !state.runs.some((r: { stage: string; status: string }) => r.stage === 'compound' && r.status === 'DONE')) throw new Error('Close the actual ticket before auditing roles');
await localAcceptanceProvider(32768);
const model = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).providers['acceptance-local'].models.loaded.modelID;
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-opencode-roles`); fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), fixture: root, source, sourceDigest: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), scope: 'Native role dispatch/completion and persisted child exports from the retained real implementation; current feature code unchanged; no model requests or stage result rewriting', actualConfiguredModel: model, roles: [] };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const trace = acceptanceTrace(output, save); report.processEvidence = { calls: trace.calls, errors: trace.errors };
await withProcessEvidence(trace.capture, async () => { try {
  await assertRuntimeIdentity(state.executionPlan.implement.profile, repo, state.executionPlan.implement.nativeContext);
  const events = native.stdout.trim().split(/\r?\n/).map((line: string) => JSON.parse(line));
  const parents = [...new Set(events.map((e: any) => e.sessionID).filter(Boolean))];
  if (parents.length !== 1) throw new Error('Ambiguous native parent');
  const used = new Set<string>();
  for (const role of ['implementer:1', 'task-review:1', 'final-review']) {
    const calls = events.filter((e: any) => e.type === 'tool_use' && e.part?.tool === 'subagent' && e.part.state?.status === 'completed').map((e: any) => ({ e, args: JSON.parse(e.part.state.metadata.rawInput) }))
      .filter((c: any) => c.args.prompt.startsWith(`[pipeline:${role}]`));
    if (calls.length !== 1) throw new Error(`Missing or ambiguous completed role ${role}`);
    const { e, args } = calls[0], childId = e.part.state.metadata.metadata.sessionID;
    if (typeof childId !== 'string' || childId === parents[0] || used.has(childId) || args.background !== false) throw new Error('Roles are not independent native foreground children');
    used.add(childId);
    const exported = await runProcess(process.env.PIPELINE_OPENCODE_BIN || 'opencode', ['session', 'export', childId, '--standalone'], { cwd: repo, timeoutMs: 15000 });
    if (exported.code !== 0) throw new Error('Native child export failed');
    const child = JSON.parse(exported.stdout), final = child.messages.filter((m: any) => m.type === 'assistant').at(-1), idle = child.messages.at(-1);
    const text = final?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    if (child.info.id !== childId || child.info.parentID !== parents[0] || child.info.agent !== args.agent || child.info.outcome !== 'succeeded' || fs.realpathSync.native(child.info.location.directory) !== repo
      || !['stop', 'end_turn'].includes(final?.finish) || !text || !e.part.state.output.includes(text) || idle.type !== 'idle' || idle.outcome !== 'succeeded' || idle.time.created < final.time.completed
      || `${child.info.model.providerID}/${child.info.model.id}` !== args.model) throw new Error(`Native completion/model/context mismatch for ${role}`);
    if (role !== 'implementer:1' && !text.includes(role === 'final-review' ? 'PIPELINE_FINAL_VERDICT: PASS' : 'PIPELINE_REVIEW_VERDICT: PASS')) throw new Error('Reviewer did not return a real passing verdict');
    (report.roles as unknown[]).push({ role, parentId: parents[0], childId, agent: args.agent, model: args.model, nativeOutcome: child.info.outcome, exportDigest: createHash('sha256').update(exported.stdout).digest('hex') }); save();
  }
  // The parent later reorganized commits; compare the reviewed code, not aliases.
  execFileSync('git', ['diff', '--exit-code', '0e13fea', 'HEAD', '--', 'greeting.js', 'greeting.test.js'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
  report.reviewedFeatureUnchanged = true;
  const helpers = events.filter((e: any) => e.type === 'tool_use' && e.part?.tool === 'shell' && e.part.state?.status === 'completed').map((e: any) => ({ command: JSON.parse(e.part.state.metadata.rawInput).command, exit: e.part.state.metadata.metadata.exit }));
  if (!['task-brief', 'sdd-workspace', 'review-package'].every(name => helpers.some((h: any) => h.exit === 0 && h.command.includes(`/scripts/${name}`)))) throw new Error('Original SDD helper completion evidence missing');
  report.originalSddHelpersExecuted = true; report.status = 'PASS';
} catch (error) { report.status = 'NOT_PASS'; report.error = (error as Error).message; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(`Evidence: ${output}; ${report.status}`); if (report.status !== 'PASS') process.exitCode = 1; }
});
