import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProfile } from '../profile.js';

/**
 * 浏览器 e2e（Playwright MCP）：项目约定 `e2e: playwright` 打开后，验收/评审阶段的会话带浏览器工具，
 * 人工验收项先在 testEnv 上实测，判不了的才落成人工卡。
 *
 * 两个引擎的配方都是 2026-09-05 真机探针跑通的：
 * - claude -p：`--mcp-config <json> --strict-mcp-config --allowedTools …,mcp__playwright`（4 轮 $0.23 读到 lakeghost 首页）。
 * - codex exec：`--ignore-user-config`（否则模型会去用内建 cua_repl 找已开的 Chrome）+ 显式 stdio server
 *   `-c mcp_servers.playwright.command/args` + `--approve-for-me`（exec 默认永不审批，browser_navigate 会被静默拒在 about:blank）。
 * 只给读为主的阶段开：自动审批不该给 implement 这种会改代码的阶段。
 */

export const E2E_STAGES = new Set(['acceptance', 'review']);

export const PLAYWRIGHT_MCP = { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] } as const;

export function e2eEnabledFor(repo: string, stage: string): boolean {
  if (!E2E_STAGES.has(stage)) return false;
  return readProfile(repo)?.e2e === 'playwright';
}

/** claude -p 用的 MCP 配置文件内容 */
export function claudeMcpConfig(): { mcpServers: Record<string, { command: string; args: string[] }> } {
  return { mcpServers: { playwright: { command: PLAYWRIGHT_MCP.command, args: [...PLAYWRIGHT_MCP.args] } } };
}

/** 落一份临时 MCP 配置文件给 claude -p 读，返回路径（调用方用完删） */
export function writeClaudeMcpConfig(): string {
  const f = path.join(os.tmpdir(), `pipeline-mcp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fs.writeFileSync(f, JSON.stringify(claudeMcpConfig()), 'utf-8');
  return f;
}

/** codex exec 用的额外参数 */
export function codexE2eArgs(): string[] {
  return [
    '--ignore-user-config',
    '--approve-for-me',
    '-c',
    `mcp_servers.playwright.command="${PLAYWRIGHT_MCP.command}"`,
    '-c',
    `mcp_servers.playwright.args=[${PLAYWRIGHT_MCP.args.map((a) => `"${a}"`).join(',')}]`,
  ];
}

/** 写进提示词/项目节选的一句话：会话据此知道自己有浏览器、该去哪测 */
export function e2eBriefLine(testEnvUrl: string | undefined): string {
  return `浏览器 e2e 可用（Playwright MCP：browser_navigate / browser_snapshot / browser_click / browser_take_screenshot 等）。${
    testEnvUrl ? `测试环境 ${testEnvUrl}。` : ''
  }验收/评审的页面类检查项先在浏览器里实测并记录证据（快照文字或截图路径），只有真判不了的才留给人。`;
}
