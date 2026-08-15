// 预览：斜杠指令确认卡上会写什么（改 slashTarget.ts 后拿真实仓库比对一眼）
import { PLUGIN_DIR } from '../src/config.js';
import { describeSlashTarget, resolveSlashTarget } from '../src/slashTarget.js';

const repo = process.argv[2] ?? 'D:/work/lake_spirit';
for (const t of process.argv.slice(3).length ? process.argv.slice(3) : ['/docker-push', '/docker_push']) {
  const r = resolveSlashTarget(repo, t, PLUGIN_DIR);
  console.log(`==== ${t} → ${r.kind}${r.suggestion ? `（建议 /${r.suggestion}）` : ''}`);
  if (r.kind !== 'unknown') console.log(describeSlashTarget(r, 'lakeghost'));
  console.log();
}
