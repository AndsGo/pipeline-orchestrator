import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configurationFile, initialConfiguration, writeConfiguration, readConfiguration, type AgentProfile, type Entry } from '../src/engine/configuration.js';
import { validationPlan, validateProfile, recordValidation } from '../src/engine/validation.js';
import { localAcceptanceProvider } from './acceptance-local-provider.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
const production = configurationFile();
const fingerprint = () => fs.existsSync(production) ? createHash('sha256').update(fs.readFileSync(production)).digest('hex') : 'absent';
const before = fingerprint();
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-native-engines`);
fs.mkdirSync(output, { recursive: true });
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-native-engines-')));
process.env.PIPELINE_AGENT_CONFIG_FILE = path.join(root, 'agent-config.json');
const engines = (process.env.PIPELINE_ACCEPTANCE_ENGINES || 'codex,opencode').split(',');
const entries = (process.env.PIPELINE_ACCEPTANCE_ENTRIES || 'run,implement').split(',') as Entry[];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, scope: 'User-approved native constraints; real draft validation and isolated activation; no production changes', engines: {} };
const profiles: AgentProfile[] = [];
if (engines.includes('codex')) profiles.push({ id: 'native-codex', name: 'Native Codex', cli: 'codex', model: process.env.PIPELINE_CODEX_MODEL || 'gpt-6.1-sol', constraintMode: 'native', state: 'draft', parameters: { maxTurns: 40, budgetUsd: 3, timeoutMs: 180000, effort: 'low', ...(process.env.PIPELINE_ACCEPTANCE_WINDOWS_SANDBOX ? { windowsSandbox: process.env.PIPELINE_ACCEPTANCE_WINDOWS_SANDBOX as 'unelevated' | 'elevated' | 'mxc' } : {}) } });
if (engines.includes('opencode')) {
  profiles.push({ id: 'native-opencode', name: 'Native OpenCode', cli: 'opencode', ...await localAcceptanceProvider(Number(process.env.PIPELINE_ACCEPTANCE_OUTPUT_TOKENS || 32768)), constraintMode: 'native', state: 'draft', parameters: { maxTurns: 40, budgetUsd: 3, timeoutMs: 180000 } });
}
const configuration = initialConfiguration(); configuration.profiles.push(...profiles); writeConfiguration(configuration, 0);
try {
  for (const profile of profiles) {
    console.log(`${profile.cli}: ${entries.join(',')} native probes`);
    const plan = validationPlan(profile, entries);
    const result = await validateProfile(profile, entries);
    recordValidation(profile, readConfiguration().revision, entries, result);
    (report.engines as Record<string, unknown>)[profile.cli] = { plan, validation: result, isolatedProfileState: readConfiguration().profiles.find(p => p.id === profile.id)?.state };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`${profile.cli}: ${result.ok ? 'PASS' : 'FAIL'}; ${result.errors.join('; ')}`);
  }
} finally {
  report.finishedAt = new Date().toISOString(); report.productionConfigurationChanged = fingerprint() !== before;
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(`Evidence: ${output}`);
}
