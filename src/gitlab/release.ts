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

/** 合并 MR。GitLab 返回 405/406 时通常是冲突/流水线未过/被保护分支规则挡住——原话回传给人 */
export async function mergeMr(
  api: GitlabApi,
  projectPath: string,
  iid: number,
  fetchFn: Fetch = fetch,
): Promise<{ ok: true; sha: string } | { ok: false; message: string }> {
  try {
    const res = await call(api, fetchFn, `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ should_remove_source_branch: false }),
    });
    const body = (await res.json().catch(() => ({}))) as { merge_commit_sha?: string; sha?: string; message?: string };
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}${body.message ? `：${body.message}` : ''}` };
    return { ok: true, sha: body.merge_commit_sha ?? body.sha ?? '' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
