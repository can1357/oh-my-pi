/**
 * Task Tool - Delegate tasks to specialized agents
 *
 * Discovers agent definitions from:
 *   - ~/.pi/agent/agents/*.md (user-level)
 *   - .pi/agents/*.md (project-level, opt-in via agentScope)
 *
 * Agent files use markdown with YAML frontmatter:
 *
 *   ---
 *   name: explore
 *   description: Fast codebase recon
 *   tools: read, grep, find, ls, bash
 *   model: claude-haiku-4-5
 *   ---
 *
 *   You are a scout. Quickly investigate and return findings.
 *
 * The tool spawns a separate `pi` process for each task, giving it an
 * isolated context window. All tasks run in parallel.
 *
 * Parameters:
 *   - tasks: Array of {agent, task} to run in parallel
 *   - context: (optional) Shared context prepended to all task prompts
 *   Results are written to /tmp/pi-task-{runId}/task_{agent}_{i}.md
 *   - agentScope: "user" | "project" | "both"
 */

import { spawn, spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { StringEnum } from '@mariozechner/pi-ai'
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
import runtime from './runtime.json'

/** Cache for available models (refreshed once per tool factory instantiation) */
let cachedModels: string[] | null = null

/**
 * Get available models from `pi --list-models`.
 * Caches the result for performance.
 */
function getAvailableModels(): string[] {
   if (cachedModels !== null) return cachedModels

   try {
      const result = spawnSync('pi', ['--list-models'], {
         encoding: 'utf-8',
         timeout: 5000,
      })

      if (result.status !== 0 || !result.stdout) {
         cachedModels = []
         return cachedModels
      }

      // Parse output: skip header line, extract model column
      const lines = result.stdout.trim().split('\n')
      cachedModels = lines
         .slice(1) // Skip header
         .map(line => {
            const parts = line.trim().split(/\s+/)
            return parts[1] // Model name is second column
         })
         .filter(Boolean)

      return cachedModels
   } catch {
      cachedModels = []
      return cachedModels
   }
}

/**
 * Resolve a fuzzy model pattern to an actual model name.
 * Supports comma-separated patterns (e.g., "gpt, opus").
 * Returns the first match found, or undefined if no match.
 */
function resolveModelPattern(pattern: string, availableModels?: string[]): string | undefined {
   if (!pattern || pattern === 'default') return undefined

   const models = availableModels ?? getAvailableModels()
   if (models.length === 0) {
      // Fallback: return pattern as-is if we can't get available models
      return pattern
   }

   // Split by comma, try each pattern in order
   const patterns = pattern
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean)

   for (const p of patterns) {
      const match = models.find(m => m.toLowerCase().includes(p))
      if (match) return match
   }

   // No match found - use default model instead of erroring
   return undefined
}

const MAX_OUTPUT_LINES = runtime.options.maxOutputLines ?? 5000
const MAX_OUTPUT_BYTES = runtime.options.maxOutputBytes ?? 500_000
const MAX_PARALLEL_TASKS = runtime.options.maxParallelTasks ?? 32
const MAX_CONCURRENCY = runtime.options.maxConcurrency ?? 16
const MAX_AGENTS_IN_DESCRIPTION = runtime.options.maxAgentsInDescription ?? 10

type AgentScope = 'user' | 'project' | 'both'

interface AgentConfig {
   name: string
   description: string
   tools?: string[]
   model?: string
   forkContext?: boolean
   systemPrompt: string
   source: 'user' | 'project'
   filePath: string
}

interface AgentProgress {
   agent: string
   agentSource: 'user' | 'project' | 'unknown'
   status: 'running' | 'completed' | 'failed'
   task: string
   currentTool?: string
   currentToolDescription?: string
   currentToolStartMs?: number
   recentTools: Array<{ tool: string; desc: string; endMs: number }>
   recentOutput: string[]
   toolCount: number
   tokens: number
   durationMs: number
   step?: number
   index: number
   modelOverride?: string
}

interface SingleResult {
   agent: string
   agentSource: 'user' | 'project' | 'unknown'
   task: string
   exitCode: number
   stdout: string
   stderr: string
   truncated: boolean
   durationMs: number
   step?: number
   modelOverride?: string
}

interface TaskDetails {
   agentScope: AgentScope
   projectAgentsDir: string | null
   results: SingleResult[]
   totalDurationMs: number
   /** Output file paths */
   outputPaths?: string[]
   /** For streaming progress updates */
   progress?: AgentProgress[]
}

function parseFrontmatter(content: string): {
   frontmatter: Record<string, string>
   body: string
} {
   const frontmatter: Record<string, string> = {}
   const normalized = content.replace(/\r\n/g, '\n')

   if (!normalized.startsWith('---')) {
      return { frontmatter, body: normalized }
   }

   const endIndex = normalized.indexOf('\n---', 3)
   if (endIndex === -1) {
      return { frontmatter, body: normalized }
   }

   const frontmatterBlock = normalized.slice(4, endIndex)
   const body = normalized.slice(endIndex + 4).trim()

   for (const line of frontmatterBlock.split('\n')) {
      const match = line.match(/^([\w-]+):\s*(.*)$/)
      if (match) {
         let value = match[2].trim()
         if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
         }
         frontmatter[match[1]] = value
      }
   }

   return { frontmatter, body }
}

