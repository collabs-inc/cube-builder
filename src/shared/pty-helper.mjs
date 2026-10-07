import { lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';

// node-pty 1.1.0's published Darwin helpers can have mode 0644. Repair only
// its known executable files, including cached runtimes used by live workers.
export async function repairPtyHelpers(packageRoot) {
  for (const directory of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
    const path = join(packageRoot, directory, 'spawn-helper');
    try {
      const info = await lstat(path);
      if (info.isFile() && (info.mode & 0o111) !== 0o111) await chmod(path, info.mode | 0o111);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
