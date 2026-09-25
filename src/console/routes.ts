// 控制台路由：管环境 / 项目配置、看任务 / 需求 / 文档、发起重启。与 daemon 只通过 data/ 下的文件说话。
// 由 src/web/server.ts 挂载（与 GitLab webhook、结果预览同一进程同一端口）；没有 CONSOLE_TOKEN 就不挂。
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import type http from 'node:http';
import type { Route } from '../gitlab/routes.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../paths.js';
import { setPaused } from '../pause.js';
import { listReqs, readReq, REQ_RE } from '../requirements.js';
import {
  buildOverview,
  readDoc,
  recentSenders,
  type PersonHint,
  listDocTickets,
  listProjectDocs,
  listTicketDocs,
  readEnvView,
  readProjectsView,
  readRuntime,
  stagesView,
  tailLog,
  ticketDetail,
  ticketRows,
  writeEnvChanges,
  writeProjects,
} from './api.js';
import type { Project } from '../projects.js';
import { readSnapshot } from '../ticket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const envFile = path.join(root, '.env');
const webDir = path.join(root, 'web');
const logsDir = path.join(root, 'logs');
let log = (m: string) => console.log(`[console] ${new Date().toISOString()} ${m}`);

// 口令与会话在 createConsoleRoute 里定：会话 cookie = sha256(口令 + 本进程随机盐)，进程一重启旧 cookie 全部失效，口令本身不进浏览器
let token = '';
let session = '';
const COOKIE = 'console_session';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authed(req: http.IncomingMessage): boolean {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(req.headers.cookie ?? '');
  return !!m && safeEqual(m[1], session);
}

