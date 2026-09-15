/// <reference path="./music-qrcode.d.ts" />
import { Buffer } from 'node:buffer';
import { create } from 'qrcode/lib/core/qrcode.js';
import { render } from 'qrcode/lib/renderer/svg-tag.js';

export function musicQrImage(url: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(render(create(url), { width: 192, margin: 4 })).toString('base64');
}
