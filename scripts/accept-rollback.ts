import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const fixture = process.env.PIPELINE_ACCEPTANCE_RESUME_DIR;
if (!fixture) throw new Error('Specify the completed owned fixture using PIPELINE_ACCEPTANCE_RESUME_DIR');
const root = fs.realpathSync.native(fixture);
if (!/^pipeline-full-ticket-[^/\\]+$/.test(path.relative(fs.realpathSync.native(os.tmpdir()), root))) throw new Error('Only an owned full-ticket fixture may be tested');
const file = path.join(root, 'data/REAL-001.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const closed = !state.haltedReason && !state.pendingGate && !state.pendingRewind && state.runs.some((run: { stage: string; status: string }) => run.stage === 'compound' && run.status === 'DONE');
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-rollback`); fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { scope: 'Isolated code-version switch and completed-ticket data preservation; no daemon restart, model calls, live ticket execution or credential changes', fixture: root, closed, safeDuringInflight: false };
if (!closed) { report.status = 'BLOCKED'; report.reason = 'Drain and complete the real ticket before rolling back a version that lacks frozen execution plans.'; }
else {
  const staging = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-version-rollback-')));
  const repository = path.resolve('.'), plugin = path.resolve('../pipeline-plugin');
  const sources = [{ name: 'pipeline-orchestrator', cwd: repository }, { name: 'pipeline-plugin', cwd: plugin }];
  const checkpoints: object[] = [];
  for (const source of sources) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source.cwd, encoding: 'utf8' }).trim();
    const baseline = path.join(staging, 'baseline', source.name), candidate = path.join(staging, 'candidate', source.name);
    fs.mkdirSync(baseline, { recursive: true }); fs.mkdirSync(candidate, { recursive: true });
    const archive = path.join(staging, `${source.name}.tar`);
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: source.cwd, windowsHide: true });
    execFileSync('tar', ['-xf', archive, '-C', baseline], { windowsHide: true });
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source.cwd, encoding: 'utf8' }).split('\0');
    const added = source.name === 'pipeline-orchestrator' ? execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'web', 'vitest.config.ts'], { cwd: source.cwd, encoding: 'utf8' }).split('\0') : [];
    const digest = createHash('sha256');
    for (const relative of [...new Set([...tracked, ...added])].filter(Boolean).sort()) {
      const input = path.join(source.cwd, relative), target = path.resolve(candidate, relative);
      if (path.relative(candidate, target).startsWith('..') || !fs.existsSync(input) || !fs.statSync(input).isFile()) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(input, target); digest.update(relative).update(fs.readFileSync(input));
    }
    checkpoints.push({ repository: source.name, baselineCommit: sha, candidateContentDigest: digest.digest('hex') });
  }
  report.checkpoints = checkpoints;
  const data = path.join(staging, 'data'); fs.mkdirSync(data);
  const copy = path.join(data, 'REAL-001.json'); fs.copyFileSync(file, copy);
  const fingerprint = (input: string) => createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  const before = fingerprint(copy), original = fingerprint(file);
  const probe = path.join(staging, 'read-ticket.mjs');
  fs.writeFileSync(probe, 'import path from "node:path"; import { pathToFileURL } from "node:url"; const mod = await import(pathToFileURL(path.join(process.env.PIPELINE_VERSION_ROOT,"src/ticket.ts")).href); const state = mod.readSnapshot("REAL-001"); if (!state || state.ticket !== "REAL-001") throw new Error("snapshot missing"); process.stdout.write(JSON.stringify({ticket:state.ticket,cursor:state.cursor,runs:state.runs.length,executionPlan:state.executionPlan}));');
  const reads: object[] = [];
  for (const version of ['candidate', 'baseline', 'candidate']) {
    const cwd = path.join(staging, version, 'pipeline-orchestrator');
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) fs.symlinkSync(path.join(repository, 'node_modules'), path.join(cwd, 'node_modules'), 'junction');
    const result = execFileSync(process.execPath, ['--import', 'tsx', probe], { cwd, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PIPELINE_VERSION_ROOT: cwd, PIPELINE_DATA_DIR: data, PIPELINE_AGENT_CONFIG_FILE: path.join(staging, 'isolated-agent-config.json'), PIPELINE_PLUGIN_DIR: path.join(staging, version, 'pipeline-plugin') } });
    const parsed = JSON.parse(result);
    reads.push({ version, ticket: parsed.ticket, runs: parsed.runs, executionPlanPreserved: JSON.stringify(parsed.executionPlan) === JSON.stringify(state.executionPlan) });
  }
  report.reads = reads; report.originalDataUnchanged = fingerprint(file) === original; report.rollbackCopyUnchanged = fingerprint(copy) === before;
  report.status = report.originalDataUnchanged && report.rollbackCopyUnchanged && reads.every(read => (read as { executionPlanPreserved: boolean }).executionPlanPreserved) ? 'PASS' : 'NOT_PASS';
  report.staging = staging;
  report.limitations = ['Baseline version does not support named execution plans; rollback must drain all writers and pending tickets, preserve data/native sessions, and suspend new OpenCode entries. This test proves version loading and closed-state preservation, not old-version execution of new profiles.'];
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(`Evidence: ${output}; ${report.status}`);
if (report.status !== 'PASS') process.exitCode = 1;
