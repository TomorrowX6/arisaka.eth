# Third-party assets

## Breeze icons

Copyright KDE contributors. Licensed under the GNU Lesser General Public License; see `public/icons/COPYING.LIB.txt`.

Source: https://github.com/KDE/breeze-icons/tree/235730e69d90949621e4fee77fcc459772b7a8f0

SVG symbolic foreground colors are changed to the Breeze Dark palette. No other design changes. Icon symlinks are resolved to their original SVG source.

## CodeMirror

Copyright Marijn Haverbeke and contributors. MIT licensed. The generated editor bundle contains its package license notices in `public/vendor/editor-engine.LICENSE.txt`.

## Desktop wallpapers

Nuvole by Krystian Zajdel is the unmodified 2560×1440 dark wallpaper from KDE Breeze v6.3.5 and is the default for new desktop profiles. Mountain by Andy Betts, Flow by Sandra Smukaste, and Scarlet Tree by axo1otl are from KDE's plasma-workspace-wallpapers collection; these three images have been resized and JPEG-encoded. All are licensed under CC BY-SA 4.0. Pinned source URLs and modifications are recorded in `public/wallpapers/attribution.json`, alongside the full license.

## Desktop fonts

Noto Sans Variable (Latin) and Noto Sans SC Regular are licensed under SIL OFL 1.1. Hack Regular 3.003 is licensed under MIT and the Bitstream Vera font license. The local WOFF2 files, full license texts, pinned source URLs, and conversion details are in `public/fonts/` and `public/fonts/attribution.json`.

## KWin spring motion

`public/motion.js` includes a JavaScript adaptation of KWin v6.3.5's SpringMotion numerical integration, copyright 2022 Vlad Zahorodnii, under GPL-2.0-or-later. It samples the spring into Web Animations keyframes and preserves velocity when reversing a desktop transition. The full license is served at `public/licenses/kwin-GPL-2.0-or-later.txt`; the readable modified source is served at `/motion.js`.

Source: https://github.com/KDE/kwin/blob/v6.3.5/src/plugins/slide/springmotion.cpp

## Browser libraries

Versions and transitive dependencies are pinned in `pnpm-lock.yaml`. Generated bundles are rebuilt from the corresponding npm packages, not committed binaries.

| Library | Source | License / bundled notice |
| --- | --- | --- |
| fflate | https://github.com/101arrowz/fflate | MIT; `public/vendor/codecs.LICENSE.txt` |
| jsQR | https://github.com/cozmo/jsQR | Apache-2.0; `public/vendor/jsQR-LICENSE.txt` |
| OpenPGP.js | https://github.com/openpgpjs/openpgpjs | LGPL-3.0; `public/vendor/openpgp.LICENSE.txt` |
| sql.js | https://github.com/sql-js/sql.js | MIT; `public/vendor/sqlite.LICENSE.txt` |
| PDF.js | https://github.com/mozilla/pdf.js | Apache-2.0; `public/vendor/pdf.LICENSE.txt`, plus notices in its font / CMap / WASM directories |
| Pyodide | https://github.com/pyodide/pyodide | MPL-2.0; `ui/licenses/pyodide.txt`, copied to `public/vendor/pyodide/LICENSE.txt` |

The Python runtime includes CPython and the selected NumPy, SymPy, mpmath, and PyCryptodome wheels. Their upstream license files are preserved inside the runtime distribution and wheel archives. Wheel filenames, dependencies, and SHA-256 checksums come from the locked Pyodide release manifest.

## YesPlayMusic

YesPlayMusic 0.4.10, copyright qier222 and contributors, is MIT licensed. Source commit: https://github.com/qier222/YesPlayMusic/tree/df075cca247eab7bf8686155cb8cc9a1f4c7e271. The build preserves the upstream Vue interface, adds desktop profile storage and API transport, and disables analytics and service worker registration. Its license and source details are published as `/yesplaymusic/LICENSE.txt` and `/yesplaymusic/NOTICE.txt`; dependencies are locked in `runtime/yesplaymusic/package-lock.json`. The desktop icon is converted from the pinned upstream logo to lossless WebP.

The Workers API adapts the NetEase protocol from `@neteasecloudmusicapienhanced/api` 4.40.1 (Binaryify and contributors, MIT), with its license retained in `runtime/music-transport.ts`. Cloud audio metadata uses `music-metadata` 11.14.0 (Borewit and contributors, MIT), pinned in `pnpm-lock.yaml`.

KDE application names describe the interface being emulated. This project is not a KDE distribution and is not affiliated with or endorsed by KDE.

## Maintenance-only cryptography and test data

ML-KEM fixture production uses `@noble/post-quantum` 0.7.1 (Paul Miller and
contributors, MIT), pinned together with its dependencies in `pnpm-lock.yaml`.
It is not part of browser or Worker bundles. The readable recovery arithmetic is
independent and is checked against selected public NIST ACVP FIPS 203 vectors;
provenance is embedded in `test/fixtures/nist-mlkem768.json`.

The unmodified TRS interoperability fixture from Keysight / Riscure is under the
Clear BSD license. Full source revision, checksum and license are retained in
`test/fixtures/trs/`. It is test data, not a public game artifact.
