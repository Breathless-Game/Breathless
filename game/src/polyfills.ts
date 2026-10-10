import { Buffer } from 'buffer';

// Umi and the Irys web uploader expect Node's Buffer as a global.
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown };
g.Buffer ??= Buffer;
g.global ??= globalThis;
