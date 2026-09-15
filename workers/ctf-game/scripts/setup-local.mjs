import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build-challenges.mjs';

try {
  await writeFile(resolve(root, '.dev.vars.local'), 'SESSION_SECRET=' + randomBytes(48).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created a private local session key.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
