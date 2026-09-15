declare module 'qrcode/lib/core/qrcode.js' {
  export interface QrCode { modules: { size: number; data: Uint8Array } }
  export function create(text: string): QrCode;
}
declare module 'qrcode/lib/renderer/svg-tag.js' {
  import type { QrCode } from 'qrcode/lib/core/qrcode.js';
  export function render(code: QrCode, options: { width: number; margin: number }): string;
}