function loadAgentsFromDir(dir: string, source: 'user' | 'project'): AgentConfig[] {
   const agents: AgentConfig[] = []

   if (!fs.existsSync(dir)) {
      return agents
   }

   let entries: fs.Dirent[]
   try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
   } catch {
      return agents
   }

   for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue

      const filePath = path.join(dir, entry.name)

      // Handle both regular files and symlinks (statSync follows symlinks)
      try {
         if (!fs.statSync(filePath).isFile()) continue
      } catch {
         continue
      }
      let content: string
      try {
         content = fs.readFileSync(filePath, 'utf-8')
      } catch {
         continue
      }

      const { frontmatter, body } = parseFrontmatter(content)

      if (!frontmatter.name || !frontmatter.description) {
         continue
      }

      const tools = frontmatter.tools
         ?.split(',')
         .map(t => t.trim())
         .filter(Boolean)

      const forkContext =
         frontmatter.forkContext === undefined ? undefined : frontmatter.forkContext === 'true' || frontmatter.forkContext === '1'

      agents.push({
         name: frontmatter.name,
         description: frontmatter.description,
         tools: tools && tools.length > 0 ? tools : undefined,
         model: frontmatter.model,
         forkContext,
         systemPrompt: body,
         source,
         filePath,
      })
   }

   return agents
}

function isDirectory(p: string): boolean {
   try {
      return fs.statSync(p).isDirectory()
   } catch {
      return false
   }
}

function findNearestDir(cwd: string, relPath: string): string | null {
   let currentDir = cwd
   while (true) {
      const candidate = path.join(currentDir, relPath)
      if (isDirectory(candidate)) return candidate

      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) return null
      currentDir = parentDir
   }
}

function discoverAgents(cwd: string, scope: AgentScope): { agents: AgentConfig[]; projectAgentsDir: string | null } {
   // Primary directories (.pi)
   const userPiDir = path.join(os.homedir(), '.pi', 'agent', 'agents')
   const projectPiDir = findNearestDir(cwd, '.pi/agents')

   // Fallback directories (.claude) - only load agents not already present
   const userClaudeDir = path.join(os.homedir(), '.claude', 'agents')
   const projectClaudeDir = findNearestDir(cwd, '.claude/agents')

   const agentMap = new Map<string, AgentConfig>()

   // Load from .pi directories first (primary)
   const userPiAgents = scope === 'project' ? [] : loadAgentsFromDir(userPiDir, 'user')
   const projectPiAgents = scope === 'user' || !projectPiDir ? [] : loadAgentsFromDir(projectPiDir, 'project')

   // Load from .claude directories (fallback)
   const userClaudeAgents = scope === 'project' ? [] : loadAgentsFromDir(userClaudeDir, 'user')
   const projectClaudeAgents = scope === 'user' || !projectClaudeDir ? [] : loadAgentsFromDir(projectClaudeDir, 'project')

   if (scope === 'both') {
      // Order: user .claude → user .pi → project .claude → project .pi
      // Later entries override earlier ones, so .pi takes precedence over .claude
      for (const agent of userClaudeAgents) agentMap.set(agent.name, agent)
      for (const agent of userPiAgents) agentMap.set(agent.name, agent)
      for (const agent of projectClaudeAgents) agentMap.set(agent.name, agent)
      for (const agent of projectPiAgents) agentMap.set(agent.name, agent)
   } else if (scope === 'user') {
      // user .claude → user .pi (later overrides earlier)
      for (const agent of userClaudeAgents) agentMap.set(agent.name, agent)
      for (const agent of userPiAgents) agentMap.set(agent.name, agent)
   } else {
      // project .claude → project .pi
      for (const agent of projectClaudeAgents) agentMap.set(agent.name, agent)
      for (const agent of projectPiAgents) agentMap.set(agent.name, agent)
   }

   return { agents: Array.from(agentMap.values()), projectAgentsDir: projectPiDir }
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
   let truncated = false
   let byteBudget = MAX_OUTPUT_BYTES
   let lineBudget = MAX_OUTPUT_LINES

   let i = 0
   let lastNewlineIndex = -1
   while (i < output.length && byteBudget > 0) {
      const ch = output.charCodeAt(i)
      byteBudget--

      if (ch === 10 /* \n */) {
         lineBudget--
         lastNewlineIndex = i
         if (lineBudget <= 0) {
            truncated = true
            break
         }
      }

      i++
   }

   if (i < output.length) {
      truncated = true
   }

   if (truncated && lineBudget <= 0 && lastNewlineIndex >= 0) {
      output = output.slice(0, lastNewlineIndex)
   } else {
      output = output.slice(0, i)
   }

   return { text: output, truncated }
}

