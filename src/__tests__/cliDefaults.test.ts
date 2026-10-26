import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { freezeExecution, assertRequirements, initialConfiguration, validateConfiguration, type AgentProfile } from '../engine/configuration.js';
import { profileCredentialContext } from '../engine/identity.js';
import { engineNamed } from '../engine/index.js';
import * as subprocess from '../engine/process.js';
import { nativeJsonContext, observedNativeModel } from '../engine/nativeDefaults.js';
let root: string;
const env = { ...process.env };
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-cli-defaults-')));
  process.env.CLAUDE_CONFIG_DIR = root; process.env.PIPELINE_CODEX_HOME = root; process.env.XDG_CONFIG_HOME = root; process.env.XDG_DATA_HOME = root;
  delete process.env.OPENCODE_CONFIG; delete process.env.OPENCODE_CONFIG_CONTENT; delete process.env.OPENCODE_CONFIG_DIR;
});
afterEach(() => { vi.restoreAllMocks(); process.env = { ...env }; fs.rmSync(root, { recursive: true, force: true }); });
const profile = (cli: AgentProfile['cli']): AgentProfile => ({ id: 'native-defaults', name: 'Native', cli, modelSource: 'cli', constraintMode: 'native', parameters: {}, state: 'draft' });
it.each(['claude','codex','opencode'] as const)('freezes the follow-native choice for %s instead of pipeline model env', cli => {
  process.env.PIPELINE_CODEX_MODEL = 'other'; process.env.PIPELINE_CLASSIFY_MODEL = 'other'; process.env.PIPELINE_OPENCODE_MODEL = 'other';
  const p = profile(cli); const c = initialConfiguration(); c.profiles.push(p);
  expect(() => validateConfiguration(c)).not.toThrow();
  const snapshot = freezeExecution(undefined, 'classify', p);
  expect(snapshot.model).toBe('@cli-default'); expect(() => assertRequirements(snapshot)).not.toThrow();
  snapshot.profile.modelSource = undefined;
  expect(() => assertRequirements(snapshot)).toThrow('未明确选择');
});
it.each(['claude','codex','opencode'] as const)('does not bind default parent models but binds provider/security/role config for %s', cli => {
  const p = profile(cli);
  const file = cli === 'codex' ? path.join(root,'config.toml') : cli === 'claude' ? path.join(root,'settings.json') : path.join(root,'opencode','opencode.jsonc');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file, cli === 'codex' ? 'model="first"\nmodel_reasoning_effort="low"' : '{"model":"first"}');
  const digest = () => profileCredentialContext(p, undefined, undefined, 'cli-defaults-v1');
  const before = digest();
  fs.writeFileSync(file, cli === 'codex' ? 'model="second"\nmodel_reasoning_effort="high"' : cli === 'claude' ? '{"model":"second","effortLevel":"high","env":{"ANTHROPIC_MODEL":"third"}}' : '{/* native jsonc */"model":"second",}');
  expect(digest()).toBe(before);
  fs.writeFileSync(file, cli === 'codex' ? 'model_provider="changed"' : cli === 'claude' ? '{"permissions":{"allow":["Bash"]}}' : '{"agent":{"reviewer":{"model":"changed"}}}');
  expect(digest()).not.toBe(before);
});
it('normalizes inline and explicit-path OpenCode defaults without ignoring referenced credentials', () => {
  const p=profile('opencode'); process.env.OPENCODE_CONFIG_CONTENT='{"model":"first","provider":{"test":{"options":{"apiKey":"{env:TEST_CLI_SECRET}"}}}}';
  process.env.TEST_CLI_SECRET='first-fixture';
  const digest=()=>profileCredentialContext(p,undefined,undefined,'cli-defaults-v1'); const before=digest();
  process.env.OPENCODE_CONFIG_CONTENT=process.env.OPENCODE_CONFIG_CONTENT.replace('"first"','"second"'); expect(digest()).toBe(before);
  process.env.TEST_CLI_SECRET='second-fixture'; expect(digest()).not.toBe(before);
  delete process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG=path.join(root,'external.jsonc');fs.writeFileSync(process.env.OPENCODE_CONFIG,'{"model":"first"}');const external=digest();
  fs.writeFileSync(process.env.OPENCODE_CONFIG,'{"model":"second"}');expect(digest()).toBe(external);
});
it('binds OpenCode provider selection, small-model/role settings and substituted security fields', () => {
  const ctx=(text:string)=>nativeJsonContext(text,'opencode',root);
  expect(ctx('{"model":"one/first"}')).toBe(ctx('{"model":"one/second"}'));
  expect(ctx('{"model":"one/first"}')).not.toBe(ctx('{"model":"two/first"}'));
  expect(ctx('{"small_model":"one/first"}')).not.toBe(ctx('{"small_model":"one/second"}'));
  process.env.NATIVE_MODEL_TEST='one/first';const template='{"model":"{env:NATIVE_MODEL_TEST}"}';const before=ctx(template);
  process.env.NATIVE_MODEL_TEST='one/second';expect(ctx(template)).toBe(before);
  process.env.NATIVE_MODEL_TEST='one/second","permission":{"edit":"allow"},"extra":"';expect(ctx(template)).not.toBe(before);
  fs.writeFileSync(path.join(root,'token.txt'),'fixture-key');
  expect(ctx('{"provider":{"key":"{file:token.txt}"}}')).toContain('fixture-key');
  expect(()=>ctx('{"model":"{file:absent.txt}"}')).toThrow('引用文件不可读');
  expect(()=>ctx('{"key":"do-not-log-this')).toThrow('无法解析');
});
it('requires strict Claude JSON and preserves fallback/role fields', () => {
  expect(()=>nativeJsonContext('{"model":"first",}','claude')).toThrow('无法解析');
  expect(nativeJsonContext('{"model":"first","fallbackModel":"backup"}','claude')).not.toBe(nativeJsonContext('{"model":"first"}','claude'));
  expect(nativeJsonContext('{"agents":{"reviewer":{"model":"first"}}}','claude')).not.toBe(nativeJsonContext('{"agents":{"reviewer":{"model":"second"}}}','claude'));
});
it('records a model only from parent protocol metadata, never guessed from result prose', () => {
  expect(observedNativeModel('claude',JSON.stringify({type:'system',subtype:'init',model:'reported-model'}))).toBe('reported-model');
  expect(observedNativeModel('claude',JSON.stringify({type:'system',subtype:'init',parent_tool_use_id:'child',model:'child-model'}))).toBeUndefined();
  expect(observedNativeModel('codex','I used a model')).toBeUndefined();
});
it('does not use fixed Codex prices for an unreported native model', async () => {
  process.env.PIPELINE_CODEX_PRICE_IN='10';process.env.PIPELINE_CODEX_PRICE_OUT='20';
  const stdout=[{type:'thread.started',thread_id:'session'},{type:'item.completed',item:{type:'agent_message',text:'ok'}},{type:'turn.completed',usage:{input_tokens:1000,output_tokens:100}}].map(e=>JSON.stringify(e)).join('\n');
  vi.spyOn(subprocess,'runProcess').mockResolvedValue({code:0,stdout,stderr:''});
  const opts={cwd:root,prompt:'fixture',tools:'Read',maxTurns:1,budgetUsd:0,constraintMode:'native' as const};
  const fixed=await engineNamed('codex').runText({...opts,model:'fixed-model'});
  expect(fixed.costStatus).toBe('reported');expect(fixed.costUsd).toBeGreaterThan(0);
  const native=await engineNamed('codex').runText({...opts,model:'@cli-default'});
  expect(native.costStatus).toBe('unknown');expect(native.costUsd).toBe(0);
});
it.each(['model','provider','credentialRef','effort','strict'])('rejects conflicting follow-native override %s', field => {
  const c=initialConfiguration(),p=profile('claude');
  if(field==='effort')p.parameters.effort='high';else if(field==='strict')p.constraintMode='strict';else Object.assign(p,{[field]:'override'});
  c.profiles.push(p);expect(()=>validateConfiguration(c)).toThrow('跟随 CLI');
});
it.each(['claude','codex','opencode'] as const)('omits model and effort flags on new and resumed %s calls and never falls back', async cli => {
  const stdout=cli==='claude'?JSON.stringify({type:'result',is_error:false,session_id:'session',num_turns:1,total_cost_usd:0,result:'ok'}):cli==='codex'?[{type:'thread.started',thread_id:'session'},{type:'item.completed',item:{type:'agent_message',text:'ok'}}].map(e=>JSON.stringify(e)).join('\n'):[{type:'text',sessionID:'session',part:{messageID:'msg',text:'ok'}},{type:'step_finish',sessionID:'session',part:{messageID:'msg',reason:'stop',cost:0}}].map(e=>JSON.stringify(e)).join('\n');
  const run=vi.spyOn(subprocess,'runProcess').mockResolvedValue({code:0,stdout,stderr:''});
  for(const resumeSessionId of [undefined,'session']) {
    await engineNamed(cli).runText({cwd:root,prompt:'fixture',model:'@cli-default',tools:'Read',maxTurns:1,budgetUsd:0,constraintMode:'native',resumeSessionId});
    const args=run.mock.calls.at(-1)![1];const command=args.join(' ');
    expect(args).not.toContain('-m');expect(command).not.toContain('--model');expect(command).not.toContain('--effort');expect(command).not.toContain('model_reasoning_effort');expect(command).not.toContain('@cli-default');
  }
  run.mockClear();run.mockResolvedValue({code:1,stdout:'',stderr:'fixture-failure'});
  const call=engineNamed(cli).runText({cwd:root,prompt:'fixture',model:'@cli-default',tools:'Read',maxTurns:1,budgetUsd:0,constraintMode:'native'});
  if(cli==='codex')expect((await call).isError).toBe(true);else await expect(call).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});
