import fs from 'node:fs';
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

/**
 * 删单个文件（不存在则忽略）。**别用 fs.rmSync 删路径里带中文的文件**：Node 24.13（Windows）的非递归 rmSync
 * 走 C++ std::filesystem，路径按 ANSI 代码页转换，遇到 CJK 直接 std::terminate——进程以 0xC0000409 无声退出，
 * 没有 JS 栈、没有 stderr、--report-on-fatalerror 也不落报告。daemon 六次「无声消失」（2026-09-10 ～ 09-12）
 * 全是写回结束后清理「结合标题描述的场景化测试结果(282条).csv」这类文件触发的。unlinkSync 走 libuv，UTF-8 路径正常。
 */
export function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
