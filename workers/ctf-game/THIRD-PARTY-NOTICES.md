# Third-party assets

## Breeze icons

Copyright KDE contributors. Licensed under the GNU Lesser General Public License; see `public/icons/COPYING.LIB.txt`.

Source: https://github.com/KDE/breeze-icons/tree/235730e69d90949621e4fee77fcc459772b7a8f0

SVG symbolic foreground colors are changed to the Breeze Dark palette. No other design changes. Icon symlinks are resolved to their original SVG source.

## CodeMirror

Copyright Marijn Haverbeke and contributors. MIT licensed. The generated editor bundle contains its package license notices in `public/vendor/editor-engine.LICENSE.txt`.

## Desktop wallpapers

Mountain by Andy Betts, Flow by Sandra Smukaste, and Scarlet Tree by axo1otl, from KDE's plasma-workspace-wallpapers collection. Licensed under CC BY-SA 4.0. The images have been resized and JPEG-encoded; pinned source URLs and modifications are recorded in `public/wallpapers/attribution.json`, alongside the full license.

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

KDE application names describe the interface being emulated. This project is not a KDE distribution and is not affiliated with or endorsed by KDE.
