import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import app, { closePool } from './index.mjs';

const folder = path.dirname(fileURLToPath(import.meta.url));
const local = express();
local.disable('x-powered-by');
local.use(express.static(path.resolve(folder, 'public'), { index: 'index.html', dotfiles: 'deny', etag: false, maxAge: 0 }));
local.use(app);

const port = Number(process.env.PORT || 8788);
const server = local.listen(port, () => console.log(`Festin local server listening on port ${port}`));
async function shutdown() {
  server.close();
  await closePool();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
