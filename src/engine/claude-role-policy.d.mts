export interface RoleDispatch { role: 'implementer' | 'task-review' | 'escalated-implementer' | 'final-review' | 'mechanical'; task?: number; requestedModel: string; }
export function roleDispatch(input: unknown): RoleDispatch;
