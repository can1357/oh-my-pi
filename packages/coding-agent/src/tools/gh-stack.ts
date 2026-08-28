/**
 * GitHub stacked PR operations.
 *
 * Mutations and local navigation wrap `gh stack` (the github/gh-stack
 * extension) with the non-interactive flags agents need. Reads of a PR's
 * remote stack membership use the Stacks REST API so `pr://` and `stack://`
 * work even when the checkout is not a locally tracked stack.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { github } from "../utils/github";
import type { ToolSession } from ".";
import type { GhToolDetails } from "./gh";
import {
	buildTextResult,
	ghApiHostArgs,
	normalizeOptionalString,
	normalizePrIdentifierList,
	parsePositiveDecimalInt,
	parseRepoRef,
	requireNonEmpty,
	resolveDefaultRepoMemoized,
} from "./gh-common";
import type { GhPrStack, GhPrStackPullRequest, GithubInput, StackCommand } from "./gh-types";
import { ToolError } from "./tool-errors";

export const GH_STACK_INSTALL = "gh extension install github/gh-stack";
export const GH_STACK_MISSING = `GitHub Stacked PRs CLI is not installed. Run \`${GH_STACK_INSTALL}\`.`;

export const STACK_COMMANDS = [
	"init",
	"add",
	"view",
	"push",
	"submit",
	"sync",
	"rebase",
	"checkout",
	"merge",
	"unstack",
	"up",
	"down",
	"top",
	"bottom",
	"trunk",
	"link",
] as const;

export function isStackCommand(value: string): value is StackCommand {
	return (STACK_COMMANDS as readonly string[]).includes(value);
}
interface GhRestStackPullRequest {
	number?: number;
	state?: string;
	draft?: boolean;
	merged_at?: string | null;
	head?: { ref?: string; sha?: string };
}

interface GhRestStack {
	number?: number;
	url?: string;
	open?: boolean;
	base?: { ref?: string };
	pull_requests?: GhRestStackPullRequest[];
}

interface GhStackViewPr {
	number?: number;
	url?: string;
	state?: string;
}

interface GhStackViewBranch {
	name?: string;
	head?: string;
	base?: string;
	isCurrent?: boolean;
	isMerged?: boolean;
	isQueued?: boolean;
	needsRebase?: boolean;
	pr?: GhStackViewPr | null;
}

interface GhStackViewJson {
	trunk?: string;
	currentBranch?: string;
	branches?: GhStackViewBranch[];
}

let ghStackAvailable: boolean | undefined;

/** Test helper: forget the process-lifetime `gh stack` availability memo. */
export function resetGhStackAvailabilityForTests(): void {
	ghStackAvailable = undefined;
}

export async function assertGhStack(cwd: string, signal?: AbortSignal): Promise<void> {
	if (ghStackAvailable === true) return;
	const result = await github.run(cwd, ["stack", "--help"], signal);
	if (result.exitCode !== 0) {
		ghStackAvailable = false;
		throw new ToolError(GH_STACK_MISSING);
	}
	ghStackAvailable = true;
}

export function normalizeRestStack(raw: unknown): GhPrStack | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const rec = raw as GhRestStack;
	const number = typeof rec.number === "number" && Number.isInteger(rec.number) && rec.number > 0 ? rec.number : 0;
	if (number === 0) return undefined;
	const baseRef = rec.base?.ref;
	const base = typeof baseRef === "string" ? baseRef : "";
	const url = typeof rec.url === "string" ? rec.url : undefined;
	const open = typeof rec.open === "boolean" ? rec.open : undefined;
	const pullRequests: GhPrStackPullRequest[] = [];
	if (Array.isArray(rec.pull_requests)) {
		for (const entry of rec.pull_requests) {
			if (typeof entry.number !== "number") continue;
			const headRef = typeof entry.head?.ref === "string" ? entry.head.ref : "";
			pullRequests.push({
				number: entry.number,
				state: typeof entry.state === "string" ? entry.state : "open",
				draft: entry.draft === true,
				mergedAt: typeof entry.merged_at === "string" || entry.merged_at === null ? entry.merged_at : undefined,
				headRef,
			});
		}
	}
	return { number, base, url, open, pullRequests };
}

