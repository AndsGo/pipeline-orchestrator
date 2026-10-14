import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { codexCommand, codexEnvironment } from '../src/engine/codex.js';
import { runProcess, withProcessEvidence } from '../src/engine/process.js';
import { acceptanceTrace } from './acceptance-trace.js';

const input = process.env.PIPELINE_ACCEPTANCE_RESUME_DIR;
if (!input) throw new Error('Specify the owned acceptance fixture');
const root = fs.realpathSync.native(input);
if (!/^pipeline-full-ticket-[^/\\]+$/.test(path.relative(fs.realpathSync.native(os.tmpdir()), root))) throw new Error('Only an owned fixture is allowed');
const repo = fs.realpathSync.native(path.join(root, 'repo'));
// Keep diagnostic commits and generated helper artifacts out of the real ticket.
// A fresh two-commit canary range exercises review-package's original guards.
const diagnostic = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'sandbox-diagnostic-')));
const copied = ['.agents', 'docs/pipeline/REAL-001/20-plan.md', 'package.json', 'greeting.js', 'greeting.test.js'];
const inputDigests: Record<string, string> = {};
for (const relative of copied) {
  const source = path.join(repo, relative), target = path.join(diagnostic, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  if (fs.statSync(source).isFile()) inputDigests[relative] = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: diagnostic, encoding: 'utf8', windowsHide: true });
git('init', '-q');
git('add', '.');
git('-c', 'user.name=Pipeline diagnostic', '-c', 'user.email=diagnostic@localhost', 'commit', '-qm', 'Copy original acceptance toolchain');
const base = git('rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(diagnostic, 'diagnostic-range.txt'), 'Native sandbox diagnostic only; no ticket implementation.\n');
git('add', 'diagnostic-range.txt');
git('-c', 'user.name=Pipeline diagnostic', '-c', 'user.email=diagnostic@localhost', 'commit', '-qm', 'Add diagnostic range canary');
const head = git('rev-parse', 'HEAD').trim();
const mode = process.env.PIPELINE_ACCEPTANCE_WINDOWS_SANDBOX || 'mxc';
if (!['mxc', 'elevated', 'unelevated'].includes(mode)) throw new Error('Unknown native sandbox mode');
const headlessRuntime = process.argv.includes('--headless-runtime');
const overrides = headlessRuntime ? ['-c', 'notify=[]', '-c', 'mcp_servers.node_repl.enabled=false'] : [];
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-codex-sandbox`); fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: 'Actual native Codex sandbox commands in an isolated diagnostic repository; native refresh can update sandbox ACLs; original SDD helpers/test files, canary-only commit range; no model requests, ticket writes or saved native configuration changes; not functional ticket acceptance', mode, headlessRuntime, overrides, fixture: root, diagnosticRepository: diagnostic, reviewRange: { base, head }, inputDigests, checks: [] };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const trace = acceptanceTrace(output, save); report.processEvidence = { calls: trace.calls, errors: trace.errors };
const command = codexCommand();
const invoke = (profile: string, args: string[]) => runProcess(command.cmd, [...command.prefix, ...overrides, '-c', `windows.sandbox=${JSON.stringify(mode)}`, 'sandbox', '--include-managed-config', '--permission-profile', profile, '--', ...args], { cwd: diagnostic, env: codexEnvironment(), timeoutMs: 60000 });
await withProcessEvidence(trace.capture, async () => { try {
  const hello = await invoke(':workspace', ['cmd.exe', '/d', '/c', 'echo MXC_OK']);
  if (hello.code !== 0 || !hello.stdout.includes('MXC_OK')) throw new Error(`Native startup failed: ${hello.stderr.slice(-300)}`);
  (report.checks as string[]).push('Native command startup');
  const tools = await invoke(':workspace', ['powershell.exe', '-NoProfile', '-Command', "$ErrorActionPreference='Stop'; bash --version; if ($LASTEXITCODE) { exit $LASTEXITCODE }; $plan='docs/pipeline/REAL-001/20-plan.md'; $base='.agents/skills/subagent-driven-development/scripts/'; bash ($base+'sdd-workspace') $plan; if ($LASTEXITCODE) { exit $LASTEXITCODE }; bash ($base+'task-brief') $plan 1; if ($LASTEXITCODE) { exit $LASTEXITCODE }; $head=git rev-parse HEAD; $parent=git rev-parse 'HEAD^'; bash ($base+'review-package') $plan $parent $head; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm.cmd test; exit $LASTEXITCODE"]);
  report.tools = { code: tools.code, stdout: tools.stdout, stderr: tools.stderr };
  if (tools.code !== 0) throw new Error('Bash / original SDD scripts / unmodified npm test failed');
  (report.checks as string[]).push('Bash and all three original SDD scripts; original npm test with child isolation');
  const canary = path.join(diagnostic, 'sandbox-canary.txt');
  fs.writeFileSync(canary, 'original');
  const denied = await invoke(':read-only', ['node.exe', '-e', 'require("node:fs").writeFileSync("sandbox-canary.txt","changed")']);
  report.readOnly = { code: denied.code, unchanged: fs.readFileSync(canary, 'utf8') === 'original' };
  if (denied.code === 0 || fs.readFileSync(canary, 'utf8') !== 'original') throw new Error('Native read-only write boundary was not enforced');
  const writable = await invoke(':workspace', ['node.exe', '-e', 'require("node:fs").writeFileSync("sandbox-canary.txt","changed")']);
  if (writable.code !== 0 || fs.readFileSync(canary, 'utf8') !== 'changed') throw new Error('Native workspace write failed');
  fs.unlinkSync(canary);
  (report.checks as string[]).push('Actual read-only denial and workspace write');
  report.status = 'PASS';
} catch (error) { report.status = 'NOT_PASS'; report.error = (error as Error).message; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(`Evidence: ${output}; ${report.status}`); if (report.status !== 'PASS') process.exitCode = 1; }
});
