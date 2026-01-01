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
const MAX_BYTES = 50 * 1024 * 1024 // 50MB for binary files
const MAX_OUTPUT_CHARS = 500_000

// Convertible document types (markitdown supported)
const CONVERTIBLE_MIMES = new Set([
   'application/pdf',
   'application/msword',
   'application/vnd.ms-powerpoint',
   'application/vnd.ms-excel',
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
   'application/vnd.openxmlformats-officedocument.presentationml.presentation',
   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
   'application/rtf',
   'application/epub+zip',
   'application/zip',
   'image/png',
   'image/jpeg',
   'image/gif',
   'image/webp',
   'audio/mpeg',
   'audio/wav',
   'audio/ogg',
])

const CONVERTIBLE_EXTENSIONS = new Set([
   '.pdf',
   '.doc',
   '.docx',
   '.ppt',
   '.pptx',
   '.xls',
   '.xlsx',
   '.rtf',
   '.epub',
   '.png',
   '.jpg',
   '.jpeg',
   '.gif',
   '.webp',
   '.mp3',
   '.wav',
   '.ogg',
])

/**
 * Execute a command and return stdout
 */
function exec(
   cmd: string,
   args: string[],
   options?: { timeout?: number; input?: string | Buffer }
): { stdout: string; stderr: string; ok: boolean } {
   const timeout = (options?.timeout ?? DEFAULT_TIMEOUT) * 1000
   const result = spawnSync(cmd, args, {
      encoding: options?.input instanceof Buffer ? 'buffer' : 'utf-8',
      timeout,
      maxBuffer: MAX_BYTES,
      input: options?.input,
   })
   return {
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? '',
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
 * Normalize MIME type (lowercase, strip charset/params)
 */
function normalizeMime(contentType: string): string {
   return contentType.split(';')[0].trim().toLowerCase()
}

/**
 * Get extension from URL or Content-Disposition
 */
function getExtensionHint(url: string, contentDisposition?: string): string {
   // Try Content-Disposition filename first
   if (contentDisposition) {
      const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i)
      if (match) {
         const ext = path.extname(match[1]).toLowerCase()
         if (ext) return ext
      }
   }

   // Fall back to URL path
   try {
      const pathname = new URL(url).pathname
      const ext = path.extname(pathname).toLowerCase()
      if (ext) return ext
   } catch {}

   return ''
}

/**
 * Check if content type is convertible via markitdown
 */
function isConvertible(mime: string, extensionHint: string): boolean {
   if (CONVERTIBLE_MIMES.has(mime)) return true
   if (mime === 'application/octet-stream' && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true
   if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true
   return false
}

/**
 * Check if content looks like HTML
 */
function looksLikeHtml(content: string): boolean {
   const trimmed = content.trim().toLowerCase()
   return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body')
}

/**
 * Convert binary file to markdown using markitdown
 */
function convertWithMarkitdown(content: Buffer, extensionHint: string, timeout: number): { content: string; ok: boolean } {
   if (!hasCommand('markitdown')) {
      return { content: '', ok: false }
   }

   // Write to temp file with extension hint
   const ext = extensionHint || '.bin'
   const tmpFile = path.join(os.tmpdir(), `omp-convert-${Date.now()}${ext}`)

   try {
      fs.writeFileSync(tmpFile, content)
      const result = exec('markitdown', [tmpFile], { timeout })
      return { content: result.stdout, ok: result.ok }
   } finally {
      try {
         fs.unlinkSync(tmpFile)
      } catch {}
   }
}

/**
 * Try fetching URL with .md appended (llms.txt convention)
 */
async function tryMdSuffix(url: string, timeout: number): Promise<string | null> {
   const candidates: string[] = []

   try {
      const parsed = new URL(url)
      const pathname = parsed.pathname

      if (pathname.endsWith('/')) {
         // /foo/bar/ -> /foo/bar/index.html.md
         candidates.push(`${parsed.origin}${pathname}index.html.md`)
      } else if (pathname.includes('.')) {
         // /foo/bar.html -> /foo/bar.html.md
         candidates.push(`${parsed.origin}${pathname}.md`)
      } else {
         // /foo/bar -> /foo/bar.md
         candidates.push(`${parsed.origin}${pathname}.md`)
      }
   } catch {
      return null
   }

   for (const candidate of candidates) {
      const result = await loadPage(candidate, { timeout: Math.min(timeout, 5) })
      if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
         return result.content
      }
   }

   return null
}

/**
 * Try to fetch LLM-friendly endpoints
 */
async function tryLlmEndpoints(origin: string, timeout: number): Promise<string | null> {
   const endpoints = [`${origin}/.well-known/llms.txt`, `${origin}/llms.txt`, `${origin}/llms.md`]

   for (const endpoint of endpoints) {
      const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5) })
      if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
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
      headers: { Accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8' },
   })

   if (!result.ok) return null

   const mime = normalizeMime(result.contentType)
   if (mime.includes('markdown') || mime === 'text/plain') {
      return { content: result.content, type: result.contentType }
   }

   return null
}

