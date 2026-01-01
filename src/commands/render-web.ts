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

// =============================================================================
// GitHub Special Handling
// =============================================================================

interface GitHubUrl {
   type: 'blob' | 'tree' | 'repo' | 'issue' | 'issues' | 'pull' | 'pulls' | 'discussion' | 'discussions' | 'other'
   owner: string
   repo: string
   ref?: string
   path?: string
   number?: number
}

/**
 * Parse GitHub URL into components
 */
function parseGitHubUrl(url: string): GitHubUrl | null {
   try {
      const parsed = new URL(url)
      if (parsed.hostname !== 'github.com') return null

      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts.length < 2) return null

      const [owner, repo, ...rest] = parts

      if (rest.length === 0) {
         return { type: 'repo', owner, repo }
      }

      const [section, ...subParts] = rest

      switch (section) {
         case 'blob':
         case 'tree': {
            const [ref, ...pathParts] = subParts
            return { type: section, owner, repo, ref, path: pathParts.join('/') }
         }
         case 'issues':
            if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
               return { type: 'issue', owner, repo, number: parseInt(subParts[0], 10) }
            }
            return { type: 'issues', owner, repo }
         case 'pull':
            if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
               return { type: 'pull', owner, repo, number: parseInt(subParts[0], 10) }
            }
            return { type: 'pulls', owner, repo }
         case 'pulls':
            return { type: 'pulls', owner, repo }
         case 'discussions':
            if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
               return { type: 'discussion', owner, repo, number: parseInt(subParts[0], 10) }
            }
            return { type: 'discussions', owner, repo }
         default:
            return { type: 'other', owner, repo }
      }
   } catch {
      return null
   }
}

/**
 * Convert GitHub blob URL to raw URL
 */
function toRawGitHubUrl(gh: GitHubUrl): string {
   return `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/refs/heads/${gh.ref}/${gh.path}`
}

/**
 * Fetch from GitHub API
 */
async function fetchGitHubApi(endpoint: string, timeout: number): Promise<{ data: unknown; ok: boolean }> {
   try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000)

      const headers: Record<string, string> = {
         Accept: 'application/vnd.github.v3+json',
         'User-Agent': 'omp-render-web/1.0',
      }

      // Use GITHUB_TOKEN if available
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      if (token) {
         headers.Authorization = `Bearer ${token}`
      }

      const response = await fetch(`https://api.github.com${endpoint}`, {
         signal: controller.signal,
         headers,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
         return { data: null, ok: false }
      }

      return { data: await response.json(), ok: true }
   } catch {
      return { data: null, ok: false }
   }
}

/**
 * Render GitHub issue/PR to markdown
 */
async function renderGitHubIssue(gh: GitHubUrl, timeout: number): Promise<{ content: string; ok: boolean }> {
   const endpoint =
      gh.type === 'pull' ? `/repos/${gh.owner}/${gh.repo}/pulls/${gh.number}` : `/repos/${gh.owner}/${gh.repo}/issues/${gh.number}`

   const result = await fetchGitHubApi(endpoint, timeout)
   if (!result.ok || !result.data) return { content: '', ok: false }

   const issue = result.data as {
      title: string
      number: number
      state: string
      user: { login: string }
      created_at: string
      updated_at: string
      body: string | null
      labels: Array<{ name: string }>
      comments: number
      html_url: string
   }

   let md = `# ${issue.title}\n\n`
   md += `**#${issue.number}** · ${issue.state} · opened by @${issue.user.login}\n`
   md += `Created: ${issue.created_at} · Updated: ${issue.updated_at}\n`
   if (issue.labels.length > 0) {
      md += `Labels: ${issue.labels.map(l => l.name).join(', ')}\n`
   }
   md += `\n---\n\n`
   md += issue.body || '*No description provided.*'
   md += `\n\n---\n\n`

   // Fetch comments if any
   if (issue.comments > 0) {
      const commentsResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/issues/${gh.number}/comments?per_page=50`, timeout)
      if (commentsResult.ok && Array.isArray(commentsResult.data)) {
         md += `## Comments (${issue.comments})\n\n`
         for (const comment of commentsResult.data as Array<{
            user: { login: string }
            created_at: string
            body: string
         }>) {
            md += `### @${comment.user.login} · ${comment.created_at}\n\n`
            md += `${comment.body}\n\n---\n\n`
         }
      }
   }

   return { content: md, ok: true }
}

