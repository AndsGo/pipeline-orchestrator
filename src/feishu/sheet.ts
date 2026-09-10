import fs from 'node:fs';
import path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { colLetter, coverRange, parseCsv, rectangular, toCsv } from '../sheetCsv.js';

/**
 * 在线电子表格（会话产出的表格类文件不再来回传 xlsx，而是「机器人建表、人和会话都往同一张表里写」）。
 * 权限模型：表由应用创建（应用是 owner），共享设为组织内可编辑——人点链接就能改，不用逐张表加协作者；
 * 反过来让应用去改人建的表，每张都要人手动加应用为协作者，业务方一定会忘。
 * 需要的应用权限：drive:drive、docs:document:import、sheets:spreadsheet。
 */
export interface SheetRef {
  token: string;
  url: string;
  /** 第一个工作表的 id（values 接口的 range 前缀） */
  sheetId: string;
}

/** SDK 对部分接口把 data 拆开直接返回（2026-09-10 实测 im.file.create），统一取法 */
const unwrap = <T>(res: unknown): T => {
  const r = res as { data?: T } & T;
  return (r?.data ?? r) as T;
};

export class SheetService {
  constructor(private client: lark.Client) {}

  /** 本地 csv/xlsx → 应用名下的在线电子表格；共享设为组织内可编辑；返回 token/url/首表 id */
  async importFile(file: string, title: string): Promise<SheetRef> {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (ext !== 'csv' && ext !== 'xlsx') throw new Error(`不支持导入 .${ext}（只认 csv / xlsx）`);
    const size = fs.statSync(file).size;
    // 走「上传文件到云空间根目录」而不是「上传素材(ccm_import_open)」：后者在本租户恒 1061004 forbidden
    //（2026-09-10 实测，权限齐全时也如此）；导入任务同样接受文件接口的 token，导完把源文件删掉
    const root = await this.rootFolderToken();
    const up = unwrap<{ file_token?: string }>(
      await this.client.drive.file.uploadAll({
        data: { file_name: path.basename(file), parent_type: 'explorer', parent_node: root, size, file: fs.createReadStream(file) },
      }),
    );
    if (!up?.file_token) throw new Error('文件上传未返回 file_token');
    let token: string | undefined;
    let url: string | undefined;
    try {
      const task = unwrap<{ ticket?: string }>(
        await this.client.drive.importTask.create({
          data: { file_extension: ext, file_token: up.file_token, type: 'sheet', file_name: title, point: { mount_type: 1, mount_key: '' } },
        }),
      );
      if (!task?.ticket) throw new Error('导入任务未返回 ticket');
      for (let i = 0; i < 40 && !token; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const res = unwrap<{ result?: { job_status?: number; token?: string; url?: string; job_error_msg?: string } }>(
          await this.client.drive.importTask.get({ path: { ticket: task.ticket } }),
        );
        const r = res?.result;
        if (r?.job_status === 0) {
          token = r.token;
          url = r.url;
        } else if (r?.job_status !== undefined && r.job_status > 2) {
          throw new Error(`导入失败（status ${r.job_status}）：${r.job_error_msg ?? ''}`);
        }
      }
    } finally {
      // 源文件只是导入的中转，导完（或失败）就删，别在云空间根目录攒一堆 csv
      void this.client.request({ method: 'DELETE', url: `/open-apis/drive/v1/files/${up.file_token}`, params: { type: 'file' } }).catch(() => {});
    }
    if (!token || !url) throw new Error('导入超时（60s 未完成）');
    // 组织内可编辑：群里同事点链接即可改，不用逐人加协作者。失败不致命——链接仍可由 owner 手动共享
    try {
      await this.client.drive.permissionPublic.patch({
        path: { token },
        params: { type: 'sheet' },
        data: { external_access: false, link_share_entity: 'tenant_editable', comment_entity: 'anyone_can_view', share_entity: 'anyone' },
      });
    } catch (e) {
      console.warn(`[sheet] 设置链接共享失败（表已建好，需手动共享）：${(e as Error).message.slice(0, 160)}`);
    }
    return { token, url, sheetId: await this.firstSheetId(token) };
  }

  private rootToken?: string;
  /** 应用云空间根目录（导入中转文件的落点） */
  private async rootFolderToken(): Promise<string> {
    if (this.rootToken) return this.rootToken;
    const res = unwrap<{ token?: string }>(await this.client.request({ method: 'GET', url: '/open-apis/drive/explorer/v2/root_folder/meta' }));
    if (!res?.token) throw new Error('查不到云空间根目录');
    return (this.rootToken = res.token);
  }

  private async firstSheetId(token: string): Promise<string> {
    const res = unwrap<{ sheets?: Array<{ sheet_id?: string }> }>(
      await this.client.request({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query` }),
    );
    const id = res?.sheets?.[0]?.sheet_id;
    if (!id) throw new Error('查不到工作表 id');
    return id;
  }

  /** 首表当前的行列数（values 接口对超大范围直接不返回数据，所以按实际网格读） */
  private async gridSize(ref: SheetRef): Promise<{ rows: number; cols: number }> {
    const res = unwrap<{ sheets?: Array<{ sheet_id?: string; grid_properties?: { row_count?: number; column_count?: number } }> }>(
      await this.client.request({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${ref.token}/sheets/query` }),
    );
    const g = res?.sheets?.find((s) => s.sheet_id === ref.sheetId)?.grid_properties;
    return { rows: g?.row_count ?? 0, cols: g?.column_count ?? 0 };
  }

  /** 读整张首表（按网格实际大小）；空表返回 [] */
  async readAll(ref: SheetRef): Promise<string[][]> {
    const { rows: nRows, cols: nCols } = await this.gridSize(ref);
    if (!nRows || !nCols) return [];
    const res = unwrap<{ valueRange?: { values?: unknown[][] } }>(
      await this.client.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/spreadsheets/${ref.token}/values/${ref.sheetId}!A1:${colLetter(nCols)}${nRows}`,
        params: { valueRenderOption: 'ToString' },
      }),
    );
    const values = res?.valueRange?.values ?? [];
    const rows = values.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))));
    // 去掉尾部全空行
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return rows;
  }

  /** 用 rows 覆盖首表（旧内容多出来的格子写空清掉） */
  async writeAll(ref: SheetRef, rows: string[][], oldRows: string[][]): Promise<void> {
    const { range, values } = coverRange(rectangular(rows), oldRows);
    await this.client.request({
      method: 'PUT',
      url: `/open-apis/sheets/v2/spreadsheets/${ref.token}/values`,
      data: { valueRange: { range: `${ref.sheetId}!${range}`, values } },
    });
  }

  /** 表 → 本地 csv（给会话读）。返回落盘内容，供事后比对会话有没有改 */
  async exportCsv(ref: SheetRef, file: string): Promise<string> {
    const csv = toCsv(await this.readAll(ref));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, csv, 'utf-8');
    return csv;
  }

  /** 本地 csv → 表（会话改完写回）。返回写了多少行 */
  async importCsvInto(ref: SheetRef, file: string): Promise<number> {
    const rows = parseCsv(fs.readFileSync(file, 'utf-8'));
    await this.writeAll(ref, rows, await this.readAll(ref));
    return rows.length;
  }
}
