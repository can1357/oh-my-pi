import {
	DEFAULT_SKILLS_URL,
	SKILL_HEADERS,
	SKILL_NAME_MAX,
	SKILL_SPEC_RE,
	SKILLS_ROUTES,
	SKILLS_TOKEN_ENV,
	type SkillHome,
	type SkillPackument,
	type SkillPublishResponse,
	type SkillReportedProvenance,
	type SkillSearchResponse,
	type SkillSearchSort,
	type SkillToken,
	type SkillTokenCreated,
	type SkillVersionManifest,
} from "@oh-my-pi/pi-wire/skillshare";
import { Settings } from "../config/settings";
import { StencilCredential } from "../stencil/credential";

import { cfgSkillsRegistryUrl } from "../extensibility/settings";

/** A registry failure: HTTP status plus the server's `{error}` message (or a local auth failure as 401). */
export class SkillshareError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "SkillshareError";
		this.status = status;
	}
}

export interface SkillSpec {
	scope: string;
	name: string;
	/** Exact version, semver range, or dist-tag; absent when the spec has no `@…` suffix. */
	range?: string;
}

/** Parse `@scope/name[@range]`; null when the spec is not a registry package id. */
export function parseSkillSpec(spec: string): SkillSpec | null {
	const match = SKILL_SPEC_RE.exec(spec.trim());
	if (!match) return null;
	const [, scope, name, range] = match;
	if (name.length > SKILL_NAME_MAX) return null;
	return range === undefined ? { scope, name } : { scope, name, range };
}

export interface SkillshareClientOptions {
	/** Registry base URL; defaults to the `skills.registryUrl` setting, then {@link DEFAULT_SKILLS_URL}. */
	registryUrl?: string;
	/** Mutations may authenticate with a `SKILLS_TOKEN` publish token instead of the Stencil login. */
	forPublish?: boolean;
}

export interface PublishOptions {
	/** Dist-tag to point at the new version (server default: `latest` for stable, none for prereleases). */
	tag?: string;
	provenance?: SkillReportedProvenance;
	/** GitHub Actions OIDC token requested with audience `SKILLS_OIDC_AUDIENCE`. */
	githubOidc?: string;
}

export interface CreateTokenRequest {
	name: string;
	/** `@scope/name` packages the token may publish; omitted = every package the creator manages. */
	packages?: string[];
	expiresInDays?: number;
}

interface RequestOptions {
	auth?: boolean;
	json?: unknown;
	body?: Uint8Array;
	contentType?: string;
	headers?: Record<string, string>;
	query?: Record<string, string>;
}

function normalizeRegistryUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`invalid skill registry URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`skill registry URL must use http or https: ${raw}`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** HTTP client for a Skillshare registry (`skills.omp.sh`). */
export class SkillshareClient {
	/** Normalized registry base URL (no trailing slash). */
	readonly registryUrl: string;
	#forPublish: boolean;
	#credential = new StencilCredential();

	private constructor(registryUrl: string, forPublish: boolean) {
		this.registryUrl = registryUrl;
		this.#forPublish = forPublish;
	}

	static async create(options: SkillshareClientOptions = {}): Promise<SkillshareClient> {
		let registryUrl = options.registryUrl;
		if (!registryUrl) {
			const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
			registryUrl = cfgSkillsRegistryUrl.get(settings) || DEFAULT_SKILLS_URL;
		}
		return new SkillshareClient(normalizeRegistryUrl(registryUrl), options.forPublish === true);
	}

	/**
	 * The bearer mutations send: `SKILLS_TOKEN` when publishing and set, else
	 * the Stencil credential. Null when neither is available.
	 */
	async authToken(): Promise<string | null> {
		if (this.#forPublish) {
			const publishToken = process.env[SKILLS_TOKEN_ENV]?.trim();
			if (publishToken) return publishToken;
		}
		return this.#credential.resolve();
	}

	home(): Promise<SkillHome> {
		return this.#json<SkillHome>("GET", SKILLS_ROUTES.home);
	}

	search(query: string, options: { sort?: SkillSearchSort; page?: number } = {}): Promise<SkillSearchResponse> {
		const params: Record<string, string> = { q: query };
		if (options.sort) params.sort = options.sort;
		if (options.page !== undefined) params.page = String(options.page);
		return this.#json<SkillSearchResponse>("GET", SKILLS_ROUTES.search, { query: params });
	}

	packument(scope: string, name: string): Promise<SkillPackument> {
		return this.#json<SkillPackument>("GET", SKILLS_ROUTES.packument(scope, name));
	}

	version(scope: string, name: string, versionOrTag: string): Promise<SkillVersionManifest> {
		return this.#json<SkillVersionManifest>(
			"GET",
			SKILLS_ROUTES.version(scope, name, encodeURIComponent(versionOrTag)),
		);
	}

	/** Download the `.tgz`, following the 302 to storage. Integrity is the installer's job. */
	async tarball(scope: string, name: string, version: string): Promise<Uint8Array> {
		const response = await this.#fetch("GET", SKILLS_ROUTES.tarball(scope, name, encodeURIComponent(version)), {});
		return new Uint8Array(await response.arrayBuffer());
	}

	publish(
		scope: string,
		name: string,
		version: string,
		tgz: Uint8Array,
		options: PublishOptions = {},
	): Promise<SkillPublishResponse> {
		const headers: Record<string, string> = {
			[SKILL_HEADERS.integrity]: `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}`,
		};
		if (options.tag) headers[SKILL_HEADERS.tag] = options.tag;
		if (options.provenance) {
			headers[SKILL_HEADERS.provenance] = Buffer.from(JSON.stringify(options.provenance)).toString("base64");
		}
		if (options.githubOidc) headers[SKILL_HEADERS.githubOidc] = options.githubOidc;
		return this.#json<SkillPublishResponse>("PUT", SKILLS_ROUTES.publish(scope, name, encodeURIComponent(version)), {
			auth: true,
			body: tgz,
			contentType: "application/gzip",
			headers,
		});
	}

	async setTag(scope: string, name: string, tag: string, version: string): Promise<void> {
		await this.#fetch("PUT", SKILLS_ROUTES.tag(scope, name, encodeURIComponent(tag)), {
			auth: true,
			json: { version },
		});
	}

	async removeTag(scope: string, name: string, tag: string): Promise<void> {
		await this.#fetch("DELETE", SKILLS_ROUTES.tag(scope, name, encodeURIComponent(tag)), { auth: true });
	}

	async yank(scope: string, name: string, version: string, yanked: boolean): Promise<void> {
		await this.#fetch("POST", SKILLS_ROUTES.yank(scope, name, encodeURIComponent(version)), {
			auth: true,
			json: { yanked },
		});
	}

	/** Set (string) or clear (null) the deprecation message of one version. */
	async deprecate(scope: string, name: string, version: string, message: string | null): Promise<void> {
		await this.#fetch("POST", SKILLS_ROUTES.deprecate(scope, name, encodeURIComponent(version)), {
			auth: true,
			json: { message },
		});
	}

	async addOwner(scope: string, name: string, username: string): Promise<void> {
		await this.#fetch("PUT", SKILLS_ROUTES.owner(scope, name, encodeURIComponent(username)), { auth: true });
	}

	async removeOwner(scope: string, name: string, username: string): Promise<void> {
		await this.#fetch("DELETE", SKILLS_ROUTES.owner(scope, name, encodeURIComponent(username)), { auth: true });
	}

	createToken(request: CreateTokenRequest): Promise<SkillTokenCreated> {
		return this.#json<SkillTokenCreated>("POST", SKILLS_ROUTES.tokens, { auth: true, json: request });
	}

	listTokens(): Promise<SkillToken[]> {
		return this.#json<SkillToken[]>("GET", SKILLS_ROUTES.tokens, { auth: true });
	}

	async revokeToken(id: string): Promise<void> {
		await this.#fetch("DELETE", SKILLS_ROUTES.token(encodeURIComponent(id)), { auth: true });
	}

	/** Upload a Claude `.skill` zip; the server converts and publishes it. */
	importSkill(zip: Uint8Array): Promise<SkillPublishResponse> {
		return this.#json<SkillPublishResponse>("POST", SKILLS_ROUTES.importSkill, {
			auth: true,
			body: zip,
			contentType: "application/zip",
		});
	}

	close(): void {
		this.#credential.close();
	}

	async #json<T>(method: string, route: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.#fetch(method, route, options);
		try {
			return (await response.json()) as T;
		} catch {
			throw new SkillshareError(response.status, `unexpected non-JSON response from ${this.registryUrl}`);
		}
	}

	async #fetch(method: string, route: string, options: RequestOptions): Promise<Response> {
		const url = new URL(`${this.registryUrl}${route}`);
		if (options.query) {
			for (const key in options.query) url.searchParams.set(key, options.query[key]);
		}
		const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
		if (options.auth) {
			const token = await this.authToken();
			if (!token) {
				const hint = this.#forPublish ? `, or set ${SKILLS_TOKEN_ENV} to a registry publish token` : "";
				throw new SkillshareError(401, `${StencilCredential.missingMessage}${hint}`);
			}
			headers.Authorization = `Bearer ${token}`;
		}
		let body: Uint8Array | string | undefined;
		if (options.json !== undefined) {
			body = JSON.stringify(options.json);
			headers["Content-Type"] = "application/json";
		} else if (options.body) {
			body = options.body;
			if (options.contentType) headers["Content-Type"] = options.contentType;
		}

		let response: Response;
		try {
			response = await fetch(url, { method, headers, body, redirect: "follow" });
		} catch (error) {
			throw new Error(
				`cannot reach skill registry ${this.registryUrl}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			const payload: unknown = await response.json().catch(() => null);
			const reason =
				payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
					? payload.error
					: `${response.status} ${response.statusText || "request failed"}`;
			throw new SkillshareError(response.status, reason);
		}
		return response;
	}
}
