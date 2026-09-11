// 在线表写回的子进程入口（由 src/sheetWriteback.runSheetWorker 拉起）：
//   node node_modules/tsx/dist/cli.mjs scripts/sheet-writeback.ts <job.json>
// 干活的逻辑全在 src/sheetWriteback.processSheet；这里只负责读任务、建客户端、把结果 JSON 打到 stdout 最后一行。
// 为什么是子进程：大批量嵌图曾三次让 daemon 无声退出（0xC0000409），崩就崩在这里，别带走飞书长连接。
import fs from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import { SheetService } from '../src/feishu/sheet.js';
import { processSheet, type SheetJob } from '../src/sheetWriteback.js';

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, error: '缺任务文件参数' }));
  process.exit(2);
}
try {
  const job = JSON.parse(fs.readFileSync(file, 'utf-8')) as SheetJob;
  const client = new lark.Client({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!, loggerLevel: 1 as never });
  const result = await processSheet(new SheetService(client), job);
  console.log(JSON.stringify({ ok: true, result }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: (e as Error).message.slice(0, 300) }));
  process.exit(1);
}
