// 自检：项目配置解析是否正确（仓库/前缀/GitLab/CI/Wiki 归档）
import { describeProjects, loadProjects, nextTicketId } from '../src/projects.js';
import { listTickets } from '../src/events.js';

const projects = loadProjects();
console.log(`共 ${projects.length} 个项目：${describeProjects(projects)}\n`);
for (const p of projects) {
  console.log(`[${p.alias}]`);
  console.log(`  仓库      ${p.repo}`);
  console.log(`  工单前缀  ${p.prefix}-　（下一个：${nextTicketId(p, listTickets())}）`);
  console.log(`  GitLab    ${p.gitlab ?? '(未配)'}`);
  console.log(`  Jenkins   ${p.jenkins ?? '(未配)'}`);
  console.log(`  Wiki 归档 ${p.wikiArchive ?? '(未配)'}`);
}
