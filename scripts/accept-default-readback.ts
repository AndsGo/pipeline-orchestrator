import fs from 'node:fs';
import path from 'node:path';
import { withProcessEvidence, runProcess } from '../src/engine/process.js';
import { acceptanceTrace } from './acceptance-trace.js';

// Match start-daemon.ps1's UTF-8 .env loading in this separate process.
// Do not import configuration/identity until those startup values are loaded.
const envFile = path.resolve('.env');
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  if (!/^\s*[^#].*=/.test(line)) continue;
  const index = line.indexOf('=');
  process.env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
}
const { ENTRIES, freezeExecution, readConfiguration, assertExecutable } = await import('../src/engine/configuration.js');
const { assertRuntimeIdentity } = await import('../src/engine/identity.js');
const { codexEnvironment } = await import('../src/engine/codex.js');
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-default-readback`);
fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope: 'New source in a separate process, exact watchdog .env loading, all global entry resolution and validated native identity; CLI version only, no model requests or service restart; not live activation or full ticket acceptance',
  envFile,
};
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const trace = acceptanceTrace(output, save);
report.processEvidence = { calls: trace.calls, errors: trace.errors };
await withProcessEvidence(trace.capture, async () => {
  try {
    const config = readConfiguration();
    const profile = config.profiles.find(p => p.id === config.global.default);
    if (!profile || profile.cli !== 'codex' || profile.state !== 'active') throw new Error('Saved global default is not validated Codex');
    await assertRuntimeIdentity(profile);
    const entries = ENTRIES.map(entry => {
      const snapshot = freezeExecution(undefined, entry);
      assertExecutable(snapshot);
      if (snapshot.profile.id !== profile.id || snapshot.profile.cli !== 'codex') throw new Error(`Global entry ${entry} selects another profile`);
      return { entry, profile: snapshot.profile.id, cli: snapshot.profile.cli, model: snapshot.model };
    });
    report.configuration = { revision: config.revision, default: config.global.default, entries };
    report.nativeHome = codexEnvironment().CODEX_HOME;
    const runtimeFile = path.resolve(process.env.PIPELINE_DATA_DIR || 'data', 'runtime.json');
    if (fs.existsSync(runtimeFile)) {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      report.observedRuntime = { file: runtimeFile, pid: runtime.pid, startedAt: runtime.startedAt, at: runtime.at, agentExecution: runtime.agentExecution ?? null };
      report.liveActivationStatus = runtime.agentExecution?.revision === config.revision ? 'CONFIGURATION_OBSERVED_ONLY' : 'NOT_VERIFIED';
    } else report.liveActivationStatus = 'NOT_VERIFIED';
    if (process.platform === 'win32') {
      const task = await runProcess('powershell.exe', ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName PipelineDaemonWatchdog | Select-Object TaskName,State,@{Name='Enabled';Expression={$_.Settings.Enabled}},@{Name='Repeat';Expression={$_.Triggers.Repetition.Interval}} | ConvertTo-Json -Compress"], { cwd: process.cwd(), timeoutMs: 15000 });
      if (task.code !== 0) throw new Error('Watchdog readback failed');
      report.watchdog = JSON.parse(task.stdout);
    }
    report.status = 'PASS';
  } catch (error) { report.status = 'NOT_PASS'; report.error = (error as Error).message; }
  finally {
    report.finishedAt = new Date().toISOString(); save();
    console.log(`Evidence: ${output}; ${report.status}; live activation: ${report.liveActivationStatus || 'NOT_VERIFIED'}`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }
});
