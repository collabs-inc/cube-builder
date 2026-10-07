# Notices

Cube Builder includes source adapted from Cube. The per-file source paths and
revision are recorded in `scripts/extraction-manifest.json`. This repository has
independent Git history and does not require the source repository at runtime or
build time. Adapted Cube code is released under this repository's MIT license.

## Editor and terminal dependencies

Dependencies retain their respective licenses. The installed packages include
the full license texts; `package-lock.json` records exact resolved versions.

- BlockNote (`@blocknote/core`, `@blocknote/react`, and `@blocknote/mantine`):
  Mozilla Public License 2.0, copyright TypeCell. Their source is available at
  <https://github.com/TypeCellOS/BlockNote>. This app consumes the published
  packages without modifying their source files.
- Monaco Editor: MIT, copyright Microsoft Corporation.
- xterm.js and its addons: MIT, copyright the xterm.js authors.
- node-pty: MIT, copyright its contributors. The durable worker runtime copies
  node-pty's license together with its JavaScript and native runtime files.
- PDF.js (`pdfjs-dist`): Apache License 2.0, copyright Mozilla Foundation.
- React: MIT, copyright Meta Platforms, Inc. and affiliates.
- Phosphor Icons: MIT, copyright Phosphor Icons.

## Fonts

The interface requests IBM Plex Mono, Inter, Geist, and Geist Mono from Google
Fonts. These fonts use the SIL Open Font License 1.1. The app uses system font
fallbacks when the font service is unavailable. No font binaries are vendored.

- IBM Plex: <https://github.com/IBM/plex>.
- Inter: <https://github.com/rsms/inter>.
- Geist: <https://github.com/vercel/geist-font>.
