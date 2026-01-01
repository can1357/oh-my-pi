const MAX_BYTES = 32 * 1024 * 1024 // 32MB

const USER_AGENTS = [
   'Mozilla/5.0 (compatible; TextBot/1.0)',
   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

interface LoadPageResult {
   content: string
   contentType: string
   finalUrl: string
   ok: boolean
   status?: number
}

interface LoadPageOptions {
   timeout?: number
   headers?: Record<string, string>
   maxBytes?: number
}

/**
 * Check if response indicates bot blocking (Cloudflare, etc.)
 */
function isBotBlocked(status: number, content: string): boolean {
   if (status === 403 || status === 503) {
      const lower = content.toLowerCase()
      return (
         lower.includes('cloudflare') ||
         lower.includes('captcha') ||
         lower.includes('challenge') ||
         lower.includes('blocked') ||
         lower.includes('access denied') ||
         lower.includes('bot detection')
      )
   }
   return false
}

/**
 * Fetch a page with timeout, size limit, and automatic retry with browser UA if blocked
 */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
   const { timeout = 20, headers = {}, maxBytes = MAX_BYTES } = options

   for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
      const userAgent = USER_AGENTS[attempt]

      try {
         const controller = new AbortController()
         const timeoutId = setTimeout(() => controller.abort(), timeout * 1000)

         const response = await fetch(url, {
            signal: controller.signal,
            headers: {
               'User-Agent': userAgent,
               ...headers,
            },
            redirect: 'follow',
         })

         clearTimeout(timeoutId)

         const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
         const finalUrl = response.url

         // Read with size limit
         const reader = response.body?.getReader()
         if (!reader) {
            return { content: '', contentType, finalUrl, ok: false, status: response.status }
         }

         const chunks: Uint8Array[] = []
         let totalSize = 0

         while (true) {
            const { done, value } = await reader.read()
            if (done) break

            chunks.push(value)
            totalSize += value.length

            if (totalSize > maxBytes) {
               reader.cancel()
               break
            }
         }

         const decoder = new TextDecoder()
         const content = decoder.decode(Buffer.concat(chunks))

         // Check if we got blocked and should retry with browser UA
         if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
            continue
         }

         if (!response.ok) {
            return { content, contentType, finalUrl, ok: false, status: response.status }
         }

         return { content, contentType, finalUrl, ok: true, status: response.status }
      } catch (_err) {
         // On last attempt, return failure
         if (attempt === USER_AGENTS.length - 1) {
            return { content: '', contentType: '', finalUrl: url, ok: false }
         }
         // Otherwise retry with next UA
      }
   }

   return { content: '', contentType: '', finalUrl: url, ok: false }
}
