import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { engineNamed } from '../src/engine/index.js';

// A synthetic local endpoint tests request configuration only. It cannot activate
// a profile or establish any model, subagent or pipeline acceptance result.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-wire-probe-')));
execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true, stdio: 'ignore' });
const requests: object[] = [];
const cli = process.env.PIPELINE_WIRE_CLI === 'claude' ? 'claude' : 'opencode';
const server = http.createServer(async (request, response) => {
  let input = ''; for await (const chunk of request) input += chunk.toString();
  if (!input.trim()) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
  const body = JSON.parse(input);
  requests.push({ url: request.url, model: body.model, stream: body.stream, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens, hasAuthorization: !!request.headers.authorization });
  if (cli === 'claude') { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'WIRE_DIAGNOSTIC_NO_MODEL' } })); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'wire-only', object: 'chat.completion.chunk', created: 1, model: 'wire-only', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  response.write(event({ role: 'assistant', content: 'WIRE_DIAGNOSTIC' }, null));
  response.write(event({}, 'stop')); response.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
process.env.PIPELINE_WIRE_TEST_KEY = 'synthetic-wire-test';
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { recording: { env: ['PIPELINE_WIRE_TEST_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { mock: { modelID: 'wire-only', body: { max_tokens: 8192 }, limit: { context: 32768, output: 8192 } } } } } });
const output = path.resolve(`docs/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-opencode-wire`); fs.mkdirSync(output, { recursive: true });
const report: Record<string, unknown> = { cli, scope: 'Synthetic loopback request-body diagnostic only; no model call, no profile activation or pipeline acceptance', requests };
try {
  if (cli === 'claude') {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`; process.env.ANTHROPIC_API_KEY = 'synthetic-wire-test'; process.env.ANTHROPIC_AUTH_TOKEN = 'synthetic-wire-test';
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '8192';
    process.env.CLAUDE_CODE_MAX_RETRIES = '0';
  }
  const result = await engineNamed(cli).runText({ cwd: root, prompt: 'Reply WIRE_DIAGNOSTIC. Do not call tools.', model: cli === 'claude' ? 'wire-only' : 'recording/mock', tools: 'Read', maxTurns: 1, budgetUsd: cli === 'claude' ? 0.1 : 0, timeoutMs: 30000, constraintMode: 'native', ...(cli === 'claude' ? { settingSources: '' } : {}) });
  report.nativeCliComplete = !result.isError;
  report.requestBodyVerified = requests.length > 0 && requests.every(request => (request as { max_tokens?: number }).max_tokens === 8192);
} catch (error) { report.error = (error as Error).message; }
finally { server.close(); report.requestBodyVerified = requests.length > 0 && requests.every(request => (request as { max_tokens?: number }).max_tokens === 8192); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); console.log(`Evidence: ${output}`); }
