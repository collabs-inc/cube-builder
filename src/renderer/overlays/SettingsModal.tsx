/**
 * Ported from src/windows/settings/src/App.tsx (the old settings webview),
 * with the transport swapped out: the guest's hand-rolled `SettingsApi` /
 * `window.api` cast is gone, replaced by `services.*` calls. `api.close()`
 * becomes the `onClose` prop; open/close is driven by main
 * (services.desktop.onSettingsToggle in App.tsx sets state/ui.ts's
 * settingsModalOpen, which is what actually mounts/unmounts this
 * component — see App.tsx). Escape and the backdrop click both call
 * `onClose`, same as before.
 *
 * The wrapper markup (backdrop + centered box) is ported from
 * shell/index.html:54-57 and shell.css's #settings-overlay rules
 * (SettingsModal.css). Dropped entirely: the old shell's webview focus
 * juggling (blurNonModalSurfaces, the document-level focusin refocus
 * trap, singletonWebviews.settings.webview.blur()) — none of it is needed
 * here. App.tsx instead sets the native `inert` attribute on the
 * sidebar+main containers while this is open (porting
 * setUnderlyingShellInert's semantics), which already prevents focus and
 * pointer interaction from reaching anything underneath, natively.
 *
 * Dropped along with the canvas skill: IntegrationsPane (a prior review
 * established it was exclusively the canvas-skill install UI) and its nav
 * item, and the getAgents/installSkill/uninstallSkill calls that backed it.
 *
 * This file is the SHELL only (#69): the frame, the rail, which pane is
 * showing, and the shared keyboard/focus behaviour. The panes themselves and
 * the row vocabulary they are built from live in ./settings/. The developer
 * chord stays here rather than moving with its pane, because it belongs to
 * the shell — it has to work before that pane exists.
 */



import { useEffect, useRef, useState } from "react";
import { Keyboard } from '@phosphor-icons/react/dist/csr/Keyboard';
import { Palette } from '@phosphor-icons/react/dist/csr/Palette';
import { Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { CaretLeft } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import "./SettingsModal.css";
import { services } from "../services";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { useDialogBehavior } from "./dialog-behavior";
import { PaneHeader } from "./settings/rows";
import AppearancePane from "./settings/AppearancePane";
import HotkeysPane from "./settings/HotkeysPane";
import AgentsPane from "./settings/AgentsPane";

type Pane = "appearance" | "agents" | "hotkeys";

/**
 * A pane's rail label, and the title and lede its own header shows.
 *
 * `lede` is optional and usually absent. A subtitle earns its place only by
 * saying something the title does not — "Changes take effect for new
 * terminals" is worth a line; "Customize how Cube looks" under the word
 * Appearance is not.
 *
 * The title need not be the nav label: a rail wants the shortest word that
 * identifies a destination, a header the one that describes it. No pane
 * diverges today — Hotkeys used to be "Controls" in the rail and "Keyboard
 * Shortcuts" in the header, and naming it for the thing it lists collapsed
 * the two — but the split stays, because the next pane may need it.
 *
 * Both live here rather than inside each pane so the two projections can
 * frame them differently: the desktop pane scrolls its header at the top of
 * its own column, while the narrow one puts it in the fixed bar beside the
 * back control.
 */
interface NavItem {
  id: Pane;
  label: string;
  title: string;
  lede?: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Rail order: things you own, then things you configure, then things you
 * look up.
 *
 * Account and Cloud lead and stay adjacent. #69 split Account out of Cloud
 * on the grounds that identity and billing belong to the ACCOUNT while the
 * machine is infrastructure that account happens to own — separating the two
 * halves by unrelated panes would undo the relationship that split named.
 *
 * Hotkeys is last of the visible panes because it is the only one that
 * changes nothing: it renders a list and takes no input at all. Panes that DO
 * something come before a pane that only tells you something.
 *
 * Developer is appended after these when unlocked, and stays last: it is a
 * pane of daemon kill switches and an account teardown.
 */
const NAV_ITEMS: NavItem[] = [
  {
    id: "agents",
    label: "Agents",
    title: "Agents",
    icon: Sparkle,
  },
  {
    id: "appearance",
    label: "Appearance",
    title: "Appearance",
    icon: Palette,
  },
  { id: "hotkeys", label: "Hotkeys", title: "Hotkeys", icon: Keyboard },
];

/**
 * What the gear opens: the rail's first row, read from the list rather than
 * named again here. Hardcoding it meant the panel landed on Appearance while
 * the rail's first row said something else, which reads as pre-scrolled. The
 * sidebar's avatar still routes to Account explicitly, and any caller naming
 * a pane still wins over this.
 */
const DEFAULT_PANE: Pane = NAV_ITEMS[0]!.id;

/**
 * The ring, and the key that does the same thing captioned under it.
 *
 * The caption is half of this control: Escape closes the panel, and the
 * label is the only place the app says so. Dropping it left a bare ring
 * that looked subtly wrong without being obviously missing anything.
 */
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        aria-label="Close"
        data-tooltip="Close settings"
        data-shortcut="Escape"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-foreground/25 bg-transparent p-0 text-foreground/25 transition-opacity duration-150 hover:text-foreground/60 hover:border-foreground/60 cursor-pointer"
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M3 3L9 9M9 3L3 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="text-[11px] tracking-[0px] text-foreground/25 select-none pointer-events-none font-mono">
        esc
      </span>
    </div>
  );
}

