import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';

export const OUTPUT_LEVELS = ['concise', 'professional'] as const;
export const OUTPUT_STAGES = ['answer', 'intake', 'confirmation', 'delivery'] as const;
export type OutputLevel = typeof OUTPUT_LEVELS[number];
export type OutputStage = typeof OUTPUT_STAGES[number];
export interface OutputConfiguration {
  version: 1;
  revision: number;
  defaultLevel: OutputLevel;
  projects: Record<string, { defaultLevel?: OutputLevel; stages?: Partial<Record<OutputStage, OutputLevel>> }>;
}
export interface OutputResolution { level: OutputLevel; source: string; revision: number; }
export class OutputConfigurationError extends Error { readonly code: string = 'OUTPUT_CONFIG'; }
export class OutputConfigurationConflictError extends OutputConfigurationError { readonly code = 'OUTPUT_CONFIG_CONFLICT'; }

const configurationFile = (): string => path.join(dataDir(), 'output-config.json');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const level = (value: unknown): value is OutputLevel => OUTPUT_LEVELS.includes(value as OutputLevel);
const fail = (message: string): never => { throw new OutputConfigurationError(message); };

export function validateOutputConfiguration(value: unknown): OutputConfiguration {
  if (!object(value) || Object.keys(value).some(key => !['version', 'revision', 'defaultLevel', 'projects'].includes(key))
    || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !level(value.defaultLevel) || !object(value.projects)) return fail('回复配置格式不合法');
  const projects: OutputConfiguration['projects'] = {};
  for (const [repo, selection] of Object.entries(value.projects)) {
    if (!path.isAbsolute(repo) || !object(selection) || Object.keys(selection).some(key => !['defaultLevel', 'stages'].includes(key))) return fail('项目回复配置必须使用仓库绝对路径及有效字段');
    if (selection.defaultLevel !== undefined && !level(selection.defaultLevel)) return fail('项目回复档位不合法');
    if (selection.stages !== undefined && (!object(selection.stages) || Object.entries(selection.stages).some(([stage, selected]) => !OUTPUT_STAGES.includes(stage as OutputStage) || !level(selected)))) return fail('回复阶段或档位不合法');
    const key = path.resolve(repo);
    if (Object.hasOwn(projects, key)) return fail('项目回复配置路径重复');
    projects[key] = structuredClone(selection) as OutputConfiguration['projects'][string];
  }
  return { version: 1, revision: value.revision as number, defaultLevel: value.defaultLevel, projects };
}

export function readOutputConfiguration(): OutputConfiguration {
  try { return validateOutputConfiguration(JSON.parse(fs.readFileSync(configurationFile(), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, defaultLevel: 'concise', projects: {} };
    if (error instanceof OutputConfigurationError) throw error;
    return fail(`回复配置读取失败：${(error as Error).message}`);
  }
}

/** Locks are never reclaimed automatically, so a crashed writer cannot lose a successor's lock. */
export function withOutputLock<T>(file: string, action: () => T): T {
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OutputConfigurationConflictError('回复数据正在写入；请重试。若持有者已退出，请停止所有写入进程后显式清理锁');
    throw error;
  }
  try { fs.writeFileSync(fd, owner); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  try { return action(); }
  finally {
    fs.closeSync(fd);
    try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch { /* release only our own lock */ }
  }
}

export function writeOutputJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function writeOutputConfiguration(expectedRevision: number, value: unknown): OutputConfiguration {
  const requested = validateOutputConfiguration(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('回复配置版本不合法');
  const file = configurationFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withOutputLock(`${file}.lock`, () => {
    const previous = readOutputConfiguration();
    if (previous.revision !== expectedRevision) throw new OutputConfigurationConflictError('回复配置已被修改，请刷新后重试');
    const next = validateOutputConfiguration({ ...requested, revision: previous.revision + 1 });
    writeOutputJson(file, next);
    return next;
  });
}

export function resolveOutput(repo: string | undefined, stage: OutputStage, override?: OutputLevel, config = readOutputConfiguration()): OutputResolution {
  if (!OUTPUT_STAGES.includes(stage) || (override !== undefined && !level(override))) return fail('回复阶段或档位不合法');
  const project = repo ? config.projects[path.resolve(repo)] : undefined;
  if (override) return { level: override, source: 'override', revision: config.revision };
  if (project?.stages?.[stage]) return { level: project.stages[stage]!, source: 'project.stage', revision: config.revision };
  if (project?.defaultLevel) return { level: project.defaultLevel, source: 'project.default', revision: config.revision };
  return { level: config.defaultLevel, source: 'global.default', revision: config.revision };
}
