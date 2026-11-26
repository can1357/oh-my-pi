import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IsoBackendKind, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath, logger } from "@oh-my-pi/pi-utils";
import { parseGitUrl } from "../extensibility/plugins/git-url";
import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";
import { withRepoLock } from "../utils/repo-lock";
import { resolveAvailableWorktreePath } from "../worktree/paths";
import type { GlMrCheckoutSummary, GlToolDetails } from "./details/gitlab";
import {
	normalizeOptionalString,
	normalizePrIdentifierList,
	parsePositiveDecimalInt,
	requireCurrentGitBranch,
	requireNonEmpty,
} from "./gh-common";
import { formatShortSha, pushLine } from "./gh-format";
import {
	joinSections,
	requireGitRepoRoot,
	requirePrimaryGitRepoRoot,
	sanitizeRemoteName,
	selectPrCloneUrl,
	toLocalBranchRef,
} from "./gh-pr-checkout";
import { invalidateAllForNumber } from "./github-cache";
import {
	buildGlTextResult,
	encodeProjectPath,
	glabApiJson,
	parseGitlabMrUrl,
	resolveGitlabMrIid,
	resolveGitlabProject,
} from "./gl-common";
import type { GitlabInput, GlMrApi, GlProjectApi } from "./gl-types";
import type { ToolSession } from ".";
import { throwIfAborted, ToolError } from "./tool-errors";

const MR_FETCH_TIMEOUT_MS = 30 * 60 * 1000;

interface MrCheckoutOutcome {
	mr: GlMrApi;
	project: string;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	sourceBranch: string;
	isCrossRepository: boolean;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

export function mrLocalBranchName(projectFull: string, iid: number): string {
	return `mr-${hashPath(projectFull.toLowerCase()).slice(0, 8)}-${iid}`;
}

function remoteMatchesProject(
	remoteUrl: string,
	expectedProjectFull: string | undefined,
	sourceProject: GlProjectApi | undefined,
): boolean {
	if (sourceProject) {
		if (sourceProject.http_url_to_repo && remoteUrl === sourceProject.http_url_to_repo) return true;
		if (sourceProject.ssh_url_to_repo && remoteUrl === sourceProject.ssh_url_to_repo) return true;
	}
	if (!expectedProjectFull) return false;
	const parsed = parseGitUrl(remoteUrl);
	if (!parsed) return false;
	return `${parsed.host}/${parsed.path}`.toLowerCase() === expectedProjectFull.toLowerCase();
}

async function listRemoteUrls(repository: VcsGitRepo, signal: AbortSignal | undefined): Promise<Map<string, string>> {
	const remotes = new Map<string, string>();
	for (const remoteName of await repository.remoteList(signal)) {
		const url = await repository.remoteUrl(remoteName, signal);
		if (url) remotes.set(remoteName, url);
	}
	return remotes;
}

function findMatchingRemote(
	remotes: Map<string, string>,
	expectedProjectFull: string | undefined,
	sourceProject: GlProjectApi | undefined,
): { name: string; url: string } | undefined {
	const originUrl = remotes.get("origin");
	if (originUrl && remoteMatchesProject(originUrl, expectedProjectFull, sourceProject)) {
		return { name: "origin", url: originUrl };
	}
	for (const [remoteName, url] of remotes) {
		if (remoteMatchesProject(url, expectedProjectFull, sourceProject)) {
			return { name: remoteName, url };
		}
	}
	return undefined;
}

async function ensureMrRemoteWithRepo(
	repository: VcsGitRepo,
	isCrossRepository: boolean,
	expectedProjectFull: string | undefined,
	sourceProject: GlProjectApi | undefined,
	signal: AbortSignal | undefined,
): Promise<{ name: string; url: string }> {
	const remotes = await listRemoteUrls(repository, signal);
	const matched = findMatchingRemote(remotes, expectedProjectFull, sourceProject);
	if (matched) return matched;

	const originUrl = remotes.get("origin");
	// For local-path bare remotes in tests/offline clones (where parseGitUrl returns null),
	// keep origin when the MR is same-project and no explicit sourceProject clone URL was fetched.
	if (!isCrossRepository && !sourceProject && originUrl && !parseGitUrl(originUrl)) {
		return { name: "origin", url: originUrl };
	}

	if (!sourceProject) {
		throw new ToolError(
			`No local git remote matches ${expectedProjectFull ?? "the MR source project"} and source project clone metadata is unavailable.`,
		);
	}
	const remoteUrl = selectPrCloneUrl(originUrl, {
		url: sourceProject.http_url_to_repo,
		sshUrl: sourceProject.ssh_url_to_repo,
	});
	if (!remoteUrl) {
		throw new ToolError(`Could not determine a clone URL for ${sourceProject.path_with_namespace ?? "MR source"}.`);
	}

	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) return { name: remoteName, url };
	}

	const preferredOwner = sourceProject.path_with_namespace?.split("/")[0] ?? "fork";
	const preferredRemoteName = sanitizeRemoteName(preferredOwner);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}
	await repository.remoteAdd(remoteName, remoteUrl, signal);
	return { name: remoteName, url: remoteUrl };
}

