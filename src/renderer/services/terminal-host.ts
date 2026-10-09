import type { TerminalHost } from '../../components/Terminal/host';
import { services } from './index';

/** The extracted terminal component uses Builder's own services. */
export const terminalHost: TerminalHost = {
  getPlatform: () => services.desktop.getPlatform(),
  openExternal: url => services.desktop.openExternal(url),
  ptyWrite: (id, text) => services.pty.write(id, text),
  ptyResize: (id, cols, rows) => {
    void services.pty.resize(id, cols, rows).catch(error => console.error('[terminal] resize failed:', error));
  },
  writeClipboardText: text => services.desktop.clipboard.writeText(text),
  onPtyData: (id, callback) => services.pty.onData(id, callback),
  offPtyData: (id, callback) => services.pty.offData(id, callback),
  ptyStashFile: (id, bytes, mime, name) => services.pty.stashFile(id, bytes, mime, name),
  isDirectory: path => services.files.isDirectory(path),
  onShellBlur: callback => services.desktop.onShellBlur(callback),
};
