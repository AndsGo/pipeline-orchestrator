import fs from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import { SCHEMA_PATH } from './config.js';
import type { StageResult } from './types.js';

let fullValidator: ValidateFunction | null = null;
let wireJson: string | null = null;

function loadSchema(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
}

/** 传给 claude --json-schema 的线上版：API 不支持顶层 allOf，剥掉后由编排器回程校验补足 */
export function wireSchema(): string {
  if (!wireJson) {
    const s = loadSchema();
    delete s.allOf;
    wireJson = JSON.stringify(s);
  }
  return wireJson;
}

/** 完整 schema（含条件约束）的回程校验。返回错误列表，空数组 = 通过 */
export function validateResult(result: unknown): string[] {
  if (!fullValidator) {
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    fullValidator = ajv.compile(loadSchema());
  }
  if (fullValidator(result)) return [];
  return (fullValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

export function isStageResult(v: unknown): v is StageResult {
  return validateResult(v).length === 0;
}
