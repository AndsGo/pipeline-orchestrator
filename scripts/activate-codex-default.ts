import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configurationFile, ENTRIES, freezeExecution, initialConfiguration, profileFingerprint, readConfiguration, writeConfiguration, type AgentProfile, type WindowsSandbox } from '../src/engine/configuration.js';
import { recordValidation, validateProfile, validationPlan } from '../src/engine/validation.js';
import { withProcessEvidence } from '../src/engine/process.js';
import { acceptanceTrace } from './acceptance-trace.js';
import { writeEnvChanges } from '../src/console/api.js';

if (!process.argv.includes('--allow-model-calls') || !process.argv.includes('--apply')) throw new Error('Requires --allow-model-calls --apply for the user-requested default change');
const sandboxArg = process.argv.indexOf('--windows-sandbox');
const requestedSandbox = sandboxArg >= 0 ? process.argv[sandboxArg + 1] : 'unelevated';
if (!['elevated', 'unelevated', 'mxc'].includes(requestedSandbox)) throw new Error('Specify elevated, unelevated or mxc explicitly; no automatic fallback');
const windowsSandbox = requestedSandbox as WindowsSandbox;
const production = configurationFile(), original = readConfiguration();
const nativeHomeArg = process.argv.indexOf('--native-home');
const nativeHome = nativeHomeArg >= 0 ? fs.realpathSync.native(process.argv[nativeHomeArg + 1]) : undefined;
const envFile = path.resolve('.env'), envMtime = nativeHome ? fs.statSync(envFile).mtimeMs : undefined;
if (nativeHome) process.env.PIPELINE_CODEX_HOME = nativeHome;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-codex-default-')));
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-codex-default`); fs.mkdirSync(output, { recursive: true });
// A different mode gets a new named profile; preserve the old profile and tickets.
const profile: AgentProfile = { id: windowsSandbox === 'unelevated' ? 'codex-default' : `codex-default-${windowsSandbox}`, name: windowsSandbox === 'unelevated' ? 'Codex default' : `Codex default (${windowsSandbox})`, cli: 'codex', model: 'gpt-6.1-sol', constraintMode: 'native', parameters: { windowsSandbox }, state: 'draft' };
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: 'User-requested global Codex default; real all-entry validation before active profile selection; no daemon restart or native authentication change', configuration: production, priorRevision: original.revision, isolatedDirectory: root, browserScope: 'No browser proof: Playwright projects remain blocked until separate successful native MCP validation', plan: validationPlan(profile, [...ENTRIES], { browser: false }) };
report.nativeHome = nativeHome; report.priorValidation = original.profiles.find(p => p.id === profile.id)?.validation;
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const trace = acceptanceTrace(output, save); report.processEvidence = { calls: trace.calls, errors: trace.errors };
await withProcessEvidence(trace.capture, async () => {
  try {
    process.env.PIPELINE_AGENT_CONFIG_FILE = path.join(root, 'agent-config.json');
    const isolated = initialConfiguration(); isolated.profiles.push(profile); const written = writeConfiguration(isolated, 0);
    save(); console.log(`Codex: real validation for ${ENTRIES.length} entries`);
    const validation = await validateProfile(profile, [...ENTRIES], { browser: false }); report.validation = validation; save();
    if (!validation.ok) throw new Error(`Codex validation failed: ${validation.errors.join('; ')}`);
    recordValidation(profile, written.revision, [...ENTRIES], validation);
    const active = readConfiguration().profiles.find(p => p.id === profile.id)!;
    process.env.PIPELINE_AGENT_CONFIG_FILE = production;
    const current = readConfiguration();
    if (current.revision !== original.revision) throw new Error('Global configuration changed during validation; do not overwrite a newer choice');
    const existing = current.profiles.findIndex(p => p.id === profile.id);
    if (existing >= 0 && profileFingerprint(current.profiles[existing]) !== profileFingerprint(profile)) throw new Error('Existing codex-default content differs: preserve the newer user configuration');
    if (nativeHome) {
      const envWrite = writeEnvChanges(envFile, envMtime!, { PIPELINE_CODEX_HOME: nativeHome });
      if (!envWrite.ok) throw new Error(envWrite.error);
      report.nativeHomeConfigured = true;
    }
    if (existing >= 0) current.profiles[existing] = active; else current.profiles.push(active);
    current.global.default = active.id;
    const applied = writeConfiguration(current, original.revision);
    report.appliedRevision = applied.revision; report.default = applied.global.default;
    report.resolvedEntries = ENTRIES.map(entry => { const s = freezeExecution(undefined, entry); return { entry, cli: s.profile.cli, model: s.model, profile: s.profile.id }; });
    report.status = 'PASS';
  } catch (error) { report.status = 'NOT_PASS'; report.error = (error as Error).message; }
  finally { report.finishedAt = new Date().toISOString(); save(); console.log(`Evidence: ${output}; ${report.status}`); if (report.status !== 'PASS') process.exitCode = 1; }
});
