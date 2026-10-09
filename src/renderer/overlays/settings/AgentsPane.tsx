/**
 * The preferred agent for new conversations — or, with conversations gated
 * off, for the terminal ⌘N opens — with local installation actions.
 */



import { useEffect, useState } from "react";
import { AGENT_HARNESS_IDS, LOCAL_MACHINE_ID, type AgentHarnessId } from "@port/shared/types";
import { acpConversationsEnabled } from "../../feature-flags";
import { services } from "../../services";
import type { TerminalTargetOption } from "../../services/types";
import { DEFAULT_AGENT_PREF, getDefaultAgent } from "../../items/agent/default-agent";
import { availableAgentTargets } from "../../items/agent/available-agents";
import { runCommandInFreshTerminal } from "../../items/run-command-in-terminal";
import { closePanel } from "../../state/desktop";
import { RadioRow, SettingAction, SettingGroup } from "./rows";
import { confirmDialog } from '../ConfirmDialog';

/** The Cmd+N accelerator, written the way HotkeysPane writes shortcuts. */
function newAgentShortcut(): string {
  return services.desktop.getPlatform() === "darwin" ? "⌘N" : "Ctrl+N";
}

/**
 * Opens a local terminal with the vendor's install command run in it, on
 * click. The terminal is forced to `target: "shell"` — a new terminal
 * otherwise inherits the user's own default, which in this app may well BE
 * an agent, and a command typed at an agent is submitted as a prompt
 * instead of run. It is pinned to the local machine rather than the active
 * repo's, because a cloud repo's machine already has all three harnesses
 * and installing there would fix nothing.
 *
 * The panel is closed afterwards, the way the Agents surface's own install
 * does: the terminal this just opened is behind it.
 */
async function installHarness(option: TerminalTargetOption): Promise<void> {
  if (option.installCommand === undefined) return;
  try {
    await runCommandInFreshTerminal({ machineId: LOCAL_MACHINE_ID, command: option.installCommand });
    closePanel();
  } catch (err: unknown) {
    console.error("[settings] failed to open an install terminal:", err);
  }
}

/**
 * The strip under a harness this machine can't run. It stays SELECTABLE on
 * purpose — the pref is global while installation is per-machine, and the
 * cubed image carries all three, so a harness missing here is still the
 * right default for someone who works mainly on cloud repos. Hence the
 * wording: what's true locally, and what's true in the cloud.
 */
function InstallStrip({ option }: { option: TerminalTargetOption }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="setting-install-strip">
      <p className="setting-install-note">
        Not installed locally
      </p>
      <SettingAction
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void installHarness(option);
        }}
      >
        Install
      </SettingAction>
    </div>
  );
}

export default function AgentsPane({ visible = true }: { visible?: boolean } = {}) {
  const [target, setTarget] = useState<string | null>(null);
  const [options, setOptions] = useState<TerminalTargetOption[]>([]);

  useEffect(() => {
    getDefaultAgent().then(setTarget).catch(() => {});
    availableAgentTargets()
      .then((items) => setOptions(items.filter(item => AGENT_HARNESS_IDS.includes(item.id as AgentHarnessId) || (item.id.startsWith("catalog:") && item.installed))))
      .catch(() => {});
  }, []);

  async function handleTargetChange(value: string) {
    setTarget(value);
    await services.prefs.set(DEFAULT_AGENT_PREF, value);
  }

  return (
    <div className="settings-content">
      {/* With conversations gated off (feature-flags.ts), ⌘N opens a
          terminal running this agent, so say that rather than promise a
          conversation the build cannot offer. */}
      <SettingGroup label={acpConversationsEnabled() ? "New conversations" : "New terminals"}>
        <p className="setting-note agent-default-note">Default agent · {newAgentShortcut()}</p>
        <div className="setting-radio-list">
          {options.map((option) => (
            <div key={option.id}>
              <RadioRow
                selected={target === option.id}
                onClick={() => {
                  void handleTargetChange(option.id as AgentHarnessId);
                }}
                label={option.label}
                attached={option.installCommand !== undefined}
              />
              {option.installCommand !== undefined && <InstallStrip option={option} />}
            </div>
          ))}
        </div>
      </SettingGroup>
      <SettingGroup label="Running sessions">
        <p className="setting-note">Terminals and agents keep running when you close, reload, or update Builder. Stop them here before shutting down their work.</p>
        <SettingAction onClick={()=>{void confirmDialog({
          message:'Stop all Builder sessions?',
          detail:'This stops every terminal and agent launched by this Builder installation. Other apps and sessions are unaffected.',
          buttons:['Cancel','Stop all sessions'],
          onConfirm:()=>services.pty.stopAll(),
          pendingMessage:'Stopping sessions…',
        })}}>Stop all sessions</SettingAction>
      </SettingGroup>
    </div>
  );
}
