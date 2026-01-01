import { execSync, spawn } from 'node:child_process'

import { StringEnum } from '@mariozechner/pi-ai'
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const hasFd = (() => {
   try {
      execSync('fd --version', { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
})()

interface GlobDetails {
   pattern: string
   path: string
   files: string[]
   truncated: boolean
   error?: string
}

const GlobParams = Type.Object({
   pattern: Type.String({ description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.js")' }),
   path: Type.Optional(Type.String({ description: 'Directory to search in (defaults to cwd)' })),
   type: Type.Optional(
      StringEnum(['file', 'directory', 'any'] as const, { description: 'What to match: file, directory, or any (default: file)' })
   ),
   hidden: Type.Optional(Type.Boolean({ description: 'Include hidden files (default: false)' })),
   max_results: Type.Optional(Type.Number({ description: 'Maximum number of results (default: 200)' })),
})

const factory: CustomToolFactory = pi => {
   if (!hasFd) return null

   return {
      name: 'glob',
      label: 'Glob',
      description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.`,
      parameters: GlobParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
         const searchPath = params.path ?? pi.cwd
         const maxResults = params.max_results ?? 200
         const typeFilter = params.type ?? 'file'
         const includeHidden = params.hidden ?? false

         // Build fd arguments
         const args: string[] = ['-g', params.pattern]

         // Type filter
         if (typeFilter === 'file') {
            args.push('-t', 'f')
         } else if (typeFilter === 'directory') {
            args.push('-t', 'd')
         }
         // 'any' - no type filter

         // Hidden files
         if (includeHidden) {
            args.push('-H')
         }

         // Absolute paths for clarity
         args.push('-a')

         // Search path
         args.push(searchPath)

         // Check if already aborted
         if (signal?.aborted) {
            return {
               content: [{ type: 'text', text: 'Aborted' }],
               details: { pattern: params.pattern, path: searchPath, files: [], truncated: false },
            }
         }

         return new Promise(resolve => {
            const proc = spawn('fd', args)
            let stdout = ''
            let stderr = ''
            let wasAborted = false

            const onAbort = () => {
               wasAborted = true
               proc.kill('SIGTERM')
            }

            if (signal) {
               signal.addEventListener('abort', onAbort, { once: true })
            }

            proc.stdout.on('data', data => {
               stdout += data
            })

            proc.stderr.on('data', data => {
               stderr += data
            })

            proc.on('close', code => {
               signal?.removeEventListener('abort', onAbort)

               if (wasAborted) {
                  resolve({
                     content: [{ type: 'text', text: 'Aborted' }],
                     details: { pattern: params.pattern, path: searchPath, files: [], truncated: false },
                  })
                  return
               }

               if (code !== 0 && stderr.trim()) {
                  resolve({
                     content: [{ type: 'text', text: `Error: ${stderr.trim()}` }],
                     details: { pattern: params.pattern, path: searchPath, files: [], truncated: false },
                  })
                  return
               }

               // Parse and sort by mtime
               const allFiles = stdout.trim().split('\n').filter(Boolean)

               // Sort by modification time (we'll stat each file)
               // For performance, we do a simple spawned `ls -t` to get mtime order
               if (allFiles.length === 0) {
                  resolve({
                     content: [{ type: 'text', text: 'No files found.' }],
                     details: { pattern: params.pattern, path: searchPath, files: [], truncated: false },
                  })
                  return
               }

               // Sort by mtime using ls -t
               const sortProc = spawn('ls', ['-t', '--', ...allFiles])
               let sortedOutput = ''

               sortProc.stdout?.on('data', data => {
                  sortedOutput += data
               })

               sortProc.on('close', () => {
                  let files = sortedOutput.trim().split('\n').filter(Boolean)
                  if (files.length === 0) {
                     // Fallback to unsorted if ls fails
                     files = allFiles
                  }

                  const truncated = files.length > maxResults
                  const limitedFiles = files.slice(0, maxResults)

                  let resultText = limitedFiles.join('\n')
                  if (truncated) {
                     resultText += `\n\n(Showing ${maxResults} of ${files.length} results)`
                  }

                  resolve({
                     content: [{ type: 'text', text: resultText }],
                     details: { pattern: params.pattern, path: searchPath, files: limitedFiles, truncated },
                  })
               })

               sortProc.on('error', () => {
                  // Fallback to unsorted if ls fails
                  const truncated = allFiles.length > maxResults
                  const limitedFiles = allFiles.slice(0, maxResults)

                  let resultText = limitedFiles.join('\n')
                  if (truncated) {
                     resultText += `\n\n(Showing ${maxResults} of ${allFiles.length} results)`
                  }

                  resolve({
                     content: [{ type: 'text', text: resultText }],
                     details: { pattern: params.pattern, path: searchPath, files: limitedFiles, truncated },
                  })
               })
            })

            proc.on('error', err => {
               signal?.removeEventListener('abort', onAbort)
               resolve({
                  content: [{ type: 'text', text: `Failed to execute fd: ${err.message}` }],
                  details: { pattern: params.pattern, path: searchPath, files: [], truncated: false },
               })
            })
         })
      },

      renderCall(args, theme) {
         let text = theme.fg('toolTitle', theme.bold('glob '))
         text += theme.fg('accent', args.pattern)
         if (args.path) {
            text += theme.fg('dim', ' in ') + theme.fg('muted', args.path)
         }
         return new Text(text, 0, 0)
      },

      renderResult(result, { expanded }, theme) {
         const { details } = result
         const files = details?.files ?? []
         const count = files.length
         const truncated = details?.truncated ?? false

         const icon = count > 0 ? theme.fg('success', '●') : theme.fg('warning', '●')
         const countText = truncated ? `${count}+` : `${count}`
         const hint = expanded || count === 0 ? '' : theme.fg('dim', ' (Ctrl+O to expand)')

         let text = `${icon} ${theme.fg('toolTitle', 'Found')} ${theme.fg('accent', countText)} ${theme.fg('muted', count === 1 ? 'file' : 'files')}${hint}`

         if (count === 0) {
            return new Text(text, 0, 0)
         }

         const TREE_MID = '├─'
         const TREE_END = '└─'

         const displayCount = expanded ? files.length : Math.min(5, files.length)
         const showMore = !expanded && files.length > 5

         for (let i = 0; i < displayCount; i++) {
            const isLast = i === displayCount - 1 && !showMore
            const branch = isLast ? TREE_END : TREE_MID
            text += `\n ${theme.fg('dim', branch)} ${theme.fg('muted', files[i])}`
         }

         if (showMore) {
            const remaining = files.length - 5
            text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('dim', `… ${remaining} more`)}`
         }

         return new Text(text, 0, 0)
      },
   }
}

export default factory
