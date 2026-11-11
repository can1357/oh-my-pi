/**
 * Client for claude.ai Artifacts — the private-by-default pages Claude Code
 * publishes — over the frame API on `api.anthropic.com`, authenticated with an
 * Anthropic OAuth (claude.ai subscription) access token.
 */

import { getClaudeCodeUserAgent, getClaudeCodeVersion } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { FetchImpl } from "../blob-broker/uploader-runtime";

const FRAME_API = "https://api.anthropic.com/api/frame";
const OAUTH_BETA = "oauth-2025-04-20";

/** Non-secret identity of the Anthropic account (and organization) an artifact belongs to. */
export interface ClaudeAccount {
	accountId?: string;
	orgId?: string;
	email?: string;
}

/** An access token and the account it authenticates. */
export interface ClaudeAccess {
	token: string;
	account: ClaudeAccount;
}

/**
 * Resolves Anthropic OAuth access: the session's account without `owner`,
 * otherwise exactly `owner`. `undefined` when that login is not available.
 */
export type ClaudeAccessResolver = (owner?: ClaudeAccount) => Promise<ClaudeAccess | undefined>;

/** A published artifact revision. */
export interface ClaudeDeployment {
	slug: string;
	/** Live version id; the base for the next publish. */
	version: string;
	/** Account that owns the artifact. */
	owner: ClaudeAccount;
}

/** Shareable claude.ai URL of an artifact. */
export function claudeArtifactUrl(slug: string): string {
	return `https://claude.ai/code/artifact/${slug}`;
}

export class ClaudeArtifactsClient {
	#access: ClaudeAccessResolver;
	#fetch: FetchImpl;

	constructor(access: ClaudeAccessResolver, fetchFn: FetchImpl = globalThis.fetch) {
		this.#access = access;
		this.#fetch = fetchFn;
	}

	async #request(
		owner: ClaudeAccount | undefined,
		signal: AbortSignal | undefined,
		method: string,
		route: string,
		body?: unknown,
	): Promise<{ response: Response; account: ClaudeAccount }> {
		const access = await this.#access(owner);
		if (!access) {
			throw new Error(
				owner
					? `The Anthropic account that owns this artifact${owner.email ? ` (${owner.email})` : ""} is not logged in`
					: "claude.ai artifacts need an Anthropic OAuth login; log in to Anthropic with /login",
			);
		}
		const response = await this.#fetch(`${FRAME_API}${route}`, {
			method,
			redirect: "manual",
			signal,
			headers: {
				Authorization: `Bearer ${access.token}`,
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
		return { response, account: access.account };
	}

	/**
	 * Create an artifact (no `slug`) or publish the next version of one.
	 * `baseVersion` must name the live version; when someone else published
	 * since, the call fails unless `force` adopts their version as the base.
	 */
	async deploy(options: {
		slug?: string;
		owner?: ClaudeAccount;
		baseVersion?: string;
		title: string;
		content: string;
		force?: boolean;
		signal?: AbortSignal;
	}): Promise<ClaudeDeployment> {
		const body = {
			...(options.slug ? { slug: options.slug } : {}),
			...(options.baseVersion ? { baseVersion: options.baseVersion } : {}),
			title: options.title,
			content: options.content,
		};
		let { response, account } = await this.#request(options.owner, options.signal, "POST", "/deploy/direct", body);
		if (response.status === 409 && options.slug) {
			const conflict = (await response.json().catch(() => ({}))) as { live?: unknown };
			const live = typeof conflict.live === "string" ? conflict.live : undefined;
			if (!options.force || !live) {
				throw new Error(
					`The artifact changed on claude.ai since omp last published it${live ? ` (live version ${live})` : ""}; publish with force to overwrite that version`,
				);
			}
			({ response, account } = await this.#request(account, options.signal, "POST", "/deploy/direct", {
				...body,
				baseVersion: live,
			}));
		}
		if (!response.ok) throw await failure("publish", response);
		const result = (await response.json()) as { slug?: unknown; version?: unknown };
		if (typeof result.slug !== "string" || typeof result.version !== "string") {
			throw new Error("claude.ai publish returned no artifact slug or version");
		}
		return { slug: result.slug, version: result.version, owner: account };
	}

	/** Delete an artifact. The API answers 204 for an already deleted one, so 404 is a failure. */
	async remove(slug: string, owner: ClaudeAccount | undefined, signal?: AbortSignal): Promise<void> {
		const { response } = await this.#request(owner, signal, "DELETE", `/${encodeURIComponent(slug)}`);
		if (!response.ok) throw await failure("delete", response);
		await response.body?.cancel();
	}

	/** Pin to or unpin from the owner's claude.ai sidebar. */
	async setPinned(
		slug: string,
		owner: ClaudeAccount | undefined,
		pinned: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		const { response } = await this.#request(
			owner,
			signal,
			pinned ? "POST" : "DELETE",
			`/favorite/${encodeURIComponent(slug)}`,
		);
		if (!response.ok) throw await failure(pinned ? "pin" : "unpin", response);
		await response.body?.cancel();
	}
}

async function failure(operation: string, response: Response): Promise<Error> {
	const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
	return new Error(`claude.ai ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}
