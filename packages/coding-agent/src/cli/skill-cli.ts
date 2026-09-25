/**
 * `omp skill <action>` handlers: publish and manage packages on a Skillshare
 * registry, and dispatch install/update/uninstall/search/info to the installer.
 */
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import {
	SKILL_LIMITS,
	SKILL_SCOPE_RE,
	SKILLS_OIDC_AUDIENCE,
	SKILLS_TOKEN_ENV,
	type SkillPublishResponse,
	type SkillReportedProvenance,
	type SkillSearchSort,
} from "@oh-my-pi/pi-wire/skillshare";
import { StencilCredential } from "../stencil/credential";
import { parseSkillSpec, type SkillSpec, SkillshareClient, SkillshareError } from "../skillshare/client";
import { installSkills, searchSkills, showSkillInfo, uninstallSkills, updateSkills } from "../skillshare/installer";
import { bumpVersion, type PackResult, packSkill, SEMVER_RE } from "../skillshare/pack";

export type SkillAction =
	| "publish"
	| "version"
	| "tag"
	| "yank"
	| "deprecate"
	| "owner"
	| "token"
	| "import"
	| "install"
	| "update"
	| "uninstall"
	| "search"
	| "info";

export const SKILL_ACTIONS: readonly SkillAction[] = [
	"publish",
	"version",
	"tag",
	"yank",
	"deprecate",
	"owner",
	"token",
	"import",
	"install",
	"update",
	"uninstall",
	"search",
	"info",
];

export interface SkillCommandArgs {
	action: SkillAction;
	args: string[];
	cwd: string;
	flags: {
		tag?: string;
		dryRun?: boolean;
		allowSecrets?: boolean;
		registry?: string;
		scope?: string;
		undo?: boolean;
		global?: boolean;
		yes?: boolean;
		json?: boolean;
		sort?: SkillSearchSort;
		package?: string[];
		expires?: number;
	};
}

export const SKILL_USAGE = `Usage: omp skill <action> [...]

Install and discover:
  install [@scope/name[@range]...] [-g] [--yes]   Install skills (no specs: install from skills.json)
  update [name...] [-g] [--yes]                   Update installed skills within their ranges
  uninstall <name...> [-g]                        Remove installed skills
  search <query> [--sort relevance|downloads|recent] [--json]
  info <@scope/name[@version]> [--json]

Publish and manage:
  publish [dir] [--scope s] [--tag t] [--dry-run] [--allow-secrets]
  version <patch|minor|major|x.y.z> [dir]         Bump metadata.version in SKILL.md
  tag <@scope/name@version> <tag>                 Point a dist-tag at a version
  tag rm <@scope/name> <tag>                      Remove a dist-tag
  yank <@scope/name@version> [--undo]             Hide a version from range resolution
  deprecate <@scope/name[@range]> <message|--undo>
  owner add|rm <@scope/name> <username>
  token create <name> [--package @scope/name]... [--expires days]
  token ls [--json]
  token revoke <id>
  import <file.skill>                             Publish a Claude .skill archive

Management commands accept --registry <url> (default: skills.registryUrl).
`;

function specOrThrow(raw: string | undefined, usage: string): SkillSpec {
	const spec = raw === undefined ? null : parseSkillSpec(raw);
	if (!spec)
		throw new CliUsageError(raw === undefined ? usage : `invalid package spec ${JSON.stringify(raw)}; ${usage}`);
	return spec;
}

function exactVersionOrThrow(spec: SkillSpec, usage: string): string {
	if (spec.range === undefined || !SEMVER_RE.test(spec.range)) {
		throw new CliUsageError(`an exact version is required (@scope/name@x.y.z); ${usage}`);
	}
	return spec.range;
}

function formatDate(ms: number | undefined): string {
	return ms === undefined ? "-" : new Date(ms).toISOString().slice(0, 10);
}

