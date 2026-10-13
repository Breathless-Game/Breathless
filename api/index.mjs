// The one Vercel Function: every /api route (vercel.json rewrites /api/* here). The handlers are
// the server's own (sensor/vercel-handler.mjs); self-hosting with `npm start` (sensor/index.mjs)
// never loads this file. See deploy/VERCEL.md.

import { createVercelHandler } from '../sensor/vercel-handler.mjs';

export default createVercelHandler();
