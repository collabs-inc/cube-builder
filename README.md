# Cube Builder

Cube Builder is a workspace for repositories, worktrees, terminals, coding agents,
files, and HTML previews on the machine where you install it. It runs as a
standalone web app and includes a `cube.json` manifest for installation in Cube.
It uses its own server and terminal worker. It does not need Cube APIs, a browser
preload, a parent-frame bridge, or a Cube daemon.

## Install in Cube

Open **Apps** on your chosen machine, enter this repository's Git URL, and choose
**Add app**:

```text
https://github.com/collabs-inc/cube-builder
```

Cube runs `npm ci && npm run build`, then starts `node dist/server.js` with its
assigned `PORT`. All directories, Git operations, and agent processes belong to
that installation's machine. Builder does not connect to your other machines.

## Run standalone

Use Node.js 22.16 or later and Git on Linux or macOS. The native terminal module
may need Python 3 and a C/C++ build toolchain: build-essential on Linux or Xcode
Command Line Tools on macOS. Allow about 4 GiB of memory for the production build.

```sh
git clone https://github.com/collabs-inc/cube-builder.git
cd cube-builder
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3210`. Set `PORT` to choose another port. The server binds
to loopback. For remote access, use an authenticated reverse proxy that preserves
`Host` and `Origin` and sets `X-Forwarded-Proto: https`. Cube provides this gate
when you install the app there.

## Use your workspace

Choose **Open folder** to register a directory. You can create or clone a Git
repository, create worktrees, browse and upload files, edit Markdown or source,
and open image, PDF, and HTML previews. Removing a repository registration keeps
its files on disk. Removing a worktree checks for uncommitted work and live
Builder terminals first.

Builder discovers `claude`, `codex`, and `opencode` on its server's `PATH`. Install
and sign in to those CLIs on the same machine before launching them. Builder uses
per-launch attention hooks and never rewrites your global agent configuration.
Resume is an explicit agent action; opening Builder never resumes agents for you.

Layouts and display preferences are specific to each browser. Repositories,
files, and terminals are shared by browsers connected to the same installation.
HTML previews run in opaque sandboxed frames and cannot call Builder's control
API. Conflicting file edits keep your draft available to download or reload.

## Terminal lifetime and data

Hiding a pane, closing the browser, restarting the web server, or updating the
app keeps its terminal processes running. The terminal worker and its native
runtime live outside the replaceable app checkout. Reopening Builder reconnects
to those sessions. A machine reboot ends processes; it does not relaunch them.

**Close terminal** ends that terminal. **Settings → Stop all terminals** ends all
Builder terminals. Stop terminals before uninstalling if you want them to end:
uninstalling the HTTP app leaves running worker sessions alive. You can reinstall
with the same state directory to reconnect and stop them.

State lives in:

- Linux: `$XDG_STATE_HOME/cube-builder`, or `~/.local/state/cube-builder`.
- macOS: `~/Library/Application Support/Cube Builder`.
- Either platform: the directory set by `BUILDER_STATE_DIR`, when provided.

The state directory contains the registry, attention spool, browser helper, and
versioned worker runtimes. The worker uses a private Unix socket under the system
temporary directory. Output replay is bounded and held in memory. Source files
and Git repositories remain at the paths you register.

The built-in Cube Builder and this app have separate sessions and registries.
This app does not attach to or stop the built-in Builder's terminals.

## Development and verification

Run the checks from the repository root:

```sh
npm ci
npm run typecheck
npm run build
npm test
node scripts/check-public.mjs
```

The browser acceptance runner uses `cube-browser` locally and Playwright in CI. It creates disposable
repositories and state, drives real terminals and editors, and tests sandboxed
previews. Run it after building:

```sh
node --import tsx test/browser/run.ts
```

Linux was exercised locally with real PTYs, browser interaction, and Cube's
install/update/uninstall lifecycle. The host fixture is maintained in Cube's
own test suite. The CI matrix also targets macOS; a configured CI job
is not a claim that a macOS run has passed.

Adapted source files are listed in `scripts/extraction-manifest.json`. See
[NOTICE.md](NOTICE.md) for third-party notices and [LICENSE](LICENSE) for the
license of this repository's code.
