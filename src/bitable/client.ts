import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { Term } from '../glossary.js';
import type { KnowledgeEntry } from '../knowledge.js';
import { dataDir } from '../paths.js';
import {
  KB_KINDS,
  KB_SCOPES,
  NODE_FIELDS,
  NODE_TABLE,
  TICKET_FIELDS,
  TICKET_TABLE,
  nodeLinkField,
  type FieldDef,
} from './schema.js';

/** 多维表格的文本字段读回来可能是富文本片段数组 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string }).text ?? ''))).join('');
  if (v && typeof v === 'object' && 'text' in (v as object)) return String((v as { text?: string }).text ?? '');
  return v == null ? '' : String(v);
}

function linkOf(v: unknown): string | undefined {
  if (v && typeof v === 'object' && 'link' in (v as object)) return String((v as { link?: string }).link ?? '') || undefined;
  return undefined;
}

const indexFile = (): string => path.join(dataDir(), 'bitable-index.json');

export interface BitableCfg {
  appToken: string;
  ticketTableId: string;
  nodeTableId: string;
  /** 知识表（可选：未建则不做知识投影与预取） */
  kbTableId?: string;
  /** 术语表（可选：未建则不做术语注入与采集） */
  glossaryTableId?: string;
}

export function bitableCfgFromEnv(): BitableCfg | null {
  const { BITABLE_APP_TOKEN, BITABLE_TICKET_TABLE_ID, BITABLE_NODE_TABLE_ID, BITABLE_KB_TABLE_ID, BITABLE_GLOSSARY_TABLE_ID } =
    process.env;
  if (!BITABLE_APP_TOKEN || !BITABLE_TICKET_TABLE_ID || !BITABLE_NODE_TABLE_ID) return null;
  return {
    appToken: BITABLE_APP_TOKEN,
    ticketTableId: BITABLE_TICKET_TABLE_ID,
    nodeTableId: BITABLE_NODE_TABLE_ID,
    kbTableId: BITABLE_KB_TABLE_ID,
    glossaryTableId: BITABLE_GLOSSARY_TABLE_ID,
  };
}

interface IndexFile {
  tickets: Record<string, string>;
  nodes: Record<string, string>;
}

function readIndex(): IndexFile {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf-8')) as IndexFile;
  } catch {
    return { tickets: {}, nodes: {} };
  }
}

function writeIndex(ix: IndexFile): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(ix, null, 2), 'utf-8');
}

/** 节点行的表内去重键：主字段 + 时间。表里没有幂等键列，这两列合起来足以认出同一次事件的重复投影 */
export function nodeDedupKey(fields: Record<string, unknown>): string {
  const rec = fields['记录'];
  const text = Array.isArray(rec) ? ((rec[0] as { text?: string })?.text ?? '') : String(rec ?? '');
  return `${text}|${String(fields['时间'] ?? '')}`;
}

export class BitableBoard {
  private ix = readIndex();
  /** 表内已有行的去重键集合（primeNodeDedup 填充；未 prime 时为 undefined = 不做表级去重） */
  private primed?: Set<string>;

  constructor(
    private client: lark.Client,
    private cfg: BitableCfg,
  ) {}