const PANE_IDS: Pane[] = ["appearance", "agents", "hotkeys"];
const isPane = (v: string | null | undefined): v is Pane => PANE_IDS.includes(v as Pane);

/**
 * The panel itself — rail and pane — without the modal frame around it.
 * SettingsModal below wraps it in the backdrop and the dialog behaviour;
 * the navigator (desktop/Desktop.tsx) hosts it in its panel instead,
 * `windowed`, where nothing is modal and Escape is the panel's own key
 * rather than the dialog stack's.
 */
export function SettingsPanel({
  onClose,
  initialPane: requestedPane,
  requestId,
  shellRef,
  windowed = false,
  navigator = false,
  visible = true,
}: {
  onClose: () => void;
  initialPane?: string | null | undefined;
  /** Retarget even when an explicit request repeats the same pane. */
  requestId?: number | undefined;
  shellRef?: React.RefObject<HTMLDivElement | null> | undefined;
  windowed?: boolean | undefined;
  /** Use the navigator's single-column list/detail layout and outer header. */
  navigator?: boolean | undefined;
  visible?: boolean | undefined;
}) {
  // Keep older settings links working after the pane rename. The developer
  // pane answers a request only while its chord has revealed it, so a link
  // can never open what the rail does not show.
  // Machine is the sidebar's Machine surface now (MachineTitle.tsx), not a
  // Settings pane, so a request for it lands on the default pane.
  const renamed = requestedPane === "cloud" ? null : requestedPane === "terminal" ? "agents" : requestedPane;
  const initialPane: Pane | null = isPane(renamed) ? renamed : null;
  const [activePane, setActivePane] = useState<Pane>(initialPane ?? DEFAULT_PANE);
  const [appVersion, setAppVersion] = useState("");
  const isNarrow = useIsNarrow();
  const showListDetail = navigator || isNarrow;
  // Narrow's ONE piece of extra state. `activePane` is the same value in both
  // projections and is never reset by crossing the breakpoint, so the panel
  // comes back exactly as it left — the same property Rail.tsx's derived zoom
  // has. The wide layout ignores this entirely.
  //
  // Initialised from `initialPane` so opening straight to a pane
  // (openSettings("cloud") from the sidebar footer) lands ON that pane rather
  // than on a list the user then has to navigate.
  const [drilledIn, setDrilledIn] = useState(initialPane !== null);

  useEffect(() => {
    if (initialPane) {
      setActivePane(initialPane);
      setDrilledIn(true);
    } else if (requestedPane === "cloud") {
      setActivePane(DEFAULT_PANE);
      setDrilledIn(false);
    }
  }, [initialPane, requestedPane, requestId]);
  const navItems = NAV_ITEMS;
  const active = navItems.find(item => item.id === activePane) ?? NAV_ITEMS[0]!;

  useEffect(() => {
    services.desktop
      .getAppVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {});
  }, []);

  const paneBody = (
    <>
      {activePane === "appearance" && <AppearancePane />}
      {activePane === "agents" && <AgentsPane visible={visible} />}
      {/* The machine the sidebar shows — the cloud pane, or this Mac —
          with the host's connected tools under it. */}
      {activePane === "hotkeys" && <HotkeysPane />}
    </>
  );

  /**
   * The same pane in both projections — the caller decides how it is framed,
   * never what it contains.
   *
   * `withHeader` is that framing question and not a content one: on the
   * desktop the pane's title scrolls at the top of its own column, the way
   * every pane used to render its own `<h2>`; the narrow projection puts it
   * in the fixed bar beside the back control instead, so the pane must not
   * also carry it.
   */
  const renderPane = (withHeader: boolean) => (
    <div className="settings-pane scrollbar-hover">
      {withHeader && <PaneHeader title={active.title} lede={active.lede} />}
      {paneBody}
    </div>
  );

  const versionButton = appVersion && <span className="settings-version">v{appVersion}</span>;

  return (
      <div
        ref={shellRef}
        role={windowed ? undefined : "dialog"}
        aria-modal={windowed ? undefined : "true"}
        aria-label="Settings"
        tabIndex={-1}
        className={`settings-modal${showListDetail ? " is-narrow" : ""}${windowed ? " settings-windowed" : ""}${navigator ? " settings-navigator" : ""}`}
        onKeyDown={windowed ? event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } } : undefined}
      >
        {showListDetail ? (
          <div className="settings-shell settings-shell-narrow">
            {drilledIn ? (
              <>
                <div className="settings-narrow-bar">
                  <button
                    type="button"
                    className="settings-back"
                    onClick={() => setDrilledIn(false)}
                  >
                    {navigator ? <><CaretLeft size={12} aria-hidden="true" />Settings</> : "‹ Settings"}
                  </button>
                  <PaneHeader title={active.title} lede={active.lede} />
                </div>
                {renderPane(false)}
              </>
            ) : (
              <>
                {!navigator && <div className="settings-narrow-bar">
                  <h1 className="settings-narrow-title">Settings</h1>
                  <CloseButton onClick={onClose} />
                </div>}
                <nav className="settings-list">
                  {navItems.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className="settings-list-row"
                      onClick={() => {
                        setActivePane(id);
                        setDrilledIn(true);
                      }}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="settings-list-label">{label}</span>
                      <span className="settings-list-chevron" aria-hidden="true">
                        {navigator ? <CaretRight size={12} /> : "›"}
                      </span>
                    </button>
                  ))}
                </nav>
              </>
            )}
            {navigator && <div className="settings-footer">
              {versionButton}
            </div>}
          </div>
        ) : (
          /* Two columns, no band across the top. The rail runs from the close
             control down to the version in one unbroken column — panel
             identity and navigation on the left, the pane and its own title
             on the right. A header band spanning both would cut the frame
             into quadrants and box the rail's title in on two sides. */
          <div className="settings-shell">
            <div className="settings-rail">
              {/* Dismisses the PANEL, so it leads the panel's own column —
                  beside the pane title it read as closing the pane, which is
                  not an operation this panel has. `esc` under it names the
                  key that does the same thing. */}
              {/* In a window (the desktop) the frame already names the
                  panel and carries its close control; the rail starts at
                  the rows. */}
              {!windowed && (
                <div className="settings-rail-close">
                  <CloseButton onClick={onClose} />
                </div>
              )}

              {/* No icon. Every other glyph in this rail belongs to a row you
                  can click, so one in front of the heading made the panel's
                  own name read as another destination. */}
              {!windowed && <h1 className="settings-title">Settings</h1>}

              <nav className="settings-nav">
                {navItems.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActivePane(id)}
                    className={`settings-nav-row${activePane === id ? " is-selected" : ""}`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{label}</span>
                  </button>
                ))}
              </nav>

              {versionButton}
              {/* In a window the sidebar's footer — where the update pill
                  lives — is gone; the pill joins the version here. */}

            </div>

            {renderPane(true)}
          </div>
        )}
      </div>
  );
}

export default function SettingsModal({
  onClose,
  initialPane,
}: {
  onClose: () => void;
  initialPane?: string | null;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  // Escape, Tab, focus entry and focus restore are all the shared
  // behaviour's (dialog-behavior.ts). The panel is in the same stack as every
  // dialog, which is what stops a confirm raised from Cloud closing this
  // panel too when one Escape cancels it (#69) — and, with focus trapped and
  // restored here, replaces both the mount-time pane focus and the
  // window-focus refocus that used to stand in for a trap. That refocus also
  // fought the user on alt-tab, yanking focus back to the pane container
  // whatever they had selected.
  useDialogBehavior(shellRef, { onClose });
  return (
    <div className="settings-overlay app-modal-overlay">
      <div className="settings-backdrop" onClick={onClose} />
      <SettingsPanel onClose={onClose} initialPane={initialPane} shellRef={shellRef} />
    </div>
  );
}