function previewFirstLines(text: string, maxLines: number): string {
   if (maxLines <= 0) return ''
   let linesRemaining = maxLines
   let i = 0
   while (i < text.length) {
      const nextNewline = text.indexOf('\n', i)
      if (nextNewline === -1) return text
      linesRemaining--
      if (linesRemaining <= 0) return text.slice(0, nextNewline)
      i = nextNewline + 1
   }
   return text
}

function sanitizeAgentName(name: string): string {
   return name.replace(/[^\w.-]+/g, '_').slice(0, 50)
}

function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
   const MAX_LEN = 60

   // Extract the most relevant arg based on tool type
   let preview = ''
   if (args.command) {
      preview = String(args.command)
   } else if (args.file_path) {
      preview = String(args.file_path)
   } else if (args.path) {
      preview = String(args.path)
   } else if (args.pattern) {
      preview = String(args.pattern)
   } else if (args.query) {
      preview = String(args.query)
   } else if (args.url) {
      preview = String(args.url)
   } else if (args.task) {
      preview = String(args.task)
   } else {
      // Fallback: stringify first non-empty string arg
      for (const val of Object.values(args)) {
         if (typeof val === 'string' && val.length > 0) {
            preview = val
            break
         }
      }
   }

   if (!preview) {
      return toolName
   }

   // Truncate and clean up
   preview = preview.replace(/\n/g, ' ').trim()
   if (preview.length > MAX_LEN) {
      preview = `${preview.slice(0, MAX_LEN)}…`
   }

   return `${toolName}: ${preview}`
}

function formatDuration(ms: number): string {
   if (ms < 1000) return `${ms}ms`
   if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
   const mins = Math.floor(ms / 60000)
   const secs = ((ms % 60000) / 1000).toFixed(0)
   return `${mins}m${secs}s`
}

function formatTimeAgo(timestampMs: number): string {
   const ago = Date.now() - timestampMs
   if (ago < 1000) return 'just now'
   if (ago < 60000) return `${Math.round(ago / 1000)}s ago`
   const mins = Math.floor(ago / 60000)
   return `${mins}m ago`
}

