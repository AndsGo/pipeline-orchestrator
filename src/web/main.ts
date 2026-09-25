// web 服务入口（路由与挂载规则见 server.ts）
import fs from 'node:fs';
import path from 'node:path';
import { gitlabJobs } from '../gitlab/routes.js';
import { dataDir } from '../paths.js';
import { createWebServer, log, mountRoutes } from './server.js';

/**
 * 停止信号（与 daemon 的 data/daemon.stop 同一约定）：看门狗拉起的 web 是提权进程，普通 shell 杀不动。
 * 有 MR 评审在跑就等它跑完再退；启动即清掉残留信号，否则一起来就自杀。
 */
function startStopPoller(stopFile: string): void {
  fs.rmSync(stopFile, { force: true });
  let waitingLogged = false;
  setInterval(() => {
    if (!fs.existsSync(stopFile)) return;
    if (gitlabJobs.pending > 0) {
      if (!waitingLogged) log(`收到停止信号，但有 ${gitlabJobs.pending} 个 MR 评审在跑或排队，等它们结束再退出`);
      waitingLogged = true;
      return;
    }
    fs.rmSync(stopFile, { force: true });
    log('收到停止信号（data/web.stop），自行退出；看门狗会以最新代码拉起');
    process.exit(0);
  }, 5_000);
}

const mounts = mountRoutes(process.env);
const port = Number(process.env.GITLAB_WEBHOOK_PORT ?? 8377);
createWebServer(mounts).listen(port, () => log(`web 服务已启动 :${port}（数据目录 ${dataDir()}）——${mounts.summary.join('；')}`));
startStopPoller(path.join(dataDir(), 'web.stop'));
process.on('SIGTERM', () => process.exit(0));
