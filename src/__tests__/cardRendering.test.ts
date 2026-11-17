import { describe, expect, it } from 'vitest';
import { resultCard, gateCard } from '../feishu/card.js';
import { renderRequirementCard, type RequirementCard } from '../requirements.js';

const card: RequirementCard = {
  title: '刊登重量优先级', problem: '当前重量不符合预期', expected: '包装重量 > 质检毛重 > 开发重量',
  acceptance: '有包装重量时优先取包装重量', questions: ['三个重量都为空时如何处理？'],
  facts: ['用户提供了优先级'], assumptions: [], splits: [], ready: false,
};
const bodyOf = (value: Record<string, unknown>) => (value.elements as Array<{ text?: { content: string } }>)[0].text!.content;

describe('飞书需求卡片展示', () => {
  it('结果卡显示加粗分节和列表，存储的标准 Markdown 不变', () => {
    const markdown = renderRequirementCard(card);
    const body = bodyOf(resultCard('需求结果', markdown));
    expect(body).toContain('**当前问题**');
    expect(body).toContain('• 三个重量都为空时如何处理？');
    expect(body).not.toMatch(/^#{1,6} /m);
    expect(body).toContain(card.expected);
    expect(markdown).toContain('## 当前问题');
  });
  it('确认卡同样转换，保留链接、行内代码和代码块里的标题/列表', () => {
    const code = '```markdown\n# literal\n- literal\n```';
    const body = bodyOf(gateCard('REQ-001', '需求确认', `## **范围**\n- [说明](https://example.com) 和 \`weight\`\n${code}`, [], 'key'));
    expect(body).toContain('**范围**');
    expect(body).toContain('• [说明](https://example.com) 和 `weight`');
    expect(body).toContain(code);
  });
});
