// 验证 wire schema（含正则反斜杠）经 bash "$(cat file)" 展开后原样到达子进程 argv
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const schemaPath = process.env.PIPELINE_SCHEMA ?? 'D:/work/demo/pipeline-plugin/schemas/stage-result.schema.json';
const s = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
delete s.allOf;
const wire = JSON.stringify(s);

const f = path.join(os.tmpdir(), 'wire-probe.json').replace(/\\/g, '/');
fs.writeFileSync(f, wire, 'utf-8');

const shq = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
const cmd = ['node', '-e', shq('console.log(process.argv[1])'), `"$(cat ${shq(f)})"`].join(' ');

const c = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
c.stdout.on('data', (d) => (out += d));
c.on('close', () => {
  try {
    const back = JSON.parse(out.trim());
    const ok = JSON.stringify(back) === wire;
    console.log('wire schema roundtrip:', ok ? 'PASS' : 'FAIL');
    if (!ok) console.log('pattern seen:', back?.properties?.handoff_path?.pattern);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('FAIL parse:', e.message, out.slice(0, 200));
    process.exit(1);
  }
});
