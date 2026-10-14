import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { codexEnvironment } from './codex.js';

type Record = { type?: string; timestamp?: string; ordinal?: number; payload?: any };
interface Context { parentId: string; cwd: string; markerFile: string; marker: string; startedAt: number; finishedAt: number; }
export interface NamedChildEvidence { independent: boolean; parentSecretRead: boolean; reason?: string; parentId?: string; childId?: string; taskPath?: string; spawnCallId?: string; parentTurn?: string; childTurn?: string; parentRollout?: string; childRollout?: string; parentDigest?: string; childDigest?: string; }
const contents = (p: any) => Array.isArray(p?.content) ? p.content.filter((c: any) => c.type === 'input_text' || c.type === 'output_text').map((c: any) => c.text || '').join('\n') : '';
const canonical = (value: string) => path.resolve(value.startsWith('file:') ? fileURLToPath(value) : value).replace(/\\/g, '/').toLowerCase();
const timestamp = (r: Record) => Date.parse(r.timestamp || '');
const object = (value: unknown) => { const o = typeof value === 'string' ? JSON.parse(value) : value; if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Invalid native tool data'); return o as any; };

/** Named-task runtimes do not project SubAgentActivity into exec --json stdout. */
export function verifyNamedChild(parent: Record[], child: Record[], context: Context): NamedChildEvidence {
  let parentSecretRead = false;
  try {
    const require = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
    const meta = parent[0]?.type === 'session_meta' ? parent[0].payload : undefined;
    require(meta?.id === context.parentId && meta.source === 'exec' && canonical(meta.cwd) === canonical(context.cwd), 'Parent session/cwd mismatch');
    const created = Date.parse(meta.timestamp);
    require(created >= context.startedAt - 1000 && created <= context.finishedAt + 1000, 'Parent session is outside this invocation');
    const roots = parent.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started');
    require(roots.length === 1 && typeof roots[0].payload.turn_id === 'string' && !!roots[0].payload.turn_id && roots[0].payload.turn_id === roots[0].payload.root_turn_id, 'Ambiguous parent turn');
    const turn = roots[0].payload.turn_id;
    const calls = parent.filter(r => r.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(r.payload?.type));
    parentSecretRead = calls.some(r => r.payload.type !== 'function_call' || !['spawn_agent', 'wait_agent'].includes(r.payload.name))
      || parent.some(r => r.type === 'event_msg' && r.payload?.item && !['UserMessage', 'Reasoning', 'AgentMessage', 'SubAgentActivity', 'CollabAgentToolCall'].includes(r.payload.item.type));
    require(!parentSecretRead, 'Parent used an execution/file/MCP/unknown tool');
    const spawns = calls.filter(r => r.payload.name === 'spawn_agent'); require(spawns.length === 1, 'Requires exactly one native spawn');
    const spawn = spawns[0], args = object(spawn.payload.arguments);
    require(typeof args.task_name === 'string' && /^[a-z0-9_]+$/i.test(args.task_name) && typeof args.message === 'string' && !!args.message, 'Invalid named-task spawn input');
    const responses = parent.filter(r => r.type === 'response_item' && r.payload?.type === 'function_call_output' && r.payload.call_id === spawn.payload.call_id);
    require(responses.length === 1 && timestamp(responses[0]) > timestamp(spawn), 'Missing matching successful spawn output');
    const reply = object(responses[0].payload.output), taskPath = reply.task_name;
    require(typeof taskPath === 'string' && taskPath.endsWith(`/${args.task_name}`) && taskPath.startsWith('/') && !reply.error && reply.is_error !== true, 'Invalid native task identity');
    const activities = parent.filter(r => r.type === 'event_msg' && r.payload?.type === 'item_completed' && r.payload.thread_id === context.parentId && r.payload.turn_id === turn && r.payload.item?.type === 'SubAgentActivity');
    const starts = activities.filter(r => r.payload.item.kind === 'started'); require(starts.length === 1, 'Ambiguous native child start');
    const start = starts[0], childId = start.payload.item.agent_thread_id;
    require(start.payload.item.id === spawn.payload.call_id && start.payload.item.agent_path === taskPath && typeof childId === 'string' && !!childId && childId !== context.parentId, 'Spawn/start identity mismatch');
    const completed = activities.filter(r => r.payload.item.kind === 'completed' && r.payload.item.agent_thread_id === childId && r.payload.item.agent_path === taskPath);
    require(completed.length === 1 && timestamp(completed[0]) > timestamp(start), 'Missing native child completion');
    const childMeta = child[0]?.type === 'session_meta' ? child[0].payload : undefined;
    const source = childMeta?.source?.subagent?.thread_spawn;
    require(childMeta?.id === childId && childMeta.parent_thread_id === context.parentId && source?.parent_thread_id === context.parentId && source.depth === 1 && childMeta.agent_path === taskPath && source.agent_path === taskPath, 'Child first metadata is not the matching fresh spawn');
    require(Date.parse(childMeta.timestamp) >= timestamp(spawn) && Date.parse(childMeta.timestamp) <= timestamp(responses[0]), 'Child predates this spawn');
    const noHistory = args.fork_turns === 'none' && childMeta.forked_from_id === undefined && childMeta.subagent_history_start_ordinal === undefined && child.filter(r => r.type === 'session_meta').length === 1;
    const boundary = noHistory ? 0 : childMeta.subagent_history_start_ordinal;
    require(Number.isSafeInteger(boundary) && boundary >= 0, 'Missing native fork boundary');
    const own = child.filter(r => Number.isSafeInteger(r.ordinal) && r.ordinal! >= boundary);
    const childStarts = own.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started' && r.payload.root_turn_id === turn && r.payload.turn_id !== turn && r.payload.turn_attribution?.parent_turn_id === turn);
    require(childStarts.length === 1 && typeof childStarts[0].payload.turn_id === 'string' && !!childStarts[0].payload.turn_id, 'Ambiguous child execution turn');
    const childTurn = childStarts[0].payload.turn_id, parentPath = taskPath.slice(0, taskPath.lastIndexOf('/'));
    const originalPrompts = parent.filter(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user' && timestamp(r) < timestamp(spawn)).map(r => contents(r.payload));
    const markerPath = context.markerFile.replace(/\\/g, '/').toLowerCase();
    require(originalPrompts.some(text => text.replace(/\\/g, '/').toLowerCase().includes(markerPath)) && originalPrompts.every(text => !text.includes(context.marker)), 'Owned challenge was not blind in the original parent prompt');
    const delivered = own.filter(r => r.type === 'response_item' && r.payload?.type === 'agent_message' && r.payload.author === parentPath && r.payload.recipient === taskPath && r.payload.content?.some((p: any) => p.type === 'encrypted_content' && p.encrypted_content === args.message));
    require(delivered.length === 1, 'Encrypted spawn message/child delivery mismatch'); // Equality only; never decrypt or infer its plaintext.
    const reads = own.filter(r => r.type === 'event_msg' && r.payload?.type === 'item_completed' && r.payload.thread_id === childId && r.payload.turn_id === childTurn && r.payload.item?.type === 'CommandExecution');
    require(reads.some(r => {
      const item = r.payload.item, command = JSON.stringify(item.command).replace(/\\\\/g, '/').toLowerCase();
      return item.status === 'completed' && item.exit_code === 0 && canonical(item.cwd) === canonical(context.cwd) && command.includes(markerPath) && !command.includes(context.marker.toLowerCase()) && String(item.aggregated_output).includes(context.marker);
    }), 'Child lacks an actual successful owned-marker read');
    const childDone = own.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_complete' && r.payload.turn_id === childTurn && r.payload.root_turn_id === turn);
    require(childDone.length === 1 && String(childDone[0].payload.last_agent_message).includes(context.marker) && timestamp(childDone[0]) <= timestamp(completed[0]), 'Child is unfinished or returned another marker');
    const received = parent.filter(r => r.type === 'response_item' && r.payload?.type === 'agent_message' && r.payload.author === taskPath && r.payload.recipient === parentPath && r.payload.internal_chat_message_metadata_passthrough?.turn_id === turn && contents(r.payload).includes(context.marker) && timestamp(r) >= timestamp(childDone[0]));
    require(received.length === 1, 'Parent did not receive the completed matching child result');
    const waits = calls.filter(r => r.payload.name === 'wait_agent' && timestamp(r) > timestamp(responses[0]));
    require(waits.some(w => parent.some(r => r.type === 'response_item' && r.payload?.type === 'function_call_output' && r.payload.call_id === w.payload.call_id && timestamp(r) >= timestamp(completed[0]) && object(r.payload.output).timed_out === false)), 'No completed native wait');
    const parentDone = parent.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_complete' && r.payload.turn_id === turn && r.payload.root_turn_id === turn);
    require(parentDone.length === 1 && timestamp(parentDone[0]) > timestamp(received[0]) && timestamp(parentDone[0]) <= context.finishedAt + 1000 && String(parentDone[0].payload.last_agent_message).includes(context.marker), 'Parent did not complete with the verified marker');
    return { independent: true, parentSecretRead: false, parentId: context.parentId, childId, taskPath, spawnCallId: spawn.payload.call_id, parentTurn: turn, childTurn };
  } catch (error) { return { independent: false, parentSecretRead, reason: (error as Error).message }; }
}

export function namedChildFromRollouts(context: Context): NamedChildEvidence {
  try {
    const directory = fs.realpathSync.native(path.join(codexEnvironment().CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'));
    const names = fs.readdirSync(directory, { recursive: true }).filter((name): name is string => typeof name === 'string');
    const read = (id: string) => {
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid native thread ID');
      const files = names.filter(n => path.basename(n).startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
      if (files.length !== 1) throw new Error('Missing or ambiguous native rollout');
      const file = fs.realpathSync.native(path.join(directory, files[0]));
      if (path.relative(directory, file).startsWith('..')) throw new Error('Native rollout escapes sessions directory');
      const raw = fs.readFileSync(file, 'utf8');
      return { file, digest: createHash('sha256').update(raw).digest('hex'), records: raw.trim().split(/\r?\n/).map(line => JSON.parse(line) as Record) };
    };
    const parent = read(context.parentId);
    const starts = parent.records.filter(r => r.type === 'event_msg' && r.payload?.item?.type === 'SubAgentActivity' && r.payload.item.kind === 'started');
    if (starts.length !== 1) throw new Error('Requires one named-task native child');
    const child = read(starts[0].payload.item.agent_thread_id);
    const verified = verifyNamedChild(parent.records, child.records, context);
    return { ...verified, parentRollout: parent.file, childRollout: child.file, parentDigest: parent.digest, childDigest: child.digest };
  } catch (error) { return { independent: false, parentSecretRead: false, reason: (error as Error).message }; }
}
