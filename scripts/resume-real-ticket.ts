import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { localAcceptanceProvider } from './acceptance-local-provider.js';
import { readSnapshot, saveTicket } from '../src/ticket.js';
import { runTicket } from '../src/ticketRunner.js';
import { readEvents } from '../src/events.js';
import type { InteractionPort } from '../src/ports.js';
import { readConfiguration, freezeExecution, freezePlan, initialConfiguration, writeConfiguration, type Entry, type WindowsSandbox } from '../src/engine/configuration.js';
import { recordValidation, validateProfile } from '../src/engine/validation.js';
import { queueExecutionSwitch } from '../src/engine/tickets.js';
import { acceptanceTrace } from './acceptance-trace.js';
import { withProcessEvidence } from '../src/engine/process.js';
if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const sandboxArg = process.argv.indexOf('--windows-sandbox');
const requestedSandbox = sandboxArg >= 0 ? process.argv[sandboxArg + 1] : undefined;
if (sandboxArg >= 0 && (!process.argv.includes('--refresh-profile') || typeof requestedSandbox !== 'string' || !['elevated', 'unelevated', 'mxc'].includes(requestedSandbox))) throw new Error('Sandbox changes require --refresh-profile and an explicit elevated, unelevated or mxc mode');
const input = process.env.PIPELINE_ACCEPTANCE_RESUME_DIR;
if (!input) throw new Error('需要指定本次创建的临时工单目录');
const root = fs.realpathSync.native(input);
const relative = path.relative(fs.realpathSync.native(os.tmpdir()), root);
if (!/^pipeline-full-ticket-[^/\\]+$/.test(relative)) throw new Error('仅能继续本验收创建的临时工单');
const repo = fs.realpathSync.native(path.join(root, 'repo'));
if (path.relative(root, repo) !== 'repo') throw new Error('工作目录超出验收目录');
process.env.PIPELINE_DATA_DIR = path.join(root, 'data'); process.env.PIPELINE_AGENT_CONFIG_FILE = path.join(root, 'agent-config.json');
for (const key of Object.keys(process.env)) if (/^(FEISHU_|BITABLE_|JENKINS_|GITLAB_|WIKI_|PREVIEW_BASE_URL$|PIPELINE_DOUBLE_REVIEW$|PIPELINE_IMPLEMENT_MODEL$)/.test(key)) delete process.env[key];
const state = readSnapshot('REAL-001');
if (!state || fs.realpathSync.native(state.repo) !== repo) throw new Error('没有对应真实工单快照');
if (state.executionPlan?.plan.profile.cli === 'opencode') await localAcceptanceProvider(Number(process.env.PIPELINE_ACCEPTANCE_OUTPUT_TOKENS || 8192));
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-real-ticket-resume`); fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, resumedFrom: state.cursor, scope: 'Actual frozen ticket continuation; no model/CLI/constraint changes', messages: [] };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const port: InteractionPort = {
  async notify(_ticket, message) { (report.messages as string[]).push(message); save(); console.log(message.slice(0, 200)); },
  async confirmGate(_ticket, gate) { return { approved: ['prd-confirm', 'plan-approval'].includes(gate), note: 'Isolated explicit fixture approval only.' }; },
  async askQuestions(_ticket, questions) { return questions.map(q => ({ id: q.id, question: q.question, answer: q.recommended, note: 'Fixture requirement is authoritative; do not invent test results.' })); }, close() {},
};
const trace = acceptanceTrace(output, save); report.processEvidence = { calls: trace.calls, errors: trace.errors };
await withProcessEvidence(trace.capture, async () => { try {
const refresh = process.argv.includes('--refresh-profile');
if (refresh) {
  const profile = structuredClone(state.executionPlan!.plan.profile);
  delete profile.credentialRef; delete profile.validation; profile.state = 'draft';
  if (requestedSandbox) {
    if (profile.cli !== 'codex') throw new Error('Windows sandbox selection only applies to Codex');
    report.sandboxChange = { from: profile.parameters.windowsSandbox ?? 'native', to: requestedSandbox };
    profile.parameters.windowsSandbox = requestedSandbox as WindowsSandbox;
  }
  if (process.env.PIPELINE_ACCEPTANCE_TIMEOUT_MS) profile.parameters.timeoutMs = Number(process.env.PIPELINE_ACCEPTANCE_TIMEOUT_MS);
  const entries: Entry[] = ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound', 'prototype'];
  const configuration = initialConfiguration(); configuration.profiles.push(profile); configuration.global.entries = Object.fromEntries(entries.map(entry => [entry, profile.id]));
  process.env.PIPELINE_AGENT_CONFIG_FILE = path.join(root, `agent-config-refresh-${Date.now()}.json`);
  writeConfiguration(configuration, 0);
  report.refreshProfile = 'Explicit current-version profile: native authentication, current provider request output cap; original saved config and execution history retained';
}
if (refresh || process.argv.includes('--revalidate-native-context')) {
  const config = readConfiguration();
  const profile = config.profiles.find(p => p.id === state.executionPlan!.plan.profile.id);
  if (!profile) throw new Error('Missing original fixture profile');
  const entries = refresh ? ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound', 'prototype'] as Entry[] : [...profile.validation!.entries];
  console.log('Revalidating changed isolated native context before explicit boundary switch');
  const validation = await validateProfile(profile, entries, { browser: false });
  report.validation = validation; save();
  if (!validation.ok) throw new Error(`Native revalidation failed: ${validation.errors.join('; ')}`);
  recordValidation(profile, config.revision, entries, validation);
  const updated = readConfiguration();
  const validatedProfile = updated.profiles.find(p => p.id === profile.id)!;
  const plan = refresh ? freezePlan(repo, updated) : structuredClone(state.executionPlan!);
  if (!refresh) for (const entry of ['plan', 'implement', 'review', 'acceptance', 'compound'] as const) plan[entry] = freezeExecution(repo, entry, validatedProfile);
  queueExecutionSwitch(state, plan, 'isolated-real-acceptance', `Current-version validated native profile and explicit request max_tokens/stage timeout${requestedSandbox ? `; explicit Windows sandbox ${requestedSandbox}` : ''}; unchanged CLI and role permissions`);
  report.scope = 'Actual saved ticket continuation after revalidated explicit stage-boundary switch; current supported native authentication/provider configuration; original run and snapshot history retained';
}
saveTicket({ ...state, haltedReason: undefined });
await runTicket({ repo, ticket: 'REAL-001', port, lane: 'full' });
} catch (error) { report.error = (error as Error).message; }
finally {
  const final = readSnapshot('REAL-001'), events = readEvents('REAL-001');
  report.state = final; report.events = events;
  try {
    report.testOutput = execFileSync(process.execPath, ['--test'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    execFileSync(process.execPath, ['--input-type=module', '-e', 'import assert from "node:assert/strict"; import { greet } from "./greeting.js"; for (const [name,expected] of [["Ada","Hello, Ada!"],["  Ada  ","Hello, Ada!"],["","Hello, !"],["   ","Hello, !"]]) assert.equal(greet(name),expected);'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    report.testsPassed = true;
  } catch (error) { report.testsPassed = false; report.testError = (error as Error).message.slice(0, 1000); }
  report.ticketFlowStatus = !report.error && !final?.haltedReason && report.testsPassed && events.some(e => e.type === 'done') && ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound'].every(stage => final?.runs.some(r => r.stage === stage && ['DONE', 'DONE_WITH_CONCERNS'].includes(r.status))) ? 'PASS' : 'NOT_PASS';
  report.status = 'NOT_PASS'; // Overall three-engine and Astra acceptance remains separate.
  report.finishedAt = new Date().toISOString(); save(); console.log(`Evidence: ${output}; ticket ${report.ticketFlowStatus}`);
  if (report.ticketFlowStatus !== 'PASS') process.exitCode = 1;
}
});
