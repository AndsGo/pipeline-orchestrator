import fs from 'node:fs';

/** Shared by the native command hook and the completion audit. No input rewriting. */
export function roleDispatch(input) {
  const match = /^\[pipeline:(implementer|task-review|escalated-implementer):(\d+)\](?:\s|$)|^\[pipeline:(final-review|mechanical)\](?:\s|$)/.exec(input?.description || '');
  if (!match || (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1))) throw new Error('Use an explicit pipeline role in description: [pipeline:implementer:1], [pipeline:task-review:1], [pipeline:final-review], or [pipeline:mechanical].');
  const role = match[1] || match[3], task = match[2] ? Number(match[2]) : undefined;
  const expected = role === 'final-review' || role === 'escalated-implementer' ? 'opus' : role === 'mechanical' ? 'haiku' : 'sonnet';
  if (input.model !== expected) throw new Error(`${role} requires explicit model: "${expected}". Missing model/inheritance is not accepted; retry the native call with the correct input.`);
  if (role === 'escalated-implementer' && !/^PIPELINE_ESCALATION_REASON: .+$/m.test(input.prompt || '')) throw new Error('Escalation requires PIPELINE_ESCALATION_REASON and two failed task reviews; record the reason in the ledger.');
  return { role, task, requestedModel: input.model };
}

if (process.argv.includes('--native-hook')) {
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (event.hook_event_name !== 'PreToolUse' || !['Agent', 'Task'].includes(event.tool_name)) throw new Error('Unexpected native hook event');
    roleDispatch(event.tool_input);
    // No allow override: keep all native permission checks and existing hooks.
    process.stdout.write('{}');
  } catch (error) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: error.message } }));
  }
}