async function withClient<T>(
	flags: SkillCommandArgs["flags"],
	forPublish: boolean,
	fn: (client: SkillshareClient) => Promise<T>,
): Promise<T> {
	const client = await SkillshareClient.create({ registryUrl: flags.registry, forPublish });
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

/**
 * The publishing scope: `--scope`, else the `preferred_username` claim of the
 * Stencil access token (decoded without verification; the server decides).
 * A `SKILLS_TOKEN` carries no username, so it requires `--scope`.
 */
async function resolvePublishScope(client: SkillshareClient, flagScope: string | undefined): Promise<string> {
	if (flagScope !== undefined) {
		if (!SKILL_SCOPE_RE.test(flagScope)) throw new CliUsageError(`invalid --scope ${JSON.stringify(flagScope)}`);
		return flagScope;
	}
	if (process.env[SKILLS_TOKEN_ENV]?.trim()) {
		throw new CliUsageError(`--scope is required when publishing with ${SKILLS_TOKEN_ENV}`);
	}
	const token = await client.authToken();
	if (!token) throw new Error(StencilCredential.missingMessage);
	const parts = token.split(".");
	let username: unknown;
	if (parts.length === 3) {
		try {
			const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			if (payload && typeof payload === "object" && "preferred_username" in payload) {
				username = payload.preferred_username;
			}
		} catch {
			username = undefined;
		}
	}
	if (typeof username !== "string" || !SKILL_SCOPE_RE.test(username)) {
		throw new CliUsageError("cannot determine your Stencil username from the credential; pass --scope");
	}
	return username;
}

async function reportedProvenance(dir: string): Promise<SkillReportedProvenance> {
	const provenance: SkillReportedProvenance = { ompVersion: VERSION };
	try {
		const repo = vcs.git(dir);
		if (!repo) return provenance;
		const remote = await repo.remoteUrl("origin");
		if (remote) {
			// Never ship credentials embedded in an https remote.
			let sanitized = remote;
			try {
				const url = new URL(remote);
				url.username = "";
				url.password = "";
				sanitized = url.toString();
			} catch {
				sanitized = remote;
			}
			provenance.gitRemote = sanitized;
		}
		const sha = await repo.headSha();
		if (sha) provenance.gitCommit = sha;
	} catch {
		// Unborn HEAD, no origin, or unreadable repo: report only what was resolved.
	}
	return provenance;
}

/** GitHub Actions OIDC token for {@link SKILLS_OIDC_AUDIENCE}; undefined outside Actions (or without `id-token: write`). */
async function githubOidcToken(): Promise<string | undefined> {
	const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!requestUrl || !requestToken) return undefined;
	const url = new URL(requestUrl);
	url.searchParams.set("audience", SKILLS_OIDC_AUDIENCE);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`GitHub Actions OIDC token request failed (${response.status})`);
	const payload: unknown = await response.json().catch(() => null);
	if (payload && typeof payload === "object" && "value" in payload && typeof payload.value === "string") {
		return payload.value;
	}
	throw new Error("GitHub Actions OIDC token response has no value");
}

function printPack(pack: PackResult, id: string): void {
	const out = process.stdout;
	out.write(`${chalk.bold(`${id}@${pack.version}`)}\n`);
	const width = Math.max(...pack.files.map(file => formatBytes(file.size).length));
	let unpacked = 0;
	for (const file of pack.files) {
		unpacked += file.size;
		const size = formatBytes(file.size).padStart(width);
		out.write(`  ${chalk.dim(size)}  ${file.path}${file.executable ? chalk.yellow(" (executable)") : ""}\n`);
	}
	out.write(`${pack.files.length} files, ${formatBytes(unpacked)} unpacked, ${formatBytes(pack.tgz.length)} packed\n`);
	out.write(`${chalk.dim(`integrity ${pack.integrity}`)}\n`);
	if (pack.hasScripts) {
		out.write(`${chalk.yellow("ships scripts: installers are asked to confirm before installing")}\n`);
	}
}

