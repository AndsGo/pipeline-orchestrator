import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行时数据目录（工单快照、事件日志、锁、暂停信号、看板索引……）的唯一解析点。
 *
 * 此前 `path.resolve(dirname(import.meta.url), '../data')` 在十来个文件里各写一份，
 * 测试没有办法把它们一起指到别处——runTicket 一直没有端到端测试，一部分原因就是跑一次会往真 data/ 里写。
 * 每次调用时读环境变量而不是在 import 时定死：测试可以先设 PIPELINE_DATA_DIR 再用，不必操心模块加载顺序。
 */
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

export function dataDir(): string {
  const env = process.env.PIPELINE_DATA_DIR?.trim();
  return env ? path.resolve(env) : DEFAULT_DATA_DIR;
}
