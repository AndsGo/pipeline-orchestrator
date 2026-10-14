export type CostStatus = 'reported' | 'partial' | 'unknown';
export function formatCost(usd: number, status: CostStatus = 'reported', digits = 2): string {
  if (status === 'unknown') return '费用未知';
  const value = `$${usd.toFixed(digits)}`;
  return status === 'partial' ? `已报告 ${value}（另有未知费用）` : value;
}
export function aggregateCostStatus(entries: { costStatus?: CostStatus }[]): CostStatus {
  if (!entries.some(e => e.costStatus === 'unknown' || e.costStatus === 'partial')) return 'reported';
  return entries.length > 0 && entries.every(e => e.costStatus === 'unknown') ? 'unknown' : 'partial';
}
