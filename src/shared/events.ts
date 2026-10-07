import type { BuilderSnapshot } from './model.js';
import type { TerminalEvent } from './terminal-protocol.js';
export type BuilderEvent = { type: 'snapshot'; snapshot: BuilderSnapshot } | { type: 'terminal'; event: TerminalEvent } | { type: 'error'; message: string } | { type: 'files'; paths: string[] };