/**
 * Parse alternate links from HTML head
 */
function parseAlternateLinks(html: string, pageUrl: string): string[] {
   const links: string[] = []

   try {
      const doc = parseHtml(html.slice(0, 262144))
      const alternateLinks = doc.querySelectorAll('link[rel="alternate"]')

      for (const link of alternateLinks) {
         const href = link.getAttribute('href')
         const type = link.getAttribute('type')?.toLowerCase() ?? ''

         if (!href) continue

         // Skip site-wide feeds
         if (href.includes('RecentChanges') || href.includes('Special:') || href.includes('/feed/') || href.includes('action=feed')) {
            continue
         }

         if (type.includes('markdown')) {
            links.push(href)
         } else if (
            (type.includes('rss') || type.includes('atom') || type.includes('feed')) &&
            (href.includes(new URL(pageUrl).pathname) || href.includes('comments'))
         ) {
            links.push(href)
         }
      }
   } catch {}

   return links
}

/**
 * Extract document links from HTML (for PDF/DOCX wrapper pages)
 */
function extractDocumentLinks(html: string, baseUrl: string): string[] {
   const links: string[] = []

   try {
      const doc = parseHtml(html)
      const anchors = doc.querySelectorAll('a[href]')

      for (const anchor of anchors) {
         const href = anchor.getAttribute('href')
         if (!href) continue

         const ext = path.extname(href).toLowerCase()
         if (CONVERTIBLE_EXTENSIONS.has(ext)) {
            const resolved = href.startsWith('http') ? href : new URL(href, baseUrl).href
            links.push(resolved)
         }
      }
   } catch {}

   return links
}

/**
 * Strip CDATA wrapper and clean text
 */
function cleanFeedText(text: string): string {
   return text
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '') // Strip HTML tags
      .trim()
}

/**
 * Parse RSS/Atom feed to markdown
 */
function parseFeedToMarkdown(content: string, maxItems = 10): string {
   try {
      const doc = parseHtml(content, { parseNoneClosedTags: true })

      // Try RSS
      const channel = doc.querySelector('channel')
      if (channel) {
         const title = cleanFeedText(channel.querySelector('title')?.text || 'RSS Feed')
         const items = channel.querySelectorAll('item').slice(0, maxItems)

         let md = `# ${title}\n\n`
         for (const item of items) {
            const itemTitle = cleanFeedText(item.querySelector('title')?.text || 'Untitled')
            const link = cleanFeedText(item.querySelector('link')?.text || '')
            const pubDate = cleanFeedText(item.querySelector('pubDate')?.text || '')
            const desc = cleanFeedText(item.querySelector('description')?.text || '')

            md += `## ${itemTitle}\n`
            if (pubDate) md += `*${pubDate}*\n\n`
            if (desc) md += `${desc.slice(0, 500)}${desc.length > 500 ? '...' : ''}\n\n`
            if (link) md += `[Read more](${link})\n\n`
            md += '---\n\n'
         }
         return md
      }

      // Try Atom
      const feed = doc.querySelector('feed')
      if (feed) {
         const title = cleanFeedText(feed.querySelector('title')?.text || 'Atom Feed')
         const entries = feed.querySelectorAll('entry').slice(0, maxItems)

         let md = `# ${title}\n\n`
         for (const entry of entries) {
            const entryTitle = cleanFeedText(entry.querySelector('title')?.text || 'Untitled')
            const link = entry.querySelector('link')?.getAttribute('href') || ''
            const updated = cleanFeedText(entry.querySelector('updated')?.text || '')
            const summary = cleanFeedText(entry.querySelector('summary')?.text || entry.querySelector('content')?.text || '')

            md += `## ${entryTitle}\n`
            if (updated) md += `*${updated}*\n\n`
            if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? '...' : ''}\n\n`
            if (link) md += `[Read more](${link})\n\n`
            md += '---\n\n'
         }
         return md
      }
   } catch {}

   return content // Fall back to raw content
}

/**
 * Render HTML to text using lynx
 */
function renderWithLynx(html: string, timeout: number): { content: string; ok: boolean } {
   const tmpFile = path.join(os.tmpdir(), `omp-render-${Date.now()}.html`)
   try {
      fs.writeFileSync(tmpFile, html)
      const result = exec('lynx', ['-dump', '-nolist', '-width', '120', `file://${tmpFile}`], { timeout })
      return { content: result.stdout, ok: result.ok }
   } finally {
      try {
         fs.unlinkSync(tmpFile)
      } catch {}
   }
}

/**
 * Check if lynx output looks JS-gated or mostly navigation
 */
function isLowQualityOutput(content: string): boolean {
   const lower = content.toLowerCase()

   // JS-gated indicators
   const jsGated = ['enable javascript', 'javascript required', 'turn on javascript', 'please enable javascript', 'browser not supported']
   if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
      return true
   }

   // Mostly navigation (high link/menu density)
   const lines = content.split('\n').filter(l => l.trim())
   const shortLines = lines.filter(l => l.trim().length < 40)
   if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
      return true
   }

   return false
}

