/**
 * 多维表格看板的表结构定义——setup 建表与运行时投影共用的唯一真源。
 * 字段类型：1 文本 / 2 数字 / 3 单选 / 5 日期 / 15 超链接 / 18 单向关联
 */

export const STAGE_CN: Record<string, string> = {
  clarify: '澄清',
  plan: '计划',
  implement: '实现',
  review: '评审',
  ci: 'CI',
  acceptance: '验收',
  compound: '沉淀',
  fast: '快车道',
  triage: '分诊',
};

export const STAGE_OPTIONS = ['分诊', '快车道', '澄清', '计划', '实现', '评审', 'CI', '验收', '沉淀', '已闭环'];
export const RUN_STATE_OPTIONS = ['在跑', '等人工', '挂起', '闭环'];
export const LANE_OPTIONS = ['快车道', '全流水线'];
export const RESULT_OPTIONS = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED', '—'];
export const VERDICT_OPTIONS = ['PASS', 'PASS_WITH_SUGGESTIONS', 'BLOCK', '—'];

export interface FieldDef {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

const sel = (name: string, options: string[]): FieldDef => ({
  field_name: name,
  type: 3,
  property: { options: options.map((o) => ({ name: o })) },
});
const num = (name: string, formatter = '0'): FieldDef => ({ field_name: name, type: 2, property: { formatter } });
const date = (name: string): FieldDef => ({
  field_name: name,
  type: 5,
  property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false },
});
const text = (name: string): FieldDef => ({ field_name: name, type: 1 });
const url = (name: string): FieldDef => ({ field_name: name, type: 15 });

/** 工单表：一行一个工单，看板视图按「当前阶段」分组 */
export const TICKET_TABLE = '工单';
export const TICKET_FIELDS: FieldDef[] = [
  text('工单号'), // 主字段
  text('项目'),
  text('需求'),
  sel('当前阶段', STAGE_OPTIONS),
  sel('运行状态', RUN_STATE_OPTIONS),
  sel('通道', LANE_OPTIONS),
  text('当前在等'),
  num('累计成本USD', '0.00'),
  num('会话数'),
  num('评审回环'),
  num('验收回环'),
  text('分支'),
  url('工件目录'),
  url('交付文档'),
  date('开始时间'),
  date('最后更新'),
];

/** 节点表：一行一次阶段运行或一次人工决策 */
export const NODE_TABLE = '节点';
export const NODE_FIELDS: FieldDef[] = [
  text('记录'), // 主字段：LS-003 · 评审 · 第2轮
  text('工单号'),
  text('项目'),
  sel('阶段', STAGE_OPTIONS),
  num('轮次'),
  sel('结果', RESULT_OPTIONS),
  sel('结论', VERDICT_OPTIONS),
  text('摘要'),
  text('人工决策'),
  num('成本USD', '0.00'),
  num('轮数'),
  url('产物'),
  date('时间'),
];

/** 知识表：跨工单累积的可复用经验，供各阶段检索 */
export const KB_TABLE = '知识';
export const KB_KINDS = ['踩坑', '项目常识', '流程改进', '决策先例'];
/** 适用范围决定跨项目复用：本项目的不外溢，技术栈/执行环境/流程级的所有项目都该看到 */
export const KB_SCOPES = ['本项目', '技术栈', '执行环境', '流程'];
/**
 * 状态门：新条目「待审」，人审通过才「生效」参与注入，纠错走「已失效」（保留历史，不删）。
 * 没有人审门的自动写入记忆，最终都会变成提示词污染源。
 */
export const KB_STATUSES = ['待审', '生效', '已失效'];
export const KB_FIELDS: FieldDef[] = [
  text('标题'), // 主字段
  text('项目'),
  sel('状态', KB_STATUSES),
  sel('适用范围', KB_SCOPES),
  sel('类型', KB_KINDS),
  text('标签'),
  text('现象'),
  text('根因'),
  text('正确做法'),
  text('来源工单'),
  url('证据'),
  date('记录时间'),
];

/** 关联字段单独加：需要工单表的 table_id，建表后再补 */
export const nodeLinkField = (ticketTableId: string): FieldDef => ({
  field_name: '工单',
  type: 18,
  property: { table_id: ticketTableId },
});
