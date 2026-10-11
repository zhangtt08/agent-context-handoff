#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const serverCjs = path.join(ROOT, 'release', 'app', 'server.cjs');

const { startServer } = require(serverCjs);
const port = Number(process.env.AGENT_PORT || process.env.ACB_PORT || 5174);

try {
  const handle = await startServer(port);
  console.log(`[agent] ACB v0.2.0 -> http://127.0.0.1:${handle.port}`);
} catch (err) {
  console.error(`[agent] ACB 启动失败:`, err);
  process.exit(1);
}