/**
 * Render GitHub issues list to markdown
 */
async function renderGitHubIssuesList(gh: GitHubUrl, timeout: number): Promise<{ content: string; ok: boolean }> {
   const result = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/issues?state=open&per_page=30`, timeout)
   if (!result.ok || !Array.isArray(result.data)) return { content: '', ok: false }

   const issues = result.data as Array<{
      number: number
      title: string
      state: string
      user: { login: string }
      created_at: string
      comments: number
      labels: Array<{ name: string }>
      pull_request?: unknown
   }>

   let md = `# ${gh.owner}/${gh.repo} - Open Issues\n\n`

   for (const issue of issues) {
      if (issue.pull_request) continue // Skip PRs in issues list
      const labels = issue.labels.length > 0 ? ` [${issue.labels.map(l => l.name).join(', ')}]` : ''
      md += `- **#${issue.number}** ${issue.title}${labels}\n`
      md += `  by @${issue.user.login} · ${issue.comments} comments · ${issue.created_at}\n\n`
   }

   return { content: md, ok: true }
}

/**
 * Render GitHub repo to markdown (file list + README)
 */
async function renderGitHubRepo(gh: GitHubUrl, timeout: number): Promise<{ content: string; ok: boolean }> {
   // Fetch repo info
   const repoResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}`, timeout)
   if (!repoResult.ok) return { content: '', ok: false }

   const repo = repoResult.data as {
      full_name: string
      description: string | null
      stargazers_count: number
      forks_count: number
      open_issues_count: number
      default_branch: string
      language: string | null
      license: { name: string } | null
   }

   let md = `# ${repo.full_name}\n\n`
   if (repo.description) md += `${repo.description}\n\n`
   md += `⭐ ${repo.stargazers_count} · 🍴 ${repo.forks_count} · 📝 ${repo.open_issues_count} issues\n`
   if (repo.language) md += `Language: ${repo.language}\n`
   if (repo.license) md += `License: ${repo.license.name}\n`
   md += `\n---\n\n`

   // Fetch file tree
   const treeResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${repo.default_branch}?recursive=1`, timeout)
   if (treeResult.ok && treeResult.data) {
      const tree = (treeResult.data as { tree: Array<{ path: string; type: string }> }).tree
      md += `## Files\n\n`
      md += '```\n'
      for (const item of tree.slice(0, 100)) {
         const prefix = item.type === 'tree' ? '📁 ' : '   '
         md += `${prefix}${item.path}\n`
      }
      if (tree.length > 100) {
         md += `... and ${tree.length - 100} more files\n`
      }
      md += '```\n\n'
   }

   // Fetch README
   const readmeResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/readme`, timeout)
   if (readmeResult.ok && readmeResult.data) {
      const readme = readmeResult.data as { content: string; encoding: string }
      if (readme.encoding === 'base64') {
         const decoded = Buffer.from(readme.content, 'base64').toString('utf-8')
         md += `## README\n\n${decoded}`
      }
   }

   return { content: md, ok: true }
}

/**
 * Handle GitHub URLs specially
 */
