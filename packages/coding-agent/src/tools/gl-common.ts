import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { GlToolDetails } from "./details/gitlab";
import { ToolError } from "./tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import { gitlab } from "../utils/gitlab";
import { appendArtifactReference, parsePositiveDecimalInt, requireCurrentGitBranch } from "./gh-common";
import {
	assertGitlabHostTrustedForEnvToken,
	GITLAB_HOST_PATTERN,
	GITLAB_PATH_SEGMENT_PATTERN,
	resolveDefaultGitlabProjectMemoized,
} from "./glab-mr";
import type { GlMrApi, GlUserApi } from "./gl-types";
import { ToolAbortError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface GitlabProjectRef {
	host: string;
	path: string;
	full: string;
}

const DEFAULT_GITLAB_HOST_ENV_VARS = ["GITLAB_HOST", "GITLAB_URI", "GITLAB_URL", "GL_HOST"] as const;

export function encodeProjectPath(projectPath: string): string {
	return encodeURIComponent(projectPath);
}

export function formatGlUser(user: GlUserApi | null | undefined): string | undefined {
	if (!user) return undefined;
	if (user.username && user.name) return `${user.name} (@${user.username})`;
	if (user.username) return `@${user.username}`;
	return user.name || undefined;
}

export function formatGlUsers(users: readonly GlUserApi[] | undefined): string | undefined {
	if (!users || users.length === 0) return undefined;
	const formatted = users.map(formatGlUser).filter((value): value is string => Boolean(value));
	return formatted.length > 0 ? formatted.join(", ") : undefined;
}

export function formatGlLabels(labels: readonly string[] | undefined): string | undefined {
	if (!labels || labels.length === 0) return undefined;
	const cleaned = labels.map(label => label.trim()).filter(Boolean);
	return cleaned.length > 0 ? cleaned.join(", ") : undefined;
}

export async function defaultGitlabHost(cwd: string, signal?: AbortSignal): Promise<string> {
	for (const name of DEFAULT_GITLAB_HOST_ENV_VARS) {
		const value = process.env[name]?.trim();
		if (!value) continue;
		try {
			const parsed = new URL(value.includes("://") ? value : `https://${value}`);
			if (!parsed.username && !parsed.password && GITLAB_HOST_PATTERN.test(parsed.host)) {
				return parsed.host.toLowerCase();
			}
		} catch {
			logger.debug("gl: ignoring unparseable default host env var", { name, value });
		}
	}
	try {
		const ownProject = await resolveDefaultGitlabProjectMemoized(cwd, signal);
		const host = ownProject.split("/")[0];
		if (host) return host.toLowerCase();
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		logger.debug("gl: ignoring default project lookup while resolving default host", { err: String(err) });
	}
	return "gitlab.com";
}

function isHostSegment(segment: string): boolean {
	return segment.includes(".") || segment.includes(":") || segment === "localhost";
}

function parseGitlabNamespaceRef(
	raw: string,
	fallbackHost: string,
	minSegments: number,
	label: string,
): GitlabProjectRef {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new ToolError(`${label} must not be empty.`);
	}

	let host: string;
	let segments: string[];
	if (/^https?:\/\//i.test(trimmed)) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new ToolError(`Invalid GitLab ${label} URL: ${raw}`);
		}
		if (parsed.username || parsed.password || !GITLAB_HOST_PATTERN.test(parsed.host)) {
			throw new ToolError(`Invalid GitLab host in ${label}: ${raw}`);
		}
		host = parsed.host.toLowerCase();
		const cleanedPath = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
		segments = cleanedPath.split("/").filter(Boolean);
	} else {
		const cleaned = trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
		const parts = cleaned.split("/").filter(Boolean);
		if (parts.length >= minSegments + 1 && isHostSegment(parts[0]!)) {
			host = parts[0]!.toLowerCase();
			segments = parts.slice(1);
		} else {
			host = fallbackHost.toLowerCase();
			segments = parts;
		}
	}

	if (!GITLAB_HOST_PATTERN.test(host)) {
		throw new ToolError(`Invalid GitLab host: ${host}`);
	}
	if (segments.length < minSegments || !segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) {
		throw new ToolError(
			minSegments >= 2
				? `Invalid GitLab repository '${raw}'. Expected [<host>/]<group>/<project>.`
				: `Invalid GitLab group '${raw}'. Expected [<host>/]<group>.`,
		);
	}

	const groupOrProjectPath = segments.join("/");
	return { host, path: groupOrProjectPath, full: `${host}/${groupOrProjectPath}` };
}

