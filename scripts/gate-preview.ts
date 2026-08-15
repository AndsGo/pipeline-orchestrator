// 预览某个卡点将呈现的决策材料：npx tsx scripts/gate-preview.ts <repo> <ticket> <gate>
import { gateDetail } from '../src/artifacts.js';

const [repo, ticket, gate] = process.argv.slice(2);
if (!repo || !ticket || !gate) {
  console.error('用法: npx tsx scripts/gate-preview.ts <repo> <ticket> <prd-confirm|plan-approval|deploy-approval>');
  process.exit(1);
}
const d = gateDetail(gate, repo, ticket);
console.log(d || '（无可提取内容，卡片将退回纯摘要）');
console.log(`\n--- 长度 ${d.length} 字符 ---`);
