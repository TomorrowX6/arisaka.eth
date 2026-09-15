import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRuntimes } from './build-runtimes.mjs';
import { buildYesPlayMusic } from './build-yesplaymusic.mjs';

export async function prepareRuntimes() {
  const minecraft = await buildRuntimes();
  const yesplaymusic = await buildYesPlayMusic();
  return { minecraft, yesplaymusic };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await prepareRuntimes();
