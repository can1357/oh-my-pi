import * as cp from 'node:child_process'
import * as path from 'node:path'

import { StringEnum } from '@mariozechner/pi-ai'
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const hasRg = (() => {
   try {
      cp.execSync('rg --version', { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
})()

const TOOL_NAME = 'rg'
const BASH_TOOL_NAME = 'bash'
const TASK_TOOL_NAME = 'task'

interface GrepDetails {
   matchCount: number
   fileCount: number
   mode: string
   truncated: boolean
   files?: string[]
   error?: string
}

const GrepParams = Type.Object({
   pattern: Type.String({ description: 'Regex pattern to search for' }),
   path: Type.Optional(Type.String({ description: 'Directory or file to search (defaults to cwd)' })),
   glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.tsx")' })),
   type: Type.Optional(Type.String({ description: 'File type filter (e.g., "js", "py", "rust")' })),
   mode: Type.Optional(
      StringEnum(['content', 'files_with_matches', 'count'] as const, {
         description:
            'Output mode: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts',
      })
   ),
   case_sensitive: Type.Optional(Type.Boolean({ description: 'Enable case-sensitive search (default: false, uses smart case)' })),
   multiline: Type.Optional(Type.Boolean({ description: 'Enable multiline matching for cross-line patterns' })),
   context_lines: Type.Optional(Type.Number({ description: 'Lines of context around matches' })),
   max_results: Type.Optional(Type.Number({ description: 'Limit number of results (default: 200)' })),
})

const factory: CustomToolFactory = pi => {
   if (!hasRg) return null

   return {
      name: TOOL_NAME,
      label: 'Ripgrep',
      description: `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\\\s+\\\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${TASK_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\\\{\\\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\\\{[\\\\s\\\\S]*?field\`, use \`multiline: true\``,

      parameters: GrepParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
         const mode = params.mode ?? 'files_with_matches'
         const maxResults = params.max_results ?? 200
         const searchPath = params.path ? path.resolve(pi.cwd, params.path) : pi.cwd

         // Build rg command
         const args: string[] = ['--color=never', '--no-heading', '--with-filename', '--line-number']

         // Mode-specific flags
         if (mode === 'files_with_matches') {
            args.push('--files-with-matches')
         } else if (mode === 'count') {
            args.push('--count')
         }

         // Case sensitivity
         if (params.case_sensitive) {
            args.push('--case-sensitive')
         } else {
            args.push('--smart-case')
         }

         // Multiline
         if (params.multiline) {
            args.push('--multiline')
         }

         // Context lines (only for content mode)
         if (params.context_lines !== undefined && mode === 'content') {
            args.push(`--context=${params.context_lines}`)
         }

         // File filtering
         if (params.glob) {
            args.push(`--glob=${params.glob}`)
         }
         if (params.type) {
            args.push(`--type=${params.type}`)
         }

         // Max count
         args.push(`--max-count=${maxResults}`)

         // Pattern and path
         args.push('--', params.pattern, searchPath)

         // Check abort before spawn
         if (signal?.aborted) {
            return {
               content: [{ type: 'text', text: 'Search aborted.' }],
               details: { matchCount: 0, fileCount: 0, mode, truncated: false, error: 'aborted' },
            }
         }

         return new Promise(resolve => {
            let stdout = ''
            let stderr = ''
            let wasAborted = false

            const proc = cp.spawn('rg', args, {
               cwd: pi.cwd,
               stdio: ['ignore', 'pipe', 'pipe'],
               env: { ...process.env },
            })

            const onAbort = () => {
               wasAborted = true
               proc.kill('SIGTERM')
            }

            if (signal) {
               if (signal.aborted) {
                  onAbort()
               } else {
                  signal.addEventListener('abort', onAbort, { once: true })
               }
            }

            proc.stdout?.on('data', data => {
               stdout += data.toString()
            })

            proc.stderr?.on('data', data => {
               stderr += data.toString()
            })

            proc.on('close', code => {
               signal?.removeEventListener('abort', onAbort)

               if (wasAborted) {
                  resolve({
                     content: [{ type: 'text', text: 'Search aborted.' }],
                     details: { matchCount: 0, fileCount: 0, mode, truncated: false, error: 'aborted' },
                  })
                  return
               }

               // rg exit codes: 0 = matches found, 1 = no matches, 2 = error
               if (code === 2 && stderr) {
                  resolve({
                     content: [{ type: 'text', text: `Error: ${stderr.trim()}` }],
                     details: { matchCount: 0, fileCount: 0, mode, truncated: false, error: stderr.trim() },
                  })
                  return
               }

               const lines = stdout.trim().split('\n').filter(Boolean)

               if (lines.length === 0) {
                  resolve({
                     content: [{ type: 'text', text: 'No matches found.' }],
                     details: { matchCount: 0, fileCount: 0, mode, truncated: false },
                  })
                  return
               }

               // Process results based on mode
               let matchCount = 0
               let fileCount = 0
               const files = new Set<string>()
               let truncated = false

               if (mode === 'files_with_matches') {
                  // Each line is a file path
                  for (const line of lines) {
                     const relPath = path.relative(pi.cwd, line)
                     files.add(relPath)
                  }
                  fileCount = files.size
                  matchCount = fileCount

                  if (files.size > maxResults) {
                     truncated = true
                  }
               } else if (mode === 'count') {
                  // Each line is: file:count
                  for (const line of lines) {
                     const match = line.match(/^(.+):(\d+)$/)
                     if (match) {
                        const relPath = path.relative(pi.cwd, match[1])
                        files.add(relPath)
                        matchCount += Number.parseInt(match[2], 10)
                     }
                  }
                  fileCount = files.size
               } else {
                  // content mode: file:line:content
                  for (const line of lines) {
                     const match = line.match(/^(.+?):(\d+):/)
                     if (match) {
                        const relPath = path.relative(pi.cwd, match[1])
                        files.add(relPath)
                        matchCount++
                     }
                  }
                  fileCount = files.size

                  if (matchCount >= maxResults) {
                     truncated = true
                  }
               }

               // Format output
               let output: string
               if (mode === 'files_with_matches') {
                  const fileList = Array.from(files).slice(0, maxResults)
                  output = fileList.join('\n')
                  if (truncated) {
                     output += `\n\n... truncated at ${maxResults} files`
                  }
               } else if (mode === 'count') {
                  output = lines
                     .map(line => {
                        const match = line.match(/^(.+):(\d+)$/)
                        if (match) {
                           return `${path.relative(pi.cwd, match[1])}: ${match[2]} matches`
                        }
                        return line
                     })
                     .join('\n')
               } else {
                  // content mode - relativize paths
                  const relLines = lines.slice(0, maxResults).map(line => {
                     const match = line.match(/^(.+?):(\d+):(.*)$/)
                     if (match) {
                        const relPath = path.relative(pi.cwd, match[1])
                        return `${relPath}:${match[2]}:${match[3]}`
                     }
                     return line
                  })
                  output = relLines.join('\n')
                  if (truncated) {
                     output += `\n\n... truncated at ${maxResults} matches`
                  }
               }

               resolve({
                  content: [{ type: 'text', text: output }],
                  details: {
                     matchCount,
                     fileCount,
                     mode,
                     truncated,
                     files: Array.from(files).slice(0, 50),
                  },
               })
            })

            proc.on('error', err => {
               signal?.removeEventListener('abort', onAbort)
               resolve({
                  content: [{ type: 'text', text: `Error: ${err.message}` }],
                  details: { matchCount: 0, fileCount: 0, mode, truncated: false, error: err.message },
               })
            })
         })
      },

      renderCall(args, theme) {
         let text = theme.fg('toolTitle', theme.bold('rg '))
         text += theme.fg('accent', args.pattern || '?')

         const meta: string[] = []
         if (args.path) meta.push(args.path)
         if (args.glob) meta.push(`glob:${args.glob}`)
         if (args.type) meta.push(`type:${args.type}`)
         if (args.mode && args.mode !== 'files_with_matches') meta.push(args.mode)
         if (args.multiline) meta.push('multiline')

         if (meta.length > 0) {
            text += ` ${theme.fg('muted', meta.join(' '))}`
         }

         return new Text(text, 0, 0)
      },

      renderResult(result, { expanded }, theme) {
         const TREE_MID = '├─'
         const TREE_END = '└─'

         const details = result.details as GrepDetails | undefined

         // Error case
         if (details?.error) {
            return new Text(`${theme.fg('error', '●')} ${theme.fg('error', details.error)}`, 0, 0)
         }

         const matchCount = details?.matchCount ?? 0
         const fileCount = details?.fileCount ?? 0
         const mode = details?.mode ?? 'files_with_matches'
         const truncated = details?.truncated ?? false
         const files = details?.files ?? []

         // No matches
         if (matchCount === 0) {
            return new Text(`${theme.fg('warning', '●')} ${theme.fg('muted', 'No matches found')}`, 0, 0)
         }

         // Build summary
         const icon = theme.fg('success', '●')
         let summary: string
         if (mode === 'files_with_matches') {
            summary = `${fileCount} file${fileCount !== 1 ? 's' : ''}`
         } else if (mode === 'count') {
            summary = `${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
         } else {
            summary = `${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
         }

         if (truncated) {
            summary += theme.fg('warning', ' (truncated)')
         }

         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', 'rg')} ${theme.fg('dim', summary)}${expandHint}`

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
