/**
 * Jenkins 集成：buildWithParameters 触发 → queue item 换 build number → 轮询结果。
 * 认证用 user + API token（Basic），API token 认证免 CSRF crumb（Jenkins 官方口径）。
 * fetch 可注入以便单测。
 */

export interface JenkinsConfig {
  url: string; // http://jenkins.internal:8080
  job: string; // 任务名（支持 folder/job 形式：a/b → job/a/job/b）
  user: string;
  token: string;
  timeoutMin: number;
}

export interface BuildResult {
  ok: boolean;
  buildNumber: number | null;
  buildUrl: string | null;
  result: string; // SUCCESS | FAILURE | UNSTABLE | ABORTED | TIMEOUT | TRIGGER_FAILED
  logTail: string;
}

type FetchLike = typeof fetch;

/**
 * Jenkins 配置。任务名必须由调用方经 projects.ciJobFor 按项目解析后传入——
 * 本函数不再兜底全局 JENKINS_JOB：旧的 `job ?? JENKINS_JOB` 兜底让第二个项目
 * 静默触发第一个项目的构建（nova 验收实测，2026-08-26），是接多项目时最危险的一处。
 */
export function jenkinsConfigFromEnv(job: string | undefined): JenkinsConfig | null {
  const { JENKINS_URL, JENKINS_USER, JENKINS_TOKEN, JENKINS_TIMEOUT_MIN } = process.env;
  if (!JENKINS_URL || !job) return null;
  if (!JENKINS_USER || !JENKINS_TOKEN) {
    throw new Error('已配置 Jenkins 任务但缺少 JENKINS_USER/JENKINS_TOKEN');
  }
  return {
    url: JENKINS_URL.replace(/\/$/, ''),
    job,
    user: JENKINS_USER,
    token: JENKINS_TOKEN,
    timeoutMin: Number(JENKINS_TIMEOUT_MIN ?? 30),
  };
}

export function jobPath(job: string): string {
  return job
    .split('/')
    .map((seg) => `job/${encodeURIComponent(seg)}`)
    .join('/');
}

function authHeader(cfg: JenkinsConfig): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.token}`).toString('base64')}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 触发构建，返回 queue item URL（Location 头） */
export async function triggerBuild(
  cfg: JenkinsConfig,
  params: Record<string, string>,
  fetchFn: FetchLike = fetch,
): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const url = `${cfg.url}/${jobPath(cfg.job)}/buildWithParameters${qs ? '?' + qs : ''}`;
  let res = await fetchFn(url, { method: 'POST', headers: authHeader(cfg) });
  if (res.status === 400 || res.status === 405 || res.status === 500) {
    // 无参数任务：回退普通 build 端点（TICKET/BRANCH 无法传入，任务自带分支逻辑时可用）。
    // 实测 Jenkins 2.516 对无参数任务的 buildWithParameters 返回 500，一并回退。
    res = await fetchFn(`${cfg.url}/${jobPath(cfg.job)}/build`, { method: 'POST', headers: authHeader(cfg) });
  }
  if (res.status !== 201) {
    const body = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Jenkins 触发失败：HTTP ${res.status} ${body}`);
  }
  const loc = res.headers.get('location');
  if (!loc) throw new Error('Jenkins 未返回 Location 头（queue item URL）');
  return loc.replace(/\/$/, '');
}

/** queue item → build number（注意：item 完成约 5 分钟后过期，须尽快轮询） */
export async function resolveBuildNumber(
  cfg: JenkinsConfig,
  queueUrl: string,
  fetchFn: FetchLike = fetch,
  pollMs = 3000,
  maxWaitMs = 5 * 60 * 1000,
): Promise<{ number: number; url: string }> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await fetchFn(`${queueUrl}/api/json`, { headers: authHeader(cfg) });
    if (res.ok) {
      const item = (await res.json()) as { executable?: { number: number; url: string }; cancelled?: boolean };
      if (item.cancelled) throw new Error('Jenkins queue item 被取消');
      if (item.executable) return item.executable;
    }
    if (Date.now() > deadline) throw new Error('等待 Jenkins 分配 build number 超时');
    await sleep(pollMs);
  }
}

/** 轮询直至构建结束；onProgress 每轮回调（可用于心跳/续期） */
export async function waitForBuild(
  cfg: JenkinsConfig,
  buildUrl: string,
  fetchFn: FetchLike = fetch,
  pollMs = 15000,
  onProgress?: (elapsedMs: number) => void,
): Promise<string> {
  const deadline = Date.now() + cfg.timeoutMin * 60 * 1000;
  const start = Date.now();
  for (;;) {
    const res = await fetchFn(`${buildUrl}api/json`, { headers: authHeader(cfg) });
    if (res.ok) {
      const b = (await res.json()) as { building: boolean; result: string | null };
      if (!b.building && b.result) return b.result;
    }
    if (Date.now() > deadline) return 'TIMEOUT';
    onProgress?.(Date.now() - start);
    await sleep(pollMs);
  }
}

/** 取 console 日志尾部（失败时给人看/给修复轮用） */
export async function fetchLogTail(
  cfg: JenkinsConfig,
  buildUrl: string,
  fetchFn: FetchLike = fetch,
  tailChars = 4000,
): Promise<string> {
  try {
    const res = await fetchFn(`${buildUrl}consoleText`, { headers: authHeader(cfg) });
    if (!res.ok) return `(日志获取失败：HTTP ${res.status})`;
    const text = await res.text();
    return text.length > tailChars ? '…' + text.slice(-tailChars) : text;
  } catch (e) {
    return `(日志获取异常：${(e as Error).message})`;
  }
}

/** 完整流程：触发 → 等 build → 等结果 → 失败取日志尾部 */
export async function runJenkinsBuild(
  cfg: JenkinsConfig,
  params: Record<string, string>,
  fetchFn: FetchLike = fetch,
  onEvent?: (msg: string) => void,
): Promise<BuildResult> {
  let queueUrl: string;
  try {
    queueUrl = await triggerBuild(cfg, params, fetchFn);
  } catch (e) {
    return { ok: false, buildNumber: null, buildUrl: null, result: 'TRIGGER_FAILED', logTail: (e as Error).message };
  }
  const { number, url } = await resolveBuildNumber(cfg, queueUrl, fetchFn);
  onEvent?.(`Jenkins 构建 #${number} 已开始：${url}`);
  const result = await waitForBuild(cfg, url, fetchFn);
  const logTail = result === 'SUCCESS' ? '' : await fetchLogTail(cfg, url, fetchFn);
  return { ok: result === 'SUCCESS', buildNumber: number, buildUrl: url, result, logTail };
}
