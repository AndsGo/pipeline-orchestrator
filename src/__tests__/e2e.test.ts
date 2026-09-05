import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeMcpConfig, codexE2eArgs, e2eBriefLine, e2eEnabledFor, E2E_STAGES } from '../engine/e2e.js';
import { parseProfile, stageBrief } from '../profile.js';

describe('浏览器 e2e 开关（PIPELINE.md 的 e2e: playwright，2026-09-05 两引擎探针配方）', () => {
  it('profile 解析：e2e: playwright → playwright；其它/缺省 → null', () => {
    expect(parseProfile('---\ne2e: playwright   # 注释\n---').e2e).toBe('playwright');
    expect(parseProfile('---\ne2e: cypress\n---').e2e).toBeNull();
    expect(parseProfile('---\nrelease: none\n---').e2e).toBeNull();
  });

  it('只给验收/评审开；按仓库约定判断；没有约定文件 → 关', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
    try {
      expect(e2eEnabledFor(dir, 'acceptance')).toBe(false);
      fs.mkdirSync(path.join(dir, 'docs', 'pipeline'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'pipeline', 'PIPELINE.md'), '---\ne2e: playwright\ntestEnv: http://localhost:5173\n---\n', 'utf-8');
      expect(e2eEnabledFor(dir, 'acceptance')).toBe(true);
      expect(e2eEnabledFor(dir, 'review')).toBe(true);
      expect(e2eEnabledFor(dir, 'implement')).toBe(false); // 自动审批不给会改代码的阶段
      expect([...E2E_STAGES].sort()).toEqual(['acceptance', 'review']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claude 侧：MCP 配置只挂 playwright 一个 stdio server（--strict-mcp-config 配合）', () => {
    expect(claudeMcpConfig()).toEqual({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] } } });
  });

  it('codex 侧：忽略用户配置 + 自动审批 + 显式声明 playwright server（缺任一探针都停在 about:blank 或走 cua_repl）', () => {
    const a = codexE2eArgs();
    expect(a).toContain('--ignore-user-config');
    expect(a).toContain('--approve-for-me');
    expect(a.join(' ')).toContain('mcp_servers.playwright.command="npx"');
    expect(a.join(' ')).toContain('mcp_servers.playwright.args=["-y","@playwright/mcp@latest","--headless"]');
  });

  it('阶段节选与提示词行：验收/评审带浏览器说明与测试环境地址，implement 不带', () => {
    const p = parseProfile('---\ne2e: playwright\ntestEnv: http://localhost:5173\n---\n## acceptance\n去任务中心。');
    expect(stageBrief(p, 'acceptance')).toContain('浏览器 e2e：可用');
    expect(stageBrief(p, 'acceptance')).toContain('http://localhost:5173');
    expect(stageBrief(p, 'implement') ?? '').not.toContain('浏览器 e2e');
    expect(e2eBriefLine('http://localhost:5173')).toContain('browser_navigate');
    expect(e2eBriefLine(undefined)).not.toContain('测试环境 ');
  });
});
