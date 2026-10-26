import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  request: vi.fn(), get: vi.fn(), start: vi.fn(),
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { request = sdk.request; im = { message: { get: sdk.get } }; },
  WSClient: class { start = sdk.start; },
  EventDispatcher: class {
    register(handlers: typeof sdk.handlers) { sdk.handlers = handlers; return this; }
  },
}));
import { FeishuPort } from '../feishu/port.js';

beforeEach(() => {
  vi.restoreAllMocks(); sdk.request.mockReset(); sdk.get.mockReset(); sdk.start.mockReset();
  sdk.request.mockResolvedValue({ bot: { open_id: 'ou_bot' } });
  sdk.get.mockResolvedValue({ data: { items: [] } });
});
async function ingress() {
  const received = vi.fn();
  const port = await FeishuPort.create({ appId: 'test', appSecret: 'test', chatId: 'chat' }, received);
  const quote = vi.spyOn(port, 'fetchQuoted').mockResolvedValue('quoted context');
  const download = vi.spyOn(port as unknown as { downloadQuotedResource(ref: unknown): Promise<string | null> }, 'downloadQuotedResource').mockResolvedValue('image.png');
  const notify = vi.spyOn(port, 'notify').mockResolvedValue();
  return { port, received, quote, download, notify, send: (message: Record<string, unknown>) => sdk.handlers['im.message.receive_v1']({ message: { chat_id: 'chat', message_id: 'message', message_type: 'text', ...message }, sender: { sender_id: { open_id: 'human' } } }) };
}
describe('explicit bot mention at message ingress', () => {
  it.each(['/run deploy', '/new fix checkout', '继续 LS-007', '暂停流水线', '通过', '全部同意，顺便开个工单'])('ignores unmentioned %s before daemon dispatch or quote expansion', async text => {
    const h = await ingress();
    await h.send({ content: JSON.stringify({ text }), root_id: 'thread-root', thread_id: 'thread', parent_id: 'quoted' });
    expect(h.received).not.toHaveBeenCalled(); expect(h.quote).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled(); expect(sdk.get).not.toHaveBeenCalled();
  });
  it('does not download unmentioned rich-text images or act on @colleague', async () => {
    const h = await ingress();
    await h.send({ message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'img', image_key: 'image' }, { tag: 'at', user_id: 'colleague' }, { tag: 'text', text: '/run deploy' }]] }), mentions: [{ id: { open_id: 'colleague' } }] });
    expect(h.download).not.toHaveBeenCalled(); expect(h.received).not.toHaveBeenCalled();
  });
  it('delivers an explicitly mentioned slash command', async () => {
    const h = await ingress();
    await h.send({ content: JSON.stringify({ text: '@_user_1 /list' }), mentions: [{ id: { open_id: 'ou_bot' } }] });
    expect(h.received).toHaveBeenCalledWith(expect.objectContaining({ text: '/list', mentioned: true }));
  });
  it('verifies missing event mentions by message metadata before accepting rich text', async () => {
    const h = await ingress(); sdk.get.mockResolvedValue({ data: { items: [{ mentions: [{ id: 'ou_bot' }] }] } });
    await h.send({ message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: '继续' }]] }), mentions: [] });
    expect(sdk.get).toHaveBeenCalledTimes(1);
    expect(h.received).toHaveBeenCalledWith(expect.objectContaining({ text: '继续', mentioned: true }));
  });
  it.each(['colleague', undefined])('does not accept an unresolved body @ (metadata: %s)', async id => {
    const h = await ingress(); sdk.get.mockResolvedValue({ data: { items: [{ mentions: id ? [{ id }] : [] }] } });
    await h.send({ content: JSON.stringify({ text: '@_user_1 /run deploy' }), mentions: [] });
    expect(h.received).not.toHaveBeenCalled();
  });
  it('ignores ambiguous mentions when the metadata read fails', async () => {
    const h = await ingress(); sdk.get.mockRejectedValue(new Error('metadata unavailable'));
    await h.send({ content: JSON.stringify({ text: '@_user_1 /run deploy' }) });
    expect(h.received).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
  });
  it('cannot accept message commands without the bot identity', async () => {
    sdk.request.mockResolvedValue({}); const h = await ingress();
    await h.send({ content: JSON.stringify({ text: '@_user_1 /list' }), mentions: [{ id: 'ou_bot' }] });
    expect(h.received).not.toHaveBeenCalled();
  });
  it('retains explicit card actions without a chat-message mention', async () => {
    const h = await ingress(); const action = vi.spyOn(h.port, 'handleCardAction').mockReturnValue('denied');
    const result = await sdk.handlers['card.action.trigger']({ action: { value: { kind: 'answer' } }, operator: { open_id: 'human' } });
    expect(action).toHaveBeenCalled(); expect(result).toMatchObject({ toast: { type: 'warning' } });
  });
});
