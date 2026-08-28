/** Behavior-compatible reimplementation of @xterm/headless's used surface. */
export * from "./vterm/buffer";
export * from "./vterm/terminal";

import { Terminal } from "./vterm/terminal";

const vterm = { Terminal };
export default vterm;