function restStackState(entry: GhPrStackPullRequest): string {
	if (entry.mergedAt) return "merged";
	if (entry.draft) return "draft";
	return entry.state.toLowerCase();
}

/** Render a remote stack as a numbered map. Position 1 is closest to trunk. */
export function formatStackMap(stack: GhPrStack, repo: string, currentPr?: number): string[] {
	const count = stack.pullRequests.length;
	const lines: string[] = [
		`## Stack #${stack.number} (base: ${stack.base || "unknown"}, ${count} PR${count === 1 ? "" : "s"})`,
		"",
	];
	if (count === 0) {
		lines.push("No pull requests in this stack.");
		return lines;
	}
	for (let i = 0; i < stack.pullRequests.length; i++) {
		const entry = stack.pullRequests[i];
		if (!entry) continue;
		const position = i + 1;
		const markers: string[] = [];
		if (position === 1) markers.push("bottom");
		if (position === count) markers.push("top");
		if (currentPr === entry.number) markers.push("this");
		const mark = markers.length > 0 ? `  ← ${markers.join(", ")}` : "";
		const head = entry.headRef || "(unknown branch)";
		lines.push(`${position}. pr://${repo}/${entry.number}  ${head}  ${restStackState(entry)}${mark}`);
	}
	return lines;
}

export function formatStackList(repo: string, stacks: GhPrStack[]): string {
	const lines: string[] = [`# Pull request stacks (${repo})`, ""];
	if (stacks.length === 0) {
		lines.push("No stacks.");
		return lines.join("\n");
	}
	for (const stack of stacks) {
		const prs = stack.pullRequests.length;
		const status = stack.open === false ? "closed" : "open";
		const top = stack.pullRequests[stack.pullRequests.length - 1];
		const bottom = stack.pullRequests[0];
		const span =
			bottom && top
				? `${bottom.headRef || `#${bottom.number}`} → ${top.headRef || `#${top.number}`}`
				: `${prs} PR${prs === 1 ? "" : "s"}`;
		lines.push(
			`- stack://${repo}/${stack.number}  ${stack.base}  ${span}  ${status}  ${prs} PR${prs === 1 ? "" : "s"}`,
		);
	}
	return lines.join("\n");
}

export function formatRemoteStackView(stack: GhPrStack, repo: string): string {
	const lines: string[] = [
		`# Stack #${stack.number}`,
		"",
		`Base: ${stack.base || "unknown"}`,
		`PRs: ${stack.pullRequests.length}`,
	];
	if (stack.open !== undefined) lines.push(`Open: ${stack.open}`);
	if (stack.url) lines.push(`URL: ${stack.url}`);
	lines.push("");
	lines.push(...formatStackMap(stack, repo).slice(2));
	return lines.join("\n").trim();
}

export function formatLocalStackView(data: GhStackViewJson, repo: string | undefined): string {
	const trunk = data.trunk ?? "unknown";
	const lines: string[] = [`# Local stack (trunk: ${trunk})`, ""];
	const branches = data.branches ?? [];
	if (branches.length === 0) {
		lines.push("No branches in this stack.");
		return lines.join("\n");
	}
	for (let i = 0; i < branches.length; i++) {
		const branch = branches[i];
		if (!branch) continue;
		const position = i + 1;
		const flags: string[] = [];
		if (branch.isCurrent) flags.push("current");
		if (branch.isMerged) flags.push("merged");
		if (branch.isQueued) flags.push("queued");
		if (branch.needsRebase) flags.push("needs rebase");
		const flagText = flags.length > 0 ? `  (${flags.join(", ")})` : "";
		let prText = "";
		if (branch.pr && typeof branch.pr.number === "number") {
			const href =
				repo !== undefined ? `pr://${repo}/${branch.pr.number}` : (branch.pr.url ?? `PR #${branch.pr.number}`);
			const state = branch.pr.state ? ` ${branch.pr.state}` : "";
			prText = `  ${href}${state}`;
		}
		const markers: string[] = [];
		if (position === 1) markers.push("bottom");
		if (position === branches.length) markers.push("top");
		const mark = markers.length > 0 ? `  ← ${markers.join(", ")}` : "";
		lines.push(`${position}. ${branch.name ?? "(unnamed)"}${prText}${flagText}${mark}`);
	}
	return lines.join("\n");
}

