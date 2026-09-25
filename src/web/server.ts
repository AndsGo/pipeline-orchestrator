// web 服务：一个进程、一个端口（GITLAB_WEBHOOK_PORT，默认 8377）承载三组路由——
//   /preview/<工单号>/  结果预览（免登录，业务人员从卡片点进来）
//   /gitlab             GitLab MR 评论评审（X-Gitlab-Token 校验；没配 GITLAB_* 就不挂）
//   其余                控制台（口令 cookie；没配 CONSOLE_TOKEN 就不挂）
// 2026-09-25 由 webhook 与控制台两个进程合并而来：两个端口、两套启动脚本和看门狗分支，
// 每个还套着 cmd→npm→cmd→tsx→node 五层包装，实际流量又很小（MR 评审六周一次）。
// 入口在 src/web/main.ts（启动：scripts/start-web.ps1 / start-web.sh；重启：写 data/web.stop，空闲时自退、看门狗拉起）。
import http from 'node:http';
import { createConsoleRoute } from '../console/routes.js';
import { gitlabConfigFromEnv, type GitlabConfig } from '../gitlab/core.js';
import { gitlabRoute, previewRoute, type Route } from '../gitlab/routes.js';

export const log = (m: string) => console.log(`[web] ${new Date().toISOString()} ${m}`);

export interface WebMounts {
  routes: Route[];
  /** 给人看的一行：挂了什么、没挂什么、为什么 */
  summary: string[];
}

/** 按配置决定挂哪几组路由（纯函数，可单测）：缺哪组的配置就不挂哪组，不因此起不来 */
export function mountRoutes(env: NodeJS.ProcessEnv, logger: (m: string) => void = log): WebMounts {
  const routes: Route[] = [previewRoute(logger)];
  const summary = ['/preview/ 结果预览'];
  let gl: GitlabConfig | null = null;
  try {
    gl = gitlabConfigFromEnv(env);
  } catch (e) {
    summary.push(`/gitlab 未挂（${(e as Error).message}）`);
  }
  if (gl) {
    routes.push(gitlabRoute(gl, logger));
    summary.push(`/gitlab MR 评审（触发词 "${gl.trigger}"，映射 ${Object.keys(gl.repoMap).join(', ')}）`);
  }
  const token = env.CONSOLE_TOKEN?.trim();
  if (token && token.length >= 8) {
    routes.push(createConsoleRoute(token, (m) => logger(`[console] ${m}`)));
    summary.push('/ 控制台');
  } else {
    summary.push(`控制台未挂（${token ? 'CONSOLE_TOKEN 不足 8 位' : '缺 CONSOLE_TOKEN'}）`);
  }
  return { routes, summary };
}

export function createWebServer(mounts: WebMounts): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void (async () => {
      for (const r of mounts.routes) if (await r(req, res, url)) return;
      log(`404：${req.method} ${url.pathname}（来自 ${req.socket.remoteAddress}）`);
      res.writeHead(404).end();
    })().catch((e: Error) => {
      log(`${req.method} ${url.pathname} 失败：${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}