async function handlePublish(cmd: SkillCommandArgs): Promise<number> {
	const dir = path.resolve(cmd.cwd, cmd.args[0] ?? ".");
	const pack = await packSkill(dir);

	return withClient(cmd.flags, true, async client => {
		let scope: string | undefined;
		try {
			scope = await resolvePublishScope(client, cmd.flags.scope);
		} catch (error) {
			if (!cmd.flags.dryRun) throw error;
			scope = undefined;
		}
		printPack(pack, `@${scope ?? "<scope>"}/${pack.name}`);

		if (pack.secrets.length > 0) {
			const color = cmd.flags.allowSecrets ? chalk.yellow : chalk.red;
			process.stderr.write(`${color("possible secrets found:")}\n`);
			for (const finding of pack.secrets) {
				process.stderr.write(`  ${finding.path}:${finding.line}  ${finding.kind}\n`);
			}
			if (!cmd.flags.allowSecrets) {
				process.stderr.write(
					"refusing to publish: remove them, list the files in .skillignore, or pass --allow-secrets\n",
				);
				return 1;
			}
		}

		if (cmd.flags.dryRun) {
			process.stdout.write(chalk.dim("dry run: nothing published\n"));
			return 0;
		}
		if (scope === undefined) throw new Error("publishing scope could not be resolved");

		const [provenance, githubOidc] = await Promise.all([reportedProvenance(dir), githubOidcToken()]);
		let result: SkillPublishResponse;
		try {
			result = await client.publish(scope, pack.name, pack.version, pack.tgz, {
				tag: cmd.flags.tag,
				provenance,
				githubOidc,
			});
		} catch (error) {
			if (error instanceof SkillshareError && error.status === 409) {
				throw new Error(`${error.message} (versions are immutable; bump with \`omp skill version patch\`)`);
			}
			throw error;
		}
		const tags = result.tags.length > 0 ? ` (${result.tags.join(", ")})` : "";
		process.stdout.write(`${chalk.green("+")} @${result.scope}/${result.name}@${result.version}${tags}\n`);
		process.stdout.write(`${result.url}\n`);
		return 0;
	});
}

// ---------------------------------------------------------------------------
// management
// ---------------------------------------------------------------------------

async function handleVersion(cmd: SkillCommandArgs): Promise<number> {
	const kind = cmd.args[0];
	if (!kind) throw new CliUsageError("usage: omp skill version <patch|minor|major|x.y.z> [dir]");
	const version = await bumpVersion(path.resolve(cmd.cwd, cmd.args[1] ?? "."), kind);
	process.stdout.write(`v${version}\n`);
	return 0;
}

async function handleTag(cmd: SkillCommandArgs): Promise<number> {
	if (cmd.args[0] === "rm" || cmd.args[0] === "remove") {
		const usage = "usage: omp skill tag rm <@scope/name> <tag>";
		const spec = specOrThrow(cmd.args[1], usage);
		const tag = cmd.args[2];
		if (!tag) throw new CliUsageError(usage);
		if (tag === "latest") throw new CliUsageError("the latest tag cannot be removed; point it elsewhere instead");
		await withClient(cmd.flags, false, client => client.removeTag(spec.scope, spec.name, tag));
		process.stdout.write(`- ${tag}: @${spec.scope}/${spec.name}\n`);
		return 0;
	}
	const usage = "usage: omp skill tag <@scope/name@version> <tag>";
	const spec = specOrThrow(cmd.args[0], usage);
	const version = exactVersionOrThrow(spec, usage);
	const tag = cmd.args[1];
	if (!tag) throw new CliUsageError(usage);
	if (SEMVER_RE.test(tag) || Bun.semver.satisfies(version, tag)) {
		throw new CliUsageError(`tag ${JSON.stringify(tag)} looks like a version or range; tags must be names`);
	}
	await withClient(cmd.flags, false, client => client.setTag(spec.scope, spec.name, tag, version));
	process.stdout.write(`+ ${tag}: @${spec.scope}/${spec.name}@${version}\n`);
	return 0;
}

