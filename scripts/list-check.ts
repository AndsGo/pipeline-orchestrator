// 自检：/list 会列出哪些工单（排除 data/ 下的基础设施文件）
import { listTickets } from '../src/events.js';
console.log('LIST:', JSON.stringify(listTickets()));
