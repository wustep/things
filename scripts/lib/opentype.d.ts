// The little of opentype.js (2.x, which ships no types) that the share cards use.
declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M' | 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' };
  export interface Path {
    commands: PathCommand[];
  }
  export interface Glyph {
    advanceWidth?: number;
  }
  export interface Font {
    unitsPerEm: number;
    getPath(text: string, x: number, y: number, fontSize: number, options?: { kerning?: boolean }): Path;
    getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  // Its package has no exports map, so Node loads the CommonJS build: import the default.
  const opentype: { parse: typeof parse };
  export default opentype;
}
