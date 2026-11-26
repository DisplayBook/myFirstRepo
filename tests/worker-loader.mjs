// Loads workers/trip-ai/worker.js for tests with its internal helpers exported.
// The worker file itself only has `export default { fetch }`, which is what
// Cloudflare expects; this adds a named export to a copy, in memory.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../workers/trip-ai/worker.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(`${src}\nexport { makeHandler, verifyFirebaseToken, checkBody };\n`).toString('base64')}`);
export const { makeHandler, verifyFirebaseToken, checkBody } = mod;
export default mod.default;
