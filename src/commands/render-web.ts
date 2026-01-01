import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log, outputJson, setJsonMode } from '@omp/output'
import { loadPage } from '@omp/utils/fetch'
import chalk from 'chalk'
import { parse as parseHtml } from 'node-html-parser'

export interface RenderWebOptions {
   json?: boolean
   raw?: boolean
   timeout?: string
}

interface RenderResult {
   url: string
   finalUrl: string
   contentType: string
   method: string
   content: string
   fetchedAt: string
   truncated: boolean
   notes: string[]
}

const DEFAULT_TIMEOUT = 20
const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_OUTPUT_CHARS = 500_000

/**
 * Execute a command and return stdout
 */
function exec(
   cmd: string,
   args: string[],
   options?: { timeout?: number; input?: string }
): { stdout: string; stderr: string; ok: boolean } {
   const timeout = (options?.timeout ?? DEFAULT_TIMEOUT) * 1000
   const result = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: MAX_BYTES,
      input: options?.input,
   })
   return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ok: result.status === 0,
   }
}

/**
 * Check if a command exists
 */
function hasCommand(cmd: string): boolean {
   const result = spawnSync('which', [cmd], { encoding: 'utf-8' })
   return result.status === 0
}

/**
 * Extract origin from URL
 */
function getOrigin(url: string): string {
   try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}`
   } catch {
      return ''
   }
}

/**
 * Normalize URL (add scheme if missing)
 */
function normalizeUrl(url: string): string {
   if (!url.match(/^https?:\/\//i)) {
      return `https://${url}`
   }
   return url
}

/**
 * Check if content looks like HTML
 */
function looksLikeHtml(content: string): boolean {
   const trimmed = content.trim().toLowerCase()
   return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body')
}

/**
 * Try to fetch LLM-friendly endpoints
 */
async function tryLlmEndpoints(origin: string, timeout: number): Promise<string | null> {
   const endpoints = [`${origin}/.well-known/llms.txt`, `${origin}/llms.txt`, `${origin}/llms.md`]

   for (const endpoint of endpoints) {
      const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5) })
      if (result.ok && result.content.trim().length > 100) {
         // Validate it's actually text/markdown, not HTML
         if (looksLikeHtml(result.content)) {
            continue
         }
         return result.content
      }
   }
   return null
}

/**
 * Try content negotiation for markdown/plain
 */
async function tryContentNegotiation(url: string, timeout: number): Promise<{ content: string; type: string } | null> {
   const result = await loadPage(url, {
      timeout,
      headers: {
         Accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8',
      },
   })

   if (!result.ok) return null

   if (result.contentType.includes('markdown') || result.contentType === 'text/plain') {
      return { content: result.content, type: result.contentType }
   }

   return null
}

/**
 * Parse alternate links from HTML head
 * Only returns links likely to be page-specific content (not site-wide feeds)
 */
function parseAlternateLinks(html: string, pageUrl: string): string[] {
   const links: string[] = []

   try {
      const doc = parseHtml(html.slice(0, 262144)) // First 256KB
      const alternateLinks = doc.querySelectorAll('link[rel="alternate"]')

      for (const link of alternateLinks) {
         const href = link.getAttribute('href')
         const type = link.getAttribute('type')?.toLowerCase() ?? ''

         if (!href) continue

         // Skip site-wide feeds (RecentChanges, Special pages, etc.)
         if (href.includes('RecentChanges') || href.includes('Special:') || href.includes('/feed/') || href.includes('action=feed')) {
            continue
         }

         // Only consider markdown alternates or feeds that look page-specific
         if (type.includes('markdown')) {
            links.push(href)
         } else if (
            (type.includes('rss') || type.includes('atom') || type.includes('feed')) &&
            // Feed URL should relate to the page URL somehow
            (href.includes(new URL(pageUrl).pathname) || href.includes('comments'))
         ) {
            links.push(href)
         }
      }
   } catch {
      // If parsing fails, return empty
   }

   return links
}

/**
 * Render HTML to text using lynx
 */
function renderWithLynx(input: string, isUrl: boolean, timeout: number): { content: string; ok: boolean } {
   const args = ['-dump', '-nolist', '-width', '120']

   if (isUrl) {
      args.push(input)
      const result = exec('lynx', args, { timeout })
      return { content: result.stdout, ok: result.ok }
   } else {
      // Write to temp file for local HTML
      const tmpFile = path.join(os.tmpdir(), `omp-render-${Date.now()}.html`)
      try {
         fs.writeFileSync(tmpFile, input)
         args.push(`file://${tmpFile}`)
         const result = exec('lynx', args, { timeout })
         return { content: result.stdout, ok: result.ok }
      } finally {
         try {
            fs.unlinkSync(tmpFile)
         } catch {}
      }
   }
}