async function handleYank(cmd: SkillCommandArgs): Promise<number> {
	const usage = "usage: omp skill yank <@scope/name@version> [--undo]";
	const spec = specOrThrow(cmd.args[0], usage);
	const version = exactVersionOrThrow(spec, usage);
	const yanked = !cmd.flags.undo;
	await withClient(cmd.flags, false, client => client.yank(spec.scope, spec.name, version, yanked));
	process.stdout.write(`${yanked ? "yanked" : "restored"} @${spec.scope}/${spec.name}@${version}\n`);
	return 0;
}

async function handleDeprecate(cmd: SkillCommandArgs): Promise<number> {
	const usage = "usage: omp skill deprecate <@scope/name[@range]> <message|--undo>";
	const spec = specOrThrow(cmd.args[0], usage);
	const text = cmd.args.slice(1).join(" ").trim();
	if (cmd.flags.undo && text) throw new CliUsageError(`pass a message or --undo, not both; ${usage}`);
	if (!cmd.flags.undo && !text) throw new CliUsageError(usage);
	if (text.length > SKILL_LIMITS.deprecationLength) {
		throw new CliUsageError(`deprecation message exceeds ${SKILL_LIMITS.deprecationLength} characters`);
	}
	const message = cmd.flags.undo ? null : text;

	return withClient(cmd.flags, false, async client => {
		let versions: string[];
		if (spec.range !== undefined && SEMVER_RE.test(spec.range)) {
			versions = [spec.range];
		} else {
			const packument = await client.packument(spec.scope, spec.name);
			const range = spec.range;
			versions = Object.keys(packument.versions).filter(
				version => range === undefined || Bun.semver.satisfies(version, range),
			);
			if (versions.length === 0) {
				process.stderr.write(`skill deprecate: no versions of @${spec.scope}/${spec.name} match ${range}\n`);
				return 1;
			}
		}
		for (const version of versions) {
			await client.deprecate(spec.scope, spec.name, version, message);
			process.stdout.write(
				`${message === null ? "undeprecated" : "deprecated"} @${spec.scope}/${spec.name}@${version}\n`,
			);
		}
		return 0;
	});
}

async function handleOwner(cmd: SkillCommandArgs): Promise<number> {
	const usage = "usage: omp skill owner add|rm <@scope/name> <username>";
	const op = cmd.args[0];
	if (op !== "add" && op !== "rm" && op !== "remove") throw new CliUsageError(usage);
	const spec = specOrThrow(cmd.args[1], usage);
	if (spec.range !== undefined) throw new CliUsageError(`owners apply to the whole package; ${usage}`);
	const username = cmd.args[2];
	if (username === undefined) throw new CliUsageError(usage);
	if (!SKILL_SCOPE_RE.test(username))
		throw new CliUsageError(`invalid username ${JSON.stringify(username)}; ${usage}`);
	await withClient(cmd.flags, false, client =>
		op === "add"
			? client.addOwner(spec.scope, spec.name, username)
			: client.removeOwner(spec.scope, spec.name, username),
	);
	process.stdout.write(`${op === "add" ? "+" : "-"} ${username}: @${spec.scope}/${spec.name}\n`);
	return 0;
}

