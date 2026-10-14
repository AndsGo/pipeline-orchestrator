import type { Envelope } from '../types.js';

/** Keep reported usage when a billed call fails its execution or output contract. */
export class CliExecutionError extends Error {
  constructor(message: string, readonly envelope: Envelope) {
    super(message);
    this.name = 'CliExecutionError';
  }
}

export function failureUsage(envelope: Envelope): Record<string, unknown> {
  if (envelope.costStatus === 'unknown') return { costStatus: 'unknown',
    ...(envelope.session_id ? { sessionId: envelope.session_id, turns: envelope.num_turns } : envelope.num_turns > 0 ? { turns: envelope.num_turns } : {}) };
  return { costUsd: envelope.total_cost_usd, turns: envelope.num_turns, sessionId: envelope.session_id,
    ...(envelope.costStatus === 'partial' ? { costStatus: 'partial' } : {}) };
}