function stacksApiArgs(repo: string, extra: string[]): string[] {
	const ref = parseRepoRef(repo);
	return ["api", ...ghApiHostArgs(ref), ...extra];
}

export async function fetchPrStack(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrStack | undefined> {
	try {
		const ref = parseRepoRef(repo);
		const stacks = await github.json<unknown>(
			cwd,
			stacksApiArgs(repo, [`/repos/${ref.slug}/stacks`, "-F", `pull_request=${prNumber}`, "-F", "per_page=1"]),
			signal,
			{ repoProvided: true },
		);
		if (!Array.isArray(stacks) || stacks.length === 0) return undefined;
		return normalizeRestStack(stacks[0]);
	} catch {
		return undefined;
	}
}

export async function fetchRepoStacks(cwd: string, repo: string, signal?: AbortSignal): Promise<GhPrStack[]> {
	const ref = parseRepoRef(repo);
	const stacks = await github.json<unknown>(
		cwd,
		stacksApiArgs(repo, [`/repos/${ref.slug}/stacks`, "-F", "per_page=50"]),
		signal,
		{ repoProvided: true },
	);
	if (!Array.isArray(stacks)) return [];
	const out: GhPrStack[] = [];
	for (const entry of stacks) {
		const stack = normalizeRestStack(entry);
		if (stack) out.push(stack);
	}
	return out;
}

export async function fetchRemoteStack(
	cwd: string,
	repo: string,
	stackNumber: number,
	signal?: AbortSignal,
): Promise<GhPrStack> {
	const ref = parseRepoRef(repo);
	const raw = await github.json<unknown>(
		cwd,
		stacksApiArgs(repo, [`/repos/${ref.slug}/stacks/${stackNumber}`]),
		signal,
		{ repoProvided: true },
	);
	const stack = normalizeRestStack(raw);
	if (!stack) {
		throw new ToolError(`GitHub returned an unreadable stack payload for stack #${stackNumber}.`);
	}
	return stack;
}

function stackIdentifier(params: GithubInput): string | undefined {
	const stack = normalizeOptionalString(params.stack);
	if (stack) return stack;
	const prs = normalizePrIdentifierList(params.pr);
	if (prs[0]) return prs[0];
	return normalizeOptionalString(params.branch);
}

function requireStackCommand(params: GithubInput): StackCommand {
	const command = normalizeOptionalString(params.command);
	if (!command) {
		throw new ToolError("stack command is required when op is stack");
	}
	if (!isStackCommand(command)) {
		throw new ToolError(`unknown stack command: ${command}`);
	}
	return command;
}

function appendRemote(args: string[], params: GithubInput): void {
	const remote = normalizeOptionalString(params.remote);
	if (remote) args.push("--remote", remote);
}

function branchList(params: GithubInput): string[] {
	const fromArray = params.branches?.map(value => value.trim()).filter(value => value.length > 0) ?? [];
	const single = normalizeOptionalString(params.branch);
	if (single && !fromArray.includes(single)) return [...fromArray, single];
	return fromArray;
}

async function stackText(session: ToolSession, args: string[], signal: AbortSignal | undefined): Promise<string> {
	await assertGhStack(session.cwd, signal);
	return github.text(session.cwd, ["stack", ...args], signal);
}

async function executeInit(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branches = branchList(params);
	if (branches.length === 0) {
		throw new ToolError("stack init requires at least one branch name");
	}
	const args = ["init"];
	const base = normalizeOptionalString(params.base);
	if (base) args.push("--base", base);
	args.push(...branches);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || `Initialized stack: ${branches.join(" → ")}`);
}

async function executeAdd(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branch = requireNonEmpty(normalizeOptionalString(params.branch) ?? branchList(params)[0], "branch");
	const args = ["add"];
	const message = normalizeOptionalString(params.message);
	if (message) args.push("-m", message);
	args.push(branch);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || `Added stack branch ${branch}`, undefined, { branch });
}