async function handleToken(cmd: SkillCommandArgs): Promise<number> {
	const op = cmd.args[0];
	if (op === "create") {
		const usage = "usage: omp skill token create <name> [--package @scope/name]... [--expires days]";
		const name = cmd.args.slice(1).join(" ").trim();
		if (!name) throw new CliUsageError(usage);
		const packages = (cmd.flags.package ?? []).map(raw => {
			const spec = specOrThrow(raw, usage);
			if (spec.range !== undefined) throw new CliUsageError(`--package takes @scope/name without a version`);
			return `@${spec.scope}/${spec.name}`;
		});
		const expires = cmd.flags.expires;
		if (expires !== undefined && expires <= 0) throw new CliUsageError("--expires must be a positive number of days");
		const created = await withClient(cmd.flags, false, client =>
			client.createToken({
				name,
				...(packages.length > 0 && { packages }),
				...(expires !== undefined && { expiresInDays: expires }),
			}),
		);
		if (cmd.flags.json) {
			process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
			return 0;
		}
		process.stderr.write(`created token ${created.name} (${created.id})\n`);
		process.stdout.write(`${created.token}\n`);
		process.stderr.write(
			chalk.yellow(`store it now (e.g. as the ${SKILLS_TOKEN_ENV} CI secret); it cannot be shown again\n`),
		);
		return 0;
	}
	if (op === "ls" || op === "list") {
		const tokens = await withClient(cmd.flags, false, client => client.listTokens());
		if (cmd.flags.json) {
			process.stdout.write(`${JSON.stringify(tokens, null, 2)}\n`);
			return 0;
		}
		if (tokens.length === 0) {
			process.stdout.write(chalk.dim("no tokens\n"));
			return 0;
		}
		for (const token of tokens) {
			const scope = token.packages.length > 0 ? token.packages.join(", ") : "all your packages";
			process.stdout.write(
				`${chalk.bold(token.id)}  ${token.name}  ${chalk.dim(scope)}  created ${formatDate(token.createdAt)}  expires ${formatDate(token.expiresAt)}  last used ${formatDate(token.lastUsedAt)}\n`,
			);
		}
		return 0;
	}
	if (op === "revoke" || op === "rm") {
		const id = cmd.args[1];
		if (!id) throw new CliUsageError("usage: omp skill token revoke <id>");
		await withClient(cmd.flags, false, client => client.revokeToken(id));
		process.stdout.write(`revoked ${id}\n`);
		return 0;
	}
	throw new CliUsageError("usage: omp skill token create|ls|revoke");
}

async function handleImport(cmd: SkillCommandArgs): Promise<number> {
	const file = cmd.args[0];
	if (!file) throw new CliUsageError("usage: omp skill import <file.skill>");
	const resolved = path.resolve(cmd.cwd, file);
	let zip: Uint8Array;
	try {
		zip = await Bun.file(resolved).bytes();
	} catch (error) {
		if (isEnoent(error)) throw new CliUsageError(`file not found: ${resolved}`);
		throw error;
	}
	const result = await withClient(cmd.flags, false, client => client.importSkill(zip));
	const tags = result.tags.length > 0 ? ` (${result.tags.join(", ")})` : "";
	process.stdout.write(`${chalk.green("+")} @${result.scope}/${result.name}@${result.version}${tags}\n`);
	process.stdout.write(`${result.url}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function dispatch(cmd: SkillCommandArgs): Promise<number> {
	const { args, flags, cwd } = cmd;
	switch (cmd.action) {
		case "publish":
			return handlePublish(cmd);
		case "version":
			return handleVersion(cmd);
		case "tag":
			return handleTag(cmd);
		case "yank":
			return handleYank(cmd);
		case "deprecate":
			return handleDeprecate(cmd);
		case "owner":
			return handleOwner(cmd);
		case "token":
			return handleToken(cmd);
		case "import":
			return handleImport(cmd);
		case "install":
			return installSkills({ specs: args, global: flags.global === true, yes: flags.yes === true, cwd });
		case "update":
			return updateSkills({ names: args, global: flags.global === true, yes: flags.yes === true, cwd });
		case "uninstall":
			if (args.length === 0) throw new CliUsageError("usage: omp skill uninstall <name...> [-g]");
			return uninstallSkills({ names: args, global: flags.global === true, cwd });
		case "search": {
			const query = args.join(" ").trim();
			if (!query) throw new CliUsageError("usage: omp skill search <query>");
			return searchSkills({ query, sort: flags.sort ?? "relevance", json: flags.json === true });
		}
		case "info": {
			const spec = args[0];
			if (!spec) throw new CliUsageError("usage: omp skill info <@scope/name[@version]>");
			return showSkillInfo({ spec, json: flags.json === true });
		}
	}
}

/**
 * Run one `omp skill` action and return the process exit code. Usage mistakes
 * propagate as {@link CliUsageError}; registry and validation failures are
 * printed as `skill <action>: <message>` and yield 1.
 */
export async function runSkillCommand(cmd: SkillCommandArgs): Promise<number> {
	try {
		return await dispatch(cmd);
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`skill ${cmd.action}: ${message}\n`);
		return 1;
	}
}
