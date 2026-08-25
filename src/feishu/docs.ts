import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Markdown → 飞书云文档，并可归档进知识库。
 * 定位：单向生成的只读镜像——git 工件是权威，文档头部会写明这一点。
 */

interface ConvertedBlock {
  block_id?: string;
  children?: string[];
  [k: string]: unknown;
}

/** 单次 descendant 写入的块上限（官方 1000，留余量） */
const CHUNK = 800;

export interface PublishedDoc {
  documentId: string;
  url: string;
  blocks: number;
  truncated: boolean;
}

/**
 * 净化 convert 产物：某些字段 convert 会输出但 descendant 接口拒收。
 * 实测：表格块带 `table.property.merge_info` 时整批插入报 1770001 invalid param（只要一个表格就全军覆没）。
 * 图片块需要先单独上传素材，这里降级为一行说明，正文里已有 git 链接可查原图。
 */
export function sanitizeBlocks(blocks: ConvertedBlock[]): { blocks: ConvertedBlock[]; droppedImages: number } {
  let droppedImages = 0;
  const out = blocks.map((b) => {
    const t = b as { block_type?: number; table?: { property?: Record<string, unknown> }; image?: unknown };
    if (t.block_type === 31 && t.table?.property) {
      const { merge_info: _ignored, ...rest } = t.table.property;
      return { ...b, table: { ...t.table, property: rest } };
    }
    if (t.block_type === 27) {
      droppedImages++;
      return {
        ...b,
        block_type: 2,
        image: undefined,
        text: { elements: [{ text_run: { content: '（图片见 git 工件）' } }], style: {} },
      } as ConvertedBlock;
    }
    return b;
  });
  return { blocks: out, droppedImages };
}

/** 收集一批根块的完整子树（分批插入时不能把父子拆开） */
function subtree(roots: string[], map: Map<string, ConvertedBlock>): ConvertedBlock[] {
  const out: ConvertedBlock[] = [];
  const walk = (id: string): void => {
    const b = map.get(id);
    if (!b) return;
    out.push(b);
    for (const c of b.children ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

export async function publishMarkdownDoc(
  client: lark.Client,
  title: string,
  markdown: string,
  ownerOpenId?: string,
  folderToken?: string,
): Promise<PublishedDoc> {
  const created = (await client.docx.document.create({
    data: { title, ...(folderToken ? { folder_token: folderToken } : {}) },
  })) as { data?: { document?: { document_id?: string } } };
  const documentId = created?.data?.document?.document_id;
  if (!documentId) throw new Error('创建飞书文档失败：未返回 document_id');

  const { blocks: inserted, truncated } = await insertMarkdown(client, documentId, markdown);

  if (ownerOpenId) {
    try {
      await client.drive.permissionMember.create({
        path: { token: documentId },
        params: { type: 'docx' },
        data: { member_type: 'openid', member_id: ownerOpenId, perm: 'full_access' },
      });
    } catch (e) {
      console.warn(`文档授权失败（需手动分享）：${(e as Error).message}`);
    }
  }

  return { documentId, url: `https://feishu.cn/docx/${documentId}`, blocks: inserted, truncated };
}

/**
 * 覆盖已有文档的正文：清空根块下全部子块后重新写入。
 *
 * 用于会反复刷新的常驻文档（如能力地图）——每次新建会攒出一堆同名页，
 * 而业务人员应当只有一个固定链接。文档本身（及其 wiki 归档位置、评论、权限）保持不变。
 * 文档已被删除/无权访问时抛错，由调用方决定是否退回新建。
 */
export async function updateMarkdownDoc(
  client: lark.Client,
  documentId: string,
  markdown: string,
): Promise<PublishedDoc> {
  const existing = (await client.docx.documentBlockChildren.get({
    path: { document_id: documentId, block_id: documentId },
    params: { page_size: 500, document_revision_id: -1 },
  })) as { data?: { items?: unknown[] } };
  const count = existing?.data?.items?.length ?? 0;
  if (count) {
    await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: documentId, block_id: documentId },
      params: { document_revision_id: -1 },
      data: { start_index: 0, end_index: count },
    });
  }
  const { blocks, truncated } = await insertMarkdown(client, documentId, markdown);
  return { documentId, url: `https://feishu.cn/docx/${documentId}`, blocks, truncated };
}

