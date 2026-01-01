/**
 * Progress indicators for long-running operations.
 *
 * Provides spinners with elapsed time tracking. Automatically suppressed in:
 * - --json mode
 * - Non-TTY environments (CI, piped output)
 */

import { isJsonMode } from '@omp/output'
import ora, { type Ora } from 'ora'

/**
 * Check if progress indicators should be shown.
 * Returns false in JSON mode or non-TTY environments.
 */
export function shouldShowProgress(): boolean {
   if (isJsonMode()) return false
   if (!process.stdout.isTTY) return false
   return true
}

/**
 * Wrapper around ora spinner that:
 * - Tracks elapsed time
 * - Auto-disables in JSON mode / non-TTY
 * - Provides consistent styling
 */
export interface Progress {
   /** Update the spinner text */
   text(message: string): void
   /** Stop with success (green checkmark) */
   succeed(message?: string): void
   /** Stop with failure (red X) */
   fail(message?: string): void
   /** Stop with warning (yellow triangle) */
   warn(message?: string): void
   /** Stop with info (blue i) */
   info(message?: string): void
   /** Stop without any symbol */
   stop(): void
   /** Get elapsed time in seconds */
   elapsed(): number
}

/**
 * Create a progress spinner.
 *
 * @param message Initial message to display
 * @returns Progress interface
 *
 * @example
 * ```ts
 * const progress = createProgress("Installing packages...");
 * try {
 *   await npmInstall(packages);
 *   progress.succeed(`Installed in ${progress.elapsed()}s`);
 * } catch (err) {
 *   progress.fail("Installation failed");
 * }
 * ```
 */
export function createProgress(message: string): Progress {
   const startTime = Date.now()
   const enabled = shouldShowProgress()

   const elapsed = () => Math.round((Date.now() - startTime) / 100) / 10

   // In silent mode, return a no-op implementation
   if (!enabled) {
      return {
         text: () => {},
         succeed: () => {},
         fail: () => {},
         warn: () => {},
         info: () => {},
         stop: () => {},
         elapsed,
      }
   }

   const spinner: Ora = ora({
      text: message,
      color: 'cyan',
      // Use stderr so stdout can be piped cleanly
      stream: process.stderr,
   }).start()

   // Update text with elapsed time periodically
   let currentMessage = message
   const updateInterval = setInterval(() => {
      if (spinner.isSpinning) {
         spinner.text = `${currentMessage} (${elapsed()}s)`
      }
   }, 1000)

   const cleanup = () => {
      clearInterval(updateInterval)
   }

   return {
      text(msg: string) {
         currentMessage = msg
         spinner.text = msg
      },
      succeed(msg?: string) {
         cleanup()
         const finalMsg = msg ?? `${currentMessage} (${elapsed()}s)`
         spinner.succeed(finalMsg)
      },
      fail(msg?: string) {
         cleanup()
         const finalMsg = msg ?? currentMessage
         spinner.fail(finalMsg)
      },
      warn(msg?: string) {
         cleanup()
         const finalMsg = msg ?? currentMessage
         spinner.warn(finalMsg)
      },
      info(msg?: string) {
         cleanup()
         const finalMsg = msg ?? currentMessage
         spinner.info(finalMsg)
      },
      stop() {
         cleanup()
         spinner.stop()
      },
      elapsed,
   }
}

/**
 * Run an async operation with a progress spinner.
 *
 * @param message Message to display during operation
 * @param operation Async operation to run
 * @param options Configuration options
 * @returns Result of the operation
 *
 * @example
 * ```ts
 * const result = await withProgress(
 *   "Fetching package info",
 *   () => npmInfo(packageName),
 *   { successMessage: (r) => `Found ${r.name}@${r.version}` }
 * );
 * ```
 */
export async function withProgress<T>(
   message: string,
   operation: () => Promise<T>,
   options: {
      /** Message to show on success. Can be a function that receives the result. */
      successMessage?: string | ((result: T) => string)
      /** Message to show on failure. Can be a function that receives the error. */
      failMessage?: string | ((error: Error) => string)
      /** If true, don't show success message (just stop spinner) */
      silent?: boolean
   } = {}
): Promise<T> {
   const progress = createProgress(message)

   try {
      const result = await operation()

      if (options.silent) {
         progress.stop()
      } else if (options.successMessage) {
         const msg = typeof options.successMessage === 'function' ? options.successMessage(result) : options.successMessage
         progress.succeed(msg)
      } else {
         progress.succeed()
      }

      return result
   } catch (err) {
      const error = err as Error

      if (options.failMessage) {
         const msg = typeof options.failMessage === 'function' ? options.failMessage(error) : options.failMessage
         progress.fail(msg)
      } else {
         progress.fail()
      }

      throw err
   }
}