export function hasExplicitGitlabHost(raw: string, minSegments: number = 2): boolean {
	const trimmed = raw.trim();
	if (/^https?:\/\//i.test(trimmed)) return true;
	const parts = trimmed
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	return parts.length >= minSegments + 1 && isHostSegment(parts[0]!);
}

export function parseGitlabProjectRef(raw: string, fallbackHost: string): GitlabProjectRef {
	return parseGitlabNamespaceRef(raw, fallbackHost, 2, "repository");
}

/** Parse a known host-qualified `<host>/<group…>/<project>` ref (supports single-label hosts). */
export function parseCanonicalGitlabProject(project: string): GitlabProjectRef {
	const cleaned = project
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "");
	const parts = cleaned.split("/").filter(Boolean);
	const host = parts[0]?.toLowerCase() ?? "";
	const segments = parts.slice(1);
	if (
		!GITLAB_HOST_PATTERN.test(host) ||
		segments.length < 2 ||
		!segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))
	) {
		throw new ToolError(`Invalid GitLab project reference '${project}'. Expected <host>/<group>/<project>.`);
	}
	const projectPath = segments.join("/");
	return { host, path: projectPath, full: `${host}/${projectPath}` };
}

/** Verify that any URL-derived project references agree and return the common one. */
export function requireConsistentUrlProject(projects: ReadonlyArray<string | undefined>): string | undefined {
	let resolved: GitlabProjectRef | undefined;
	for (const candidate of projects) {
		if (!candidate) continue;
		const parsed = parseCanonicalGitlabProject(candidate);
		if (resolved && resolved.full.toLowerCase() !== parsed.full.toLowerCase()) {
			throw new ToolError(`Conflicting GitLab project URLs: '${resolved.full}' does not match '${parsed.full}'.`);
		}
		resolved = parsed;
	}
	return resolved?.full;
}

export function parseGitlabGroupRef(raw: string, fallbackHost: string): GitlabProjectRef {
	return parseGitlabNamespaceRef(raw, fallbackHost, 1, "group");
}

export async function resolveGitlabProject(
	cwd: string,
	explicitRepo: string | undefined,
	urlProject: string | undefined,
	signal?: AbortSignal,
): Promise<GitlabProjectRef> {
	let ref: GitlabProjectRef;
	const urlRef = urlProject ? parseCanonicalGitlabProject(urlProject) : undefined;
	if (explicitRepo) {
		const fallbackHost = hasExplicitGitlabHost(explicitRepo) ? "gitlab.com" : await defaultGitlabHost(cwd, signal);
		ref = parseGitlabProjectRef(explicitRepo, fallbackHost);
		if (urlRef && ref.full.toLowerCase() !== urlRef.full.toLowerCase()) {
			throw new ToolError(
				`Conflicting GitLab project targets: repo '${ref.full}' does not match URL project '${urlRef.full}'.`,
			);
		}
	} else if (urlRef) {
		ref = urlRef;
	} else {
		const defaultProject = await resolveDefaultGitlabProjectMemoized(cwd, signal);
		ref = parseCanonicalGitlabProject(defaultProject);
	}
	await assertGitlabHostTrustedForEnvToken(ref.host, cwd, signal);
	return ref;
}

function parseGitlabResourceUrl(
	value: string | undefined,
	resource: "merge_requests" | "issues" | "pipelines" | "jobs",
): { project?: string; id?: number } {
	if (!value) return {};
	const trimmed = value.trim();
	if (!/^https?:\/\//i.test(trimmed)) return {};
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return {};
	}
	if (parsed.username || parsed.password || !GITLAB_HOST_PATTERN.test(parsed.host)) return {};
	const segments = parsed.pathname.split("/").filter(Boolean);
	for (let i = 2; i < segments.length - 1; i++) {
		if (segments[i] === "-" && segments[i + 1] === resource && i + 2 < segments.length) {
			const projectSegments = segments.slice(0, i);
			const id = parsePositiveDecimalInt(segments[i + 2]);
			if (id !== undefined && projectSegments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) {
				return { project: `${parsed.host.toLowerCase()}/${projectSegments.join("/")}`, id };
			}
			return {};
		}
	}
	for (let i = 2; i < segments.length - 1; i++) {
		if (segments[i] === resource && i + 1 < segments.length) {
			const projectSegments = segments.slice(0, i);
			const id = parsePositiveDecimalInt(segments[i + 1]);
			if (id !== undefined && projectSegments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) {
				return { project: `${parsed.host.toLowerCase()}/${projectSegments.join("/")}`, id };
			}
			return {};
		}
	}
	return {};
}