/** markdown → 块并写入指定文档根部（新建与覆盖共用；分批逻辑与截断策略只此一份） */
async function insertMarkdown(
  client: lark.Client,
  documentId: string,
  markdown: string,
): Promise<{ blocks: number; truncated: boolean }> {
  const conv = (await client.docx.document.convert({
    data: { content_type: 'markdown', content: markdown },
  })) as { data?: { first_level_block_ids?: string[]; blocks?: ConvertedBlock[] } };
  const roots = conv?.data?.first_level_block_ids ?? [];
  const { blocks } = sanitizeBlocks(conv?.data?.blocks ?? []);
  if (!roots.length) throw new Error('Markdown 转换未产出块');

  const map = new Map<string, ConvertedBlock>();
  for (const b of blocks) if (b.block_id) map.set(b.block_id, b);

  // 按根块分批，保证每批的父子完整；index 累加维持顺序
  let inserted = 0;
  let index = 0;
  let truncated = false;
  let batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const descendants = subtree(batch, map);
    await client.docx.documentBlockDescendant.create({
      path: { document_id: documentId, block_id: documentId },
      params: { document_revision_id: -1 },
      data: { children_id: batch, index, descendants: descendants as never },
    });
    inserted += descendants.length;
    index += batch.length;
    batch = [];
  };

  for (const r of roots) {
    if (subtree([...batch, r], map).length > CHUNK) {
      await flush();
      if (inserted > CHUNK * 6) {
        truncated = true; // 极长文档：停止追加，正文里已有 git 链接可查全文
        break;
      }
    }
    batch.push(r);
  }
  await flush();

  return { blocks: inserted, truncated };
}

/** 把已有云文档移进知识库指定父节点，返回 wiki 链接 */
export async function moveDocToWiki(
  client: lark.Client,
  spaceId: string,
  documentId: string,
  parentNodeToken?: string,
): Promise<string | null> {
  try {
    const res = (await client.wiki.spaceNode.moveDocsToWiki({
      path: { space_id: spaceId },
      data: { obj_type: 'docx', obj_token: documentId, ...(parentNodeToken ? { parent_wiki_token: parentNodeToken } : {}) },
    })) as { data?: { wiki_token?: string; applied?: boolean; task_id?: string } };
    const token = res?.data?.wiki_token;
    return token ? `https://feishu.cn/wiki/${token}` : null;
  } catch (e) {
    console.warn(`归档进知识库失败（云文档仍可用）：${(e as Error).message}`);
    return null;
  }
}

/**
 * 幂等地取得某个目录节点：同名子节点已存在就复用，否则新建。
 * 一个知识库空间共用，项目维度靠子节点划分——不要为每个项目开独立空间。
 */
export async function ensureWikiFolder(
  client: lark.Client,
  spaceId: string,
  title: string,
  parentNodeToken?: string,
): Promise<string> {
  try {
    const res = (await client.wiki.spaceNode.list({
      path: { space_id: spaceId },
      params: { page_size: 50, ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}) },
    })) as { data?: { items?: Array<{ title?: string; node_token?: string }> } };
    const hit = (res?.data?.items ?? []).find((n) => n.title === title);
    if (hit?.node_token) return hit.node_token;
  } catch {
    /* 列不出来就直接建 */
  }
  return createWikiFolder(client, spaceId, title, parentNodeToken);
}

/** 在知识库里建一个父节点（分类目录），返回 node_token */
export async function createWikiFolder(
  client: lark.Client,
  spaceId: string,
  title: string,
  parentNodeToken?: string,
): Promise<string> {
  const res = (await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: { obj_type: 'docx', node_type: 'origin', title, ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}) },
  })) as { data?: { node?: { node_token?: string } } };
  const token = res?.data?.node?.node_token;
  if (!token) throw new Error(`创建知识库节点「${title}」失败`);
  return token;
}