function redactRemoteUrlCredentials(rawUrl: string): string {
	if (!rawUrl.includes("://")) return rawUrl;
	try {
		const parsed = new URL(rawUrl);
		if (!parsed.username && !parsed.password) return rawUrl;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return rawUrl.replace(/(\w+:\/\/)[^/\s@]+@/, "$1");
	}
}

function formatMrCheckoutResult(outcome: MrCheckoutOutcome): string {
	const { mr, localBranch, worktreePath, remoteName, remoteUrl, sourceBranch, isCrossRepository, reused, clonedWith } =
		outcome;
	const lines: string[] = [
		reused ? `# Merge Request !${mr.iid ?? "?"} Worktree` : `# Checked Out Merge Request !${mr.iid ?? "?"}`,
		"",
	];
	pushLine(lines, "Title", mr.title ?? undefined);
	pushLine(lines, "URL", mr.web_url);
	pushLine(lines, "Target branch", mr.target_branch);
	pushLine(lines, "Source branch", sourceBranch);
	pushLine(lines, "Local branch", localBranch);
	pushLine(
		lines,
		"Worktree",
		clonedWith != null ? `${worktreePath} (cloned via ${formatIsolationBackend(clonedWith)})` : worktreePath,
	);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote URL", redactRemoteUrlCredentials(remoteUrl));
	pushLine(lines, "Cross repository", isCrossRepository);
	if (mr.allow_collaboration !== undefined) {
		pushLine(lines, "Allow collaboration", mr.allow_collaboration);
	}
	lines.push("");
	lines.push(
		reused
			? "Reused the existing MR worktree."
			: "Created a dedicated worktree for this MR and configured the local branch to push back to the MR source branch.",
	);
	return lines.join("\n").trim();
}

function outcomeToSummary(outcome: MrCheckoutOutcome): GlMrCheckoutSummary {
	return {
		mrIid: outcome.mr.iid,
		url: outcome.mr.web_url,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.sourceBranch,
		reused: outcome.reused,
		clonedWith: outcome.clonedWith,
	};
}

