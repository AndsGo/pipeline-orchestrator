import fs from 'node:fs';
import path from 'node:path';
import { localAcceptanceProvider } from './acceptance-local-provider.js';
if (!process.argv.includes('--allow-model-calls')) throw new Error('Requires --allow-model-calls');
await localAcceptanceProvider(16);
const provider = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).providers['acceptance-local'];
const response = await fetch(`${provider.settings.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.PIPELINE_ACCEPTANCE_LOCAL_KEY}` },
  body: JSON.stringify({ model: provider.models.loaded.modelID, messages: [{ role: 'user', content: 'List every integer from 1 to 100, separated by spaces. No tools.' }], max_tokens: 16, stream: false }), signal: AbortSignal.timeout(30000) });
const result = await response.json() as { usage?: { completion_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string } }[]; error?: { message?: string } };
const tokens = result.usage?.completion_tokens;
const report = { scope: 'Paid local-provider generation-cap diagnostic, independent of profile or pipeline acceptance', model: provider.models.loaded.modelID,
  requestMaxTokens: 16, httpStatus: response.status, completionTokens: tokens, finishReason: result.choices?.[0]?.finish_reason, textLength: result.choices?.[0]?.message?.content?.length,
  capObserved: response.ok && typeof tokens === 'number' && tokens <= 16 && result.choices?.[0]?.finish_reason === 'length', costStatus: 'unknown' };
const output = path.resolve(`data/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-provider-cap`); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); console.log(`Evidence: ${output}`);
