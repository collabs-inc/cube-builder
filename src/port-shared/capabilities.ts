// What this host can do. The preload answers all-true; the browser shim
// answers honestly. The UI HIDES an affordance whose flag is false rather
// than offering a dead button; the corresponding window.api member still
// exists and throws UnsupportedOnWeb, so a forgotten call site fails loudly
// in development instead of no-op'ing in a user's tab.
export interface Capabilities {
  /** Local (this-machine) repos and terminals. */
  localRepos: boolean;
  /** Image and PDF viewing (cube-file:// scheme). */
  images: boolean;
  /** Native OS context menus (false = DOM menus). */
  nativeMenus: boolean;
  /** In-app auto-updater UI. */
  updater: boolean;
  /** Reveal in Finder / open in system terminal. */
  revealInFinder: boolean;
  /** Native folder picker (Add local repo). */
  folderPicker: boolean;
}
export const ALL_CAPABILITIES: Capabilities = { localRepos: true, images: true, nativeMenus: true, updater: true, revealInFinder: true, folderPicker: true };
