// Jenkins 集成真机探针：走 jenkins.ts 的完整代码路径（触发→queue→build→结果→日志）
import { jenkinsConfigFromEnv, runJenkinsBuild, fetchLogTail } from '../src/jenkins.js';

const cfg = jenkinsConfigFromEnv(process.env.JENKINS_JOB);
if (!cfg) {
  console.error('缺少 JENKINS_URL / JENKINS_JOB / JENKINS_USER / JENKINS_TOKEN');
  process.exit(1);
}
console.log(`[probe] 触发 ${cfg.job} …`);
const r = await runJenkinsBuild(cfg, { TICKET: 'PROBE-1', BRANCH: 'probe/test' }, fetch, (m) => console.log('[probe]', m));
console.log(`[probe] 结果：${r.result} | build #${r.buildNumber} | ${r.buildUrl ?? ''}`);
if (r.ok && r.buildUrl) {
  if (process.env.PROBE_EXPECT_PARAMS === '0') {
    console.log('[probe] PASS（无参数任务模式：仅验证触发/轮询/结果链路）');
    process.exit(0);
  }
  const log = await fetchLogTail(cfg, r.buildUrl, fetch, 1500);
  const hasParams = log.includes('TICKET=PROBE-1') && log.includes('BRANCH=probe/test');
  console.log(`[probe] 参数透传：${hasParams ? 'PASS' : 'FAIL（日志里没找到 TICKET/BRANCH 回显）'}`);
  process.exit(hasParams ? 0 : 1);
}
console.log('[probe] FAIL，日志尾部：\n' + r.logTail.slice(-1500));
process.exit(1);