async function handleGitHub(url: string, timeout: number): Promise<RenderResult | null> {
   const gh = parseGitHubUrl(url)
   if (!gh) return null

   const fetchedAt = new Date().toISOString()
   const notes: string[] = []

   switch (gh.type) {
      case 'blob': {
         // Convert to raw URL and fetch
         const rawUrl = toRawGitHubUrl(gh)
         notes.push(`Fetched raw: ${rawUrl}`)
         const result = await loadPage(rawUrl, { timeout })
         if (result.ok) {
            const output = finalizeOutput(result.content)
            return {
               url,
               finalUrl: rawUrl,
               contentType: 'text/plain',
               method: 'github-raw',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
         break
      }

      case 'issue':
      case 'pull': {
         notes.push(`Fetched via GitHub API`)
         const result = await renderGitHubIssue(gh, timeout)
         if (result.ok) {
            const output = finalizeOutput(result.content)
            return {
               url,
               finalUrl: url,
               contentType: 'text/markdown',
               method: gh.type === 'pull' ? 'github-pr' : 'github-issue',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
         break
      }

      case 'issues': {
         notes.push(`Fetched via GitHub API`)
         const result = await renderGitHubIssuesList(gh, timeout)
         if (result.ok) {
            const output = finalizeOutput(result.content)
            return {
               url,
               finalUrl: url,
               contentType: 'text/markdown',
               method: 'github-issues',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
         break
      }

      case 'repo': {
         notes.push(`Fetched via GitHub API`)
         const result = await renderGitHubRepo(gh, timeout)
         if (result.ok) {
            const output = finalizeOutput(result.content)
            return {
               url,
               finalUrl: url,
               contentType: 'text/markdown',
               method: 'github-repo',
               content: output.content,
               fetchedAt,
               truncated: output.truncated,
               notes,
            }
         }
         break
      }
   }

   // Fall back to null (let normal rendering handle it)
   return null
}

// =============================================================================
// Twitter/X Special Handling (via Nitter)
// =============================================================================

const NITTER_INSTANCES = ['nitter.poast.org', 'nitter.privacydev.net', 'nitter.woodland.cafe']

/**
 * Handle Twitter/X URLs via Nitter
 */
async function handleTwitter(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      if (!['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com'].includes(parsed.hostname)) {
         return null
      }

      const fetchedAt = new Date().toISOString()

      // Try Nitter instances
      for (const instance of NITTER_INSTANCES) {
         const nitterUrl = `https://${instance}${parsed.pathname}`
         const result = await loadPage(nitterUrl, { timeout: Math.min(timeout, 10) })

         if (result.ok && result.content.length > 500) {
            // Parse the Nitter HTML
            const doc = parseHtml(result.content)

            // Extract tweet content
            const tweetContent = doc.querySelector('.tweet-content')?.text?.trim()
            const fullname = doc.querySelector('.fullname')?.text?.trim()
            const username = doc.querySelector('.username')?.text?.trim()
            const date = doc.querySelector('.tweet-date a')?.text?.trim()
            const stats = doc.querySelector('.tweet-stats')?.text?.trim()

            if (tweetContent) {
               let md = `# Tweet by ${fullname || 'Unknown'} (${username || '@?'})\n\n`
               if (date) md += `*${date}*\n\n`
               md += `${tweetContent}\n\n`
               if (stats) md += `---\n${stats.replace(/\s+/g, ' ')}\n`

               // Check for replies/thread
               const replies = doc.querySelectorAll('.timeline-item .tweet-content')
               if (replies.length > 1) {
                  md += `\n---\n\n## Thread/Replies\n\n`
                  for (const reply of Array.from(replies).slice(1, 10)) {
                     const replyUser = reply.parentNode?.querySelector('.username')?.text?.trim()
                     md += `**${replyUser || '@?'}**: ${reply.text?.trim()}\n\n`
                  }
               }

               const output = finalizeOutput(md)
               return {
                  url,
                  finalUrl: nitterUrl,
                  contentType: 'text/markdown',
                  method: 'twitter-nitter',
                  content: output.content,
                  fetchedAt,
                  truncated: output.truncated,
                  notes: [`Via Nitter: ${instance}`],
               }
            }
         }
      }
   } catch {}

   return null
}

// =============================================================================
// Stack Overflow Special Handling
// =============================================================================

interface SOQuestion {
   title: string
   body: string
   score: number
   owner: { display_name: string }
   creation_date: number
   tags: string[]
   answer_count: number
   is_answered: boolean
}

interface SOAnswer {
   body: string
   score: number
   is_accepted: boolean
   owner: { display_name: string }
   creation_date: number
}

/**
 * Handle Stack Overflow URLs via API
 */
async function handleStackOverflow(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      if (!parsed.hostname.includes('stackoverflow.com') && !parsed.hostname.includes('stackexchange.com')) {
         return null
      }

      // Extract question ID from URL patterns like /questions/12345/...
      const match = parsed.pathname.match(/\/questions\/(\d+)/)
      if (!match) return null

      const questionId = match[1]
      const site = parsed.hostname.includes('stackoverflow') ? 'stackoverflow' : parsed.hostname.split('.')[0]
      const fetchedAt = new Date().toISOString()

      // Fetch question with answers
      const apiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}?order=desc&sort=votes&site=${site}&filter=withbody`
      const qResult = await loadPage(apiUrl, { timeout })

      if (!qResult.ok) return null

      const qData = JSON.parse(qResult.content) as { items: SOQuestion[] }
      if (!qData.items?.length) return null

      const question = qData.items[0]

      let md = `# ${question.title}\n\n`
      md += `**Score:** ${question.score} · **Answers:** ${question.answer_count}`
      md += question.is_answered ? ' ✓ Answered' : ''
      md += `\n**Tags:** ${question.tags.join(', ')}\n`
      md += `**Asked by:** ${question.owner.display_name} · ${new Date(question.creation_date * 1000).toISOString().split('T')[0]}\n\n`
      md += `---\n\n## Question\n\n${htmlToBasicMarkdown(question.body)}\n\n`

      // Fetch answers
      const aUrl = `https://api.stackexchange.com/2.3/questions/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`
      const aResult = await loadPage(aUrl, { timeout })

      if (aResult.ok) {
         const aData = JSON.parse(aResult.content) as { items: SOAnswer[] }
         if (aData.items?.length) {
            md += `---\n\n## Answers\n\n`
            for (const answer of aData.items.slice(0, 5)) {
               const accepted = answer.is_accepted ? ' ✓ Accepted' : ''
               md += `### Score: ${answer.score}${accepted} · by ${answer.owner.display_name}\n\n`
               md += `${htmlToBasicMarkdown(answer.body)}\n\n---\n\n`
            }
         }
      }

      const output = finalizeOutput(md)
      return {
         url,
         finalUrl: url,
         contentType: 'text/markdown',
         method: 'stackoverflow',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes: ['Fetched via Stack Exchange API'],
      }
   } catch {}

   return null
}

/**
 * Convert basic HTML to markdown (for SO bodies)
 */
function htmlToBasicMarkdown(html: string): string {
   return html
      .replace(/<pre><code[^>]*>/g, '\n```\n')
      .replace(/<\/code><\/pre>/g, '\n```\n')
      .replace(/<code>/g, '`')
      .replace(/<\/code>/g, '`')
      .replace(/<strong>/g, '**')
      .replace(/<\/strong>/g, '**')
      .replace(/<em>/g, '*')
      .replace(/<\/em>/g, '*')
      .replace(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g, '[$2]($1)')
      .replace(/<p>/g, '\n\n')
      .replace(/<\/p>/g, '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<li>/g, '- ')
      .replace(/<\/li>/g, '\n')
      .replace(/<\/?[uo]l>/g, '\n')
      .replace(/<h(\d)>/g, (_, n) => '\n' + '#'.repeat(parseInt(n)) + ' ')
      .replace(/<\/h\d>/g, '\n')
      .replace(/<blockquote>/g, '\n> ')
      .replace(/<\/blockquote>/g, '\n')
      .replace(/<[^>]+>/g, '') // Strip remaining tags
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
}

// =============================================================================
// Wikipedia Special Handling
// =============================================================================

/**
 * Handle Wikipedia URLs via API
 */
async function handleWikipedia(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      // Match *.wikipedia.org
      const wikiMatch = parsed.hostname.match(/^(\w+)\.wikipedia\.org$/)
      if (!wikiMatch) return null

      const lang = wikiMatch[1]
      const titleMatch = parsed.pathname.match(/\/wiki\/(.+)/)
      if (!titleMatch) return null

      const title = decodeURIComponent(titleMatch[1])
      const fetchedAt = new Date().toISOString()

      // Use Wikipedia API to get plain text extract
      const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
      const summaryResult = await loadPage(apiUrl, { timeout })

      let md = ''

      if (summaryResult.ok) {
         const summary = JSON.parse(summaryResult.content) as {
            title: string
            description?: string
            extract: string
         }
         md = `# ${summary.title}\n\n`
         if (summary.description) md += `*${summary.description}*\n\n`
         md += `${summary.extract}\n\n---\n\n`
      }

      // Get full article content via mobile-html or parse API
      const contentUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(title)}`
      const contentResult = await loadPage(contentUrl, { timeout })

      if (contentResult.ok) {
         const doc = parseHtml(contentResult.content)

         // Extract main content sections
         const sections = doc.querySelectorAll('section')
         for (const section of sections) {
            const heading = section.querySelector('h2, h3, h4')
            const headingText = heading?.text?.trim()

            // Skip certain sections
            if (headingText && ['References', 'External links', 'See also', 'Notes', 'Further reading'].includes(headingText)) {
               continue
            }

            if (headingText) {
               const level = heading?.tagName === 'H2' ? '##' : '###'
               md += `${level} ${headingText}\n\n`
            }

            const paragraphs = section.querySelectorAll('p')
            for (const p of paragraphs) {
               const text = p.text?.trim()
               if (text && text.length > 20) {
                  md += `${text}\n\n`
               }
            }
         }
      }

      if (!md) return null

      const output = finalizeOutput(md)
      return {
         url,
         finalUrl: url,
         contentType: 'text/markdown',
         method: 'wikipedia',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes: ['Fetched via Wikipedia API'],
      }
   } catch {}

   return null
}

// =============================================================================
// Reddit Special Handling
// =============================================================================

interface RedditPost {
   title: string
   selftext: string
   author: string
   score: number
   num_comments: number
   created_utc: number
   subreddit: string
   url: string
   is_self: boolean
}

interface RedditComment {
   body: string
   author: string
   score: number
   created_utc: number
   replies?: { data: { children: Array<{ data: RedditComment }> } }
}

/**
 * Handle Reddit URLs via JSON API
 */
async function handleReddit(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      if (!parsed.hostname.includes('reddit.com')) return null

      const fetchedAt = new Date().toISOString()

      // Append .json to get JSON response
      let jsonUrl = url.replace(/\/$/, '') + '.json'
      if (parsed.search) {
         jsonUrl = url.replace(/\/$/, '').replace(parsed.search, '') + '.json' + parsed.search
      }

      const result = await loadPage(jsonUrl, { timeout })
      if (!result.ok) return null

      const data = JSON.parse(result.content)
      let md = ''

      // Handle different Reddit URL types
      if (Array.isArray(data) && data.length >= 1) {
         // Post page (with comments)
         const postData = data[0]?.data?.children?.[0]?.data as RedditPost | undefined
         if (postData) {
            md = `# ${postData.title}\n\n`
            md += `**r/${postData.subreddit}** · u/${postData.author} · ${postData.score} points · ${postData.num_comments} comments\n`
            md += `*${new Date(postData.created_utc * 1000).toISOString().split('T')[0]}*\n\n`

            if (postData.is_self && postData.selftext) {
               md += `---\n\n${postData.selftext}\n\n`
            } else if (!postData.is_self) {
               md += `**Link:** ${postData.url}\n\n`
            }

            // Add comments if available
            if (data.length >= 2 && data[1]?.data?.children) {
               md += `---\n\n## Top Comments\n\n`
               const comments = data[1].data.children
                  .filter((c: { kind: string }) => c.kind === 't1')
                  .slice(0, 10)

               for (const { data: comment } of comments as Array<{ data: RedditComment }>) {
                  md += `### u/${comment.author} · ${comment.score} points\n\n`
                  md += `${comment.body}\n\n---\n\n`
               }
            }
         }
      } else if (data?.data?.children) {
         // Subreddit or listing page
         const posts = data.data.children.slice(0, 20) as Array<{ data: RedditPost }>
         const subreddit = posts[0]?.data?.subreddit

         md = `# r/${subreddit || 'Reddit'}\n\n`
         for (const { data: post } of posts) {
            md += `- **${post.title}** (${post.score} pts, ${post.num_comments} comments)\n`
            md += `  by u/${post.author}\n\n`
         }
      }

      if (!md) return null

      const output = finalizeOutput(md)
      return {
         url,
         finalUrl: url,
         contentType: 'text/markdown',
         method: 'reddit',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes: ['Fetched via Reddit JSON API'],
      }
   } catch {}

   return null
}

