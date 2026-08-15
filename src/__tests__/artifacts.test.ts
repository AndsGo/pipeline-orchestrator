import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acDigest, gateDetail, scopeDigest, section, taskDigest } from '../artifacts.js';

const PRD = `---
ticket: T-1
---

## 本阶段结论
做一个永不过期的 key。

## 范围

**In：**
- 新增"永不过期"选项
- 后端签发不带 exp

**Out：**
- 不做 key 吊销名单

## 需求描述
R-1 …

## 验收标准（AC 清单）

### AC-1: 选择"永不过期"时签发的 JWT 不含 exp 声明（验证 R-1）
**Given** 管理员选择永不过期
**验证方式：** 自动 — \`go test ./internal/handler\`

### AC-2: 既有 30/60/90 天档位不受影响（回归，验证 R-1）
**验证方式：** 自动 — 现有用例保持通过

### AC-5: 弹窗新增"永不过期"选项（验证 R-2）
**验证方式：** 人工 — 打开弹窗检查选项列表

## 非功能要求
无
`;

const PLAN = `## 审批摘要

- **改动范围**：后端 3 文件 + 前端 2 文件
- **主要风险**：吊销依赖 App Secret 轮换
- **回滚方式**：单个 MR revert

## 本阶段结论
6 个任务。

### Task 1: 无过期签名原语（覆盖：AC-1）
- [ ] Step 1

### Task 2: 签发接口与响应契约（覆盖：AC-1, AC-2）
- [ ] Step 1
`;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'art-test-'));
const dir = path.join(repo, 'docs/pipeline/T-1');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '10-prd.md'), PRD, 'utf-8');
fs.writeFileSync(path.join(dir, '20-plan.md'), PLAN, 'utf-8');
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('工件提取', () => {
  it('AC 清单带自动/人工标记，去掉冗余的验证 R-n 后缀', () => {
    const d = acDigest(PRD);
    expect(d.split('\n')).toHaveLength(3);
    expect(d).toContain('🤖 **AC-1** 选择"永不过期"时签发的 JWT 不含 exp 声明');
    expect(d).toContain('🙋 **AC-5**');
    expect(d).not.toContain('验证 R-1');
  });

  it('范围拆成"做/不做"两段', () => {
    const s = scopeDigest(PRD);
    expect(s).toContain('**做**');
    expect(s).toContain('新增"永不过期"选项');
    expect(s).toContain('**不做**');
    expect(s).toContain('不做 key 吊销名单');
  });

  it('任务清单只取标题行，保留覆盖的 AC', () => {
    const t = taskDigest(PLAN);
    expect(t.split('\n')).toHaveLength(2);
    expect(t).toContain('**Task 2** 签发接口与响应契约（覆盖：AC-1, AC-2）');
    expect(t).not.toContain('Step 1'); // 步骤细节不进卡片
  });

  it('section 只取指定小节，不越界到下一节', () => {
    expect(section(PLAN, '审批摘要')).toContain('回滚方式');
    expect(section(PLAN, '审批摘要')).not.toContain('6 个任务');
  });
});

describe('卡点决策材料组装', () => {
  it('prd-confirm 给出范围 + AC 清单', () => {
    const d = gateDetail('prd-confirm', repo, 'T-1');
    expect(d).toContain('**范围**');
    expect(d).toContain('验收标准（3 条');
    expect(d).toContain('AC-5');
  });

  it('plan-approval 给出审批摘要 + 任务拆分', () => {
    const d = gateDetail('plan-approval', repo, 'T-1');
    expect(d).toContain('回滚方式');
    expect(d).toContain('任务拆分（2 个）');
  });

  it('工件缺失或未知卡点时返回空串，卡片退回纯摘要而不是报错', () => {
    expect(gateDetail('prd-confirm', repo, 'NOPE')).toBe('');
    expect(gateDetail('unknown-gate', repo, 'T-1')).toBe('');
  });

  it('超长内容被截断并提示看全文', () => {
    const big = path.join(repo, 'docs/pipeline/BIG');
    fs.mkdirSync(big, { recursive: true });
    const many = Array.from({ length: 200 }, (_, i) => `### AC-${i + 1}: ${'很长的验收标准描述'.repeat(6)}\n**验证方式：** 人工 — x\n`).join('\n');
    fs.writeFileSync(path.join(big, '10-prd.md'), `## 范围\n**In：**\n- x\n\n${many}`, 'utf-8');
    const d = gateDetail('prd-confirm', repo, 'BIG');
    expect(d.length).toBeLessThan(3200);
    expect(d).toContain('全文见工件');
  });
});
