# Third-party notices

Web Image Bridge's own source code is licensed under the [MIT License](LICENSE).
The Windows release package also contains the third-party software below, each under its own license.
Nothing here changes those licenses; where this file and a component's own license differ, the component's license applies.

In an unzipped release package the full license files are kept next to each component:

| What | Where in the package |
| --- | --- |
| Electron | `runtime/LICENSE` |
| Chromium and the libraries it includes | `runtime/LICENSES.chromium.html` |
| npm packages | `runtime/resources/app/node_modules/<package>/` (`LICENSE`, `NOTICE` and `README` as published) |
| GNU LGPL 3.0 and GNU GPL 3.0 texts | `runtime/resources/app/licenses/` |
| This file and the project license | package root and `runtime/resources/app/` |

## Electron runtime

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Electron | 44.4.3 | MIT | <https://github.com/electron/electron/releases/tag/v44.4.3> |

Electron bundles Chromium, Node.js, FFmpeg and other libraries. Their licenses and notices are listed in `LICENSES.chromium.html`, shipped unchanged from the Electron distribution.

## npm packages

Production dependencies installed in the package, direct and indirect:

| Package | Version | License |
| --- | --- | --- |
| `@hono/node-server` | 1.19.17 | MIT |
| `@img/colour` | 1.1.0 | MIT |
| `@img/sharp-win32-x64` | 0.35.4 | Apache-2.0 AND LGPL-3.0-or-later (see below) |
| `@modelcontextprotocol/client` | 2.0.0 | MIT |
| `@modelcontextprotocol/core` | 2.0.0 | MIT |
| `@modelcontextprotocol/node` | 2.0.0 | MIT |
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `@types/node` | 24.13.6 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `detect-libc` | 2.1.2 | Apache-2.0 |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.8 | BSD-3-Clause |
| `hono` | 4.13.8 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.12 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `semver` | 7.8.5 | ISC |
| `sharp` | 0.35.4 | Apache-2.0 |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `smol-toml` | 1.8.0 | BSD-3-Clause |
| `undici-types` | 7.18.2 | MIT |
| `which` | 2.0.2 | ISC |
| `zod` | 4.6.5 | MIT |

## libvips and LGPL components

`@img/sharp-win32-x64` contains prebuilt, unmodified dynamic libraries (`lib/libvips-42.dll`, `lib/libvips-cpp-8.18.6.dll`) built from libvips 8.18.6 and its dependencies.
Some of these are licensed under the GNU Lesser General Public License version 3: libvips, glib, pango, fribidi, libheif, librsvg, libexif and proxy-libintl. cairo is under the Mozilla Public License 2.0, and the rest are under permissive licenses. The package's `README.md` lists the license of each library, and `versions.json` lists the exact versions.

- Web Image Bridge uses these libraries only through dynamic linking. The DLLs are shipped as separate, unpacked files, so you can replace them with a compatible build you made yourself.
- The full license texts are in [`licenses/LGPL-3.0.txt`](licenses/LGPL-3.0.txt) and [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).
- Source code:
  - libvips 8.18.6: <https://github.com/libvips/libvips/releases/tag/v8.18.6>
  - sharp 0.35.4, which packages the prebuilt libraries: <https://github.com/lovell/sharp/tree/v0.35.4>
  - Build scripts for the prebuilt libraries: <https://github.com/lovell/sharp-libvips>
  - Each other library's source is published by its project at the version listed in `versions.json`.

If a source link stops working, please open an [issue](https://github.com/tttaliesin/codex-image-web-gpt/issues) and the corresponding source will be provided.