// =============================================================================
// NPM Special Handling
// =============================================================================

interface NpmPackage {
   name: string
   description?: string
   'dist-tags': { latest: string }
   versions: Record<string, {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
   }>
   readme?: string
   homepage?: string
   repository?: { url: string }
   license?: string
   keywords?: string[]
   maintainers?: Array<{ name: string }>
}

/**
 * Handle NPM URLs via registry API
 */
async function handleNpm(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      if (parsed.hostname !== 'www.npmjs.com' && parsed.hostname !== 'npmjs.com') return null

      // Extract package name from /package/[scope/]name
      const match = parsed.pathname.match(/^\/package\/(.+?)(?:\/|$)/)
      if (!match) return null

      let packageName = decodeURIComponent(match[1])
      // Handle scoped packages: /package/@scope/name
      if (packageName.startsWith('@')) {
         const scopeMatch = parsed.pathname.match(/^\/package\/(@[^/]+\/[^/]+)/)
         if (scopeMatch) packageName = decodeURIComponent(scopeMatch[1])
      }

      const fetchedAt = new Date().toISOString()

      // Fetch from npm registry - use /latest endpoint for smaller response
      const latestUrl = `https://registry.npmjs.org/${packageName}/latest`
      const result = await loadPage(latestUrl, { timeout })

      if (!result.ok) return null

      let pkg: {
         name: string
         version: string
         description?: string
         license?: string
         homepage?: string
         repository?: { url: string } | string
         keywords?: string[]
         maintainers?: Array<{ name: string }>
         dependencies?: Record<string, string>
         readme?: string
      }

      try {
         pkg = JSON.parse(result.content)
      } catch {
         return null // JSON parse failed (truncated response)
      }

      let md = `# ${pkg.name}\n\n`
      if (pkg.description) md += `${pkg.description}\n\n`

      md += `**Latest:** ${pkg.version || 'unknown'}`
      if (pkg.license) md += ` · **License:** ${typeof pkg.license === 'string' ? pkg.license : pkg.license}`
      md += '\n\n'

      if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`
      const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      if (repoUrl) md += `**Repository:** ${repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')}\n`
      if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(', ')}\n`
      if (pkg.maintainers?.length) md += `**Maintainers:** ${pkg.maintainers.map(m => m.name).join(', ')}\n`

      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
         md += `\n## Dependencies\n\n`
         for (const [dep, version] of Object.entries(pkg.dependencies)) {
            md += `- ${dep}: ${version}\n`
         }
      }

      if (pkg.readme) {
         md += `\n---\n\n## README\n\n${pkg.readme}\n`
      }

      const output = finalizeOutput(md)
      return {
         url,
         finalUrl: url,
         contentType: 'text/markdown',
         method: 'npm',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes: ['Fetched via npm registry'],
      }
   } catch {}

   return null
}

