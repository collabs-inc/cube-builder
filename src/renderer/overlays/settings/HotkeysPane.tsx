import { SHORTCUT_ACCELERATORS, formatShortcut } from "@port/shared/shortcuts";
import { acpConversationsEnabled } from "../../feature-flags";
import { services } from "../../services";
import { SettingGroup, SettingRow } from "./rows";

export default function HotkeysPane() {
  const platform = services.desktop.getPlatform();
  const key = (action: keyof typeof SHORTCUT_ACCELERATORS) => formatShortcut(SHORTCUT_ACCELERATORS[action], platform);
  const directions = (action: 'focus-pane-left' | 'move-pane-left') => key(action).replace('←', '← ↑ → ↓');
  const groups = [
    { label: 'General', items: [
      { label: 'Settings', keys: key('toggle-settings') },
      { label: 'Toggle app sidebar', keys: key('sidebar-files') },
      { label: acpConversationsEnabled() ? 'New conversation' : 'New terminal', keys: key('new-tile') },
      { label: 'Add cloud repo', keys: key('add-repo') },
      { label: 'Find in conversation', keys: formatShortcut('CommandOrControl+F', platform) },
      { label: 'Dismiss dialog', keys: 'Esc' },
    ] },
    { label: 'Panes & screens', items: [
      { label: 'Toggle Cube Builder sidebar', keys: key('studio-sidebar') },
      { label: 'Hide pane', keys: key('close-tile') },
      { label: 'Close screen', keys: key('close-screen') },
      { label: 'Go to screen 1–9', keys: key('go-to-screen').replace('1', '1–9') },
      { label: 'Expand pane', keys: key('zoom-pane') },
      { label: 'Focus adjacent pane', keys: directions('focus-pane-left') },
      { label: 'Move pane', keys: directions('move-pane-left') },
    ] },
    { label: 'Window', items: [
      { label: 'Zoom in', keys: formatShortcut('CommandOrControl+=', platform) },
      { label: 'Zoom out', keys: formatShortcut('CommandOrControl+-', platform) },
      { label: 'Actual size', keys: formatShortcut('CommandOrControl+0', platform) },
      { label: 'Toggle full screen', keys: platform === 'darwin' ? '⌃⌘F' : 'F11' },
    ] },
  ];
  return <div className="settings-content">
    {groups.map(group => <SettingGroup key={group.label} label={group.label} ruled>
      {group.items.map(({ label, keys }) => <SettingRow key={label} label={label}>
        <kbd className="setting-kbd">{keys}</kbd>
      </SettingRow>)}
    </SettingGroup>)}
  </div>;
}
