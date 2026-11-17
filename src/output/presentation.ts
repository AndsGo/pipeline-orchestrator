import type { OutputLevel } from './configuration.js';
export { renderOutput } from './records.js';

export interface OutputResponse { summary: string; detail: string; risks: string[]; actions: string[]; evidence: string[]; }

export function composeOutputInstructions(): string {
  return `请在本次调用中同时生成简洁摘要与完整说明，只返回一个 JSON 对象，可用 \`\`\`output-result 代码围栏包裹。结构必须为：
{"summary":"面向用户的简洁结论，不能为空","detail":"完整说明、推理依据与必要技术细节","risks":["所有会影响用户决策的风险、限制、未验证事项"],"actions":["用户需要采取的行动或作出的决定"],"evidence":["实际引用的来源、文件、检查或测试结果"]}
五个业务字段必须全部提供。另可提供可选的 internalHandoff 字符串，仅供会话交接，记录内部工具地址、脚本路径、调用参数；这些内部交接信息不得放入业务五字段。除此之外不得增加字段。summary、detail 为字符串；risks、actions、evidence 为字符串数组，没有内容时用 []。摘要必须独立可读，先回答业务结论、影响和下一步，用短句和日常词，不以函数名、字段名或工具过程开头；明确区分代码核对、测试通过、已上线和线上已验证，不要把检查结果夸大为上线结果。不要截取正文充当摘要，detail 保留专业细节。所有关键风险和待用户决策事项都必须列入 risks/actions，不能仅放在 detail 或 evidence。依据必须真实，不要编造检查或来源。`;
}

export function parseOutputResponse(text: string): OutputResponse | null {
  const trimmed = text.trim();
  const fenced = /^```(?:output-result|json)\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const fields = ['summary', 'detail', 'risks', 'actions', 'evidence'];
  if (fields.some(key => !Object.hasOwn(candidate, key)) || Object.keys(candidate).some(key => !fields.includes(key) && key !== 'internalHandoff')
    || (candidate.internalHandoff !== undefined && typeof candidate.internalHandoff !== 'string')
    || typeof candidate.summary !== 'string' || !candidate.summary.trim() || typeof candidate.detail !== 'string'
    || ['risks', 'actions', 'evidence'].some(key => !Array.isArray(candidate[key]) || !(candidate[key] as unknown[]).every(item => typeof item === 'string' && !!item.trim()))) return null;
  const { summary, detail, risks, actions, evidence } = candidate as unknown as OutputResponse;
  return { summary, detail, risks, actions, evidence };
}

/** Failed structured responses must not turn internal handoff fields into public prose. */
export function fallbackOutputResponse(text: string): OutputResponse {
  const empty = { summary: '', risks: [], actions: [], evidence: [] };
  const withheld = { ...empty, detail: '输出格式异常，无法安全展示；原始内容已仅在内部留档，请重新生成回复。' };
  const hasHandoff = (value: string): boolean => /internal[\s_-]*handoff/i.test(value.replace(/\\u([0-9a-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16))));
  const trimmed = text.trim();
  const fenced = /^```(?:output-result|json)\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { return hasHandoff(text) ? withheld : { ...empty, detail: text }; }
  // The replacer removes this field at every depth while retaining all business fields and types.
  const detail = JSON.stringify(value, (key, item: unknown) => key === 'internalHandoff' ? undefined : item, 2);
  if (hasHandoff(detail)) return withheld;
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const items = (key: string): string[] => Array.isArray(candidate[key]) && candidate[key].every((item): item is string => typeof item === 'string' && !!item.trim()) ? candidate[key] : [];
  return { summary: '', detail, risks: items('risks'), actions: items('actions'), evidence: items('evidence') };
}

/** Only explicit instructions in the current request select a presentation override. */
export function extractOutputOverride(text: string): OutputLevel | undefined {
  const request = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  const instruction = /(?:^|[，,。.!！？?；;\n])\s*(?:(?:这次|本次|请|麻烦|回复|回答|答复)[：:\s]*)*(简单说|给业务看|展开依据|给开发看)(?:一下|一点)?\s*(?=$|[，,。.!！？?；;：:\n])/g;
  const levels = new Set<OutputLevel>();
  for (const match of request.matchAll(instruction)) levels.add(['简单说', '给业务看'].includes(match[1]) ? 'concise' : 'professional');
  return levels.size === 1 ? [...levels][0] : undefined;
}