type Res = http.ServerResponse;
const json = (res: Res, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};
const text = (res: Res, status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
};

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c;
      if (body.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

const LOGIN_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流水线控制台</title>
<link rel="stylesheet" href="/style.css"></head><body class="login"><form id="f"><h1>流水线控制台</h1><p class="muted">输入 .env 里的 CONSOLE_TOKEN</p>
<input id="t" type="password" autocomplete="current-password" autofocus placeholder="口令"><button>进入</button><p id="e" class="err"></p></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.getElementById('t').value})});if(r.ok)location.href='/';else document.getElementById('e').textContent='口令不对'}</script></body></html>`;

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(urlPath: string, res: Res): void {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, 'not found');
  const type = STATIC_TYPES[path.extname(file).toLowerCase()];
  if (!type) return text(res, 404, 'not found');
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(fs.readFileSync(file));
}

function projectsNow(): Project[] {
  return readProjectsView(envFile).projects;
}

const TICKET_RE = /^[A-Za-z]{1,6}-\d{1,6}$/;

function runDoctor(): Promise<{ lines: string[]; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['tsx', 'scripts/doctor.ts', '--no-infer'], { cwd: root, shell: true, env: process.env });
    let out = '';
    p.stdout.on('data', (c: Buffer) => (out += c));
    p.stderr.on('data', (c: Buffer) => (out += c));
    const timer = setTimeout(() => p.kill(), 90_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ lines: out.split(/\r?\n/).filter(Boolean), code });
    });
  });
}

/**
 * 负责人候选：优先读群成员（主群 + 各项目绑定群，需应用开通 im:chat.members:read），读不到就退回
 * 「最近 @ 过机器人的人」。这是控制台唯一一处调飞书，只读，结果缓存 10 分钟。
 */
interface PeopleResult {
  source: 'members' | 'logs';
  people: PersonHint[];
  /** 读不到群成员时给出的原因（不含凭据） */
  note?: string;
}
let peopleCache: { at: number; v: PeopleResult } | null = null;

async function peopleHints(): Promise<PeopleResult> {
  if (peopleCache && Date.now() - peopleCache.at < 10 * 60_000) return peopleCache.v;
  const senders = recentSenders(logsDir);
  const byId = new Map(senders.map((p) => [p.openId, { ...p }]));
  let note: string | undefined;
  let gotMembers = false;
  const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret, FEISHU_CHAT_ID: mainChat } = process.env;
  if (appId && appSecret) {
    // 权限错误我们自己捕获并降级，别让 SDK 整段打进日志
    const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.fatal });
    const chats = [...new Set([mainChat, ...projectsNow().map((p) => p.chatId)].filter((c): c is string => !!c))];
    for (const chat_id of chats) {
      try {
        const r = await client.im.chatMembers.get({ path: { chat_id }, params: { member_id_type: 'open_id', page_size: 100 } });
        for (const m of r.data?.items ?? []) {
          if (!m.member_id) continue;
          const p = byId.get(m.member_id) ?? { openId: m.member_id, messages: 0 };
          p.name = m.name ?? p.name;
          byId.set(m.member_id, p);
          gotMembers = true;
        }
      } catch (e) {
        const code = (e as { response?: { data?: { code?: number } } }).response?.data?.code;
        note = code === 99991672 ? '机器人未开通 im:chat.members:read，读不到群成员名单；下面是最近 @ 过机器人的人' : `读群成员失败（${code ?? (e as Error).message.slice(0, 60)}）`;
        break;
      }
    }
  }
  const v: PeopleResult = { source: gotMembers ? 'members' : 'logs', people: [...byId.values()].sort((a, b) => b.messages - a.messages), note };
  peopleCache = { at: Date.now(), v };
  return v;
}

async function api(req: http.IncomingMessage, res: Res, url: URL): Promise<void> {
  const p = url.pathname;
  const method = req.method ?? 'GET';
  const dir = dataDir();

  if (p === '/api/overview' && method === 'GET') return json(res, 200, buildOverview({ dir, watchdogLog: path.join(logsDir, 'watchdog.log') }));
  if (p === '/api/doctor' && method === 'POST') return json(res, 200, await runDoctor());
  if (p === '/api/stages' && method === 'GET') return json(res, 200, stagesView());

  if (p === '/api/env' && method === 'GET') return json(res, 200, readEnvView(envFile));
  if (p === '/api/env' && method === 'PUT') {
    const b = (await readBody(req)) as { mtime?: number; changes?: Record<string, string> };
    const changes = Object.fromEntries(Object.entries(b.changes ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const r = writeEnvChanges(envFile, Number(b.mtime), changes);
    if (r.ok) {
      fs.writeFileSync(path.join(dir, 'env.reload'), new Date().toISOString(), 'utf-8');
      log(`.env 已改：${Object.keys(changes).join('、')}（已写热重载信号）`);
    }
    return json(res, r.ok ? 200 : 409, r);
  }

  if (p === '/api/projects' && method === 'GET') return json(res, 200, readProjectsView(envFile));
  if (p === '/api/projects' && method === 'PUT') {
    const b = (await readBody(req)) as { mtime?: number; projects?: Project[] };
    const list = (b.projects ?? []).map((x) => ({
      alias: String(x.alias ?? '').trim(),
      repo: String(x.repo ?? '').trim(),
      prefix: String(x.prefix ?? '').trim(),
      gitlab: x.gitlab,
      jenkins: x.jenkins,
      wikiArchive: x.wikiArchive,
      wikiKnowledge: x.wikiKnowledge,
      chatId: x.chatId,
      owner: x.owner,
    }));
    const r = writeProjects(envFile, Number(b.mtime), list);
    if (r.ok) {
      fs.writeFileSync(path.join(dir, 'env.reload'), new Date().toISOString(), 'utf-8');
      log(`项目表已改：${list.map((x) => x.alias).join('、')}（已写热重载信号）`);
    }
    return json(res, r.ok ? 200 : 409, r);
  }

  if (p === '/api/restart' && method === 'POST') {
    fs.writeFileSync(path.join(dir, 'daemon.stop'), new Date().toISOString(), 'utf-8');
    log('已写停止信号 data/daemon.stop（控制台发起重启）');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/restart-web' && method === 'POST') {
    // 重启的就是本进程：写信号后 5 秒内退出（有 MR 评审在跑则等），看门狗 2 分钟内拉起——页面会断开一会儿
    fs.writeFileSync(path.join(dir, 'web.stop'), new Date().toISOString(), 'utf-8');
    log('已写 web 停止信号 data/web.stop（控制台发起重启 web 服务）');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/tickets' && method === 'GET') return json(res, 200, ticketRows(readRuntime(dir)));
  let m = /^\/api\/tickets\/([^/]+)(?:\/(pause|resume))?$/.exec(p);
  if (m) {
    const ticket = decodeURIComponent(m[1]);
    if (!TICKET_RE.test(ticket)) return json(res, 400, { error: '工单号不合法' });
    if (!m[2] && method === 'GET') {
      const d = ticketDetail(ticket, readRuntime(dir));
      return d ? json(res, 200, d) : json(res, 404, { error: '无此工单' });
    }
    if (method !== 'POST') return json(res, 405, { error: 'method' });
    if (m[2] === 'pause') {
      setPaused(ticket, '控制台');
      log(`${ticket} 已登记暂停（控制台）`);
      return json(res, 200, { ok: true, note: '当前阶段跑完即停，不打断进行中的会话' });
    }
    fs.appendFileSync(path.join(dir, 'console.queue.jsonl'), JSON.stringify({ kind: 'resume', ticket, by: '控制台', at: new Date().toISOString() }) + '\n', 'utf-8');
    log(`${ticket} 恢复请求已入队（daemon 10 秒内接手）`);
    return json(res, 200, { ok: true, note: 'daemon 10 秒内接手，结果发到群里' });
  }

  if (p === '/api/reqs' && method === 'GET') return json(res, 200, listReqs());
  m = /^\/api\/reqs\/([^/]+)$/.exec(p);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    if (!REQ_RE.test(id)) return json(res, 400, { error: '需求号不合法' });
    const r = readReq(id);
    return r ? json(res, 200, r) : json(res, 404, { error: '无此需求' });
  }

  if (p === '/api/docs' && method === 'GET') {
    return json(
      res,
      200,
      projectsNow().map((pr) => ({ alias: pr.alias, prefix: pr.prefix, repo: pr.repo, files: listProjectDocs(pr.repo), tickets: listDocTickets(pr.repo, pr.prefix) })),
    );
  }
  m = /^\/api\/docs\/([^/]+)\/(tickets\/([^/]+)|file)$/.exec(p);
  if (m && method === 'GET') {
    const pr = projectsNow().find((x) => x.alias === decodeURIComponent(m![1]));
    if (!pr) return json(res, 404, { error: '无此项目' });
    if (m[3]) {
      const ticket = decodeURIComponent(m[3]);
      if (!TICKET_RE.test(ticket)) return json(res, 400, { error: '工单号不合法' });
      return json(res, 200, listTicketDocs(pr.repo, ticket, readSnapshot(ticket)?.branch));
    }
    const body = readDoc(pr.repo, url.searchParams.get('path') ?? '');
    if (body === null) return json(res, 404, { error: '无此文件' });
    return text(res, 200, body); // 一律按纯文本给：仓库里的 html 不在控制台源下执行
  }

  if (p === '/api/people' && method === 'GET') return json(res, 200, await peopleHints());

  if (p === '/api/logs' && method === 'GET') {
    const name = url.searchParams.get('file') ?? 'daemon';
    if (!/^(daemon|web|watchdog|webhook|console)$/.test(name)) return json(res, 400, { error: 'file' });
    return json(res, 200, tailLog(path.join(logsDir, `${name}.log`), Number(url.searchParams.get('lines') ?? 200), url.searchParams.get('q') ?? undefined));
  }

  json(res, 404, { error: 'not found' });
}

/**
 * 控制台路由：兜底路由（web 服务里排在预览、GitLab 之后），未登录一律给登录页。
 * 口令至少 8 位，不够就不挂——没有口令的控制台等于把 .env 交给内网任何人。
 */
export function createConsoleRoute(consoleToken: string, logger: (m: string) => void): Route {
  token = consoleToken;
  session = createHash('sha256').update(`${token}:${randomBytes(16).toString('hex')}`).digest('hex');
  log = logger;
  return async (req, res, url) => {
    try {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const b = (await readBody(req)) as { token?: string };
        if (typeof b.token === 'string' && safeEqual(b.token, token)) {
          res.writeHead(200, { 'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}` }).end('ok');
          log(`登录成功（来自 ${req.socket.remoteAddress}）`);
          return true;
        }
        log(`登录失败（来自 ${req.socket.remoteAddress}）`);
        await new Promise((r) => setTimeout(r, 1000)); // 错一次等一秒：挡住暴力试口令
        text(res, 401, 'unauthorized');
        return true;
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        res.writeHead(200, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }).end('ok');
        return true;
      }
      if (url.pathname === '/style.css') {
        serveStatic(url.pathname, res); // 登录页也要样式
        return true;
      }
      if (!authed(req)) {
        if (url.pathname.startsWith('/api/')) json(res, 401, { error: 'unauthorized' });
        else text(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8');
        return true;
      }
      if (url.pathname.startsWith('/api/')) {
        await api(req, res, url);
        return true;
      }
      serveStatic(url.pathname, res);
    } catch (e) {
      log(`${req.method} ${url.pathname} 失败：${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    }
    return true;
  };
}
