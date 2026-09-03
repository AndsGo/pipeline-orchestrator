import { runClaudeText, runStage } from '../runner.js';
import type { Engine } from './types.js';

/** 原生引擎：claude -p（实现在 runner.ts，这里只是挂到接口上） */
export const claudeEngine: Engine = {
  name: 'claude',
  runStage,
  runText: runClaudeText,
};