  static fromEnv(): BitableBoard | null {
    const cfg = bitableCfgFromEnv();
    const { FEISHU_APP_ID, FEISHU_APP_SECRET } = process.env;
    if (!cfg || !FEISHU_APP_ID || !FEISHU_APP_SECRET) return null;
    return new BitableBoard(new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET }), cfg);
  }

  /** 工单行 upsert：本地索引命中则更新，否则按工单号搜索，仍无则新建 */
  async upsertTicket(ticket: string, fields: Record<string, unknown>): Promise<string> {
    let recordId = this.ix.tickets[ticket] ?? (await this.findTicketRecord(ticket));
    if (recordId) {
      await this.client.bitable.appTableRecord.update({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.ticketTableId, record_id: recordId },
        data: { fields: fields as Record<string, never> },
      });
    } else {
      const res = (await this.client.bitable.appTableRecord.create({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.ticketTableId },
        data: { fields: fields as Record<string, never> },
      })) as { data?: { record?: { record_id?: string } } };
      recordId = res?.data?.record?.record_id ?? '';
    }
    if (recordId) {
      this.ix.tickets[ticket] = recordId;
      writeIndex(this.ix);
    }
    return recordId;
  }

  /**
   * 拉全表建「记录|时间」去重集合，供 appendNode 在本地索引失效时兜底。
   *
   * 幂等键（ticket|ts|type|摘要指纹）只存在 data/bitable-index.json 里，表里没有这一列，
   * 所以索引一旦丢失/被重置，去重就完全失效。实测代价（2026-08-25）：索引为空时跑一次
   * bitable-backfill，205 行节点表被翻成 408 行、203 组重复。
   * 一次列表调用换掉这个隐患，比每次 append 都查一次便宜，也不拖慢 daemon 的常规路径。
   * 返回已存在的行数。
   */
  async primeNodeDedup(): Promise<number> {
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let p = 0; p < 40; p++) {
      const res = (await this.client.bitable.appTableRecord.list({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.nodeTableId },
        params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
      })) as { data?: { items?: Array<{ fields?: Record<string, unknown> }>; page_token?: string; has_more?: boolean } };
      for (const it of res.data?.items ?? []) seen.add(nodeDedupKey(it.fields ?? {}));
      if (!res.data?.has_more || !res.data.page_token) break;
      pageToken = res.data.page_token;
    }
    this.primed = seen;
    return seen.size;
  }

  /** 节点行 append：按幂等键去重，重复投影不产生重复行 */
  async appendNode(key: string, fields: Record<string, unknown>, ticketRecordId?: string): Promise<void> {
    if (this.ix.nodes[key]) return;
    // 本地索引没有它，但表里可能已经有了（索引丢失后的重放）——priming 过就以表为准
    const dedupKey = nodeDedupKey(fields);
    if (this.primed?.has(dedupKey)) {
      this.ix.nodes[key] = 'existing';
      writeIndex(this.ix);
      return;
    }
    const payload = { ...fields };
    if (ticketRecordId) payload['工单'] = [ticketRecordId];
    let res: { data?: { record?: { record_id?: string } } };
    try {
      res = (await this.client.bitable.appTableRecord.create({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.nodeTableId },
        data: { fields: payload as Record<string, never> },
      })) as { data?: { record?: { record_id?: string } } };
    } catch (e) {
      // 关联字段可能未建/格式不符：去掉关联再写一次，宁可少一个链接也要留下记录
      if (!ticketRecordId) throw e;
      delete payload['工单'];
      res = (await this.client.bitable.appTableRecord.create({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.nodeTableId },
        data: { fields: payload as Record<string, never> },
      })) as { data?: { record?: { record_id?: string } } };
    }
    this.ix.nodes[key] = res?.data?.record?.record_id ?? 'created';
    this.primed?.add(dedupKey); // 同一次运行里重复的事件也不再重复写
    writeIndex(this.ix);
  }

  /** 只改工单行的部分字段（如回填交付文档链接），不重算整行 */
  async patchTicket(ticket: string, fields: Record<string, unknown>): Promise<void> {
    const recordId = this.ix.tickets[ticket] ?? (await this.findTicketRecord(ticket));
    if (!recordId) return;
    await this.client.bitable.appTableRecord.update({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.ticketTableId, record_id: recordId },
      data: { fields: fields as Record<string, never> },
    });
  }

  /** 知识条目 upsert：同标题视为同一条知识，跨工单更新而不是堆重复。新建为「待审」，更新不动状态（人定的状态只有人能改） */
  async upsertKnowledge(entry: KnowledgeEntry): Promise<'created' | 'updated' | 'skipped'> {
    if (!this.cfg.kbTableId) return 'skipped';
    const fields: Record<string, unknown> = {
      标题: entry.title.slice(0, 200),
      项目: entry.project ?? '',
      适用范围: KB_SCOPES.includes(entry.scope ?? '') ? entry.scope : '本项目',
      类型: KB_KINDS.includes(entry.kind) ? entry.kind : '踩坑',
      标签: (entry.tags ?? []).join('、').slice(0, 200),
      现象: (entry.symptom ?? '').slice(0, 900),
      根因: (entry.cause ?? '').slice(0, 900),
      正确做法: (entry.practice ?? '').slice(0, 900),
      来源工单: entry.ticket ?? '',
      记录时间: Date.now(),
    };
    if (entry.evidence?.startsWith('http')) fields['证据'] = { text: '证据', link: entry.evidence };

    const existing = await this.findRecord(this.cfg.kbTableId, '标题', entry.title);
    if (existing) {
      await this.client.bitable.appTableRecord.update({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.kbTableId, record_id: existing },
        data: { fields: fields as Record<string, never> },
      });
      return 'updated';
    }
    const createFields: Record<string, unknown> = { ...fields, 状态: '待审' };
    await this.client.bitable.appTableRecord.create({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.kbTableId },
      data: { fields: createFields as Record<string, never> },
    });
    return 'created';
  }

  /** 状态门流转（人审卡采纳 → 生效；纠错 → 已失效）。找不到该标题返回 false */
  async setKnowledgeStatus(title: string, status: string): Promise<boolean> {
    if (!this.cfg.kbTableId) return false;
    const recordId = await this.findRecord(this.cfg.kbTableId, '标题', title);
    if (!recordId) return false;
    const statusField: Record<string, unknown> = { 状态: status };
    await this.client.bitable.appTableRecord.update({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.kbTableId, record_id: recordId },
      data: { fields: statusField as Record<string, never> },
    });
    return true;
  }

  /** 拉取全部知识条目（供开工前预取提示） */
  async listKnowledge(): Promise<KnowledgeEntry[]> {
    if (!this.cfg.kbTableId) return [];
    const res = (await this.client.bitable.appTableRecord.list({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.kbTableId },
      params: { page_size: 200 },
    })) as { data?: { items?: Array<{ fields?: Record<string, unknown> }> } };
    return (res?.data?.items ?? []).map((it) => {
      const f = it.fields ?? {};
      const s = (k: string): string => textOf(f[k]);
      return {
        title: s('标题'),
        kind: s('类型') || '踩坑',
        scope: s('适用范围') || '本项目',
        status: s('状态') || undefined,
        project: s('项目') || undefined,
        tags: s('标签') ? s('标签').split(/[、,，]/).filter(Boolean) : [],
        symptom: s('现象'),
        cause: s('根因'),
        practice: s('正确做法'),
        ticket: s('来源工单'),
        evidence: linkOf(f['证据']),
      };
    }).filter((e) => e.title);
  }

  /** 术语 upsert：同「术语」视为同一词条；新建为「待审」，更新不动状态（与知识表同规则） */
  async upsertTerm(t: Term): Promise<'created' | 'updated' | 'skipped'> {
    if (!this.cfg.glossaryTableId) return 'skipped';
    const fields: Record<string, unknown> = {
      术语: t.term.slice(0, 100),
      定义: t.definition.slice(0, 900),
      禁用同义词: (t.banned ?? []).join('、').slice(0, 200),
      所属域: t.domain ?? '',
      项目: t.project ?? '',
      来源工单: t.ticket ?? '',
      记录时间: Date.now(),
    };
    const existing = await this.findRecord(this.cfg.glossaryTableId, '术语', t.term);
    if (existing) {
      await this.client.bitable.appTableRecord.update({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.glossaryTableId, record_id: existing },
        data: { fields: fields as Record<string, never> },
      });
      return 'updated';
    }
    const createFields: Record<string, unknown> = { ...fields, 状态: '待审' };
    await this.client.bitable.appTableRecord.create({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.glossaryTableId },
      data: { fields: createFields as Record<string, never> },
    });
    return 'created';
  }

  async setTermStatus(term: string, status: string): Promise<boolean> {
    if (!this.cfg.glossaryTableId) return false;
    const recordId = await this.findRecord(this.cfg.glossaryTableId, '术语', term);
    if (!recordId) return false;
    const statusField: Record<string, unknown> = { 状态: status };
    await this.client.bitable.appTableRecord.update({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.glossaryTableId, record_id: recordId },
      data: { fields: statusField as Record<string, never> },
    });
    return true;
  }

  /** 拉取全部术语（供预取与 /run 命中） */
  async listGlossary(): Promise<Term[]> {
    if (!this.cfg.glossaryTableId) return [];
    const res = (await this.client.bitable.appTableRecord.list({
      path: { app_token: this.cfg.appToken, table_id: this.cfg.glossaryTableId },
      params: { page_size: 200 },
    })) as { data?: { items?: Array<{ fields?: Record<string, unknown> }> } };
    return (res?.data?.items ?? [])
      .map((it) => {
        const f = it.fields ?? {};
        const s = (k: string): string => textOf(f[k]);
        return {
          term: s('术语'),
          definition: s('定义'),
          banned: s('禁用同义词') ? s('禁用同义词').split(/[、,，]/).filter(Boolean) : [],
          domain: s('所属域') || undefined,
          status: s('状态') || undefined,
          project: s('项目') || undefined,
          ticket: s('来源工单') || undefined,
        };
      })
      .filter((t) => t.term);
  }

  private async findRecord(tableId: string, fieldName: string, value: string): Promise<string | undefined> {
    try {
      const res = (await this.client.bitable.appTableRecord.search({
        path: { app_token: this.cfg.appToken, table_id: tableId },
        data: { filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [value] }] } },
        params: { page_size: 1 },
      })) as { data?: { items?: Array<{ record_id?: string }> } };
      return res?.data?.items?.[0]?.record_id;
    } catch {
      return undefined;
    }
  }

  private async findTicketRecord(ticket: string): Promise<string | undefined> {
    try {
      const res = (await this.client.bitable.appTableRecord.search({
        path: { app_token: this.cfg.appToken, table_id: this.cfg.ticketTableId },
        data: {
          filter: { conjunction: 'and', conditions: [{ field_name: '工单号', operator: 'is', value: [ticket] }] },
        },
        params: { page_size: 1 },
      })) as { data?: { items?: Array<{ record_id?: string }> } };
      return res?.data?.items?.[0]?.record_id;
    } catch {
      return undefined; // 搜索失败就当没有，交给 create（最坏情况多一行，好过丢记录）
    }
  }
}

