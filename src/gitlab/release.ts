/**
 * 上线环节用到的两个 GitLab 动作：按源分支找开着的 MR、合并它。
 * 只依赖 GITLAB_URL + GITLAB_API_TOKEN（不像 webhook 那套还要 secret/repoMap）；缺配置 → null，调用方降级为「请人手动合并」。
 */

export interface GitlabApi {
  url: string;
  apiToken: string;
}

export interface OpenMr {
  iid: number;
  webUrl: string;
  targetBranch: string;
  title: string;
}

export function gitlabApiFromEnv(env = process.env): GitlabApi | null {
  const { GITLAB_URL, GITLAB_API_TOKEN } = env;
  if (!GITLAB_URL || !GITLAB_API_TOKEN) return null;
  return { url: GITLAB_URL.replace(/\/$/, ''), apiToken: GITLAB_API_TOKEN };
}

type Fetch = typeof fetch;

function call(api: GitlabApi, fetchFn: Fetch, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return fetchFn(`${api.url}/api/v4${pathAndQuery}`, {
    ...init,
    headers: { 'PRIVATE-TOKEN': api.apiToken, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

/** 按源分支找开着的 MR；没有或出错 → null（上线卡照发，只是没有 MR 链接） */
export async function findOpenMr(api: GitlabApi, projectPath: string, sourceBranch: string, fetchFn: Fetch = fetch): Promise<OpenMr | null> {
  try {
    const q = `/projects/${encodeURIComponent(projectPath)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`;
    const res = await call(api, fetchFn, q);
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ iid: number; web_url: string; target_branch: string; title: string }>;
    const mr = arr[0];
    return mr ? { iid: mr.iid, webUrl: mr.web_url, targetBranch: mr.target_branch, title: mr.title } : null;
  } catch {
    return null;
  }
}

/**
 * 合并 MR。GitLab 的合并 API 会异步返回：合并其实成功了，PUT 却可能回 405 Method Not Allowed
 * （2026-09-05 LS-015 实测：405 之下 MR 已是 merged）。所以非 2xx 不直接判失败——回查一次 MR 状态，
 * 已 merged 就当成功。真失败（冲突/流水线未过/保护分支）时 MR 停在 opened，把原话回传给人。
 */
export async function mergeMr(
  api: GitlabApi,
  projectPath: string,
  iid: number,
  fetchFn: Fetch = fetch,
): Promise<{ ok: true; sha: string } | { ok: false; message: string }> {
  const proj = encodeURIComponent(projectPath);
  try {
    const res = await call(api, fetchFn, `/projects/${proj}/merge_requests/${iid}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ should_remove_source_branch: false }),
    });
    const body = (await res.json().catch(() => ({}))) as { merge_commit_sha?: string; sha?: string; state?: string; message?: string };
    if (res.ok) return { ok: true, sha: body.merge_commit_sha ?? body.sha ?? '' };
    if (body.state === 'merged') return { ok: true, sha: body.merge_commit_sha ?? body.sha ?? '' };
    // 非 2xx 且响应没说 merged：回查一次真状态，别被 405 骗（异步合并已成功仍会回 405）
    const check = await call(api, fetchFn, `/projects/${proj}/merge_requests/${iid}`).then((r) => r.json().catch(() => ({}))) as {
      state?: string;
      merge_commit_sha?: string;
    };
    if (check.state === 'merged') return { ok: true, sha: check.merge_commit_sha ?? '' };
    return { ok: false, message: `HTTP ${res.status}${body.message ? `：${body.message}` : ''}（MR 状态：${check.state ?? '未知'}）` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
