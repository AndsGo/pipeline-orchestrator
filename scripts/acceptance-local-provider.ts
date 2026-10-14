import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Uses already configured local credentials in memory; does not persist them. */
export async function localAcceptanceProvider(output = 768) {
  if (!Number.isInteger(output) || output < 16 || output > 65536) throw new Error('Isolated output limit must be an integer between 16 and 65536');
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
  const endpoint = new URL(settings.env?.ANTHROPIC_BASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('诊断仅允许既有本地网关');
  const key = settings.env.ANTHROPIC_AUTH_TOKEN || settings.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('本地网关未配置凭据');
  const response = await fetch(new URL('/v1/models', endpoint), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`模型目录请求失败 ${response.status}`);
  const models = await response.json() as { data: { id: string; loaded: boolean; context_length?: number }[] };
  const loaded = models.data.find(m => m.loaded);
  if (!loaded) throw new Error('没有已加载的模型');
  process.env.PIPELINE_ACCEPTANCE_LOCAL_KEY = key;
  // V2.0.6 reserves 20k by default, leaving only 12k in a 32k model.
  // Keep compaction enabled, with a tail that fits beside its summary and output.
  const context = Number.isInteger(loaded.context_length) && loaded.context_length! > output ? loaded.context_length! : 32768;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ compaction: { auto: true, buffer: 3277, keep: { tokens: 8192 } }, providers: { 'acceptance-local': { name: 'Existing local gateway', env: ['PIPELINE_ACCEPTANCE_LOCAL_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: new URL('/v1', endpoint).href }, models: { loaded: { modelID: loaded.id, capabilities: { tools: true, input: ['text'], output: ['text'] }, body: { max_tokens: output }, limit: { context, output } } } } } });
  return { provider: 'acceptance-local', model: 'loaded' };
}
