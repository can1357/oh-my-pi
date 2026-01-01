import { execSync, spawn } from 'node:child_process'
import * as path from 'node:path'

import { StringEnum } from '@mariozechner/pi-ai'
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const hasSg = (() => {
   try {
      execSync('sg --version', { stdio: 'ignore' })
      return true
   } catch {
      return false
   }
})()

interface SgDetails {
   matchCount: number
   fileCount: number
   mode: string
   pattern: string
   replacement?: string
   truncated: boolean
   files?: string[]
   error?: string
}

const SgParams = Type.Object({
   pattern: Type.String({ description: 'AST pattern to match (e.g., "console.log($$$)")' }),
   replacement: Type.Optional(Type.String({ description: 'Replacement pattern (if omitted, search-only mode)' })),
   path: Type.Optional(Type.String({ description: 'Directory to search (defaults to cwd)' })),
   lang: Type.Optional(Type.String({ description: 'Language filter (e.g., "ts", "js", "rust", "go", "python")' })),
   mode: Type.Optional(
      StringEnum(['search', 'preview', 'apply'] as const, {
         description: 'search shows matches, preview shows diffs, apply makes changes (default: search)',
      })
   ),
   max_results: Type.Optional(Type.Number({ description: 'Limit results (default: 100)' })),
})

