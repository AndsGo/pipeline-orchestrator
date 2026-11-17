import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../paths.js';
import { OUTPUT_LEVELS, OUTPUT_STAGES, resolveOutput, withOutputLock, writeOutputJson, type OutputLevel, type OutputResolution, type OutputStage } from './configuration.js';

export interface OutputDraft {
  repo?: string;
  project?: string;
  stage: OutputStage;
  title: string;
  summary: string;
  detail: string;
  risks: string[];
  actions: string[];
  evidence: string[];
  materialRevision?: number;
  sourceRef?: string;
  override?: OutputLevel;
}
export interface OutputRecord extends OutputDraft {
  id: string;
  createdAt: string;
  level: OutputLevel;
  levelSource: string;
  configRevision: number;
  chatId?: string;
  rootId?: string;
  messageId?: string;
}
export class OutputRecordError extends Error { readonly code = 'OUTPUT_RECORD'; }
const directory = (): string => path.join(dataDir(), 'outputs');
const validId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim());
function validateDraft(draft: OutputDraft): void {
  if (!draft || !OUTPUT_STAGES.includes(draft.stage) || typeof draft.title !== 'string' || !draft.title.trim()
    || typeof draft.summary !== 'string' || typeof draft.detail !== 'string' || (!draft.summary.trim() && !draft.detail.trim())
    || !strings(draft.risks) || !strings(draft.actions) || !strings(draft.evidence)
    || (draft.repo !== undefined && (typeof draft.repo !== 'string' || !path.isAbsolute(draft.repo)))
    || (draft.override !== undefined && !OUTPUT_LEVELS.includes(draft.override))
    || (draft.materialRevision !== undefined && (!Number.isSafeInteger(draft.materialRevision) || draft.materialRevision < 0))
    || ['project', 'sourceRef'].some(key => draft[key as 'project' | 'sourceRef'] !== undefined && typeof draft[key as 'project' | 'sourceRef'] !== 'string')) throw new OutputRecordError('回复记录内容不合法');
}

export function createOutputRecord(draft: OutputDraft, audience?: { chatId?: string; rootId?: string }, resolution?: OutputResolution): OutputRecord {
  validateDraft(draft);
  const selected = resolution ?? resolveOutput(draft.repo, draft.stage, draft.override);
  if (!OUTPUT_LEVELS.includes(selected.level) || typeof selected.source !== 'string' || !selected.source || !Number.isSafeInteger(selected.revision) || selected.revision < 0
    || ['chatId', 'rootId'].some(key => audience?.[key as 'chatId' | 'rootId'] !== undefined && (typeof audience[key as 'chatId' | 'rootId'] !== 'string' || !audience[key as 'chatId' | 'rootId']!.trim()))) throw new OutputRecordError('回复记录呈现配置不合法');
  const record: OutputRecord = { ...structuredClone(draft), id: randomUUID(), createdAt: new Date().toISOString(), level: selected.level, levelSource: selected.source, configRevision: selected.revision,
    ...(audience?.chatId ? { chatId: audience.chatId } : {}), ...(audience?.rootId ? { rootId: audience.rootId } : {}) };
  fs.mkdirSync(directory(), { recursive: true });
  writeOutputJson(path.join(directory(), `${record.id}.json`), record);
  return record;
}

export function readOutputRecord(id: string): OutputRecord | null {
  if (!validId(id)) return null;
  let value: OutputRecord;
  try {
    value = JSON.parse(fs.readFileSync(path.join(directory(), `${id}.json`), 'utf8'));
    if (value && typeof value === 'object' && value.summary === undefined) value = { ...value, summary: '' };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new OutputRecordError(`回复记录读取失败：${(error as Error).message}`); }
  validateDraft(value);
  if (value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !OUTPUT_LEVELS.includes(value.level)
    || typeof value.levelSource !== 'string' || !value.levelSource || !Number.isSafeInteger(value.configRevision) || value.configRevision < 0
    || ['chatId', 'rootId', 'messageId'].some(key => value[key as 'chatId' | 'rootId' | 'messageId'] !== undefined && (typeof value[key as 'chatId' | 'rootId' | 'messageId'] !== 'string' || !value[key as 'chatId' | 'rootId' | 'messageId']!.trim()))) throw new OutputRecordError('回复记录元数据不合法');
  return value;
}

export function listOutputRecords(): OutputRecord[] {
  let names: string[];
  try { names = fs.readdirSync(directory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => readOutputRecord(name.slice(0, -5))!)
    .filter((record): record is OutputRecord => record !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function bindOutputMessage(id: string, messageId: string): OutputRecord {
  if (!validId(id) || typeof messageId !== 'string' || !messageId.trim()) throw new OutputRecordError('回复消息标识不合法');
  const file = path.join(directory(), `${id}.json`);
  if (!fs.existsSync(file)) throw new OutputRecordError('回复记录不存在');
  return withOutputLock(`${file}.lock`, () => {
    const record = readOutputRecord(id);
    if (!record) throw new OutputRecordError('回复记录不存在');
    if (record.messageId && record.messageId !== messageId) throw new OutputRecordError('回复记录已绑定其他消息');
    const next = { ...record, messageId };
    writeOutputJson(file, next);
    return next;
  });
}

export function renderOutput(record: OutputRecord, level: OutputLevel = record.level): string {
  const hasSummary = !!record.summary?.trim();
  const sections = [`**${record.title}**`, hasSummary ? record.summary : '未提供结构化摘要，以下为原始输出'];
  if ((!hasSummary || level === 'professional') && record.detail && record.detail !== record.summary) sections.push(record.detail);
  if (record.risks.length) sections.push(`**风险与限制**\n${record.risks.map(item => `- ${item}`).join('\n')}`);
  if (record.actions.length) sections.push(`**下一步**\n${record.actions.map(item => `- ${item}`).join('\n')}`);
  if (level === 'professional' && record.evidence.length) sections.push(`**依据**\n${record.evidence.map(item => `- ${item}`).join('\n')}`);
  return sections.join('\n\n');
}