/**
 * Check if lynx output looks JS-gated
 */
function looksJsGated(content: string): boolean {
   const lower = content.toLowerCase()
   const triggers = [
      'enable javascript',
      'javascript required',
      'javascript is required',
      'turn on javascript',
      'please enable javascript',
      'browser not supported',
      'unsupported browser',
      'enable cookies',
      'cookies required',
   ]
   return content.length < 1024 && triggers.some(t => lower.includes(t))
}

/**
 * Format JSON with jq or fallback to JSON.stringify
 */
function formatJson(content: string): string {
   if (!hasCommand('jq')) {
      try {
         return JSON.stringify(JSON.parse(content), null, 2)
      } catch {
         return content
      }
   }
   const result = exec('jq', ['.'], { input: content })
   return result.ok ? result.stdout : content
}

/**
 * Format XML with xmllint
 */
function formatXml(content: string): string {
   if (!hasCommand('xmllint')) return content
   const result = exec('xmllint', ['--format', '-'], { input: content })
   return result.ok ? result.stdout : content
}

/**
 * Collapse excessive blank lines
 */
function cleanupOutput(content: string): string {
   // Collapse >2 consecutive blank lines to 1
   return content.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Main render function implementing the full pipeline
 */
async function renderUrl(url: string, timeout: number): Promise<RenderResult> {
   const notes: string[] = []
   const fetchedAt = new Date().toISOString()

   // Step 1: Normalize URL
   url = normalizeUrl(url)
   const origin = getOrigin(url)

   // Step 2: Fetch and classify content
   const response = await loadPage(url, { timeout })
   if (!response.ok) {
      return {
         url,
         finalUrl: url,
         contentType: 'unknown',
         method: 'failed',
         content: '',
         fetchedAt,
         truncated: false,
         notes: ['Failed to fetch URL'],
      }
   }

   const { contentType, finalUrl, content: htmlContent } = response

   // Classify content
   const isHtml = contentType.includes('html') || contentType.includes('xhtml')
   const isJson = contentType.includes('json')
   const isXml = contentType.includes('xml') && !contentType.includes('html')
   const isText = contentType.includes('text/plain') || contentType.includes('text/markdown')
   const isBinary =
      contentType.includes('pdf') ||
      contentType.includes('image') ||
      contentType.includes('octet-stream') ||
      contentType.includes('video') ||
      contentType.includes('audio')

   if (isBinary) {
      return {
         url,
         finalUrl,
         contentType,
         method: 'unsupported',
         content: '',
         fetchedAt,
         truncated: false,
         notes: [`Unsupported binary content type: ${contentType}`],
      }
   }

   // Step 3: Try digestible formats first (for HTML content)
   if (isHtml) {
      // 3A: Check for page-specific markdown alternate (highest priority)
      const alternates = parseAlternateLinks(htmlContent, finalUrl)
      const markdownAlt = alternates.find(alt => alt.endsWith('.md') || alt.includes('markdown'))
      if (markdownAlt) {
         const resolvedAlt = markdownAlt.startsWith('http') ? markdownAlt : new URL(markdownAlt, finalUrl).href
         const altResult = await loadPage(resolvedAlt, { timeout })
         if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
            notes.push(`Used markdown alternate: ${resolvedAlt}`)
            return {
               url,
               finalUrl,
               contentType: 'text/markdown',
               method: 'alternate-markdown',
               content: cleanupOutput(altResult.content),
               fetchedAt,
               truncated: altResult.content.length > MAX_OUTPUT_CHARS,
               notes,
            }
         }
      }

      // 3B: LLM-friendly endpoints (origin-level)
      const llmContent = await tryLlmEndpoints(origin, timeout)
      if (llmContent) {
         notes.push('Found llms.txt')
         return {
            url,
            finalUrl,
            contentType: 'text/plain',
            method: 'llms.txt',
            content: cleanupOutput(llmContent),
            fetchedAt,
            truncated: llmContent.length > MAX_OUTPUT_CHARS,
            notes,
         }
      }

      // 3C: Content negotiation
      const negotiated = await tryContentNegotiation(url, timeout)
      if (negotiated) {
         notes.push(`Content negotiation returned ${negotiated.type}`)
         return {
            url,
            finalUrl,
            contentType: negotiated.type,
            method: 'content-negotiation',
            content: cleanupOutput(negotiated.content),
            fetchedAt,
            truncated: negotiated.content.length > MAX_OUTPUT_CHARS,
            notes,
         }
      }

      // 3D: Check for other alternate links (feeds)
      const feedAlternates = alternates.filter(alt => !alt.endsWith('.md') && !alt.includes('markdown'))
      for (const altUrl of feedAlternates.slice(0, 3)) {
         const resolvedAlt = altUrl.startsWith('http') ? altUrl : new URL(altUrl, finalUrl).href
         const altResult = await loadPage(resolvedAlt, { timeout })
         if (altResult.ok && altResult.content.trim().length > 500) {
            notes.push(`Used alternate link: ${resolvedAlt}`)
            let formatted = altResult.content
            if (resolvedAlt.includes('.json') || altResult.content.trim().startsWith('{')) {
               formatted = formatJson(altResult.content)
            } else if (resolvedAlt.includes('.xml') || altResult.content.trim().startsWith('<')) {
               formatted = formatXml(altResult.content)
            }
            return {
               url,
               finalUrl,
               contentType: 'application/feed',
               method: 'alternate-feed',
               content: cleanupOutput(formatted),
               fetchedAt,
               truncated: formatted.length > MAX_OUTPUT_CHARS,
               notes,
            }
         }
      }

      // Step 4: Render HTML with lynx
      if (!hasCommand('lynx')) {
         notes.push('lynx not installed, returning raw HTML')
         return {
            url,
            finalUrl,
            contentType,
            method: 'raw-html',
            content: cleanupOutput(htmlContent).slice(0, MAX_OUTPUT_CHARS),
            fetchedAt,
            truncated: htmlContent.length > MAX_OUTPUT_CHARS,
            notes,
         }
      }

      // Use lynx on the already-fetched HTML content
      const lynxResult = renderWithLynx(htmlContent, false, timeout)
      if (!lynxResult.ok) {
         notes.push('lynx failed to render')
         return {
            url,
            finalUrl,
            contentType,
            method: 'raw-html',
            content: cleanupOutput(htmlContent).slice(0, MAX_OUTPUT_CHARS),
            fetchedAt,
            truncated: htmlContent.length > MAX_OUTPUT_CHARS,
            notes,
         }
      }

      if (looksJsGated(lynxResult.content)) {
         notes.push('Page appears to require JavaScript')
      }

      return {
         url,
         finalUrl,
         contentType,
         method: 'lynx',
         content: cleanupOutput(lynxResult.content).slice(0, MAX_OUTPUT_CHARS),
         fetchedAt,
         truncated: lynxResult.content.length > MAX_OUTPUT_CHARS,
         notes,
      }
   }

   // Step 5: Handle non-HTML content
   let content = response.content
   let method = 'raw'

   if (isJson) {
      content = formatJson(content)
      method = 'json'
   } else if (isXml) {
      content = formatXml(content)
      method = 'xml'
   } else if (isText) {
      method = 'text'
   }

   return {
      url,
      finalUrl,
      contentType,
      method,
      content: cleanupOutput(content).slice(0, MAX_OUTPUT_CHARS),
      fetchedAt,
      truncated: response.content.length > MAX_OUTPUT_CHARS,
      notes,
   }
}

/**
 * CLI handler for `omp render-web <url>`
 */
export async function renderWeb(url: string, options: RenderWebOptions = {}): Promise<void> {
   if (options.json) {
      setJsonMode(true)
   }

   const timeout = options.timeout ? parseInt(options.timeout, 10) : DEFAULT_TIMEOUT

   if (!url) {
      log(chalk.red('Error: URL is required'))
      process.exitCode = 1
      return
   }

   const result = await renderUrl(url, timeout)

   if (options.json) {
      outputJson(result)
      return
   }

   if (options.raw) {
      // Just output the content, nothing else
      log(result.content)
      return
   }

   // Pretty output
   log(chalk.dim('─'.repeat(60)))
   log(chalk.bold('URL:'), result.finalUrl)
   log(chalk.bold('Content-Type:'), result.contentType)
   log(chalk.bold('Method:'), result.method)
   log(chalk.bold('Fetched:'), result.fetchedAt)
   if (result.truncated) {
      log(chalk.yellow('⚠ Output was truncated'))
   }
   if (result.notes.length > 0) {
      log(chalk.bold('Notes:'), result.notes.join('; '))
   }
   log(chalk.dim('─'.repeat(60)))
   log()
   log(result.content)
}
