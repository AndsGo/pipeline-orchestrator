import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { engineNamed } from '../src/engine/index.js';
import { capabilities, freezeExecution, initialConfiguration, assertRequirements, configurationFile, knownCli } from '../src/engine/configuration.js';
import { cliVersion } from '../src/engine/identity.js';
import { sharedPrompt } from '../src/engine/prompt.js';
import { validateProfile } from '../src/engine/validation.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('真实验收会调用模型；请显式指定 --allow-model-calls');
const output = path.resolve(process.env.PIPELINE_ACCEPTANCE_DIR || `docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-real-acceptance-'));
const nonce = randomUUID(), rule = randomUUID(), knowledge = randomUUID();
fs.mkdirSync(path.join(root, 'docs/pipeline'), { recursive: true });
fs.writeFileSync(path.join(root, 'AGENTS.md'), `Acceptance fixture. Generic rule marker: ${rule}. Do not modify files.\n`);
fs.writeFileSync(path.join(root, 'docs/pipeline/PROJECT-KNOWLEDGE.md'), `Project knowledge marker: ${knowledge}.\n`);
const schema = { type: 'object', additionalProperties: false, required: ['nonce', 'rule', 'knowledge'], properties: { nonce: { type: 'string', const: nonce }, rule: { type: 'string', const: rule }, knowledge: { type: 'string', const: knowledge } } };
const fingerprint = () => fs.existsSync(configurationFile()) ? createHash('sha256').update(fs.readFileSync(configurationFile())).digest('hex') : 'absent';
const configurationBefore = fingerprint();
const results: Record<string, unknown> = { startedAt: new Date().toISOString(), isolatedDirectory: root, engines: {}, productionConfigurationChanged: null };
function save() { fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); }
try {
  const selected = [...new Set((process.env.PIPELINE_ACCEPTANCE_ENGINES?.split(',') || ['claude', 'codex', 'opencode']).map(knownCli))];
  for (const cli of selected) {
    const entry: Record<string, unknown> = { capabilities: capabilities(cli), model: cli === 'claude' ? process.env.PIPELINE_ACCEPTANCE_CLAUDE_MODEL || 'haiku' : cli === 'codex' ? process.env.PIPELINE_CODEX_MODEL || 'gpt-6.1-sol' : process.env.PIPELINE_OPENCODE_MODEL || '@cli-default' };
    (results.engines as Record<string, unknown>)[cli] = entry;
    if (cli === 'claude' && process.env.PIPELINE_ACCEPTANCE_CLAUDE_SOURCE === 'native-auth') {
      entry.settingSources = '';
      entry.providerContext = 'isolated native authentication; user/project/local settings disabled for this diagnostic only';
    }
    console.log(`${cli}: checking real CLI`);
    try { entry.version = await cliVersion(cli); } catch (e) { entry.error = (e as Error).message; save(); continue; }
    const legacy = initialConfiguration().profiles.find(p => p.cli === cli)!;
    try { assertRequirements(freezeExecution(root, 'run', { ...legacy, model: entry.model as string })); entry.requiredConstraints = 'supported'; }
    catch (e) { entry.requiredConstraints = 'BLOCKED'; entry.constraintError = (e as Error).message; }
    save();
    try {
      const engine = engineNamed(cli);
      // Diagnostic native calls measure basic interoperability; they never activate a profile
      // or relax the production wrapper's mandatory capability checks.
      const opts = { cwd: root, model: entry.model as string, tools: 'Read,Grep,Glob', maxTurns: cli === 'codex' ? 0 : 4, budgetUsd: cli === 'claude' ? 0.3 : 0, timeoutMs: 90000, ...(entry.settingSources === '' ? { settingSources: '' } : {}) };
      if (process.env.PIPELINE_ACCEPTANCE_TEXT_ONLY === '1') {
        entry.diagnosticKind = 'text-only: no schema or tool-capability acceptance';
        const first = await engine.runText({ ...opts, tools: '', prompt: `Remember ${nonce}. Reply only with this exact value.` });
        entry.text = { isError: first.isError, sessionId: first.sessionId, matches: first.text.includes(nonce), costUsd: cli === 'claude' ? first.costUsd : null };
        if (first.isError || !first.sessionId || !first.text.includes(nonce)) throw new Error(first.text || 'Text result mismatch');
        const resumed = await engine.runText({ ...opts, tools: '', resumeSessionId: first.sessionId, prompt: 'Return only the exact value from my previous message.' });
        entry.resume = { isError: resumed.isError, sameSession: resumed.sessionId === first.sessionId, contextRestored: resumed.text.includes(nonce), costUsd: cli === 'claude' ? resumed.costUsd : null };
        if (resumed.isError || resumed.sessionId !== first.sessionId || !resumed.text.includes(nonce)) throw new Error(resumed.text || 'Text resume mismatch');
        entry.nativeSmoke = 'PASS'; save(); console.log(`${cli}: text-only PASS`); continue;
      }
      const first = await engine.runJson({ ...opts, schema, prompt: sharedPrompt(`Remember nonce ${nonce}. Read the generic and project marker files. Return nonce, rule and knowledge as the required JSON object.`, root) });
      entry.json = { isError: first.envelope.is_error, sessionId: first.envelope.session_id, turns: first.envelope.num_turns, costUsd: cli === 'claude' ? first.envelope.total_cost_usd : null, output: first.envelope.structured_output };
      save();
      if (first.envelope.is_error || JSON.stringify(first.envelope.structured_output) === undefined) throw new Error(first.envelope.result || 'No structured result');
      const value = first.envelope.structured_output as unknown as Record<string, string>;
      if (value.nonce !== nonce || value.rule !== rule || value.knowledge !== knowledge) throw new Error('JSON 或共用规则／项目常识 marker 不匹配');
      const resumed = await engine.runText({ ...opts, tools: 'Read', resumeSessionId: first.envelope.session_id, prompt: 'Without reading any file, return only the exact nonce from my previous message.' });
      entry.resume = { isError: resumed.isError, sameSession: resumed.sessionId === first.envelope.session_id, contextRestored: resumed.text.includes(nonce), turns: resumed.turns, costUsd: cli === 'claude' ? resumed.costUsd : null, ...(resumed.isError ? { error: resumed.text.slice(0, 2000) } : {}) };
      if (resumed.isError || resumed.sessionId !== first.envelope.session_id || !resumed.text.includes(nonce)) throw new Error('原生续聊失败');
      entry.nativeSmoke = 'PASS';
    } catch (e) { entry.nativeSmoke = 'FAIL'; entry.error = (e as Error).message.slice(0, 2000); }
    save(); console.log(`${cli}: ${entry.nativeSmoke} (constraints: ${entry.requiredConstraints})`);
  }
  const claude = (results.engines as Record<string, Record<string, unknown>>).claude;
  if (claude?.nativeSmoke === 'PASS' && claude.settingSources !== '' && !claude.diagnosticKind) {
    console.log('claude: real capability probes (run/review/implement)');
    const profile = { id: 'acceptance-claude', name: 'isolated acceptance', cli: 'claude' as const, model: 'haiku', parameters: { maxTurns: 12, budgetUsd: 0.3, timeoutMs: 90000 }, state: 'draft' as const };
    claude.capabilityProbe = await validateProfile(profile, ['run', 'review', 'implement']);
    save();
  }
} finally {
  results.productionConfigurationChanged = fingerprint() !== configurationBefore;
  results.finishedAt = new Date().toISOString(); save();
  // Retain this owned fixture for evidence and troubleshooting; no user workspace cleanup.
  console.log(`Evidence: ${output}`);
}