/** 建板：创建多维表格 + 两张表 + 关联字段 + 看板视图，并把所有者授权给使用者 */
export async function createBoard(
  client: lark.Client,
  name: string,
  ownerOpenId?: string,
): Promise<{ appToken: string; ticketTableId: string; nodeTableId: string; url: string }> {
  const app = (await client.bitable.app.create({ data: { name, time_zone: 'Asia/Shanghai' } })) as {
    data?: { app?: { app_token?: string; url?: string } };
  };
  const appToken = app?.data?.app?.app_token;
  if (!appToken) throw new Error('创建多维表格失败：未返回 app_token');

  const mk = async (tableName: string, fields: FieldDef[]): Promise<string> => {
    const res = (await client.bitable.appTable.create({
      path: { app_token: appToken },
      data: { table: { name: tableName, fields: fields as never } },
    })) as { data?: { table_id?: string } };
    const id = res?.data?.table_id;
    if (!id) throw new Error(`创建表 ${tableName} 失败`);
    return id;
  };

  const ticketTableId = await mk(TICKET_TABLE, TICKET_FIELDS);
  const nodeTableId = await mk(NODE_TABLE, NODE_FIELDS);

  // 节点表关联到工单表（建表后才知道 table_id）
  try {
    await client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: nodeTableId },
      data: nodeLinkField(ticketTableId) as never,
    });
  } catch (e) {
    console.warn(`关联字段创建失败（节点表仍有「工单号」文本字段可分组）：${(e as Error).message}`);
  }

  // 看板视图（分组字段需在界面上选一次「当前阶段」）
  try {
    await client.bitable.appTableView.create({
      path: { app_token: appToken, table_id: ticketTableId },
      data: { view_name: '看板', view_type: 'kanban' },
    });
  } catch (e) {
    console.warn(`看板视图创建失败（可在界面手动新建）：${(e as Error).message}`);
  }

  // 默认建出来的空表删掉，避免看板里多一张没用的表
  try {
    const tables = (await client.bitable.appTable.list({ path: { app_token: appToken } })) as {
      data?: { items?: Array<{ table_id?: string; name?: string }> };
    };
    for (const t of tables?.data?.items ?? []) {
      if (t.table_id && t.table_id !== ticketTableId && t.table_id !== nodeTableId) {
        await client.bitable.appTable.delete({ path: { app_token: appToken, table_id: t.table_id } });
      }
    }
  } catch {
    /* 删不掉无妨 */
  }

  if (ownerOpenId) {
    try {
      await client.drive.permissionMember.create({
        path: { token: appToken },
        params: { type: 'bitable' },
        data: { member_type: 'openid', member_id: ownerOpenId, perm: 'full_access' },
      });
    } catch (e) {
      console.warn(`授权使用者失败，需手动分享：${(e as Error).message}`);
    }
  }

  return { appToken, ticketTableId, nodeTableId, url: app?.data?.app?.url ?? `https://feishu.cn/base/${appToken}` };
}
