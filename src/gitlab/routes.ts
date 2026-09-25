// GitLab webhook 路由：MR 评论含触发词 → 独立 review → 回帖；以及 /preview/<工单号>/ 只读静态路由（结果预览，grill-me 定稿 2026-09-01）。
// 由 src/web/server.ts 挂载（2026-09-25 与控制台合并为一个 web 进程、一个端口）。
import fs from 'node:fs';
import type http from 'node:http';
import { parseNoteEvent, previewContentType, previewLocalPath, resolveRepo, shouldTrigger, type GitlabConfig } from './core.js';
import { runMrReview } from './job.js';
import { peekTicketRepo } from '../ticket.js';

export type Route = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean | Promise<boolean>;

/**
 * 结果预览：只读 GET，路径解析层已挡穿越；工单号 → 仓库用主快照（web 与 daemon 共享 data/）。
 * 不要登录——业务人员从 PRD 确认卡点的链接直接点进来看原型。
 */
export function previewRoute(log: (m: string) => void): Route {
  return (req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/preview/')) return false;
    const file = previewLocalPath(url.pathname, (t) => peekTicketRepo(t));
    if (!file || !fs.existsSync(file)) {
      log(`404 preview：${url.pathname}（来自 ${req.socket.remoteAddress}）`);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('无此预览：工单不存在或原型尚未生成');
      return true;
    }
    res.writeHead(200, { 'content-type': previewContentType(file), 'cache-control': 'no-cache' }).end(fs.readFileSync(file));
    return true;
  };
}

/** 在跑 / 排队中的 MR 评审数：web 进程收到停止信号时据此决定等不等 */
export const gitlabJobs = { pending: 0 };

export function gitlabRoute(cfg: GitlabConfig, log: (m: string) => void): Route {
  // 串行队列：同一时间只跑一个 review（执行机资源与 git 操作互斥）
  let queue: Promise<void> = Promise.resolve();
  return (req, res, url) => {
    if (url.pathname !== '/gitlab') return false;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return true;
    }
    if (req.headers['x-gitlab-token'] !== cfg.webhookSecret) {
      log(`401：secret 不匹配（来自 ${req.socket.remoteAddress}，事件 ${req.headers['x-gitlab-event'] ?? '?'}）`);
      res.writeHead(401).end();
      return true;
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
      gitlabJobs.pending++;
      queue = queue.then(() =>
        runMrReview(cfg, ev, repo, log)
          .catch((e) => log(`MR !${ev.mrIid} review 失败：${(e as Error).message}`))
          .finally(() => gitlabJobs.pending--),
      );
    });
    return true;
  };
}