async function checkoutMergeRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: { mrRef: string | undefined; repo: string | undefined; force: boolean },
): Promise<MrCheckoutOutcome> {
	const { mrRef, repo, force } = options;
	if (mrRef?.startsWith("-")) {
		throw new ToolError(`Invalid MR identifier '${mrRef}'. Pass an MR IID, URL, or branch name.`);
	}
	const urlParsed = parseGitlabMrUrl(mrRef);
	const ref = await resolveGitlabProject(session.cwd, repo, urlParsed.project, signal);
	const iid = await resolveGitlabMrIid(session.cwd, ref, mrRef, signal);
	const mr = await glabApiJson<GlMrApi>(
		session.cwd,
		ref.host,
		`projects/${encodeProjectPath(ref.path)}/merge_requests/${iid}`,
		undefined,
		signal,
	);

	const mrIid = mr.iid ?? iid;
	const sourceBranch = requireNonEmpty(mr.source_branch, "source branch");
	const headSha = mr.sha ?? mr.diff_refs?.head_sha ?? undefined;
	const isCrossRepository =
		mr.source_project_id != null && mr.target_project_id != null && mr.source_project_id !== mr.target_project_id;

	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);

	let sourceProject: GlProjectApi | undefined;
	let expectedSourceProjectFull: string | undefined = isCrossRepository ? undefined : ref.full;
	if (isCrossRepository && mr.source_project_id != null) {
		sourceProject = await glabApiJson<GlProjectApi>(
			session.cwd,
			ref.host,
			`projects/${mr.source_project_id}`,
			undefined,
			signal,
		);
		if (sourceProject.path_with_namespace) {
			expectedSourceProjectFull = `${ref.host}/${sourceProject.path_with_namespace}`;
		}
	} else {
		const initialRemotes = await listRemoteUrls(vcs.requireGit(repoRoot), signal);
		const matched = findMatchingRemote(initialRemotes, expectedSourceProjectFull, undefined);
		const originUrl = initialRemotes.get("origin");
		const hasLocalOnlyOrigin = Boolean(originUrl && !parseGitUrl(originUrl));
		if (!matched && !hasLocalOnlyOrigin) {
			sourceProject = await glabApiJson<GlProjectApi>(
				session.cwd,
				ref.host,
				`projects/${encodeProjectPath(ref.path)}`,
				undefined,
				signal,
			);
		}
	}

	const projectKey = ref.full.toLowerCase();
	const localBranch = mrLocalBranchName(projectKey, mrIid);
	const worktreePath = getWorktreeDir(`${localBranch}-${hashPath(primaryRepoRoot)}`);
	const mrWebUrl = mr.web_url ?? `https://${ref.host}/${ref.path}/-/merge_requests/${mrIid}`;

	return withRepoLock(
		repoRoot,
		async () => {
			const repository = vcs.requireGit(repoRoot);
			const existingWorktrees = await repository.worktrees(signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));
			const configPrefix = `branch.${localBranch}.`;

			const recordedProject = (await repository.configGet(`${configPrefix}ompMrProject`, signal))?.toLowerCase();
			if (recordedProject && recordedProject !== projectKey) {
				throw new ToolError(
					`Local branch ${localBranch} belongs to ${recordedProject}, not ${projectKey}; refusing to overwrite its MR metadata.`,
				);
			}

			const remote = await ensureMrRemoteWithRepo(
				repository,
				isCrossRepository,
				expectedSourceProjectFull,
				sourceProject,
				signal,
			);
			const remoteTrackingRef = `refs/remotes/${remote.name}/${sourceBranch}`;
			await repository.fetch(
				remote.name,
				`refs/heads/${sourceBranch}`,
				remoteTrackingRef,
				MR_FETCH_TIMEOUT_MS,
				signal,
			);
			const fetchedOid = (await repository.resolveRef(remoteTrackingRef, signal)) ?? undefined;
			if (headSha && fetchedOid && fetchedOid !== headSha) {
				throw new ToolError(
					`Fetched ${remote.name}/${sourceBranch} (${formatShortSha(fetchedOid)}) does not match MR !${mrIid} head commit (${formatShortSha(headSha)}).`,
				);
			}

			if (existingWorktree) {
				const existingOid = (await repository.resolveRef(toLocalBranchRef(localBranch), signal)) ?? undefined;
				if (force && fetchedOid && existingOid !== fetchedOid) {
					const wtRepo = vcs.requireGit(existingWorktree.path);
					if (await wtRepo.isDirty(signal)) {
						throw new ToolError(
							`Existing MR worktree at ${existingWorktree.path} has uncommitted changes; commit or discard them before passing force=true.`,
						);
					}
					await wtRepo.reset("hard", remoteTrackingRef, signal);
				}
			} else {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await repository.refExists(localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await repository.resolveRef(localBranchRef, signal);
					const expectedOid = headSha ?? fetchedOid;
					if (existingOid !== expectedOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}
						await repository.createBranch(localBranch, remoteTrackingRef, true, signal);
					}
				} else {
					await repository.createBranch(localBranch, remoteTrackingRef, false, signal);
				}
			}

			await repository.configSet(`${configPrefix}remote`, remote.name, signal);
			await repository.configSet(`${configPrefix}merge`, `refs/heads/${sourceBranch}`, signal);
			await repository.configSet(`${configPrefix}pushRemote`, remote.name, signal);
			await repository.configSet(`${configPrefix}ompMrProject`, projectKey, signal);
			if (expectedSourceProjectFull) {
				await repository.configSet(
					`${configPrefix}ompMrSourceProject`,
					expectedSourceProjectFull.toLowerCase(),
					signal,
				);
			}
			await repository.configSet(`${configPrefix}ompMrHeadRef`, sourceBranch, signal);
			await repository.configSet(`${configPrefix}ompMrUrl`, mrWebUrl, signal);
			await repository.configSet(
				`${configPrefix}ompMrIsCrossRepository`,
				String(Boolean(isCrossRepository)),
				signal,
			);
			await repository.configSet(
				`${configPrefix}ompMrAllowCollaboration`,
				String(Boolean(mr.allow_collaboration)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			let clonedWith: IsoBackendKind | undefined;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				const result = await repository.worktreeAdd(
					finalWorktreePath,
					localBranch,
					{
						detach: false,
						clone: cfgWorktreeClone.get(session.settings),
						backend: parseIsolationBackend(cfgIsolationBackend.get(session.settings)),
					},
					signal,
				);
				clonedWith = result.clonedWith ?? undefined;
				if (result.cloneError) {
					logger.warn("worktree clone fell back to plain checkout", {
						path: finalWorktreePath,
						error: result.cloneError,
					});
				}
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				mr: { ...mr, iid: mrIid, web_url: mrWebUrl },
				project: ref.full,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				sourceBranch,
				isCrossRepository,
				reused: Boolean(existingWorktree),
				clonedWith,
			};
		},
		signal,
	);
}

