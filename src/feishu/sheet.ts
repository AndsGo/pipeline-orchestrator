import fs from 'node:fs';
import path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { colLetter, coverRange, linkifyCells, parseCsv, rectangular, sheetFileName, toCsv, trimEmpty } from '../sheetCsv.js';

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
  /** 表名（建附件夹时用） */
  title?: string;
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
    return { token, url, sheetId: await this.firstSheetId(token), title };
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

  /**
   * 附件夹：每张在线表配一个云空间文件夹（<表名>-附件，组织内可读），会话产出的图片传进去、表格单元格放链接——
   * 图片不再刷进群（2026-09-10 真机：一轮 30 张图发进话题，用户要求「追加到在线表格中即可」）
   */
  async ensureAssetsFolder(title: string): Promise<string> {
    const root = await this.rootFolderToken();
    const res = unwrap<{ token?: string }>(
      await this.client.request({ method: 'POST', url: '/open-apis/drive/v1/files/create_folder', data: { name: `${title}-附件`, folder_token: root } }),
    );
    if (!res?.token) throw new Error('建附件夹未返回 token');
    // 文件夹的公开权限接口对 folder 恒「field validation failed」（2026-09-10 实测三种字段组合），共享放到每个文件上做
    return res.token;
  }

  /** 上传一个附件到附件夹并设为组织内可读，返回可点开的链接 */
  async uploadAsset(folderToken: string, file: string): Promise<string> {
    const up = unwrap<{ file_token?: string; url?: string }>(
      await this.client.drive.file.uploadAll({
        data: { file_name: path.basename(file), parent_type: 'explorer', parent_node: folderToken, size: fs.statSync(file).size, file: fs.createReadStream(file) },
      }),
    );
    if (!up?.file_token) throw new Error(`上传 ${path.basename(file)} 未返回 file_token`);
    try {
      await this.client.drive.permissionPublic.patch({
        path: { token: up.file_token },
        params: { type: 'file' },
        data: { external_access: false, link_share_entity: 'tenant_readable', share_entity: 'anyone' },
      });
    } catch (e) {
      console.warn(`[sheet] 附件共享设置失败 ${path.basename(file)}（已上传，链接可能打不开）：${(e as Error).message.slice(0, 120)}`);
    }
    return up.url ?? `https://open.feishu.cn/open-apis/drive/v1/files/${up.file_token}`;
  }

  /** 全部工作表（导入的 xlsx 常有多个 sheet 页；2026-09-10 首个真机文件就有 3 页） */
  async listSheets(ref: SheetRef): Promise<Worksheet[]> {
    const res = unwrap<{ sheets?: Array<{ sheet_id?: string; title?: string; grid_properties?: { row_count?: number; column_count?: number } }> }>(
      await this.client.request({ method: 'GET', url: `/open-apis/sheets/v3/spreadsheets/${ref.token}/sheets/query` }),
    );
    return (res?.sheets ?? [])
      .filter((s) => s.sheet_id)
      .map((s) => ({ id: s.sheet_id!, title: s.title ?? s.sheet_id!, rows: s.grid_properties?.row_count ?? 0, cols: s.grid_properties?.column_count ?? 0 }));
  }

  /** 读一张工作表（按网格实际大小；values 接口对超大范围静默返回空）；去掉尾部空行空列 */
  async readAll(ref: SheetRef, ws?: Worksheet): Promise<string[][]> {
    const sheet = ws ?? (await this.listSheets(ref)).find((s) => s.id === ref.sheetId);
    if (!sheet || !sheet.rows || !sheet.cols) return [];
    const res = unwrap<{ valueRange?: { values?: unknown[][] } }>(
      await this.client.request({
        method: 'GET',
        url: `/open-apis/sheets/v2/spreadsheets/${ref.token}/values/${sheet.id}!A1:${colLetter(sheet.cols)}${sheet.rows}`,
        params: { valueRenderOption: 'ToString' },
      }),
    );
    const values = res?.valueRange?.values ?? [];
    return trimEmpty(values.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))));
  }

  /** 用 rows 覆盖某工作表（旧内容多出来的格子写空清掉） */
  async writeAll(ref: SheetRef, rows: string[][], oldRows: string[][], sheetId = ref.sheetId): Promise<void> {
    const { range, values } = coverRange(rectangular(rows), oldRows);
    await this.client.request({
      method: 'PUT',
      url: `/open-apis/sheets/v2/spreadsheets/${ref.token}/values`,
      data: { valueRange: { range: `${sheetId}!${range}`, values } },
    });
  }

  /** 新增一个工作表，返回其 id */
  async addSheet(ref: SheetRef, title: string): Promise<string> {
    const res = unwrap<{ replies?: Array<{ addSheet?: { properties?: { sheetId?: string } } }> }>(
      await this.client.request({
        method: 'POST',
        url: `/open-apis/sheets/v2/spreadsheets/${ref.token}/sheets_batch_update`,
        data: { requests: [{ addSheet: { properties: { title } } }] },
      }),
    );
    const id = res?.replies?.[0]?.addSheet?.properties?.sheetId;
    if (!id) throw new Error(`新增工作表「${title}」未返回 id`);
    return id;
  }

  /**
   * 整本表 → 目录下每页一个 csv（文件名 = 工作表标题），给会话读。
   * 返回 {文件名 → csv 内容}，供事后比对会话改了哪几页
   */
  async exportDir(ref: SheetRef, dir: string): Promise<Record<string, string>> {
    fs.mkdirSync(dir, { recursive: true });
    const out: Record<string, string> = {};
    for (const ws of await this.listSheets(ref)) {
      const name = sheetFileName(ws.title);
      const csv = toCsv(await this.readAll(ref, ws));
      fs.writeFileSync(path.join(dir, name), csv, 'utf-8');
      out[name] = csv;
    }
    return out;
  }

  /**
   * 把 assets/ 里的附件上传到附件夹，并把各 csv 里的文件名替换成链接。返回 {文件名 → 链接}。
   * 单个上传失败跳过（文件名留在表里，附件本身随后按普通出件箱附件发出）
   */
  async uploadAssetsAndLinkify(sheetDir: string, folderToken: string): Promise<{ links: Record<string, string>; failed: string[] }> {
    const assetsDir = path.join(sheetDir, 'assets');
    const links: Record<string, string> = {};
    const failed: string[] = [];
    if (!fs.existsSync(assetsDir)) return { links, failed };
    for (const name of fs.readdirSync(assetsDir).sort()) {
      const f = path.join(assetsDir, name);
      if (!fs.statSync(f).isFile()) continue;
      try {
        links[name] = await this.uploadAsset(folderToken, f);
      } catch (e) {
        console.warn(`[sheet] 附件上传失败 ${name}：${(e as Error).message.slice(0, 120)}`);
        failed.push(name);
      }
    }
    if (Object.keys(links).length) {
      for (const csvName of fs.readdirSync(sheetDir).filter((n) => n.toLowerCase().endsWith('.csv'))) {
        const p = path.join(sheetDir, csvName);
        const rows = parseCsv(fs.readFileSync(p, 'utf-8'));
        const linked = linkifyCells(rows, links);
        if (JSON.stringify(linked) !== JSON.stringify(rows)) fs.writeFileSync(p, toCsv(linked), 'utf-8');
      }
    }
    return { links, failed };
  }

  /**
   * 目录 → 整本表：改过的页覆盖写回，新出现的 csv 新建工作表；目录里没有的页不动（会话没提到 ≠ 要删）。
   * 返回写回/新建的页名
   */
  async importDir(ref: SheetRef, dir: string, before: Record<string, string>): Promise<{ updated: string[]; added: string[] }> {
    const updated: string[] = [];
    const added: string[] = [];
    if (!fs.existsSync(dir)) return { updated, added };
    const sheets = await this.listSheets(ref);
    for (const name of fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')).sort()) {
      const csv = fs.readFileSync(path.join(dir, name), 'utf-8');
      if (before[name] !== undefined && before[name] === csv) continue; // 没改
      const rows = parseCsv(csv);
      const ws = sheets.find((s) => sheetFileName(s.title) === name);
      if (ws) {
        await this.writeAll(ref, rows, await this.readAll(ref, ws), ws.id);
        updated.push(ws.title);
      } else {
        const title = name.replace(/\.csv$/i, '');
        const id = await this.addSheet(ref, title);
        await this.writeAll(ref, rows, [], id);
        added.push(title);
      }
    }
    return { updated, added };
  }
}

export interface Worksheet {
  id: string;
  title: string;
  rows: number;
  cols: number;
}
