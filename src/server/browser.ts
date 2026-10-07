import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Per-launch browser helper outside the replaceable checkout. The terminal
 * surfaces a link for a user gesture; an agent cannot open a tab by itself. */
export async function browserCommand(stateDir: string): Promise<string> {
  const dir = join(stateDir, 'bin'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'builder-open'), temp = `${file}.${randomUUID()}`;
  await writeFile(temp, '#!/bin/sh\ncase "$1" in http://*|https://*) printf "\\033]5522;%s\\007" "$1" > /dev/tty ;; *) exit 1 ;; esac\n', { mode: 0o700 });
  await rename(temp, file); return file;
}
