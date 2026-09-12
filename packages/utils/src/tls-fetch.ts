/**
 * `NODE_EXTRA_CA_CERTS` shim for Bun's `fetch`.
 *
 * Node's TLS layer honours `NODE_EXTRA_CA_CERTS` natively, but Bun's
 * `fetch` does not, and both the provider streams (`openai-responses`,
 * `openai-completions`, `openai-codex-responses`, `ollama-chat`, ...) and
 * catalog model discovery (`/models` probes) route every request through
 * Bun's runtime. Without this wrapper, corporate relays and private
 * gateways behind a custom CA bundle fail with
 * `unknown certificate verification error` even when the env var is set.
 *
 * The wrapper merges the resolved CA bundle into Bun's `RequestInit.tls.ca`.
 * Bun's `tls.ca` REPLACES the default trust store when set, so the wrapper
 * always seeds {@link tls.rootCertificates} when the caller has not already
 * curated their own CA list.
 */
import * as fs from "node:fs";
import * as tls from "node:tls";
import { $env } from "./env";
import { isEnoent } from "./fs-error";

/**
 * `fetch`-compatible function. Accepts any callable matching the standard
 * fetch signature; `preconnect` is optional because non-Bun runtimes
 * (browsers, test mocks) won't expose it.
 */
export type FetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
	preconnect?: typeof globalThis.fetch.preconnect;
};

/**
 * `NODE_EXTRA_CA_CERTS` was set but unusable (path does not exist). This is
 * a config/contract error, not a transient transport fault — it is never
 * retried.
 */
export class ExtraCaError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ExtraCaError";
	}
}

/** Bun extension to `RequestInit` for the TLS options we touch. */
type BunTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ciphers?: string;
};

type BunTlsRequestInit = RequestInit & { tls?: BunTlsOptions };

const EXTRA_CA_FETCH_MARKER = Symbol("omp.extraCaFetch");
type ExtraCaFetch = FetchImpl & { [EXTRA_CA_FETCH_MARKER]?: true };

/**
 * Cached resolution of `NODE_EXTRA_CA_CERTS`. Keyed on the env value plus
 * the file mtime for path values so on-disk cert rotation (short-lived
 * corporate bundles) invalidates the cache instead of pinning the first
 * read forever.
 */
let cacheKey: string | undefined;
let cacheValue: string | undefined;

/**
 * Returns the PEM bytes referenced by `NODE_EXTRA_CA_CERTS`, or `undefined`
 * when the env var is unset/empty.
 *
 * Accepts the same shapes Node accepts plus an inline-PEM escape hatch:
 * - Inline PEM (`-----BEGIN CERTIFICATE-----...`). Literal `\n` escapes in
 *   the env value are expanded so callers can ship single-line PEMs through
 *   shell exports.
 * - File path. Anything that does not contain a PEM header is treated as a
 *   path, matching Node's "extensionless filename is still a path" contract.
 *   `ENOENT` becomes {@link ExtraCaError}; other I/O errors bubble.
 */
export function resolveExtraCa(): string | undefined {
	const raw = $env.NODE_EXTRA_CA_CERTS?.trim();
	if (!raw) return undefined;

	let key: string;
	if (raw.includes("-----BEGIN")) {
		key = raw;
	} else {
		try {
			key = `${raw}@${fs.statSync(raw).mtimeMs}`;
		} catch {
			key = raw;
		}
	}
	if (key === cacheKey) return cacheValue;

	if (raw.includes("-----BEGIN")) {
		cacheValue = raw.replace(/\\n/g, "\n");
	} else {
		try {
			cacheValue = fs.readFileSync(raw, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new ExtraCaError(`NODE_EXTRA_CA_CERTS path does not exist: ${raw}`);
			}
			throw error;
		}
	}
	cacheKey = key;
	return cacheValue;
}

/** Test seam: drop the cached PEM so a follow-up call re-reads the env. */
export function __resetExtraCaCache(): void {
	cacheKey = undefined;
	cacheValue = undefined;
}

/**
 * Merge `extraCa` into `init.tls.ca`. When the caller has not supplied a CA
 * list, the system root store is included alongside the extra bundle —
 * Bun's `tls.ca` replaces the default trust store, so omitting roots would
 * break every public host. When the caller already curated a list (e.g.
 * Anthropic Foundry's mTLS options, which already seed
 * `tls.rootCertificates`), only the extra CA is appended.
 */
export function withExtraCaInit(init: RequestInit | undefined, extraCa: string): RequestInit {
	const existingTls = (init as BunTlsRequestInit | undefined)?.tls;
	const existingCa = existingTls?.ca;
	let mergedCa: string[];
	if (existingCa === undefined) {
		mergedCa = [...tls.rootCertificates, extraCa];
	} else if (Array.isArray(existingCa)) {
		mergedCa = [...existingCa, extraCa];
	} else {
		mergedCa = [existingCa, extraCa];
	}
	return { ...init, tls: { ...existingTls, ca: mergedCa } } as RequestInit;
}

/**
 * Wrap `fetchImpl` so every call honours `NODE_EXTRA_CA_CERTS`. Idempotent:
 * a fetch already wrapped is returned unchanged so repeated composition
 * (Anthropic auth-retry replays, request-debug fan-out) never stacks
 * wrappers. When the env var is unset the original fetch is returned, so
 * default deployments pay nothing.
 */
export function wrapFetchForExtraCa(fetchImpl: FetchImpl): FetchImpl {
	const maybeWrapped = fetchImpl as ExtraCaFetch;
	if (maybeWrapped[EXTRA_CA_FETCH_MARKER]) return fetchImpl;
	// Peek once at construction — if the env var is unset, skip the wrapper
	// entirely so the hot fetch path stays a single function call. The env
	// is evaluated again per request below to catch in-process updates from
	// tests (`__resetExtraCaCache` + env mutation).
	if (!$env.NODE_EXTRA_CA_CERTS?.trim()) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const extraCa = resolveExtraCa();
			return extraCa ? fetchImpl(input, withExtraCaInit(init, extraCa)) : fetchImpl(input, init);
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [EXTRA_CA_FETCH_MARKER]: true as const },
	);
	return wrapped;
}