export function parseGitlabMrUrl(value: string | undefined): { project?: string; iid?: number } {
	const parsed = parseGitlabResourceUrl(value, "merge_requests");
	return { project: parsed.project, iid: parsed.id };
}

export function parseGitlabIssueUrl(value: string | undefined): { project?: string; iid?: number } {
	const parsed = parseGitlabResourceUrl(value, "issues");
	return { project: parsed.project, iid: parsed.id };
}

export function parseGitlabPipelineUrl(value: string | undefined): { project?: string; pipelineId?: number } {
	const parsed = parseGitlabResourceUrl(value, "pipelines");
	return { project: parsed.project, pipelineId: parsed.id };
}

export function parseGitlabJobUrl(value: string | undefined): { project?: string; jobId?: number } {
	const parsed = parseGitlabResourceUrl(value, "jobs");
	return { project: parsed.project, jobId: parsed.id };
}

export type GlApiQueryValue = string | number | boolean | readonly string[] | undefined;

export interface GlApiOptions {
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	query?: Record<string, GlApiQueryValue>;
	jsonBody?: unknown;
	trimOutput?: boolean;
}

async function prepareGlabApiArgs(
	cwd: string,
	host: string,
	endpoint: string,
	options: GlApiOptions | undefined,
	signal: AbortSignal | undefined,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
	await assertGitlabHostTrustedForEnvToken(host, cwd, signal);
	const args = ["api", "--hostname", host];
	const queryPairs: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(options?.query ?? {})) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				queryPairs.push([key, String(item)]);
			}
		} else {
			queryPairs.push([key, String(value)]);
		}
	}
	if (options?.method) {
		args.push("-X", options.method);
	} else if (options?.jsonBody !== undefined) {
		args.push("-X", "POST");
	} else if (queryPairs.length > 0) {
		args.push("-X", "GET");
	}
	args.push(endpoint);
	for (const [key, value] of queryPairs) {
		args.push("-f", `${key}=${value}`);
	}
	let tempDir: string | undefined;
	if (options?.jsonBody !== undefined) {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gl-api-"));
		try {
			const bodyPath = path.join(tempDir, "body.json");
			await Bun.write(bodyPath, JSON.stringify(options.jsonBody));
			args.push("-H", "Content-Type: application/json", "--input", bodyPath);
		} catch (err) {
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
	}
	return {
		args,
		cleanup: async () => {
			if (tempDir) {
				await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
}

export async function glabApiJson<T>(
	cwd: string,
	host: string,
	endpoint: string,
	options?: GlApiOptions,
	signal?: AbortSignal,
): Promise<T> {
	const prepared = await prepareGlabApiArgs(cwd, host, endpoint, options, signal);
	try {
		return await gitlab.json<T>(cwd, prepared.args, signal);
	} finally {
		await prepared.cleanup();
	}
}

export async function glabApiText(
	cwd: string,
	host: string,
	endpoint: string,
	options?: GlApiOptions,
	signal?: AbortSignal,
): Promise<string> {
	const prepared = await prepareGlabApiArgs(cwd, host, endpoint, options, signal);
	try {
		return await gitlab.text(cwd, prepared.args, signal, { trimOutput: options?.trimOutput });
	} finally {
		await prepared.cleanup();
	}
}

export async function glabApiPaginatedWithMeta<T>(
	cwd: string,
	host: string,
	endpoint: string,
	query: Record<string, GlApiQueryValue> = {},
	maxPages: number = 10,
	signal?: AbortSignal,
): Promise<{ items: T[]; truncated: boolean }> {
	const items: T[] = [];
	let truncated = false;
	for (let page = 1; page <= maxPages; page++) {
		const pageItems = await glabApiJson<T[]>(
			cwd,
			host,
			endpoint,
			{ query: { ...query, per_page: 100, page } },
			signal,
		);
		if (!Array.isArray(pageItems) || pageItems.length === 0) break;
		items.push(...pageItems);
		if (pageItems.length < 100) break;
		if (page === maxPages) {
			truncated = true;
		}
	}
	return { items, truncated };
}

export async function glabApiPaginated<T>(
	cwd: string,
	host: string,
	endpoint: string,
	query: Record<string, GlApiQueryValue> = {},
	maxPages: number = 10,
	signal?: AbortSignal,
): Promise<T[]> {
	const { items } = await glabApiPaginatedWithMeta<T>(cwd, host, endpoint, query, maxPages, signal);
	return items;
}

export async function resolveGitlabMrIid(
	cwd: string,
	ref: GitlabProjectRef,
	mrInput: string | undefined,
	signal?: AbortSignal,
): Promise<number> {
	const trimmed = mrInput?.trim();
	if (trimmed) {
		if (trimmed.startsWith("-")) {
			throw new ToolError(`Invalid merge request identifier '${trimmed}'. Pass an IID, !IID, URL, or branch name.`);
		}
		const fromUrl = parseGitlabMrUrl(trimmed);
		if (fromUrl.iid !== undefined) return fromUrl.iid;
		const numericMatch = /^!?(\d+)$/.exec(trimmed);
		if (numericMatch) {
			const parsed = parsePositiveDecimalInt(numericMatch[1]);
			if (parsed !== undefined) return parsed;
		}
		const openedMrs = await glabApiJson<GlMrApi[]>(
			cwd,
			ref.host,
			`projects/${encodeProjectPath(ref.path)}/merge_requests`,
			{ query: { source_branch: trimmed, state: "opened", per_page: 5 } },
			signal,
		);
		const opened = openedMrs.filter(mr => mr.iid !== undefined);
		if (opened.length > 1) {
			const ids = opened.map(mr => `!${mr.iid}`).join(", ");
			throw new ToolError(
				`Ambiguous merge request branch '${trimmed}' in ${ref.full}: matched multiple open MRs (${ids}). Pass an explicit IID or URL.`,
			);
		}
		if (opened.length === 1) return opened[0]!.iid!;

		const allMrs = await glabApiJson<GlMrApi[]>(
			cwd,
			ref.host,
			`projects/${encodeProjectPath(ref.path)}/merge_requests`,
			{ query: { source_branch: trimmed, per_page: 5 } },
			signal,
		);
		const withIid = allMrs.filter(mr => mr.iid !== undefined);
		if (withIid.length > 1) {
			const ids = withIid.map(mr => `!${mr.iid}`).join(", ");
			throw new ToolError(
				`Ambiguous merge request branch '${trimmed}' in ${ref.full}: matched multiple MRs (${ids}). Pass an explicit IID or URL.`,
			);
		}
		if (withIid.length === 1) return withIid[0]!.iid!;
		throw new ToolError(`No merge request found for branch '${trimmed}' in ${ref.full}.`);
	}

	const branch = await requireCurrentGitBranch(cwd, signal);
	const mrs = await glabApiJson<GlMrApi[]>(
		cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests`,
		{ query: { source_branch: branch, state: "opened", per_page: 5 } },
		signal,
	);
	const withIid = mrs.filter(mr => mr.iid !== undefined);
	if (withIid.length > 1) {
		const ids = withIid.map(mr => `!${mr.iid}`).join(", ");
		throw new ToolError(
			`Ambiguous open merge requests for current branch '${branch}' in ${ref.full} (${ids}). Pass \`mr\` explicitly (IID or URL).`,
		);
	}
	const iid = withIid[0]?.iid;
	if (iid === undefined) {
		throw new ToolError(
			`No open merge request found for current branch '${branch}' in ${ref.full}. Pass \`mr\` explicitly.`,
		);
	}
	return iid;
}

export function buildGlTextResult(
	text: string,
	sourceUrl?: string,
	details?: GlToolDetails,
	options?: { artifactId?: string; artifactLabel?: string; useless?: boolean },
): AgentToolResult<GlToolDetails> {
	const builder = toolResult<GlToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "Saved artifact"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	if (options?.useless) {
		builder.useless();
	}
	return builder.done();
}
