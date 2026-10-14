import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { validateResult, wireSchema } from '../schema.js';

describe('stage-specific native output schema', () => {
  it('requires review verdict/axes without inventing values or excluding a legitimate BLOCKED result', () => {
    const schema = JSON.parse(wireSchema('review'));
    expect(schema).not.toHaveProperty('allOf');
    const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(schema);
    const blocked = { stage: 'review', status: 'BLOCKED', handoff_path: 'docs/pipeline/T/30-review-r1.md', summary_for_card: 'Native review failed', blocked_reason: 'Missing required tool', verdict: null, axes: null };
    expect(validate(blocked)).toBe(true); expect(validateResult(blocked)).toEqual([]);
    const { verdict: _verdict, ...missing } = blocked;
    expect(validate(missing)).toBe(false);
    expect(validate({ ...blocked, stage: 'implement' })).toBe(false);
    expect(validateResult({ ...blocked, status: 'DONE', blocked_reason: null }).length).toBeGreaterThan(0);
  });
  it('requires acceptance verdict and keeps generic/other-stage schemas independent', () => {
    expect(JSON.parse(wireSchema('acceptance')).required).toContain('verdict');
    expect(JSON.parse(wireSchema('implement')).required).not.toContain('verdict');
    expect(JSON.parse(wireSchema()).properties.stage.enum.length).toBeGreaterThan(1);
  });
});
