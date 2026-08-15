// GitLab webhook 入站服务：MR 评论含触发词 → 独立 review → 回帖
// 启动：npm run webhook（需 GITLAB_* 环境变量，见 core.ts）
import http from 'node:http';
import { gitlabConfigFromEnv, parseNoteEvent, resolveRepo, shouldTrigger } from './core.js';
import { runMrReview } from './job.js';

const cfg = gitlabConfigFromEnv();
const log = (m: string) => console.log(`[webhook] ${new Date().toISOString()} ${m}`);

// 串行队列：同一时间只跑一个 review（执行机资源与 git 操作互斥）
let queue: Promise<void> = Promise.resolve();

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/gitlab') {
    log(`404：${req.method} ${req.url}（来自 ${req.socket.remoteAddress}）`);
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-gitlab-token'] !== cfg.webhookSecret) {
    log(`401：secret 不匹配（来自 ${req.socket.remoteAddress}，事件 ${req.headers['x-gitlab-event'] ?? '?'}）`);
    res.writeHead(401).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200).end('ok'); // 3 秒内必须应答，任务异步跑
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const ev = parseNoteEvent(parsed);
    if (!ev || !shouldTrigger(ev.comment, cfg.trigger)) return;
    const repo = resolveRepo(cfg.repoMap, ev.projectPath);
    if (!repo) {
      log(`忽略 ${ev.projectPath}：不在 GITLAB_REPO_MAP 中`);
      return;
    }
    log(`触发：${ev.projectPath} MR !${ev.mrIid}（by @${ev.author}）`);
    queue = queue.then(() =>
      runMrReview(cfg, ev, repo, log).catch((e) => log(`MR !${ev.mrIid} review 失败：${(e as Error).message}`)),
    );
  });
});

server.listen(cfg.port, () => log(`监听 :${cfg.port}/gitlab，触发词 "${cfg.trigger}"，映射 ${Object.keys(cfg.repoMap).join(', ')}`));