/**
 * Format JSON
 */
function formatJson(content: string): string {
   try {
      return JSON.stringify(JSON.parse(content), null, 2)
   } catch {
      return content
   }
}

/**
 * Truncate and cleanup output
 */
function finalizeOutput(content: string): { content: string; truncated: boolean } {
   const cleaned = content.replace(/\n{3,}/g, '\n\n').trim()
   const truncated = cleaned.length > MAX_OUTPUT_CHARS
   return {
      content: cleaned.slice(0, MAX_OUTPUT_CHARS),
      truncated,
   }
}

/**
 * Fetch page as binary buffer (for convertible files)
 */
async function fetchBinary(
   url: string,
   timeout: number
): Promise<{ buffer: Buffer; contentType: string; contentDisposition?: string; ok: boolean }> {
   try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000)

      const response = await fetch(url, {
         signal: controller.signal,
         headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0' },
         redirect: 'follow',
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
         return { buffer: Buffer.alloc(0), contentType: '', ok: false }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const contentDisposition = response.headers.get('content-disposition') ?? undefined
      const buffer = Buffer.from(await response.arrayBuffer())

      return { buffer, contentType, contentDisposition, ok: true }
   } catch {
      return { buffer: Buffer.alloc(0), contentType: '', ok: false }
   }
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

   // Step 2: Fetch page
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

   const { finalUrl, content: rawContent } = response
   const mime = normalizeMime(response.contentType)
   const extHint = getExtensionHint(finalUrl)

   // Step 3: Handle convertible binary files (PDF, DOCX, etc.)
   if (isConvertible(mime, extHint)) {
      const binary = await fetchBinary(finalUrl, timeout)
      if (binary.ok) {
         const ext = getExtensionHint(finalUrl, binary.contentDisposition) || extHint
         const converted = convertWithMarkitdown(binary.buffer, ext, timeout)
         if (converted.ok && converted.content.trim().length > 50) {
            notes.push(`Converted with markitdown`)
            const output = finalizeOutput(converted.content)
            return {
               url,
               finalUrl,
               contentType: mime,
               method: 'markitdown',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
      }
      notes.push('markitdown conversion failed')
   }

   // Step 4: Handle non-HTML text content
   const isHtml = mime.includes('html') || mime.includes('xhtml')
   const isJson = mime.includes('json')
   const isXml = mime.includes('xml') && !isHtml
   const isText = mime.includes('text/plain') || mime.includes('text/markdown')
   const isFeed = mime.includes('rss') || mime.includes('atom') || mime.includes('feed')

   if (isJson) {
      const output = finalizeOutput(formatJson(rawContent))
      return {
         url,
         finalUrl,
         contentType: mime,
         method: 'json',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes,
      }
   }

   if (isFeed || (isXml && (rawContent.includes('<rss') || rawContent.includes('<feed')))) {
      const parsed = parseFeedToMarkdown(rawContent)
      const output = finalizeOutput(parsed)
      return {
         url,
         finalUrl,
         contentType: mime,
         method: 'feed',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes,
      }
   }

   if (isText && !looksLikeHtml(rawContent)) {
      const output = finalizeOutput(rawContent)
      return {
         url,
         finalUrl,
         contentType: mime,
         method: 'text',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes,
      }
   }

   // Step 5: For HTML, try digestible formats first
   if (isHtml) {
      // 5A: Check for page-specific markdown alternate
      const alternates = parseAlternateLinks(rawContent, finalUrl)
      const markdownAlt = alternates.find(alt => alt.endsWith('.md') || alt.includes('markdown'))
      if (markdownAlt) {
         const resolved = markdownAlt.startsWith('http') ? markdownAlt : new URL(markdownAlt, finalUrl).href
         const altResult = await loadPage(resolved, { timeout })
         if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
            notes.push(`Used markdown alternate: ${resolved}`)
            const output = finalizeOutput(altResult.content)
            return {
               url,
               finalUrl,
               contentType: 'text/markdown',
               method: 'alternate-markdown',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
      }

      // 5B: Try URL.md suffix (llms.txt convention)
      const mdSuffix = await tryMdSuffix(finalUrl, timeout)
      if (mdSuffix) {
         notes.push('Found .md suffix version')
         const output = finalizeOutput(mdSuffix)
         return {
            url,
            finalUrl,
            contentType: 'text/markdown',
            method: 'md-suffix',
            content: output.content,
            fetchedAt,
            truncated: output.truncated,
            notes,
         }
      }

      // 5C: LLM-friendly endpoints
      const llmContent = await tryLlmEndpoints(origin, timeout)
      if (llmContent) {
         notes.push('Found llms.txt')
         const output = finalizeOutput(llmContent)
         return {
            url,
            finalUrl,
            contentType: 'text/plain',
            method: 'llms.txt',
            content: output.content,
            fetchedAt,
            truncated: output.truncated,
            notes,
         }
      }

      // 5D: Content negotiation
      const negotiated = await tryContentNegotiation(url, timeout)
      if (negotiated) {
         notes.push(`Content negotiation returned ${negotiated.type}`)
         const output = finalizeOutput(negotiated.content)
         return {
            url,
            finalUrl,
            contentType: normalizeMime(negotiated.type),
            method: 'content-negotiation',
            content: output.content,
            fetchedAt,
            truncated: output.truncated,
            notes,
         }
      }

      // 5E: Check for feed alternates
      const feedAlternates = alternates.filter(alt => !alt.endsWith('.md') && !alt.includes('markdown'))
      for (const altUrl of feedAlternates.slice(0, 2)) {
         const resolved = altUrl.startsWith('http') ? altUrl : new URL(altUrl, finalUrl).href
         const altResult = await loadPage(resolved, { timeout })
         if (altResult.ok && altResult.content.trim().length > 200) {
            notes.push(`Used feed alternate: ${resolved}`)
            const parsed = parseFeedToMarkdown(altResult.content)
            const output = finalizeOutput(parsed)
            return {
               url,
               finalUrl,
               contentType: 'application/feed',
               method: 'alternate-feed',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
      }

      // Step 6: Render HTML with lynx
      if (!hasCommand('lynx')) {
         notes.push('lynx not installed')
         const output = finalizeOutput(rawContent)
         return {
            url,
            finalUrl,
            contentType: mime,
            method: 'raw-html',
            content: output.content,
            fetchedAt,
            truncated: output.truncated,
            notes,
         }
      }

      const lynxResult = renderWithLynx(rawContent, timeout)
      if (!lynxResult.ok) {
         notes.push('lynx failed')
         const output = finalizeOutput(rawContent)
         return {
            url,
            finalUrl,
            contentType: mime,
            method: 'raw-html',
            content: output.content,
            fetchedAt,
            truncated: output.truncated,
            notes,
         }
      }

      // Step 7: If lynx output is low quality, try extracting document links
      if (isLowQualityOutput(lynxResult.content)) {
         const docLinks = extractDocumentLinks(rawContent, finalUrl)
         if (docLinks.length > 0) {
            const docUrl = docLinks[0]
            const binary = await fetchBinary(docUrl, timeout)
            if (binary.ok) {
               const ext = getExtensionHint(docUrl, binary.contentDisposition)
               const converted = convertWithMarkitdown(binary.buffer, ext, timeout)
               if (converted.ok && converted.content.trim().length > lynxResult.content.length) {
                  notes.push(`Extracted and converted document: ${docUrl}`)
                  const output = finalizeOutput(converted.content)
                  return {
                     url,
                     finalUrl,
                     contentType: 'application/document',
                     method: 'extracted-document',
                     content: output.content,
                     fetchedAt,
                     truncated: output.truncated,
                     notes,
                  }
               }
            }
         }
         notes.push('Page appears to require JavaScript or is mostly navigation')
      }

      const output = finalizeOutput(lynxResult.content)
      return {
         url,
         finalUrl,
         contentType: mime,
         method: 'lynx',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes,
      }
   }

   // Fallback: return raw content
   const output = finalizeOutput(rawContent)
   return {
      url,
      finalUrl,
      contentType: mime,
      method: 'raw',
      content: output.content,
      fetchedAt,
      truncated: output.truncated,
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