async function executeView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const stackNumber = parsePositiveDecimalInt(normalizeOptionalString(params.stack));
	if (stackNumber !== undefined) {
		const repo = params.repo
			? requireNonEmpty(normalizeOptionalString(params.repo), "repo")
			: await resolveDefaultRepoMemoized(session.cwd, signal);
		const stack = await fetchRemoteStack(session.cwd, repo, stackNumber, signal);
		return buildTextResult(formatRemoteStackView(stack, repo), stack.url, { repo });
	}
	await assertGhStack(session.cwd, signal);
	const data = await github.json<GhStackViewJson>(session.cwd, ["stack", "view", "--json"], signal);
	let repo: string | undefined;
	try {
		repo = await resolveDefaultRepoMemoized(session.cwd, signal);
	} catch {
		repo = undefined;
	}
	return buildTextResult(formatLocalStackView(data, repo), undefined, { repo, branch: data.currentBranch });
}

async function executePush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["push"];
	appendRemote(args, params);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Pushed stack branches.");
}

async function executeSubmit(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["submit", "--auto"];
	if (params.open === true) args.push("--open");
	appendRemote(args, params);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Submitted stack.");
}

async function executeSync(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["sync"];
	if (params.prune === true) args.push("--prune");
	appendRemote(args, params);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Synced stack.");
}

async function executeRebase(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["rebase"];
	if (params.abort === true) args.push("--abort");
	if (params.resume === true) args.push("--continue");
	if (params.upstack === true) args.push("--upstack");
	if (params.downstack === true) args.push("--downstack");
	if (params.noTrunk === true) args.push("--no-trunk");
	appendRemote(args, params);
	const branch = normalizeOptionalString(params.branch);
	if (branch) args.push(branch);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Rebased stack.");
}

async function executeCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const target = stackIdentifier(params);
	if (!target) {
		throw new ToolError("stack checkout requires stack, pr, or branch");
	}
	const text = await stackText(session, ["checkout", target], signal);
	return buildTextResult(text || `Checked out stack ${target}`, undefined, { branch: target });
}

async function executeMerge(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["merge", "--yes"];
	if (params.mergeMethod === "squash") args.push("--squash");
	else if (params.mergeMethod === "rebase") args.push("--rebase");
	else if (params.mergeMethod === "merge") args.push("--merge");
	const target = stackIdentifier(params);
	if (target) args.push(target);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Merged stack.");
}

async function executeUnstack(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args = ["unstack"];
	if (params.local === true) args.push("--local");
	const stack = normalizeOptionalString(params.stack);
	if (stack) args.push(stack);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || "Removed stack tracking.");
}

async function executeNavigate(
	session: ToolSession,
	command: "up" | "down" | "top" | "bottom" | "trunk",
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const args: string[] = [command];
	if (command === "up" || command === "down") {
		const steps = params.steps;
		if (steps !== undefined) {
			if (!Number.isFinite(steps) || steps <= 0) {
				throw new ToolError("steps must be a positive number");
			}
			args.push(String(Math.floor(steps)));
		}
	}
	const text = await stackText(session, args, signal);
	return buildTextResult(text || `Checked out stack ${command}.`);
}

async function executeLink(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const stack = normalizeOptionalString(params.stack);
	const branches = branchList(params);
	const prs = normalizePrIdentifierList(params.pr);
	if (stack) {
		if (prs.length + branches.length === 0) {
			throw new ToolError("stack link with a stack number requires branches or PRs to append");
		}
	} else if (prs.length + branches.length < 2) {
		throw new ToolError("stack link requires at least two branches or PRs, ordered bottom to top");
	}
	const args = ["link"];
	if (stack) args.push(stack);
	args.push(...prs, ...branches);
	appendRemote(args, params);
	const text = await stackText(session, args, signal);
	return buildTextResult(text || `Linked stack: ${args.slice(1).join(" → ")}`);
}

export async function executeStack(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const command = requireStackCommand(params);
	switch (command) {
		case "init":
			return executeInit(session, params, signal);
		case "add":
			return executeAdd(session, params, signal);
		case "view":
			return executeView(session, params, signal);
		case "push":
			return executePush(session, params, signal);
		case "submit":
			return executeSubmit(session, params, signal);
		case "sync":
			return executeSync(session, params, signal);
		case "rebase":
			return executeRebase(session, params, signal);
		case "checkout":
			return executeCheckout(session, params, signal);
		case "merge":
			return executeMerge(session, params, signal);
		case "unstack":
			return executeUnstack(session, params, signal);
		case "up":
		case "down":
		case "top":
		case "bottom":
		case "trunk":
			return executeNavigate(session, command, params, signal);
		case "link":
			return executeLink(session, params, signal);
	}
}
