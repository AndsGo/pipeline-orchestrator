import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initialConfiguration, readConfiguration, selectProfile, writeConfiguration, configurationFile, freezeExecution, assertRequirements, knownCli, type AgentProfile, type Entry } from '../src/engine/configuration.js';
import { validateProfile, recordValidation } from '../src/engine/validation.js';
import { runTicket } from '../src/ticketRunner.js';
import { readSnapshot, loadTicket, saveTicket } from '../src/ticket.js';
import { readEvents } from '../src/events.js';
import type { InteractionPort } from '../src/ports.js';
import { localAcceptanceProvider } from './acceptance-local-provider.js';
import { acceptanceTrace } from './acceptance-trace.js';
import { withProcessEvidence } from '../src/engine/process.js';
import { engineNamed } from '../src/engine/index.js';
import { assertRuntimeIdentity } from '../src/engine/identity.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const productionFile = configurationFile();
const currentDefault = process.argv.includes('--use-current-default') ? readConfiguration() : undefined;
const fingerprint = () => fs.existsSync(productionFile) ? createHash('sha256').update(fs.readFileSync(productionFile)).digest('hex') : 'absent';
const before = fingerprint();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-full-ticket-')));
const cli = currentDefault ? selectProfile(undefined, 'implement', currentDefault).cli : knownCli(process.env.PIPELINE_ACCEPTANCE_ENGINE || 'claude');
const profileId = `acceptance-${cli}`;
const repo = path.join(root, 'repo');
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-real-ticket`);
fs.mkdirSync(repo); fs.mkdirSync(output, { recursive: true });
process.env.PIPELINE_DATA_DIR = path.join(root, 'data');
process.env.PIPELINE_AGENT_CONFIG_FILE = path.join(root, 'agent-config.json');
for (const key of Object.keys(process.env)) if (/^(FEISHU_|BITABLE_|JENKINS_|GITLAB_|WIKI_|PREVIEW_BASE_URL$|PIPELINE_DOUBLE_REVIEW$|PIPELINE_IMPLEMENT_MODEL$)/.test(key)) delete process.env[key];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, ticket: 'REAL-001', scope: 'Actual runTicket and native stage engines; no simulated stages, CI disabled, no remote or release', otherEngineRequirements: {}, notifications: [], gates: [] };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
git('init', '-q'); git('config', 'user.name', 'Pipeline acceptance'); git('config', 'user.email', 'acceptance@localhost'); git('config', 'commit.gpgsign', 'false'); git('checkout', '-b', 'feat/REAL-001-greeting');
fs.mkdirSync(path.join(repo, 'docs/pipeline'), { recursive: true });
fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }));
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'isolated-greeting', private: true, type: 'module', scripts: { test: 'node --test' } }));
fs.writeFileSync(path.join(repo, 'greeting.js'), 'export function greet(name) { return `Hello, ${name}!`; }\n');
fs.writeFileSync(path.join(repo, 'greeting.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greeting.js';\ntest('normal greeting', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n");
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Common rules\nThis repository is an isolated real acceptance fixture. Respect all pipeline skills, independent subagents and model role constraints. No remote operations, uploads or deployment. Do not modify CLI authentication or global settings. Use node:test; no dependency installation. All changes stay here.\n');
fs.writeFileSync(path.join(repo, 'docs/pipeline/PROJECT-KNOWLEDGE.md'), '# Project knowledge\nA tiny ESM greeting library. Public export greet(name). No UI, servers, databases or remote. Node is installed. Existing test command: npm test.\n');
// Reuse an existing installed shared dependency only in this owned fixture.
const installed = path.join(os.homedir(), '.claude/plugins/installed_plugins.json');
if (fs.existsSync(installed)) {
  const plugins = JSON.parse(fs.readFileSync(installed, 'utf8')).plugins;
  const superpowers = plugins['superpowers@claude-plugins-official']?.find((p: { installPath: string }) => fs.existsSync(path.join(p.installPath, 'skills/subagent-driven-development/SKILL.md')))?.installPath;
  if (superpowers) {
    const skills = path.join(repo, '.agents/skills'); fs.mkdirSync(skills, { recursive: true });
    for (const name of ['subagent-driven-development', 'requesting-code-review']) fs.cpSync(path.join(superpowers, 'skills', name), path.join(skills, name), { recursive: true });
    if (fs.existsSync(path.join(superpowers, 'LICENSE'))) fs.copyFileSync(path.join(superpowers, 'LICENSE'), path.join(skills, 'LICENSE'));
    fs.appendFileSync(path.join(repo, 'docs/pipeline/PROJECT-KNOWLEDGE.md'), '\nThe existing upstream superpowers:subagent-driven-development dependency is copied unchanged into .agents/skills/subagent-driven-development/SKILL.md with its templates and license. Read that exact file when native skill naming differs. This is the original dependency, not a substitute workflow.\n');
  }
}
const legacyDiagnostic = process.argv.includes('--legacy-diagnostic');
fs.writeFileSync(path.join(repo, 'docs/pipeline/PIPELINE.md'), `---\ntestEnv: none\nacceptor: dev\nrelease: none\n---\n# Fixture process\n## 全阶段\nThis is a real fixture with one unambiguous requirement; use automatic Node tests. No manual/browser acceptance needed. Native CLI constraint differences are accepted; independent subagents and handoff requirements remain. No remote configured: report missing MR as a concern.\n`);
git('add', '-A'); git('commit', '-qm', 'Initial acceptance fixture');
for (const cli of ['codex', 'opencode'] as const) {
  try { assertRequirements(freezeExecution(repo, 'implement', { ...initialConfiguration().profiles.find(p => p.cli === cli)!, model: cli === 'codex' ? 'gpt-6.1-sol' : 'acceptance-local/loaded' })); (report.otherEngineRequirements as Record<string, unknown>)[cli] = { status: 'PASS' }; }
  catch (e) { (report.otherEngineRequirements as Record<string, unknown>)[cli] = { status: 'BLOCKED_BEFORE_MODEL', error: (e as Error).message }; }
}
const entries: Entry[] = ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound', 'prototype'];
const profile: AgentProfile = { id: profileId, name: `Isolated native ${cli}`, cli, ...(cli === 'claude' ? {} : { model: cli === 'codex' ? process.env.PIPELINE_CODEX_MODEL || 'gpt-6.1-sol' : process.env.PIPELINE_OPENCODE_MODEL || '@cli-default' }), constraintMode: 'native', parameters: { ...(cli === 'claude' ? {} : { maxTurns: 100, budgetUsd: 3 }), timeoutMs: Number(process.env.PIPELINE_ACCEPTANCE_TIMEOUT_MS || 300000), effort: 'low' }, state: 'draft' };
if (cli === 'opencode') Object.assign(profile, await localAcceptanceProvider(Number(process.env.PIPELINE_ACCEPTANCE_OUTPUT_TOKENS || 8192)));
if (cli === 'codex' && process.env.PIPELINE_ACCEPTANCE_WINDOWS_SANDBOX) profile.parameters.windowsSandbox = process.env.PIPELINE_ACCEPTANCE_WINDOWS_SANDBOX as 'unelevated' | 'elevated' | 'mxc';
const config = currentDefault ? { ...structuredClone(currentDefault), revision: 0, projects: {} } : initialConfiguration();
if (currentDefault) {
  if (legacyDiagnostic || cli !== 'codex') throw new Error('Current-default acceptance requires the validated user-requested Codex default');
  for (const entry of entries) if (selectProfile(undefined, entry, config).state !== 'active' || selectProfile(undefined, entry, config).cli !== 'codex') throw new Error(`Current default entry ${entry} is not a validated Codex configuration`);
  report.sourceDefault = { revision: currentDefault.revision, selection: currentDefault.global, profiles: currentDefault.profiles.filter(p => p.state === 'active') };
} else if (!legacyDiagnostic) { config.profiles.push(profile); config.global.entries = Object.fromEntries(entries.map(entry => [entry, profile.id])); }
else { config.global.default = `legacy-${cli}`; if (cli !== 'claude') process.env[`PIPELINE_${cli.toUpperCase()}_MODEL`] = profile.model!; }
const written = writeConfiguration(config, 0);
const port: InteractionPort = {
  async notify(_ticket, message) { (report.notifications as string[]).push(message); save(); console.log(message.slice(0, 200)); },
  async confirmGate(_ticket, gate, summary, concerns, detail) {
    const approved = ['prd-confirm', 'plan-approval'].includes(gate);
    (report.gates as unknown[]).push({ gate, approved, summary, concerns, detail }); save();
    return { approved, note: approved ? 'Isolated fixture approval; requirement already explicit.' : 'Unexpected failure gate: preserve evidence; no automatic retries.' };
  },
  async askQuestions(_ticket, questions) { (report as Record<string, unknown>).unexpectedQuestions = questions; save(); return questions.map(q => ({ id: q.id, question: q.question, answer: q.recommended, note: 'Fixture requirement below is authoritative; do not invent acceptance results.' })); },
  close() {},
};
const trace = acceptanceTrace(output, save); report.processEvidence = { calls: trace.calls, errors: trace.errors };
await withProcessEvidence(trace.capture, async () => { try {
  save();
  if (currentDefault) {
    report.scope = 'Actual six-stage ticket using an exact isolated copy of the validated production global Codex selection and native parameters; no acceptance-specific timeout, effort, model or sandbox overrides.';
    const snapshot = freezeExecution(repo, 'implement');
    await assertRuntimeIdentity(snapshot.profile);
    // Native workspace-write startup registers this newly created fixture's trust.
    // Initialize before runTicket freezes the project context, with the exact profile.
    const initialized = await engineNamed('codex').runJson({ cwd: repo, model: snapshot.model, tools: snapshot.tools, maxTurns: snapshot.maxTurns, budgetUsd: snapshot.budgetUsd, timeoutMs: snapshot.timeoutMs, constraintMode: snapshot.constraintMode, windowsSandbox: snapshot.profile.parameters.windowsSandbox, effort: snapshot.profile.parameters.effort,
      prompt: 'Initialize this isolated native workspace only. Return exactly {"ready":true}; do not use tools or alter any files.', schema: { type: 'object', properties: { ready: { type: 'boolean', const: true } }, required: ['ready'], additionalProperties: false } });
    report.workspaceInitialization = initialized.envelope;
    if (initialized.envelope.is_error || (initialized.envelope.structured_output as unknown as { ready?: boolean })?.ready !== true) throw new Error('Current-default fixture native initialization failed');
    await assertRuntimeIdentity(snapshot.profile);
    report.resolvedEntries = entries.map(entry => freezeExecution(repo, entry));
    report.browserScope = 'No browser requirement; separate native MCP proof is still required for e2e=true.';
  } else if (legacyDiagnostic) {
    report.scope = `Actual runTicket using original unprobed legacy ${cli} profile with frozen explicit model and user-approved native constraints; fixture-only tighter timeout limits. No draft activated and no failed validation overridden.`;
    const state = loadTicket(repo, 'REAL-001', 'clarify');
    for (const snapshot of Object.values(state.executionPlan!)) {
      snapshot.budgetUsd = Math.min(snapshot.budgetUsd, 3);
      snapshot.maxTurns = Math.min(snapshot.maxTurns, 60);
      snapshot.timeoutMs = Number(process.env.PIPELINE_ACCEPTANCE_TIMEOUT_MS || 300000);
      assertRequirements(snapshot);
    }
    saveTicket(state);
  } else {
  console.log(`${cli}: real preflight for all six stages and prototype`);
  const validation = await validateProfile(profile, entries, { browser: false }); report.validation = validation; report.browserScope = 'Fixture has no browser requirement; e2e=true remains blocked without separate MCP proof.'; save();
  if (!validation.ok) throw new Error(`真实阶段能力验证失败：${validation.errors.join('; ')}`);
  recordValidation(profile, written.revision, entries, validation);
  }
  console.log(`${cli}: actual isolated full ticket`);
  await runTicket({ repo, ticket: 'REAL-001', lane: 'full', port,
    requirement: 'Enhance greet(name) in this tiny ESM Node library: trim surrounding whitespace from a string name before greeting. Preserve the existing exact output for normal names. Example greet("  Ada  ") returns "Hello, Ada!". Inputs are strings only; empty or whitespace-only string returns "Hello, !". Add automatic node:test coverage for normal, padded, empty and whitespace-only names. npm test must pass. No other behavior, UI, external service or new dependency. One small implementation task is sufficient; retain the native independent implementation/review/final-review agents and explicit role models required by pipeline-implement.' });
  const state = readSnapshot('REAL-001'), events = readEvents('REAL-001');
  report.state = state; report.events = events;
  try {
    report.testOutput = execFileSync('npm.cmd', ['test'], { cwd: repo, encoding: 'utf8', windowsHide: true, shell: true });
    execFileSync(process.execPath, ['--input-type=module', '-e', 'import assert from "node:assert/strict"; import { greet } from "./greeting.js"; for (const [name,expected] of [["Ada","Hello, Ada!"],["  Ada  ","Hello, Ada!"],["","Hello, !"],["   ","Hello, !"]]) assert.equal(greet(name),expected);'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    report.testsPassed = true;
  }
  catch (e) { report.testsPassed = false; report.testError = (e as Error).message.slice(0, 1000); }
  report.gitLog = git('log', '--oneline', '-8'); report.gitStatus = git('status', '--porcelain');
  const expected = ['clarify', 'plan', 'implement', 'review', 'acceptance', 'compound'];
  report.ticketFlowStatus = events.some(e => e.type === 'done') && !state?.haltedReason && expected.every(stage => state?.runs.some(r => r.stage === stage && ['DONE', 'DONE_WITH_CONCERNS'].includes(r.status))) && report.testsPassed ? 'PASS' : 'NOT_PASS';
  // A completed flow alone does not establish role model or whole-tree limits.
  report.status = 'NOT_PASS';
  report.remaining = ['Native role model evidence and child constraints must pass separately before overall acceptance.'];
} catch (e) { report.status = 'NOT_PASS'; report.error = (e as Error).message; }
finally { report.finishedAt = new Date().toISOString(); report.productionConfigurationChanged = fingerprint() !== before; save(); console.log(`Evidence: ${output}; ${report.status}`); }
});
