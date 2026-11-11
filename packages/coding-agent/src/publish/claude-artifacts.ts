/**
 * Client for claude.ai Artifacts — the private-by-default pages Claude Code
 * publishes — over the frame API on `api.anthropic.com`, authenticated with an
 * Anthropic OAuth (claude.ai subscription) access token.
 */

import { getClaudeCodeUserAgent, getClaudeCodeVersion } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { FetchImpl } from "../blob-broker/uploader-runtime";

const FRAME_API = "https://api.anthropic.com/api/frame";
const OAUTH_BETA = "oauth-2025-04-20";

/** Resolves the Anthropic OAuth access token; `undefined` when not logged in. */
export type ClaudeTokenResolver = () => Promise<string | undefined>;

/** A published artifact revision. */
export interface ClaudeDeployment {
	slug: string;
	/** Live version id; the base for the next publish. */
	version: string;
}

/** Shareable claude.ai URL of an artifact. */
export function claudeArtifactUrl(slug: string): string {
	return `https://claude.ai/code/artifact/${slug}`;
}

export class ClaudeArtifactsClient {
	#token: ClaudeTokenResolver;
	#fetch: FetchImpl;

	constructor(token: ClaudeTokenResolver, fetchFn: FetchImpl = globalThis.fetch) {
		this.#token = token;
		this.#fetch = fetchFn;
	}

	async #request(method: string, route: string, body?: unknown): Promise<Response> {
		const token = await this.#token();
		if (!token) throw new Error("claude.ai artifacts need an Anthropic OAuth login; log in to Anthropic with /login");
		return this.#fetch(`${FRAME_API}${route}`, {
			method,
			redirect: "manual",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": OAUTH_BETA,
				"User-Agent": getClaudeCodeUserAgent(),
				"X-Frame-CP": "go",
				"X-Frame-Surface": "code",
				"X-Frame-Platform": "cli",
				"X-Frame-Client-Version": getClaudeCodeVersion(),
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}

	/**
	 * Create an artifact (no `slug`) or publish the next version of one.
	 * `baseVersion` must name the live version; when someone else published
	 * since, the call fails unless `force` adopts their version as the base.
	 */
	async deploy(options: {
		slug?: string;
		baseVersion?: string;
		title: string;
		content: string;
		force?: boolean;
	}): Promise<ClaudeDeployment> {
		const body = {
			...(options.slug ? { slug: options.slug } : {}),
			...(options.baseVersion ? { baseVersion: options.baseVersion } : {}),
			title: options.title,
			content: options.content,
		};
		let response = await this.#request("POST", "/deploy/direct", body);
		if (response.status === 409 && options.slug) {
			const conflict = (await response.json().catch(() => ({}))) as { live?: unknown };
			const live = typeof conflict.live === "string" ? conflict.live : undefined;
			if (!options.force || !live) {
				throw new Error(
					`The artifact changed on claude.ai since omp last published it${live ? ` (live version ${live})` : ""}; publish with force to overwrite that version`,
				);
			}
			response = await this.#request("POST", "/deploy/direct", { ...body, baseVersion: live });
		}
		if (!response.ok) throw await failure("publish", response);
		const result = (await response.json()) as { slug?: unknown; version?: unknown };
		if (typeof result.slug !== "string" || typeof result.version !== "string") {
			throw new Error("claude.ai publish returned no artifact slug or version");
		}
		return { slug: result.slug, version: result.version };
	}

	/** Delete an artifact; deleting an already deleted one succeeds. */
	async remove(slug: string): Promise<void> {
		const response = await this.#request("DELETE", `/${encodeURIComponent(slug)}`);
		if (!response.ok && response.status !== 404) throw await failure("delete", response);
		await response.body?.cancel();
	}

	/** Pin to or unpin from the user's claude.ai sidebar. */
	async setPinned(slug: string, pinned: boolean): Promise<void> {
		const response = await this.#request(pinned ? "POST" : "DELETE", `/favorite/${encodeURIComponent(slug)}`);
		if (!response.ok) throw await failure(pinned ? "pin" : "unpin", response);
		await response.body?.cancel();
	}
}

async function failure(operation: string, response: Response): Promise<Error> {
	const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
	return new Error(`claude.ai ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}
