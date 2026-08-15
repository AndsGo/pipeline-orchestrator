// 暂停/恢复工单：node scripts/pause.mjs LS-003 [--clear]
// bridge bot 可代执行；编排器在下一个阶段边界安全停住
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [ticket, flag] = process.argv.slice(2);
if (!ticket) {
  console.error('用法: node scripts/pause.mjs <ticket> [--clear]');
  process.exit(1);
}
const f = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../data/${ticket}.pause`);
if (flag === '--clear') {
  fs.rmSync(f, { force: true });
  console.log(`${ticket} 暂停信号已清除（配合 start-ticket 续跑）`);
} else {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), by: 'cli' }), 'utf-8');
  console.log(`${ticket} 将在下一个阶段边界暂停`);
}
