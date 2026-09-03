import type { Command } from '../commands.js';
import type { FeishuPort } from '../feishu/port.js';
import type { LastRun } from '../followup.js';
import type { Project } from '../projects.js';
import type { Semaphore } from '../semaphore.js';

/**
 * 指令处理器与 daemon 主体之间的契约：处理器只拿这里列出的东西，不碰模块级状态。
 * 这样每个 case 才能单独单测（daemon.ts 在 import 时就读配置、连飞书，没法直接引进测试）。
 */

/** 按 kind 收窄后的指令类型 */
export type CommandOf<K extends Command['kind']> = Extract<Command, { kind: K }>;

/** 处理器用到的端口能力子集：测试里用假端口替换，记录 notify/chooseOption/confirmGate 调用即可 */
export type DaemonPort = Pick<
  FeishuPort,
  'notify' | 'chooseOption' | 'confirmGate' | 'confirmCommand' | 'sendDashboard' | 'sendStatus' | 'sendResult' | 'pendingLabels'
>;

/** 单次执行的轻量台账条目：不建工单，但成本要看得见 */
export interface AdhocEntry {
  at: string;
  project: string;
  text: string;
  costUsd: number;
}

export interface DaemonContext {
  /** 项目表。可变：/bind、/addproject 热加载时原地替换内容（引用不变，routeChat 等闭包才看得到） */
  projects: Project[];
  cfg: { defaultProject: string; maxConcurrency: number };
  /** 主群 chat_id：综合入口，不允许 /bind 到单一项目 */
  MAIN_CHAT: string;
  port: DaemonPort;
  log: (m: string) => void;
  /** 在跑的工单 → 主仓库与实际工作目录 */
  active: Map<string, { mainRepo: string; workdir: string }>;
  sem: Semaphore;
  adhoc: AdhocEntry[];
  startedAt: number;
  /** 看板投影（多维表格）是否启用 */
  boardOn: boolean;
  /** .env 路径：/bind、/addproject 改写 PIPELINE_PROJECTS 时用 */
  envFile: string;
  /** 启动/恢复一个工单的 runner（非阻塞），返回给人看的一句话 */
  startTicket(ticket: string, projectHint: string | undefined, requirement?: string, intakeContext?: string): Promise<string>;
  /** 单次执行的公共执行体（见 adhoc.ts） */
  execAdhoc(
    project: Project,
    commandText: string,
    corePrompt: string,
    slashRisks: string[],
    chain: number,
    opts?: { resumeSessionId?: string; origin?: string; chat?: string },
  ): Promise<boolean>;
  /** 续聊：把答复接回上一次单次执行 */
  runFollowup(reply: string, chat?: string): Promise<void>;
  /** 零输入建单的草拟：整段 /run 对话 → 一段需求原文；失败返回 null */
  draftRequirementFromChat(project: Project, last: LastRun): Promise<string | null>;
}