const factory: CustomToolFactory = pi => {
   if (!hasSg) return null

   return {
      name: 'ast',
      label: 'AST Search',
      description: `AST-level structural search/replace - matches code structure, not text

Usage:
- Use $NAME for single node wildcards (e.g., $FUNC, $ARG)
- Use $$$ for multiple nodes (variadic match)
- Examples: 'console.log($$$)' matches any console.log call
- 'fn($A, $B)' matches fn calls with exactly 2 args
- Use mode='preview' to see changes before applying
- For simple text find/replace, use sd tool instead

Supports many languages: TypeScript, JavaScript, Rust, Go, Python, C, C++, Java, Ruby, etc.

Pattern tips:
- Match function calls: 'myFunc($$$)'
- Match method chains: '$OBJ.map($$$).filter($$$)'
- Match imports: 'import { $$$ } from "module"'
- Match assignments: 'const $NAME = $VALUE'`,

      parameters: SgParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
         const mode = params.mode ?? 'search'
         const maxResults = params.max_results ?? 100
         const searchPath = params.path ? path.resolve(pi.cwd, params.path) : pi.cwd

         // Validate: preview/apply modes require replacement
         if ((mode === 'preview' || mode === 'apply') && !params.replacement) {
            return {
               content: [{ type: 'text', text: `Error: mode '${mode}' requires a replacement pattern` }],
               details: {
                  matchCount: 0,
                  fileCount: 0,
                  mode,
                  pattern: params.pattern,
                  truncated: false,
                  error: 'replacement required',
               },
            }
         }

         // Build sg arguments
         const args: string[] = ['--pattern', params.pattern]

         // Language filter
         if (params.lang) {
            args.push('--lang', params.lang)
         }

         // Mode-specific flags
         if (mode === 'preview' && params.replacement) {
            args.push('--rewrite', params.replacement)
            // No --update flag = preview only
         } else if (mode === 'apply' && params.replacement) {
            args.push('--rewrite', params.replacement)
            args.push('--update-all')
         }
         // search mode: no rewrite flags

         // JSON output for easier parsing
         args.push('--json')

         // Search path
         args.push(searchPath)

         // Check abort before spawn
         if (signal?.aborted) {
            return {
               content: [{ type: 'text', text: 'Search aborted.' }],
               details: {
                  matchCount: 0,
                  fileCount: 0,
                  mode,
                  pattern: params.pattern,
                  replacement: params.replacement,
                  truncated: false,
                  error: 'aborted',
               },
            }
         }

         return new Promise(resolve => {
            let stdout = ''
            let stderr = ''
            let wasAborted = false

            const proc = spawn('sg', args, {
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
                     details: {
                        matchCount: 0,
                        fileCount: 0,
                        mode,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        truncated: false,
                        error: 'aborted',
                     },
                  })
                  return
               }

               // sg exit code 1 = no matches, 0 = matches found
               if (code !== 0 && code !== 1 && stderr) {
                  resolve({
                     content: [{ type: 'text', text: `Error: ${stderr.trim()}` }],
                     details: {
                        matchCount: 0,
                        fileCount: 0,
                        mode,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        truncated: false,
                        error: stderr.trim(),
                     },
                  })
                  return
               }

               // Parse JSON output (each line is a JSON object)
               const lines = stdout.trim().split('\n').filter(Boolean)

               if (lines.length === 0) {
                  resolve({
                     content: [{ type: 'text', text: 'No matches found.' }],
                     details: {
                        matchCount: 0,
                        fileCount: 0,
                        mode,
                        pattern: params.pattern,
                        replacement: params.replacement,
                        truncated: false,
                     },
                  })
                  return
               }

               // Process JSON matches
               const files = new Set<string>()
               const matches: Array<{ file: string; line: number; text: string; replacement?: string }> = []

               for (const line of lines) {
                  try {
                     const obj = JSON.parse(line)
                     const filePath = obj.file || obj.path
                     if (filePath) {
                        const relPath = path.relative(pi.cwd, filePath)
                        files.add(relPath)
                        matches.push({
                           file: relPath,
                           line: obj.range?.start?.line ?? obj.start?.line ?? 0,
                           text: obj.text || obj.matched || '',
                           replacement: obj.replacement,
                        })
                     }
                  } catch {
                     // Skip malformed lines
                  }
               }

               const matchCount = matches.length
               const fileCount = files.size
               const truncated = matchCount > maxResults
               const limitedMatches = matches.slice(0, maxResults)

               // Format output
               let output: string
               if (mode === 'apply') {
                  output = `Applied ${matchCount} replacement${matchCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}:\n`
                  output += Array.from(files).join('\n')
               } else if (mode === 'preview') {
                  output = `Preview of ${matchCount} replacement${matchCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}:\n\n`
                  for (const m of limitedMatches) {
                     output += `${m.file}:${m.line}\n`
                     output += `  - ${m.text}\n`
                     if (m.replacement !== undefined) {
                        output += `  + ${m.replacement}\n`
                     }
                     output += '\n'
                  }
               } else {
                  // search mode
                  output = `Found ${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}:\n\n`
                  for (const m of limitedMatches) {
                     output += `${m.file}:${m.line}: ${m.text}\n`
                  }
               }

               if (truncated) {
                  output += `\n... truncated at ${maxResults} results (${matchCount} total)`
               }

               resolve({
                  content: [{ type: 'text', text: output }],
                  details: {
                     matchCount,
                     fileCount,
                     mode,
                     pattern: params.pattern,
                     replacement: params.replacement,
                     truncated,
                     files: Array.from(files).slice(0, 50),
                  },
               })
            })

            proc.on('error', err => {
               signal?.removeEventListener('abort', onAbort)
               resolve({
                  content: [{ type: 'text', text: `Error: ${err.message}` }],
                  details: {
                     matchCount: 0,
                     fileCount: 0,
                     mode,
                     pattern: params.pattern,
                     replacement: params.replacement,
                     truncated: false,
                     error: err.message,
                  },
               })
            })
         })
      },

      renderCall(args, theme) {
         let text = theme.fg('toolTitle', theme.bold('sg '))
         text += theme.fg('accent', `'${args.pattern || '?'}'`)

         if (args.replacement) {
            text += theme.fg('dim', ' → ') + theme.fg('accent', `'${args.replacement}'`)
         }

         const meta: string[] = []
         if (args.lang) meta.push(`lang:${args.lang}`)
         if (args.mode && args.mode !== 'search') meta.push(args.mode)
         if (args.path) meta.push(args.path)

         if (meta.length > 0) {
            text += ` ${theme.fg('muted', meta.join(' '))}`
         }

         return new Text(text, 0, 0)
      },

      renderResult(result, { expanded }, theme) {
         const TREE_MID = '├─'
         const TREE_END = '└─'

         const details = result.details as SgDetails | undefined

         // Error case
         if (details?.error && details.error !== 'aborted') {
            return new Text(`${theme.fg('error', '●')} ${theme.fg('error', details.error)}`, 0, 0)
         }

         const matchCount = details?.matchCount ?? 0
         const fileCount = details?.fileCount ?? 0
         const mode = details?.mode ?? 'search'
         const truncated = details?.truncated ?? false
         const files = details?.files ?? []

         // No matches
         if (matchCount === 0) {
            return new Text(`${theme.fg('warning', '●')} ${theme.fg('muted', 'No matches found')}`, 0, 0)
         }

         // Build summary
         const icon = mode === 'apply' ? theme.fg('success', '●') : theme.fg('info', '●')
         let summary: string
         if (mode === 'apply') {
            summary = `Applied ${matchCount} replacement${matchCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
         } else if (mode === 'preview') {
            summary = `Preview: ${matchCount} replacement${matchCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
         } else {
            summary = `${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
         }

         if (truncated) {
            summary += theme.fg('warning', ' (truncated)')
         }

         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', 'ast')} ${theme.fg('dim', summary)}${expandHint}`

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
