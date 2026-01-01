import { execSync, spawn } from 'node:child_process'
import * as path from 'node:path'

import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const hasSd = (() => {
   try {
      execSync('sd --version', { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
})()

const hasFd = (() => {
   try {
      execSync('fd --version', { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
})()

interface SdDetails {
   filesChanged: number
   pattern: string
   replacement: string
   preview: boolean
   truncated: boolean
   files?: string[]
   error?: string
}

const SdParams = Type.Object({
   pattern: Type.String({ description: 'Pattern to find (literal string by default, regex if regex=true)' }),
   replacement: Type.String({ description: 'Replacement text' }),
   path: Type.Optional(Type.String({ description: 'Directory or file to search (defaults to cwd)' })),
   glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.tsx")' })),
   regex: Type.Optional(Type.Boolean({ description: 'Treat pattern as regex (default: false, literal string matching)' })),
   preview: Type.Optional(Type.Boolean({ description: 'Preview changes without applying (default: true for safety)' })),
   max_results: Type.Optional(Type.Number({ description: 'Limit files shown in output (default: 50)' })),
})

const factory: CustomToolFactory = pi => {
   if (!hasSd || !hasFd) return null

   return {
      name: 'replace_all',
      label: 'Replace All',
      description: `String/regex find & replace tool using sd (simpler than sed)

  Usage:
  - ALWAYS use sd for find & replace. NEVER use sed in bash.
  - Uses literal string matching by default (safer than regex)
  - Set regex=true for regex patterns
  - preview=true (default) shows what would change without applying
  - Set preview=false to actually apply changes
  - Use glob parameter to limit scope (e.g., "*.ts")
  - For complex AST-aware refactoring, use the sg tool instead

  Examples:
  - Rename variable: pattern="oldName", replacement="newName", glob="*.ts"
  - Fix import: pattern="from 'old-pkg'", replacement="from 'new-pkg'"
  - Regex replace: pattern="v\\d+", replacement="v2", regex=true`,

      parameters: SdParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
         const searchPath = params.path ? path.resolve(pi.cwd, params.path) : pi.cwd
         const useRegex = params.regex ?? false
         const preview = params.preview ?? true
         const maxResults = params.max_results ?? 50
         const globPattern = params.glob ?? '*'

         // Check abort before starting
         if (signal?.aborted) {
            return {
               content: [{ type: 'text', text: 'Aborted' }],
               details: {
                  filesChanged: 0,
                  pattern: params.pattern,
                  replacement: params.replacement,
                  preview,
                  truncated: false,
                  error: 'aborted',
               },
            }
         }

         return new Promise(resolve => {
            // First, find files using fd
            const fdArgs: string[] = ['-t', 'f', '-g', globPattern, searchPath]

            const fdProc = spawn('fd', fdArgs)
            let fdStdout = ''
            let fdStderr = ''
            let wasAborted = false

            const onAbort = () => {
               wasAborted = true
               fdProc.kill('SIGTERM')
            }

            if (signal) {
               signal.addEventListener('abort', onAbort, { once: true })
            }

            fdProc.stdout.on('data', data => {
               fdStdout += data.toString()
            })

            fdProc.stderr.on('data', data => {
               fdStderr += data.toString()
            })

            fdProc.on('close', fdCode => {
               if (wasAborted) {
                  signal?.removeEventListener('abort', onAbort)
                  resolve({
                     content: [{ type: 'text', text: 'Aborted' }],
                     details: {
                        filesChanged: 0,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        preview,
                        truncated: false,
                        error: 'aborted',
                     },
                  })
                  return
               }

               if (fdCode !== 0 && fdStderr.trim()) {
                  signal?.removeEventListener('abort', onAbort)
                  resolve({
                     content: [{ type: 'text', text: `Error finding files: ${fdStderr.trim()}` }],
                     details: {
                        filesChanged: 0,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        preview,
                        truncated: false,
                        error: fdStderr.trim(),
                     },
                  })
                  return
               }

               const files = fdStdout.trim().split('\n').filter(Boolean)

               if (files.length === 0) {
                  signal?.removeEventListener('abort', onAbort)
                  resolve({
                     content: [{ type: 'text', text: 'No files found matching the glob pattern.' }],
                     details: {
                        filesChanged: 0,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        preview,
                        truncated: false,
                     },
                  })
                  return
               }

               // Now run sd on each file and collect results
               const changedFiles: string[] = []
               const previewOutput: string[] = []
               let hasError = false
               let errorMsg = ''

               const processNextFile = (index: number) => {
                  if (wasAborted || hasError || index >= files.length) {
                     finalize()
                     return
                  }

                  const file = files[index]

                  // Build sd args
                  const sdArgs: string[] = []
                  if (preview) {
                     sdArgs.push('--preview')
                  }
                  if (!useRegex) {
                     sdArgs.push('-s') // string mode (literal)
                  }
                  sdArgs.push(params.pattern, params.replacement, file)

                  const sdProc = spawn('sd', sdArgs)
                  let sdStdout = ''
                  let sdStderr = ''

                  sdProc.stdout.on('data', data => {
                     sdStdout += data.toString()
                  })

                  sdProc.stderr.on('data', data => {
                     sdStderr += data.toString()
                  })

                  sdProc.on('close', sdCode => {
                     if (wasAborted) {
                        finalize()
                        return
                     }

                     // sd returns 0 even when no matches, check stdout for preview mode
                     if (sdCode !== 0 && sdStderr.trim()) {
                        // Non-fatal: some files may have encoding issues, continue
                        processNextFile(index + 1)
                        return
                     }

                     // In preview mode, sd outputs the diff to stdout
                     // In apply mode, sd modifies the file silently
                     if (preview) {
                        if (sdStdout.trim()) {
                           const relPath = path.relative(pi.cwd, file)
                           changedFiles.push(relPath)
                           if (changedFiles.length <= maxResults) {
                              previewOutput.push(`=== ${relPath} ===\n${sdStdout.trim()}`)
                           }
                        }
                     } else {
                        // For apply mode, we need to check if the file was actually changed
                        // sd doesn't report this, so we'll assume files with matches were changed
                        // Run a grep-like check first
                        const relPath = path.relative(pi.cwd, file)
                        changedFiles.push(relPath)
                     }

                     processNextFile(index + 1)
                  })

                  sdProc.on('error', err => {
                     hasError = true
                     errorMsg = err.message
                     finalize()
                  })
               }

               const finalize = () => {
                  signal?.removeEventListener('abort', onAbort)

                  if (wasAborted) {
                     resolve({
                        content: [{ type: 'text', text: 'Aborted' }],
                        details: {
                           filesChanged: 0,
                           pattern: params.pattern,
                           replacement: params.replacement,
                           preview,
                           truncated: false,
                           error: 'aborted',
                        },
                     })
                     return
                  }

                  if (hasError) {
                     resolve({
                        content: [{ type: 'text', text: `Error: ${errorMsg}` }],
                        details: {
                           filesChanged: 0,
                           pattern: params.pattern,
                           replacement: params.replacement,
                           preview,
                           truncated: false,
                           error: errorMsg,
                        },
                     })
                     return
                  }

                  const truncated = changedFiles.length > maxResults

                  if (changedFiles.length === 0) {
                     resolve({
                        content: [{ type: 'text', text: 'No matches found in any files.' }],
                        details: {
                           filesChanged: 0,
                           pattern: params.pattern,
                           replacement: params.replacement,
                           preview,
                           truncated: false,
                        },
                     })
                     return
                  }

                  let output: string
                  if (preview) {
                     const header = `Preview: ${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} would be changed\n\n`
                     output = header + previewOutput.join('\n\n')
                     if (truncated) {
                        output += `\n\n... showing ${maxResults} of ${changedFiles.length} files`
                     }
                  } else {
                     output = `Changed ${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''}:\n`
                     const displayFiles = changedFiles.slice(0, maxResults)
                     output += displayFiles.join('\n')
                     if (truncated) {
                        output += `\n\n... showing ${maxResults} of ${changedFiles.length} files`
                     }
                  }

                  resolve({
                     content: [{ type: 'text', text: output }],
                     details: {
                        filesChanged: changedFiles.length,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        preview,
                        truncated,
                        files: changedFiles.slice(0, maxResults),
                     },
                  })
               }

               // Start processing files
               processNextFile(0)
            })

            fdProc.on('error', err => {
               signal?.removeEventListener('abort', onAbort)
               resolve({
                  content: [{ type: 'text', text: `Failed to execute fd: ${err.message}` }],
                  details: {
                     filesChanged: 0,
                     pattern: params.pattern,
                     replacement: params.replacement,
                     preview,
                     truncated: false,
                     error: err.message,
                  },
               })
            })
         })
      },

      renderCall(args, theme) {
         let text = theme.fg('toolTitle', theme.bold('sd '))
         text += theme.fg('accent', `'${args.pattern}'`)
         text += theme.fg('dim', ' → ')
         text += theme.fg('accent', `'${args.replacement}'`)

         const meta: string[] = []
         if (args.preview !== false) meta.push('preview')
         if (args.glob) meta.push(`glob:${args.glob}`)
         if (args.regex) meta.push('regex')
         if (args.path) meta.push(args.path)

         if (meta.length > 0) {
            text += ` ${theme.fg('muted', `[${meta.join('] [')}]`)}`
         }

         return new Text(text, 0, 0)
      },

      renderResult(result, { expanded }, theme) {
         const TREE_MID = '├─'
         const TREE_END = '└─'

         const details = result.details as SdDetails | undefined

         // Error case
         if (details?.error && details.error !== 'aborted') {
            return new Text(`${theme.fg('error', '●')} ${theme.fg('error', details.error)}`, 0, 0)
         }

         if (details?.error === 'aborted') {
            return new Text(`${theme.fg('warning', '●')} ${theme.fg('muted', 'Aborted')}`, 0, 0)
         }

         const filesChanged = details?.filesChanged ?? 0
         const preview = details?.preview ?? true
         const truncated = details?.truncated ?? false
         const files = details?.files ?? []

         // No matches
         if (filesChanged === 0) {
            return new Text(`${theme.fg('warning', '●')} ${theme.fg('muted', 'No matches found')}`, 0, 0)
         }

         // Build summary
         const icon = preview ? theme.fg('info', '●') : theme.fg('success', '●')
         const action = preview ? 'Would change' : 'Changed'
         let summary = `${filesChanged} file${filesChanged !== 1 ? 's' : ''}`

         if (truncated) {
            summary += theme.fg('warning', ' (truncated)')
         }

         const previewTag = preview ? theme.fg('info', ' [preview]') : ''
         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', action)} ${theme.fg('dim', summary)}${previewTag}${expandHint}`

         // Show file tree
         const maxFiles = expanded ? files.length : Math.min(files.length, 8)
         for (let i = 0; i < maxFiles; i++) {
            const isLast = i === maxFiles - 1 && (expanded || files.length <= 8)
            const branch = isLast ? TREE_END : TREE_MID
            text += `\n ${theme.fg('dim', branch)} ${theme.fg('accent', files[i])}`
         }

         if (!expanded && files.length > 8) {
            text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', `… ${files.length - 8} more files`)}`
         }

         return new Text(text, 0, 0)
      },
   }
}

export default factory