// =============================================================================
// arXiv Special Handling
// =============================================================================

/**
 * Handle arXiv URLs - fetch abstract + optionally PDF
 */
async function handleArxiv(url: string, timeout: number): Promise<RenderResult | null> {
   try {
      const parsed = new URL(url)
      if (parsed.hostname !== 'arxiv.org') return null

      // Extract paper ID from various URL formats
      // /abs/1234.56789, /pdf/1234.56789, /abs/cs/0123456
      const match = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/)
      if (!match) return null

      const paperId = match[2]
      const fetchedAt = new Date().toISOString()
      const notes: string[] = []

      // Fetch metadata via arXiv API
      const apiUrl = `https://export.arxiv.org/api/query?id_list=${paperId}`
      const result = await loadPage(apiUrl, { timeout })

      if (!result.ok) return null

      // Parse the Atom feed response
      const doc = parseHtml(result.content, { parseNoneClosedTags: true })
      const entry = doc.querySelector('entry')

      if (!entry) return null

      const title = entry.querySelector('title')?.text?.trim()?.replace(/\s+/g, ' ')
      const summary = entry.querySelector('summary')?.text?.trim()
      const authors = entry.querySelectorAll('author name').map(n => n.text?.trim()).filter(Boolean)
      const published = entry.querySelector('published')?.text?.trim()?.split('T')[0]
      const categories = entry.querySelectorAll('category').map(c => c.getAttribute('term')).filter(Boolean)
      const pdfLink = entry.querySelector('link[title="pdf"]')?.getAttribute('href')

      let md = `# ${title || 'arXiv Paper'}\n\n`
      if (authors.length) md += `**Authors:** ${authors.join(', ')}\n`
      if (published) md += `**Published:** ${published}\n`
      if (categories.length) md += `**Categories:** ${categories.join(', ')}\n`
      md += `**arXiv:** ${paperId}\n\n`
      md += `---\n\n## Abstract\n\n${summary || 'No abstract available.'}\n\n`

      // If it was a PDF link or we want full content, try to fetch and convert PDF
      if (match[1] === 'pdf' || parsed.pathname.includes('.pdf')) {
         if (pdfLink) {
            notes.push('Fetching PDF for full content...')
            const pdfResult = await fetchBinary(pdfLink, timeout)
            if (pdfResult.ok) {
               const converted = convertWithMarkitdown(pdfResult.buffer, '.pdf', timeout)
               if (converted.ok && converted.content.length > 500) {
                  md += `---\n\n## Full Paper\n\n${converted.content}\n`
                  notes.push('PDF converted via markitdown')
               }
            }
         }
      }

      const output = finalizeOutput(md)
      return {
         url,
         finalUrl: url,
         contentType: 'text/markdown',
         method: 'arxiv',
         content: output.content,
         fetchedAt,
         truncated: output.truncated,
         notes: notes.length ? notes : ['Fetched via arXiv API'],
      }
   } catch {}

   return null
}

// =============================================================================
// Unified Special Handler Dispatch
// =============================================================================

/**
 * Try all special handlers
 */
async function handleSpecialUrls(url: string, timeout: number): Promise<RenderResult | null> {
   // Order matters - more specific first
   return (
      (await handleGitHub(url, timeout)) ||
      (await handleTwitter(url, timeout)) ||
      (await handleStackOverflow(url, timeout)) ||
      (await handleWikipedia(url, timeout)) ||
      (await handleReddit(url, timeout)) ||
      (await handleNpm(url, timeout)) ||
      (await handleArxiv(url, timeout))
   )
}

/**
 * Main render function implementing the full pipeline
 */
async function renderUrl(url: string, timeout: number): Promise<RenderResult> {
   const notes: string[] = []
   const fetchedAt = new Date().toISOString()

   // Step 0: Try special handlers for known sites
   const specialResult = await handleSpecialUrls(url, timeout)
   if (specialResult) return specialResult

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