export async function executeMrCheckout(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const mrList = normalizePrIdentifierList(params.mr);
	const mrRefs = mrList.length > 0 ? mrList : [undefined];
	const isMulti = mrRefs.length > 1;

	const settled = await Promise.allSettled(
		mrRefs.map(mrRef => checkoutMergeRequest(session, signal, { mrRef, repo, force })),
	);
	const outcomes: MrCheckoutOutcome[] = [];
	const failures: Array<{ mrRef: string | undefined; reason: unknown }> = [];
	for (let i = 0; i < settled.length; i++) {
		const entry = settled[i]!;
		if (entry.status === "fulfilled") outcomes.push(entry.value);
		else failures.push({ mrRef: mrRefs[i], reason: entry.reason });
	}
	if (failures.length > 0) {
		throwIfAborted(signal);
		const failureLines = failures.map(
			f => `- ${f.mrRef ?? "(current branch)"}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
		);
		if (outcomes.length === 0) {
			if (failures.length === 1) throw failures[0]!.reason;
			throw new ToolError(`all ${failures.length} MR checkouts failed:\n${failureLines.join("\n")}`);
		}
		const sections = outcomes.map(formatMrCheckoutResult);
		const header = `# ${outcomes.length}/${settled.length} Merge Request Worktrees checked out (${failures.length} failed)`;
		const text = [header, "", ...joinSections(sections), "", "## Failed", ...failureLines].join("\n").trim();
		return buildGlTextResult(text, undefined, {
			repo,
			checkouts: outcomes.map(outcomeToSummary),
		});
	}

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildGlTextResult(formatMrCheckoutResult(outcome!), outcome!.mr.web_url, {
			repo: outcome!.project,
			branch: outcome!.localBranch,
			worktreePath: outcome!.worktreePath,
			remote: outcome!.remoteName,
			remoteBranch: outcome!.sourceBranch,
			checkouts: [outcomeToSummary(outcome!)],
		});
	}

	const sections = outcomes.map(formatMrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Merge Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();
	return buildGlTextResult(text, undefined, {
		repo: repo ?? outcomes[0]?.project,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

export async function executeMrPush(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const repository = vcs.requireGit(repoRoot);
	const explicitRef = normalizeOptionalString(params.ref);
	const explicitRepo = normalizeOptionalString(params.repo);
	const mrList = normalizePrIdentifierList(params.mr);
	if (mrList.length > 1) {
		throw new ToolError("mr_push accepts a single MR identifier.");
	}
	const mrRef = mrList[0];

	let localBranch: string;
	let expectedProjectKey: string | undefined;

	if (explicitRef) {
		localBranch = explicitRef;
		if (explicitRepo) {
			expectedProjectKey = (
				await resolveGitlabProject(session.cwd, explicitRepo, undefined, signal)
			).full.toLowerCase();
		}
	} else if (mrRef) {
		const urlParsed = parseGitlabMrUrl(mrRef);
		const projectRef = await resolveGitlabProject(session.cwd, explicitRepo, urlParsed.project, signal);
		const numericMatch = /^!?(\d+)$/.exec(mrRef);
		const iid =
			urlParsed.iid ??
			(numericMatch ? parsePositiveDecimalInt(numericMatch[1]) : undefined) ??
			(await resolveGitlabMrIid(session.cwd, projectRef, mrRef, signal));
		expectedProjectKey = projectRef.full.toLowerCase();
		localBranch = mrLocalBranchName(expectedProjectKey, iid);
	} else {
		localBranch = await requireCurrentGitBranch(repoRoot, signal);
		if (explicitRepo) {
			expectedProjectKey = (
				await resolveGitlabProject(session.cwd, explicitRepo, undefined, signal)
			).full.toLowerCase();
		}
	}

	const refExists = await repository.refExists(toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const configPrefix = `branch.${localBranch}.`;
	const [headRef, pushRemote, remote, mrUrl, recordedProject, recordedSourceProject] = await Promise.all([
		repository.configGet(`${configPrefix}ompMrHeadRef`, signal),
		repository.configGet(`${configPrefix}pushRemote`, signal),
		repository.configGet(`${configPrefix}remote`, signal),
		repository.configGet(`${configPrefix}ompMrUrl`, signal),
		repository.configGet(`${configPrefix}ompMrProject`, signal),
		repository.configGet(`${configPrefix}ompMrSourceProject`, signal),
	]);
	if (!headRef) {
		throw new ToolError(`branch ${localBranch} has no MR push metadata; check it out via op: mr_checkout first`);
	}
	const branchProjectKey =
		recordedProject?.toLowerCase() ?? parseGitlabMrUrl(mrUrl ?? undefined).project?.toLowerCase();
	if (expectedProjectKey && branchProjectKey && expectedProjectKey !== branchProjectKey) {
		throw new ToolError(
			`Branch ${localBranch} is linked to ${branchProjectKey}, not ${expectedProjectKey}; refusing to push.`,
		);
	}

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`branch ${localBranch} has no configured push remote`);
	}

	const effectivePushUrl =
		(await repository.configGet(`remote.${remoteName}.pushurl`, signal)) ??
		(await repository.remoteUrl(remoteName, signal)) ??
		undefined;
	if (!effectivePushUrl) {
		throw new ToolError(`Remote '${remoteName}' has no configured push URL; refusing to push.`);
	}
	const expectedPushProject = recordedSourceProject?.toLowerCase() ?? branchProjectKey;
	if (expectedPushProject) {
		const parsedPush = parseGitUrl(effectivePushUrl);
		const isLocalFilesystemPath =
			path.isAbsolute(effectivePushUrl) || effectivePushUrl.startsWith("./") || effectivePushUrl.startsWith("../");
		if (!parsedPush) {
			if (!isLocalFilesystemPath) {
				throw new ToolError(
					`Cannot verify push destination for remote '${remoteName}' (${redactRemoteUrlCredentials(effectivePushUrl)}) against MR source project '${expectedPushProject}'; refusing to push.`,
				);
			}
		} else if (`${parsedPush.host}/${parsedPush.path}`.toLowerCase() !== expectedPushProject) {
			throw new ToolError(
				`Push destination for remote '${remoteName}' (${parsedPush.host}/${parsedPush.path}) does not match MR source project '${expectedPushProject}'; refusing to push.`,
			);
		}
	}

	const currentBranch = await repository.currentBranch(signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${headRef}`;
	await repository.push(
		{
			forceWithLease: params.forceWithLease,
			refspec,
			remote: remoteName,
		},
		signal,
	);

	const pushedMr = parseGitlabMrUrl(mrUrl ?? undefined);
	if (pushedMr.iid !== undefined) {
		invalidateAllForNumber(pushedMr.iid, pushedMr.project);
	}

	const lines = ["# Pushed Merge Request Branch", ""];
	pushLine(lines, "Local branch", localBranch);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote branch", headRef);
	pushLine(lines, "Remote URL", effectivePushUrl ? redactRemoteUrlCredentials(effectivePushUrl) : undefined);
	pushLine(lines, "MR", mrUrl ?? undefined);
	pushLine(lines, "Force with lease", params.forceWithLease ?? false);
	lines.push(`Pushed ${localBranch} to ${remoteName}:${headRef}.`);

	return buildGlTextResult(lines.join("\n").trim(), mrUrl ?? undefined, {
		repo: pushedMr.project,
		branch: localBranch,
		remote: remoteName,
		remoteBranch: headRef,
	});
}
