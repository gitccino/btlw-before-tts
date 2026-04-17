declare module "node-webvtt" {
  interface Cue {
    identifier: string;
    start: number; // seconds
    end: number;   // seconds
    text: string;
    styles: string;
  }
  interface ParseResult {
    valid: boolean;
    cues: Cue[];
    meta: Record<string, string>;
  }
  function parse(input: string, options?: { meta?: boolean }): ParseResult;
}
