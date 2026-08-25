import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mapFreshness, readMapMeta, renderMapHint, SYSTEM_MAP_DIR } from '../systemMap.js';

const tmpdirs: string[] = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** 建一个真仓库：一次基线提交 + 可选的后续提交，用于验证「落后几个提交」是真算出来的 */
function repoWithMap(opts: { capPaths?: string[]; commitAfter?: string[]; noCommit?: boolean } = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmap-'));
  tmpdirs.push(repo);
  const dir = path.join(repo, SYSTEM_MAP_DIR);
  fs.mkdirSync(path.join(dir, 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'backend', 'router.go'), 'v1\n', 'utf-8');
  fs.writeFileSync(path.join(repo, 'backend', 'other.go'), 'v1\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.md'), '# 能力地图\n', 'utf-8');

  git(repo, 'init -q');
  git(repo, 'config user.email eval@local');
  git(repo, 'config user.name eval');
  git(repo, 'add -A');
  git(repo, 'commit -qm base');
  const base = git(repo, 'rev-parse HEAD');

  if (!opts.noCommit) {
    fs.writeFileSync(
      path.join(dir, 'map.json'),
      JSON.stringify({
        version: 1,
        generated_at: '2026-08-25T00:00:00.000Z',
        code_commit: base,
        capabilities: [{ slug: 'monitor', title: '调用监控', paths: opts.capPaths ?? ['backend/router.go'] }],
      }),
      'utf-8',
    );
    git(repo, 'add -A');
    git(repo, 'commit -qm map'); // 地图自身这一笔也算落后 1 个提交，符合直觉：基线是"读代码时的那个 HEAD"
  }
  for (const f of opts.commitAfter ?? []) {
    fs.writeFileSync(path.join(repo, f), 'v2\n', 'utf-8');
    git(repo, `add -A`);
    git(repo, `commit -qm change-${path.basename(f)}`);
  }
  return repo;
}

describe('能力地图新鲜度', () => {
  it('没有地图 → 明说没有，不报错', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmap-'));
    tmpdirs.push(repo);
    const f = mapFreshness(repo);
    expect(f.exists).toBe(false);
    expect(f.headline).toContain('还没有能力地图');
  });

  it('刚生成完 → 报同步：地图自身那笔提交不算「系统变了」（真机首发回归）', () => {
    // 2026-08-25 首次上线实测：地图提交推进 HEAD，新鲜度立刻报「落后 1 个提交」。
    // 数字要回答的是系统本身变了多少，流水线工件不算——会自己长大的告警最后没人看。
    const f = mapFreshness(repoWithMap());
    expect(f.commitsBehind).toBe(0);
    expect(f.headline).toContain('同步');
  });

  it('能力的核心路径被改过 → 点名该能力，让会话知道这块以代码为准', () => {
    const f = mapFreshness(repoWithMap({ commitAfter: ['backend/router.go'] }));
    expect(f.commitsBehind).toBe(1); // 只数真正改代码的那一笔
    expect(f.touched).toEqual(['调用监控']);
    expect(f.headline).toContain('调用监控');
  });

  it('提交没碰到已登记路径 → 只报落后，不误伤某条能力', () => {
    const f = mapFreshness(repoWithMap({ commitAfter: ['backend/other.go'] }));
    expect(f.commitsBehind).toBe(1);
    expect(f.touched).toEqual([]);
    expect(f.headline).toContain('未触及');
  });

  it('缺 code_commit → 明说无法判断，而不是假装同步', () => {
    const repo = repoWithMap({ noCommit: true });
    fs.writeFileSync(path.join(repo, SYSTEM_MAP_DIR, 'map.json'), JSON.stringify({ version: 1 }), 'utf-8');
    const f = mapFreshness(repo);
    expect(f.commitsBehind).toBeNull();
    expect(f.headline).toContain('无法判断');
  });

  it('基线提交不在历史里（rebase/浅克隆）→ 明说无法判断', () => {
    const repo = repoWithMap();
    const dir = path.join(repo, SYSTEM_MAP_DIR);
    fs.writeFileSync(
      path.join(dir, 'map.json'),
      JSON.stringify({ version: 1, code_commit: 'a'.repeat(40), capabilities: [] }),
      'utf-8',
    );
    expect(mapFreshness(repo).headline).toContain('无法判断');
  });

  it('map.json 损坏 → readMapMeta 给 null，不抛', () => {
    const repo = repoWithMap();
    fs.writeFileSync(path.join(repo, SYSTEM_MAP_DIR, 'map.json'), '{ 坏的', 'utf-8');
    expect(readMapMeta(repo)).toBeNull();
    expect(mapFreshness(repo).headline).toContain('无法判断');
  });

  it('注入头带状态、入口与冲突时的裁决规则', () => {
    const hint = renderMapHint(mapFreshness(repoWithMap({ commitAfter: ['backend/router.go'] })));
    expect(hint).toContain('调用监控');
    expect(hint).toContain('system-map/index.md');
    expect(hint).toContain('以代码为准');
  });
});
