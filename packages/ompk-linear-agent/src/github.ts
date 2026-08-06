import { timingSafeEqual } from "./linear";
import type { Env, GitHubJobTarget } from "./types";

const GITHUB_API = "https://api.github.com";
const JSON_HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	// GitHub rejects requests without a User-Agent; Workers fetch sends none.
	"User-Agent": "pk-ompk-github-worker",
};
const GITHUB_JWT_TTL_SECONDS = 9 * 60;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeJson(value: unknown): string {
	return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(pem: string): ArrayBuffer {
	const normalized = pem.replaceAll("\\n", "\n").trim();
	if (!normalized.includes("BEGIN PRIVATE KEY") || !normalized.includes("END PRIVATE KEY")) {
		throw new Error("GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM private key");
	}
	const encoded = normalized.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const binary = atob(encoded);
	const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
	return bytes.buffer;
}

/** Verify the raw GitHub webhook body before parsing or dispatching it. */
export async function verifyGitHubSignature(
	rawBody: string,
	header: string | null,
	secret: string | undefined,
): Promise<boolean> {
	const configured = secret?.trim() ?? "";
	if (!configured || !header?.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(configured),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const expected = `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
	return timingSafeEqual(expected, header);
}

/** Create the short-lived JWT GitHub requires for App API calls. */
export async function createGitHubAppJwt(appId: string, privateKey: string, now = Date.now()): Promise<string> {
	const header = encodeJson({ alg: "RS256", typ: "JWT" });
	const issuedAt = Math.floor(now / 1000) - 60;
	const payload = encodeJson({ iss: appId, iat: issuedAt, exp: issuedAt + GITHUB_JWT_TTL_SECONDS });
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemBytes(privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export interface GitHubInstallationToken {
	token: string;
	expiresAt: string;
}

export async function createInstallationToken(
	appId: string,
	privateKey: string,
	installationId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<GitHubInstallationToken> {
	const jwt = await createGitHubAppJwt(appId, privateKey);
	const response = await fetchImpl(
		`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
		{
			method: "POST",
			headers: { ...JSON_HEADERS, Authorization: `Bearer ${jwt}` },
		},
	);
	if (!response.ok) throw new Error(`GitHub installation token request failed: ${response.status}`);
	const body = (await response.json()) as { token?: string; expires_at?: string };
	if (!body.token || !body.expires_at) throw new Error("GitHub installation token response was incomplete");
	return { token: body.token, expiresAt: body.expires_at };
}

export async function createConfiguredInstallationToken(
	env: Env,
	installationId: string,
): Promise<GitHubInstallationToken> {
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("GitHub App credentials are not configured");
	return createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId);
}

async function githubApi<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${GITHUB_API}${path}`, {
		...init,
		headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}`, ...init.headers },
	});
	if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`);
	return (await response.json()) as T;
}

interface RepositoryIssueResponse {
	number?: number;
	title?: string;
	body?: string | null;
	html_url?: string;
	pull_request?: { url?: string };
}

interface PullRequestResponse {
	title?: string;
	body?: string | null;
	html_url?: string;
	base?: { ref?: string; repo?: { full_name?: string } };
	head?: { ref?: string; repo?: { full_name?: string } };
}

export interface GitHubWorkItem {
	target: GitHubJobTarget;
	title: string;
	body: string;
}

export async function fetchGitHubWorkItem(
	token: string,
	owner: string,
	repo: string,
	number: number,
	installationId: string,
	defaultBranch: string,
): Promise<GitHubWorkItem> {
	const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const issue = await githubApi<RepositoryIssueResponse>(token, `/repos/${encodedRepo}/issues/${number}`);
	const pull = issue.pull_request
		? await githubApi<PullRequestResponse>(token, `/repos/${encodedRepo}/pulls/${number}`)
		: undefined;
	const target: GitHubJobTarget = {
		owner,
		repo,
		number,
		installationId,
		defaultBranch: pull?.base?.ref ?? defaultBranch,
		...(pull?.head?.ref ? { headRef: pull.head.ref } : {}),
		...(pull?.head?.repo?.full_name ? { headRepo: pull.head.repo.full_name } : {}),
		isPullRequest: Boolean(pull),
		htmlUrl: pull?.html_url ?? issue.html_url,
	};
	return { target, title: pull?.title ?? issue.title ?? `GitHub #${number}`, body: pull?.body ?? issue.body ?? "" };
}

export async function postGitHubComment(
	token: string,
	owner: string,
	repo: string,
	number: number,
	body: string,
): Promise<void> {
	const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	await githubApi(token, `/repos/${encodedRepo}/issues/${number}/comments`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
}

export async function getGitHubCollaboratorPermission(
	token: string,
	owner: string,
	repo: string,
	login: string,
): Promise<string | null> {
	const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const body = await githubApi<{ permission?: string }>(
		token,
		`/repos/${encodedRepo}/collaborators/${encodeURIComponent(login)}/permission`,
	);
	return body.permission ?? null;
}
