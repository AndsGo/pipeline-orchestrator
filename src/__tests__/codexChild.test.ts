import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyNamedChild } from '../engine/codexChild.js';

const origin = Date.parse('2026-10-13T10:00:00Z');
const event = (second: number, type: string, payload: object, ordinal = 0) => ({ timestamp: new Date(origin + second * 1000).toISOString(), type, payload, ordinal });
const cwd = path.join(os.tmpdir(), 'pipeline-owned-test'), markerFile = path.join(cwd, 'child-marker.txt'), marker = 'unique-public-marker';
const context = { parentId: 'P', cwd, markerFile, marker, startedAt: origin, finishedAt: origin + 12000 };
function fixture() {
  const parent = [
    event(0, 'session_meta', { id: 'P', source: 'exec', cwd, timestamp: new Date(origin).toISOString() }),
    event(1, 'event_msg', { type: 'task_started', turn_id: 'TP', root_turn_id: 'TP' }),
    event(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Use a fresh child to read ${markerFile}` }] }),
    event(3, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'S', arguments: JSON.stringify({ task_name: 'worker', fork_turns: 'all', message: 'opaque-encrypted-message' }) }),
    event(4, 'event_msg', { type: 'item_completed', thread_id: 'P', turn_id: 'TP', item: { type: 'SubAgentActivity', kind: 'started', id: 'S', agent_thread_id: 'C', agent_path: '/root/worker' } }),
    event(5, 'response_item', { type: 'function_call_output', call_id: 'S', output: JSON.stringify({ task_name: '/root/worker' }) }),
    event(6, 'response_item', { type: 'function_call', name: 'wait_agent', call_id: 'W', arguments: '{}' }),
    event(9, 'event_msg', { type: 'item_completed', thread_id: 'P', turn_id: 'TP', item: { type: 'SubAgentActivity', kind: 'completed', id: 'completion-TC', agent_thread_id: 'C', agent_path: '/root/worker' } }),
    event(9.5, 'response_item', { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: marker }], internal_chat_message_metadata_passthrough: { turn_id: 'TP' } }),
    event(10, 'response_item', { type: 'function_call_output', call_id: 'W', output: '{"timed_out":false}' }),
    event(11, 'event_msg', { type: 'task_complete', turn_id: 'TP', root_turn_id: 'TP', last_agent_message: marker }),
  ];
  const child = [
    event(3.5, 'session_meta', { id: 'C', parent_thread_id: 'P', agent_path: '/root/worker', subagent_history_start_ordinal: 9, timestamp: new Date(origin + 3500).toISOString(), source: { subagent: { thread_spawn: { parent_thread_id: 'P', depth: 1, agent_path: '/root/worker' } } } }),
    event(3.6, 'session_meta', { id: 'P', source: 'exec', cwd }, 1), // Inherited metadata must never replace the child identity.
    event(4.5, 'event_msg', { type: 'task_started', turn_id: 'TC', root_turn_id: 'TP', turn_attribution: { parent_turn_id: 'TP' } }, 10),
    event(5, 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'encrypted_content', encrypted_content: 'opaque-encrypted-message' }] }, 11),
    event(8, 'event_msg', { type: 'item_completed', thread_id: 'C', turn_id: 'TC', item: { type: 'CommandExecution', command: ['Get-Content', markerFile], cwd: pathToFileURL(cwd).href, status: 'completed', exit_code: 0, aggregated_output: marker } }, 12),
    event(8.5, 'event_msg', { type: 'task_complete', turn_id: 'TC', root_turn_id: 'TP', last_agent_message: marker }, 13),
  ];
  return { parent, child };
}
describe('named-task Codex native child provenance', () => {
  it('correlates a fresh spawn, encrypted delivery, real child read and both completions', () => {
    const { parent, child } = fixture();
    expect(verifyNamedChild(parent, child, context)).toMatchObject({ independent: true, parentSecretRead: false, parentId: 'P', childId: 'C', spawnCallId: 'S', parentTurn: 'TP', childTurn: 'TC' });
  });
  it('rejects parent execution even if the child returns the marker', () => {
    const { parent, child } = fixture(); parent.splice(4, 0, event(3.5, 'response_item', { type: 'custom_tool_call', name: 'exec', input: 'read marker' }));
    expect(verifyNamedChild(parent, child, context)).toMatchObject({ independent: false, parentSecretRead: true });
  });
  it('accepts an explicitly empty fork only when no inherited history metadata exists', () => {
    const f = fixture(); const meta = f.child[0].payload as any;
    delete meta.subagent_history_start_ordinal; f.child.splice(1, 1);
    const args = JSON.parse((f.parent[3].payload as any).arguments); args.fork_turns = 'none'; (f.parent[3].payload as any).arguments = JSON.stringify(args);
    expect(verifyNamedChild(f.parent, f.child, context).independent).toBe(true);
    f.child.splice(1, 0, event(3.6, 'session_meta', { id: 'P' }, 1));
    expect(verifyNamedChild(f.parent, f.child, context).independent).toBe(false);
  });
  it('rejects missing, unrelated, unfinished and reused child evidence', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.parent.splice(4, 1); },
      (f: ReturnType<typeof fixture>) => { (f.child[0].payload as any).parent_thread_id = 'other'; },
      (f: ReturnType<typeof fixture>) => { (f.child[0].payload as any).timestamp = new Date(origin - 1000).toISOString(); },
      (f: ReturnType<typeof fixture>) => { f.child.pop(); },
      (f: ReturnType<typeof fixture>) => { (f.child[3].payload as any).content[0].encrypted_content = 'unrelated-message'; },
      (f: ReturnType<typeof fixture>) => { (f.child[4].payload as any).item.command = ['echo', markerFile, marker]; },
      (f: ReturnType<typeof fixture>) => { (f.parent[2].payload as any).content[0].text += marker; },
      (f: ReturnType<typeof fixture>) => { (f.parent[8].payload as any).author = '/root/other'; },
    ]) { const f = fixture(); mutate(f); expect(verifyNamedChild(f.parent, f.child, context).independent).toBe(false); }
  });
  it('rejects a different invocation time, cwd or marker rather than guessing', () => {
    const f = fixture();
    for (const changed of [{ startedAt: origin + 5000 }, { cwd: path.join(cwd, 'other') }, { marker: 'other-marker' }]) expect(verifyNamedChild(f.parent, f.child, { ...context, ...changed }).independent).toBe(false);
  });
});
