/**
 * Global output abstraction that respects --json mode.
 *
 * When --json is active, human-readable output is suppressed entirely.
 * Only the final JSON result goes to stdout via outputJson().
 */

import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'

let jsonMode = false

/**
 * Enable JSON output mode. Human-readable output will be suppressed.
 */
export function setJsonMode(enabled: boolean): void {
   jsonMode = enabled
}

/**
 * Check if JSON mode is active.
 */
export function isJsonMode(): boolean {
   return jsonMode
}

/**
 * Print human-readable output to stdout. Suppressed in JSON mode.
 */
export function log(...args: unknown[]): void {
   if (!jsonMode) {
      console.log(...args)
   }
}

/**
 * Print human-readable error/warning to stderr. Suppressed in JSON mode.
 */
export function logError(...args: unknown[]): void {
   if (!jsonMode) {
      console.error(...args)
   }
}

/**
 * Print final JSON output to stdout. Only call this once per command.
 * This is the ONLY output that should appear when --json is active.
 */
export function outputJson(data: unknown): void {
   console.log(JSON.stringify(data, null, 2))
}

/**
 * Calculate visible string width excluding ANSI escape codes.
 * Handles Unicode characters correctly (CJK, emoji, etc).
 */
export function visibleWidth(str: string): number {
   return stringWidth(str)
}

/**
 * Pad string to width based on visible characters, accounting for ANSI codes.
 * Equivalent to str.padEnd(width) but ANSI-aware.
 */
export function padEnd(str: string, width: number): string {
   const visible = stringWidth(str)
   if (visible >= width) return str
   return str + ' '.repeat(width - visible)
}

/**
 * Truncate string to maxLen visible characters with ellipsis.
 * Handles ANSI codes gracefully by stripping them before measuring.
 */
export function truncate(str: string, maxLen: number): string {
   if (!str || maxLen < 4) return str
   const plain = stripAnsi(str)
   if (plain.length <= maxLen) return str
   // Strip ANSI, truncate, add ellipsis (str might have ANSI so use plain)
   return `${plain.slice(0, maxLen - 3)}...`
}

/**
 * Regex matching non-printable control characters.
 * Excludes tab (\x09), newline (\x0A), carriage return (\x0D).
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Sanitize untrusted text by removing terminal control sequences.
 * Prevents escape injection attacks from malicious npm metadata.
 * - Strips ANSI escape sequences (colors, cursor movement, etc.)
 * - Strips non-printable control characters (BEL, backspace, etc.)
 * - Preserves normal printable text, tabs, newlines, and carriage returns.
 */
export function sanitize(str: string): string {
   if (!str) return str
   // Use strip-ansi for robust ANSI removal, then strip remaining control chars
   return stripAnsi(str).replace(CONTROL_CHAR_REGEX, '')
}
