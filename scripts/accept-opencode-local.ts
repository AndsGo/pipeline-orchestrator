import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../src/engine/process.js';
import { openCodeConfiguration, verifiedOpenCodeResult, summarizeOpenCode } from '../src/engine/opencode.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('需要 --allow-model-calls');
// Use the existing local gateway only; never copy the credential into evidence/config files.
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
const endpoint = new URL(settings.env?.ANTHROPIC_BASE_URL);
if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('此诊断仅允许现有本地网关');
const credential = settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY;
if (!credential) throw new Error('本地网关未配置凭据');
const url = new URL('/v1/models', endpoint);
const response = await fetch(url, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error(`模型目录请求失败 ${response.status}`);
const models = await response.json() as { data: { id: string; loaded: boolean }[] };
const loaded = models.data.find(m => m.loaded);
if (!loaded) throw new Error('没有已加载的本地模型');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-opencode-local-'));
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-opencode-local`);
fs.mkdirSync(output, { recursive: true });
const nonce = randomUUID();
const withTools = process.argv.includes('--with-tools');
const rule = randomUUID(), knowledge = randomUUID();
if (withTools) {
  fs.mkdirSync(path.join(root, 'docs/pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `Generic rule marker: ${rule}. Never modify files during acceptance.`);
  fs.writeFileSync(path.join(root, 'docs/pipeline/PROJECT-KNOWLEDGE.md'), `Project knowledge marker: ${knowledge}.`);
}
const config = { ...openCodeConfiguration(withTools ? 'Read,Grep,Glob' : '', withTools ? 8 : 3), providers: {
  'acceptance-local': { name: 'Existing local gateway (isolated diagnostic)', env: ['PIPELINE_ACCEPTANCE_LOCAL_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: new URL('/v1', endpoint).href, headerTimeout: 15000, chunkTimeout: 15000, timeout: 45000 }, models: {
    loaded: { modelID: loaded.id, name: loaded.id, capabilities: { tools: withTools, input: ['text'], output: ['text'] }, limit: { context: 32768, output: withTools ? 512 : 128 } },
  } },
} };
const result: Record<string, unknown> = { startedAt: new Date().toISOString(), model: loaded.id, scope: `${withTools ? 'Structured output and rule loading' : 'Text-only'} diagnostic; ephemeral provider; no production activation or constraint relaxation`, isolatedDirectory: root, nativeDefaultProvider: 'not authenticated' };
const env = { ...process.env, PWD: root, PIPELINE_ACCEPTANCE_LOCAL_KEY: credential, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
try {
  console.log(`opencode: isolated local text probe using the already loaded ${loaded.id}`);
  const prompt = withTools ? `Remember nonce ${nonce}. Read AGENTS.md and docs/pipeline/PROJECT-KNOWLEDGE.md. Return only a JSON object with exactly nonce, rule and knowledge, using the exact markers from those files. Do not modify files.` : `Reply only ${nonce}. Remember it for my next message.`;
  const first = await runProcess(process.env.PIPELINE_OPENCODE_BIN || 'opencode', ['run', '--standalone', '--format', 'json', '--agent', 'pipeline-executor', '--model', 'acceptance-local/loaded'], { cwd: root, env, stdin: prompt, timeoutMs: 90000 });
  result.observed = summarizeOpenCode(first.stdout);
  const summary = await verifiedOpenCodeResult(first, { command: process.env.PIPELINE_OPENCODE_BIN || 'opencode', cwd: root, env });
  result.events = first.stdout.split(/\r?\n/).flatMap(line => {
    try { const e = JSON.parse(line); return [{ type: e.type, partType: e.part?.type, reason: e.part?.reason, messageID: e.part?.messageID, sessionID: e.sessionID, cost: e.part?.cost }]; }
    catch { return []; }
  });
  result.first = { exitCode: first.code, sessionId: summary.sessionId, matches: summary.text.includes(nonce), error: summary.error, costKnown: summary.costKnown };
  if (first.code || summary.error || !summary.text.includes(nonce)) throw new Error(summary.error || first.stderr.slice(-1000) || 'nonce mismatch');
  if (withTools) {
    const json = JSON.parse(summary.text);
    result.structured = { nonceMatches: json.nonce === nonce, ruleMatches: json.rule === rule, knowledgeMatches: json.knowledge === knowledge };
    if (json.nonce !== nonce || json.rule !== rule || json.knowledge !== knowledge || Object.keys(json).length !== 3) throw new Error('structured output or shared rule markers mismatch');
  }
  const second = await runProcess(process.env.PIPELINE_OPENCODE_BIN || 'opencode', ['run', '--standalone', '--format', 'json', '--agent', 'pipeline-executor', '--model', 'acceptance-local/loaded', '--session', summary.sessionId!], { cwd: root, env, stdin: 'Return only the exact value from my previous message.', timeoutMs: 90000 });
  const resumed = await verifiedOpenCodeResult(second, { command: process.env.PIPELINE_OPENCODE_BIN || 'opencode', cwd: root, env });
  result.resume = { exitCode: second.code, sameSession: resumed.sessionId === summary.sessionId, contextRestored: resumed.text.includes(nonce), error: resumed.error };
  if (second.code || resumed.error || resumed.sessionId !== summary.sessionId || !resumed.text.includes(nonce)) throw new Error(resumed.error || 'resume mismatch');
  result.nativeText = 'PASS';
} catch (e) { result.nativeText = 'FAIL'; result.error = (e as Error).message; }
finally {
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(`opencode text result: ${result.nativeText}. Evidence: ${output}`);
}