function formatTokens(tokens: number): string {
   if (tokens < 1000) return `${tokens}`
   if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`
   return `${Math.round(tokens / 1000)}k`
}

function pluralize(count: number, singular: string, plural?: string): string {
   return count === 1 ? singular : (plural ?? `${singular}s`)
}

async function mapWithConcurrencyLimit<TIn, TOut>(
   items: TIn[],
   concurrency: number,
   fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
   if (items.length === 0) return []
   const limit = Math.max(1, Math.min(concurrency, items.length))
   const results: TOut[] = new Array(items.length)

   let nextIndex = 0
   const workers = new Array(limit).fill(null).map(async () => {
      while (true) {
         const current = nextIndex++
         if (current >= items.length) return
         results[current] = await fn(items[current], current)
      }
   })

   await Promise.all(workers)
   return results
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
   const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-agent-'))
   const safeName = agentName.replace(/[^\w.-]+/g, '_')
   const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
   try {
      fs.writeFileSync(filePath, prompt, { encoding: 'utf-8', mode: 0o600 })
   } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw err
   }
   return { dir: tmpDir, filePath }
}

interface RunAgentOptions {
   onProgress?: (progress: AgentProgress) => void
   index?: number
   signal?: AbortSignal
   model?: string
}

async function runSingleAgent(
   cwd: string,
   agents: AgentConfig[],
   agentName: string,
   task: string,
   step?: number,
   options?: RunAgentOptions
): Promise<SingleResult> {
   // Check if already aborted
   if (options?.signal?.aborted) {
      return {
         agent: agentName,
         agentSource: 'unknown',
         task,
         exitCode: 1,
         stdout: '',
         stderr: 'Aborted',
         truncated: false,
         durationMs: 0,
         step,
      }
   }
   const startTime = Date.now()
   const agent = agents.find(a => a.name === agentName)
   const index = options?.index ?? 0

   if (!agent) {
      return {
         agent: agentName,
         agentSource: 'unknown',
         task,
         exitCode: 1,
         stdout: '',
         stderr: `Unknown agent: ${agentName}. Available: ${agents.map(a => a.name).join(', ') || 'none'}`,
         truncated: false,
         durationMs: Date.now() - startTime,
         step,
      }
   }

   const args: string[] = ['-p', '--no-session', '--mode', 'json']

   // "default" means no model override - use pi's configured default
   const modelOverride = options?.model
   const rawModel = modelOverride === 'default' ? undefined : (modelOverride ?? agent.model)
   const modelToUse = rawModel ? resolveModelPattern(rawModel) : undefined
   if (modelToUse) {
      args.push('--model', modelToUse)
   }

   if (agent.tools && agent.tools.length > 0) {
      args.push('--tools', agent.tools.join(','))
   }

   let tmpPromptDir: string | null = null
   let tmpPromptPath: string | null = null

   try {
      if (agent.systemPrompt.trim()) {
         const tmp = writePromptToTempFile(agent.name, agent.systemPrompt)
         tmpPromptDir = tmp.dir
         tmpPromptPath = tmp.filePath
         args.push('--append-system-prompt', tmpPromptPath)
      }

      args.push(`Task: ${task}`)

      // Emit initial "Initializing" state
      options?.onProgress?.({
         agent: agentName,
         agentSource: agent.source,
         status: 'running',
         task,
         currentTool: undefined,
         currentToolDescription: 'Initializing…',
         currentToolStartMs: undefined,
         recentTools: [],
         recentOutput: [],
         toolCount: 0,
         tokens: 0,
         durationMs: 0,
         step,
         index,
         modelOverride: options?.model,
      })

      return await new Promise<SingleResult>(resolve => {
         const proc = spawn('pi', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
         })

         let toolCount = 0
         let tokens = 0
         let currentTool: string | undefined
         let currentToolDescription: string | undefined
         let currentToolStartMs: number | undefined
         const recentTools: Array<{ tool: string; desc: string; endMs: number }> = []
         const MAX_RECENT_TOOLS = 5
         const recentOutput: string[] = []
         const MAX_RECENT_OUTPUT_LINES = 8
         let lastTextContent = ''
         let stderrContent = ''
         let aborted = false
         let resolved = false

         const doResolve = (result: SingleResult) => {
            if (resolved) return
            resolved = true
            options?.signal?.removeEventListener('abort', onAbort)
            resolve(result)
         }

         // Handle abort signal (ESC key)
         const onAbort = () => {
            aborted = true
            proc.kill('SIGTERM')
         }
         options?.signal?.addEventListener('abort', onAbort)

         const rl = readline.createInterface({ input: proc.stdout })
         let status: 'running' | 'completed' | 'failed' = 'running'

         const emitProgress = () => {
            options?.onProgress?.({
               agent: agentName,
               agentSource: agent.source,
               status,
               task,
               currentTool,
               currentToolDescription,
               currentToolStartMs,
               recentTools: recentTools.slice(),
               recentOutput: recentOutput.slice(),
               toolCount,
               tokens,
               durationMs: Date.now() - startTime,
               step,
               index,
               modelOverride: options?.model,
            })
         }

         rl.on('line', line => {
            try {
               const event = JSON.parse(line)

               if (event.type === 'tool_execution_start') {
                  toolCount++
                  currentTool = event.toolName
                  currentToolStartMs = Date.now()
                  // Extract tool args for description
                  const args = event.toolArgs || event.args || {}
                  const argPreview = formatToolArgs(event.toolName, args)
                  currentToolDescription = argPreview
                  emitProgress()
               } else if (event.type === 'tool_execution_end') {
                  // Record completed tool in recent history
                  if (currentTool && currentToolStartMs) {
                     // Extract just the preview part (after "tool: ")
                     const desc = currentToolDescription?.replace(/^[^:]+:\s*/, '') || ''
                     recentTools.push({
                        tool: currentTool,
                        desc,
                        endMs: Date.now(),
                     })
                     if (recentTools.length > MAX_RECENT_TOOLS) {
                        recentTools.shift()
                     }
                  }
                  currentTool = undefined
                  currentToolDescription = undefined
                  currentToolStartMs = undefined
               } else if (event.type === 'message_update' || event.type === 'message_end') {
                  // Extract tokens from usage
                  const usage = event.message?.usage
                  if (usage?.totalTokens) {
                     tokens = usage.totalTokens
                  }
                  // Extract recent text/thinking content
                  const content = event.message?.content
                  if (Array.isArray(content)) {
                     for (const block of content) {
                        if (block.type === 'thinking' && block.thinking) {
                           const lines = block.thinking.split('\n').filter((l: string) => l.trim())
                           for (const line of lines.slice(-3)) {
                              const formatted = `💭 ${line.slice(0, 120)}`
                              // Dedupe: don't add if same as last line
                              if (recentOutput[recentOutput.length - 1] !== formatted) {
                                 recentOutput.push(formatted)
                                 if (recentOutput.length > MAX_RECENT_OUTPUT_LINES) recentOutput.shift()
                              }
                           }
                        } else if (block.type === 'text' && block.text) {
                           const lines = block.text.split('\n').filter((l: string) => l.trim())
                           for (const line of lines.slice(-3)) {
                              const formatted = line.slice(0, 120)
                              // Dedupe: don't add if same as last line
                              if (recentOutput[recentOutput.length - 1] !== formatted) {
                                 recentOutput.push(formatted)
                                 if (recentOutput.length > MAX_RECENT_OUTPUT_LINES) recentOutput.shift()
                              }
                           }
                        }
                     }
                  }
               } else if (event.type === 'agent_end') {
                  // Extract final text from the last assistant message
                  const messages = event.messages ?? []
                  const lastMsg = messages.findLast((m: any) => m.role === 'assistant')
                  if (lastMsg?.content && Array.isArray(lastMsg.content)) {
                     const textParts = lastMsg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)
                     lastTextContent = textParts.join('\n')
                  }
                  // Get final token count
                  if (lastMsg?.usage?.totalTokens) {
                     tokens = lastMsg.usage.totalTokens
                  }
                  // Mark as completed and emit final progress
                  status = 'completed'
                  currentTool = undefined
                  currentToolDescription = 'Done'
                  emitProgress()
                  // Resolve immediately on agent_end - don't wait for process close
                  const stdoutResult = truncateOutput(lastTextContent)
                  doResolve({
                     agent: agentName,
                     agentSource: agent.source,
                     task,
                     exitCode: 0,
                     stdout: stdoutResult.text,
                     stderr: '',
                     truncated: stdoutResult.truncated,
                     durationMs: Date.now() - startTime,
                     step,
                     modelOverride: options?.model,
                  })
               }
            } catch {
               // Ignore parse errors
            }
         })

         proc.stderr.on('data', chunk => {
            stderrContent += chunk.toString()
         })

         proc.on('close', code => {
            if (aborted) {
               doResolve({
                  agent: agentName,
                  agentSource: agent.source,
                  task,
                  exitCode: 1,
                  stdout: lastTextContent,
                  stderr: 'Interrupted',
                  truncated: false,
                  durationMs: Date.now() - startTime,
                  step,
                  modelOverride: options?.model,
               })
               return
            }

            // Fallback if agent_end wasn't received
            const stdoutResult = truncateOutput(lastTextContent)
            const stderrResult = truncateOutput(stderrContent)

            doResolve({
               agent: agentName,
               agentSource: agent.source,
               task,
               exitCode: code ?? 0,
               stdout: stdoutResult.text,
               stderr: stderrResult.text,
               truncated: stdoutResult.truncated || stderrResult.truncated,
               durationMs: Date.now() - startTime,
               step,
               modelOverride: options?.model,
            })
         })

         proc.on('error', err => {
            doResolve({
               agent: agentName,
               agentSource: agent.source,
               task,
               exitCode: 1,
               stdout: '',
               stderr: aborted ? 'Interrupted' : err.message,
               truncated: false,
               durationMs: Date.now() - startTime,
               step,
               modelOverride: options?.model,
            })
         })
      })
   } finally {
      if (tmpPromptPath) {
         try {
            fs.unlinkSync(tmpPromptPath)
         } catch {
            /* ignore */
         }
      }
      if (tmpPromptDir) {
         try {
            fs.rmdirSync(tmpPromptDir)
         } catch {
            /* ignore */
         }
      }
   }
}

const TaskItem = Type.Object({
   agent: Type.String({ description: 'Agent name' }),
   task: Type.String({ description: "Agent's specific assignment" }),
   model: Type.Optional(
      Type.String({
         description: 'Override the model for this task (takes precedence over agent\'s default model), or "default" to use pi\'s default',
      })
   ),
})

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
   description: 'Which agent directories are eligible. Default: "user". Use "both" to enable project-local agents from .pi/agents.',
   default: 'user',
})

const TaskParams = Type.Object({
   context: Type.Optional(Type.String({ description: 'Shared context prepended to all tasks' })),
   tasks: Type.Array(TaskItem, { description: 'Tasks to run in parallel' }),
   agentScope: Type.Optional(AgentScopeSchema),
})

/**
 * Builds the dynamic tool description based on discovered agents.
 * Mirrors Claude Code's Task tool description format.
 */
function buildDescription(pi: ToolAPI): string {
   const user = discoverAgents(pi.cwd, 'user')
   const project = discoverAgents(pi.cwd, 'project')

   const lines: string[] = []

   lines.push('Launch a new agent to handle complex, multi-step tasks autonomously.')
   lines.push('')
   lines.push(
      'The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.'
   )
   lines.push('')
   lines.push('Available agent types and the tools they have access to:')

   for (const agent of user.agents.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
      const tools = agent.tools?.join(', ') || 'All tools'
      lines.push(`- ${agent.name}: ${agent.description} (Tools: ${tools})`)
   }
   if (user.agents.length > MAX_AGENTS_IN_DESCRIPTION) {
      lines.push(`  ...and ${user.agents.length - MAX_AGENTS_IN_DESCRIPTION} more user agents`)
   }

   if (project.agents.length > 0) {
      const projectDirNote = project.projectAgentsDir ? ` (from ${project.projectAgentsDir})` : ''
      lines.push('')
      lines.push(`Project agents${projectDirNote} (requires agentScope: "both" or "project"):`)
      for (const agent of project.agents.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
         const tools = agent.tools?.join(', ') || 'All tools'
         lines.push(`- ${agent.name}: ${agent.description} (Tools: ${tools})`)
      }
      if (project.agents.length > MAX_AGENTS_IN_DESCRIPTION) {
         lines.push(`  ...and ${project.agents.length - MAX_AGENTS_IN_DESCRIPTION} more project agents`)
      }
   }

   lines.push('')
   lines.push('When NOT to use the Task tool:')
   lines.push(
      '- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly'
   )
   lines.push(
      '- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly'
   )
   lines.push(
      '- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly'
   )
   lines.push('- Other tasks that are not related to the agent descriptions above')
   lines.push('')
   lines.push('')
   lines.push('Usage notes:')
   lines.push('- Always include a short description of the task in the task parameter')
   lines.push('- Launch multiple agents concurrently whenever possible, to maximize performance')
   lines.push(
      '- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.'
   )
   lines.push(
      '- Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your task should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.'
   )
   lines.push(
      "- IMPORTANT: Agent results are intermediate data, not task completions. Use the agent's findings to continue executing the user's request. Do not treat agent reports as 'task complete' signals - they provide context for you to perform the actual work."
   )
   lines.push("- The agent's outputs should generally be trusted")
   lines.push(
      "- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent"
   )
   lines.push(
      '- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.'
   )
   lines.push('')
   lines.push('Parameters:')
   lines.push(
      '- tasks: Array of {agent, task, model?} - tasks to run in parallel (max ' +
         MAX_PARALLEL_TASKS +
         ', ' +
         MAX_CONCURRENCY +
         ' concurrent)'
   )
   lines.push(
      '  - model: (optional) Override the agent\'s default model with fuzzy matching (e.g., "sonnet", "codex", "5.2"). Supports comma-separated fallbacks: "gpt, opus" tries gpt first, then opus. Use "default" for pi\'s default model'
   )
   lines.push('- context: (optional) Shared context string prepended to all task prompts - use this to avoid repeating instructions')
   lines.push('- agentScope: (optional) "user" | "project" | "both" - which agent directories to use')
   lines.push('')
   lines.push('Results are always written to /tmp/pi-task-{runId}/task_{agent}_{index}.md')
   lines.push('')
   lines.push('Example usage:')
   lines.push('')
   lines.push('<example_agent_descriptions>')
   lines.push('"code-reviewer": use this agent after you are done writing a significant piece of code')
   lines.push('"explore": use this agent for fast codebase exploration and research')
   lines.push('</example_agent_descriptions>')
   lines.push('')
   lines.push('<example>')
   lines.push('user: "Please write a function that checks if a number is prime"')
   lines.push('assistant: Sure let me write a function that checks if a number is prime')
   lines.push("assistant: I'm going to use the Write tool to write the following code:")
   lines.push('<code>')
   lines.push('function isPrime(n) {')
   lines.push('  if (n <= 1) return false')
   lines.push('  for (let i = 2; i * i <= n; i++) {')
   lines.push('    if (n % i === 0) return false')
   lines.push('  }')
   lines.push('  return true')
   lines.push('}')
   lines.push('</code>')
   lines.push('<commentary>')
   lines.push(
      'Since a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code'
   )
   lines.push('</commentary>')
   lines.push('assistant: Now let me use the code-reviewer agent to review the code')
   lines.push('assistant: Uses the Task tool: { tasks: [{ agent: "code-reviewer", task: "Review the isPrime function" }] }')
   lines.push('</example>')
   lines.push('')
   lines.push('<example>')
   lines.push('user: "Find all TODO comments in the codebase"')
   lines.push("assistant: I'll use multiple explore agents to search different directories in parallel")
   lines.push('assistant: Uses the Task tool:')
   lines.push('{')
   lines.push('  "context": "Find all TODO comments. Return file:line:content format.",')
   lines.push('  "tasks": [')
   lines.push('    { "agent": "explore", "task": "Search in src/" },')
   lines.push('    { "agent": "explore", "task": "Search in lib/" },')
   lines.push('    { "agent": "explore", "task": "Search in tests/" }')
   lines.push('  ]')
   lines.push('}')
   lines.push('Results → /tmp/pi-task-{runId}/task_explore_*.md')
   lines.push('</example>')

   return lines.join('\n')
}

const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function nanoid(size = 12): string {
   const bytes = crypto.randomBytes(size)
   let id = ''
   for (let i = 0; i < size; i++) {
      id += NANOID_ALPHABET[bytes[i] % NANOID_ALPHABET.length]
   }
   return id
}

const factory: CustomToolFactory = pi => {
   const runId = nanoid(8)
   const outputDir = path.join(os.tmpdir(), `pi-task-${runId}`)

   const tool: CustomAgentTool<typeof TaskParams, TaskDetails> = {
      name: 'task',
      label: 'Task',
      get description() {
         return buildDescription(pi)
      },
      parameters: TaskParams,

      async execute(_toolCallId, params, signal, onUpdate) {
         const startTime = Date.now()
         const agentScope: AgentScope = params.agentScope ?? 'user'
         const discovery = discoverAgents(pi.cwd, agentScope)
         const agents = discovery.agents
         const context = params.context

         if (!params.tasks || params.tasks.length === 0) {
            const available = agents.map(a => `${a.name} (${a.source})`).join(', ') || 'none'
            return {
               content: [
                  {
                     type: 'text',
                     text: `No tasks provided. Use: { tasks: [{agent, task}, ...] }\nAvailable agents: ${available}`,
                  },
               ],
               details: {
                  agentScope,
                  projectAgentsDir: discovery.projectAgentsDir,
                  results: [],
                  totalDurationMs: 0,
               },
            }
         }

         if (params.tasks.length > MAX_PARALLEL_TASKS) {
            return {
               content: [
                  {
                     type: 'text',
                     text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                  },
               ],
               details: {
                  agentScope,
                  projectAgentsDir: discovery.projectAgentsDir,
                  results: [],
                  totalDurationMs: 0,
               },
            }
         }

         // Track progress for all agents
         const progressMap = new Map<number, AgentProgress>()
         for (let i = 0; i < params.tasks.length; i++) {
            const t = params.tasks[i]
            const agentCfg = agents.find(a => a.name === t.agent)
            progressMap.set(i, {
               agent: t.agent,
               agentSource: agentCfg?.source ?? 'unknown',
               status: 'running',
               task: t.task,
               currentTool: undefined,
               currentToolDescription: 'Queued…',
               currentToolStartMs: undefined,
               recentTools: [],
               recentOutput: [],
               toolCount: 0,
               tokens: 0,
               durationMs: 0,
               index: i,
            })
         }

         const emitProgress = () => {
            const allProgress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index)
            onUpdate?.({
               content: [{ type: 'text', text: `Running ${params.tasks.length} agents...` }],
               details: {
                  agentScope,
                  projectAgentsDir: discovery.projectAgentsDir,
                  results: [],
                  totalDurationMs: Date.now() - startTime,
                  progress: allProgress,
               },
            })
         }

         emitProgress()

         // Build full prompts with context prepended
         const tasksWithContext = params.tasks.map(t => ({
            agent: t.agent,
            task: context ? `${context}\n\n${t.task}` : t.task,
            model: t.model,
         }))

         // Generate output paths
         fs.mkdirSync(outputDir, { recursive: true })
         const outputPaths = params.tasks.map((t, i) => path.join(outputDir, `task_${sanitizeAgentName(t.agent)}_${i}.md`))

         const results = await mapWithConcurrencyLimit(tasksWithContext, MAX_CONCURRENCY, async (t, idx) => {
            const result = await runSingleAgent(pi.cwd, agents, t.agent, t.task, undefined, {
               index: idx,
               signal,
               model: t.model,
               onProgress: progress => {
                  progressMap.set(idx, progress)
                  emitProgress()
               },
            })

            // Write output to file
            const content = result.stdout.trim() || result.stderr.trim() || '(no output)'
            try {
               fs.writeFileSync(outputPaths[idx], content, {
                  encoding: 'utf-8',
               })
            } catch (e) {
               result.stderr += `\nFailed to write output: ${e}`
            }

            return result
         })

         const successCount = results.filter(r => r.exitCode === 0).length
         const totalDuration = Date.now() - startTime

         // Build summaries
         const summaries = results.map((r, i) => {
            const status = r.exitCode === 0 ? 'completed' : `failed (exit ${r.exitCode})`
            const output = r.stdout.trim() || r.stderr.trim() || '(no output)'
            const preview = previewFirstLines(output, 5)
            return `[${r.agent}] ${status} → ${outputPaths[i]}\n${preview}`
         })

         return {
            content: [
               {
                  type: 'text',
                  text: `${successCount}/${results.length} succeeded [${formatDuration(totalDuration)}]\n\n${summaries.join('\n\n---\n\n')}`,
               },
            ],
            details: {
               agentScope,
               projectAgentsDir: discovery.projectAgentsDir,
               results,
               totalDurationMs: totalDuration,
               outputPaths,
            },
         }
      },

      renderCall(args, theme) {
         // Return minimal - renderResult handles the full display
         if (!args.tasks || args.tasks.length === 0) {
            return new Text(theme.fg('dim', 'task: initializing...'), 0, 0)
         }
         return new Text('', 0, 0)
      },

      renderResult(result, { expanded, isPartial }, theme) {
         const { details } = result

         // Tree formatting helpers
         const TREE_MID = '├─'
         const TREE_END = '└─'
         const TREE_PIPE = '│'
         const TREE_SPACE = ' '
         const TREE_HOOK = '⎿'

         const truncateTask = (task: string, maxLen: number) => {
            const firstLine = task.split('\n')[0]
            return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine
         }

         // Handle streaming progress
         if (isPartial && details?.progress && details.progress.length > 0) {
            const count = details.progress.length
            const completedCount = details.progress.filter(p => p.status === 'completed').length
            const outputDir = details.outputPaths?.[0] ? path.dirname(details.outputPaths[0]) : null
            const writeNote = outputDir ? ` → ${outputDir}` : ''

            let headerText: string
            if (completedCount === count) {
               headerText = `${theme.fg('success', '●')} ${theme.fg('toolTitle', `${count} ${pluralize(count, 'agent')} finished`)}`
            } else if (completedCount > 0) {
               headerText = theme.fg('toolTitle', `Running ${count - completedCount}/${count} agents`)
            } else {
               headerText = theme.fg('toolTitle', `Running ${count} ${pluralize(count, 'agent')}`)
            }
            const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O for details)')
            let text = headerText + theme.fg('dim', writeNote) + expandHint

            for (let i = 0; i < details.progress.length; i++) {
               const p = details.progress[i]
               const isLast = i === details.progress.length - 1
               const branch = isLast ? TREE_END : TREE_MID
               const cont = isLast ? TREE_SPACE : TREE_PIPE

               const taskPreview = truncateTask(p.task, 45)
               const tokenStr = p.tokens > 0 ? `${formatTokens(p.tokens)} tokens` : ''

               const modelTag = p.modelOverride ? theme.fg('muted', ` (${p.modelOverride})`) : ''

               if (p.status === 'completed') {
                  // Completed agent - show success
                  text += `\n ${theme.fg('dim', branch)} ${theme.fg('accent', p.agent)}${modelTag}${theme.fg('dim', ` · ${tokenStr}`)}`
                  text += `\n ${theme.fg('dim', `${cont}  ${TREE_HOOK} `)}${theme.fg('success', 'Done')}`
               } else {
                  // Running agent - show current tool
                  const toolUses = `${p.toolCount} tool ${pluralize(p.toolCount, 'use')}`
                  const stats = [toolUses, tokenStr].filter(Boolean).join(' · ')

                  text +=
                     '\n ' +
                     theme.fg('dim', branch) +
                     ' ' +
                     theme.fg('accent', p.agent) +
                     modelTag +
                     theme.fg('dim', ': ') +
                     theme.fg('muted', taskPreview) +
                     theme.fg('dim', ` · ${stats}`)

                  // Show current tool with duration if it's been running a while
                  let statusLine = p.currentToolDescription || p.currentTool || 'Initializing…'
                  if (p.currentToolStartMs) {
                     const toolDurationMs = Date.now() - p.currentToolStartMs
                     if (toolDurationMs > 5000) {
                        statusLine += theme.fg('warning', ` (${formatDuration(toolDurationMs)})`)
                     }
                  }
                  text += `\n ${theme.fg('dim', `${cont}  ${TREE_HOOK} `)}${theme.fg('dim', statusLine)}`

                  // In expanded mode, show recent output and tool history
                  if (expanded) {
                     // Show recent text/thinking output
                     if (p.recentOutput && p.recentOutput.length > 0) {
                        for (const line of p.recentOutput) {
                           const isThinking = line.startsWith('💭')
                           const color = isThinking ? 'muted' : 'dim'
                           text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg(color, line)}`
                        }
                     }
                     // Show recent tool history
                     if (p.recentTools && p.recentTools.length > 0) {
                        text += `\n ${theme.fg('dim', `${cont}     `)}`
                        for (const rt of p.recentTools) {
                           const ago = formatTimeAgo(rt.endMs)
                           const desc = rt.desc ? `${rt.tool}: ${rt.desc}` : rt.tool
                           text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg('muted', `↳ ${desc}`)} ${theme.fg('dim', `(${ago})`)}`
                        }
                     }
                  }
               }
            }

            return new Text(text, 0, 0)
         }

         if (!details || details.results.length === 0) {
            const text = result.content[0]
            return new Text(text?.type === 'text' ? text.text : '', 0, 0)
         }

         // Finished state
         const count = details.results.length
         const successCount = details.results.filter(r => r.exitCode === 0).length
         const allSuccess = successCount === count
         const icon = allSuccess ? theme.fg('success', '●') : theme.fg('warning', '●')
         const outputDir = details.outputPaths?.[0] ? path.dirname(details.outputPaths[0]) : null
         const writeNote = outputDir ? ` → ${outputDir}` : ''

         let text = `${icon} ${theme.fg('toolTitle', `${count} ${pluralize(count, 'agent')} finished`)}${theme.fg('dim', writeNote)}`

         for (let i = 0; i < details.results.length; i++) {
            const r = details.results[i]
            const isLast = i === details.results.length - 1
            const branch = isLast ? TREE_END : TREE_MID
            const cont = isLast ? TREE_SPACE : TREE_PIPE

            const status = r.exitCode === 0 ? 'Done' : `Failed (exit ${r.exitCode})`
            const statusColor = r.exitCode === 0 ? 'success' : 'error'
            const outputPath = details.outputPaths?.[i]
            const statusWithPath = outputPath ? `${status} → ${outputPath}` : status
            const modelTag = r.modelOverride ? theme.fg('muted', ` (${r.modelOverride})`) : ''

            text +=
               '\n ' +
               theme.fg('dim', branch) +
               ' ' +
               theme.fg('accent', r.agent) +
               modelTag +
               theme.fg('dim', ' ') +
               theme.fg(statusColor, statusWithPath)

            const output = r.stdout.trim() || r.stderr.trim()
            if (output) {
               const maxLines = expanded ? 15 : 3
               const lines = output.split('\n').slice(0, maxLines)
               for (const line of lines) {
                  text += `\n ${theme.fg('dim', `${cont}  `)}${theme.fg('dim', line)}`
               }
               if (output.split('\n').length > maxLines) {
                  text += `\n ${theme.fg('dim', `${cont}  `)}${theme.fg('muted', '…')}`
               }
            }
         }

         return new Text(text, 0, 0)
      },
   }

   return tool
}

export default factory
