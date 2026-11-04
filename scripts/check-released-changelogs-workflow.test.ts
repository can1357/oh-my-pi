/**
 * The released-changelog check as GitHub runs it for a pull request, in a fixture repository that
 * stands in for GitHub. A pull request that controls the copy of the check it is judged by can make
 * the check pass, so these tests change a released section together with the check itself.
 *
 * GitHub sends both `pull_request` and `pull_request_target` for an opened pull request. "The
 * `pull_request` event ... runs the workflow file from the merge commit of the pull request", and
 * `actions/checkout` checks out that merge commit by default; with `pull_request_target` "the
 * workflow, and any subsequent `actions/checkout` call that does not specify a `ref`, is taken from
 * the base repository's default branch"
 * (https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
 * `runReleasedChangelogJobs` runs, for each event, the jobs of the repository's workflows that run
 * scripts/check-released-changelogs.ts, read from the commit GitHub would read them from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { isRecord } from "../packages/utils/src/type-guards.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CHECKER = "scripts/check-released-changelogs.ts";
const CHANGELOG = "packages/tui/CHANGELOG.md";
const MOVED_ENTRY = "- Added the branch entry";
const BASE_CHANGELOG = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01

### Fixed

- Fixed an old bug
`;
const PULL_REQUEST = { number: 1, branch: "feature", repository: "owner/repo" };
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
// Each case builds repositories with real `git` and runs every matching job, twice.
const TEST_TIMEOUT_MS = 120_000;

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await $`git ${args}`.cwd(cwd).env(GIT_ENV).quiet()).text();
}

/** The checker and every repository file it imports, relative to the repository root. */
async function checkerFiles(): Promise<string[]> {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const files = new Set<string>();
	const pending = [CHECKER];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (files.has(file)) continue;
		files.add(file);
		// The transpiler rejects the `#!` line an entry script starts with.
		const source = (await Bun.file(path.join(REPO_ROOT, file)).text()).replace(/^#!.*/, "");
		for (const { path: specifier } of transpiler.scanImports(source)) {
			if (!specifier.startsWith(".")) continue;
			const target = path.posix.join(path.posix.dirname(file), specifier);
			pending.push(path.posix.extname(target) ? target : `${target}.ts`);
		}
	}
	return [...files];
}

interface Fixture {
	root: string;
	/** The bare repository that stands in for GitHub. */
	origin: string;
	/** The clone the fixture's commits were made in. */
	work: string;
	/** First on every job's PATH, for a test's stand-in of a command the job runs. */
	bin: string;
	base: string;
	head: string;
	merge: string;
}

/**
 * A repository whose main holds this repository's workflows, the checker with what it imports, and
 * `baseChangelog`; then pull request 1, whose branch `change` makes, with the merge commit GitHub
 * builds for it. A job's `gh` is a stand-in that answers nothing, so no job reaches GitHub.
 */
async function pullRequest(change: (work: string) => Promise<void>, baseChangelog = BASE_CHANGELOG): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "released-changelogs-workflow-"));
	tempDirs.push(root);
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	await git(root, "init", "-q", "--bare", "-b", "main", origin);
	// actions/checkout fetches a commit by its id.
	await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
	await git(root, "init", "-q", "-b", "main", work);
	const workflows = await Array.fromAsync(new Bun.Glob(".github/workflows/*.{yml,yaml}").scan(REPO_ROOT));
	for (const file of [...workflows, ...(await checkerFiles())]) {
		await Bun.write(path.join(work, file), Bun.file(path.join(REPO_ROOT, file)));
	}
	await Bun.write(path.join(work, CHANGELOG), baseChangelog);
	await git(work, "add", "-A");
	await git(work, "commit", "-qm", "chore: base");
	const base = (await git(work, "rev-parse", "HEAD")).trim();
	await git(work, "checkout", "-qb", PULL_REQUEST.branch);
	await change(work);
	await git(work, "add", "-A");
	await git(work, "commit", "-qm", "feat: change");
	const head = (await git(work, "rev-parse", "HEAD")).trim();
	await git(work, "checkout", "-q", "main");
	await git(work, "merge", "-q", "--no-ff", "--no-edit", PULL_REQUEST.branch);
	const merge = (await git(work, "rev-parse", "HEAD")).trim();
	await git(
		work,
		"push",
		"-q",
		origin,
		`${base}:refs/heads/main`,
		`${head}:refs/pull/${PULL_REQUEST.number}/head`,
		`${merge}:refs/pull/${PULL_REQUEST.number}/merge`,
	);
	const bin = path.join(root, "bin");
	await Bun.write(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
	await fs.chmod(path.join(bin, "gh"), 0o755);
	return { root, origin, work, bin, base, head, merge };
}

type Event = "pull_request" | "pull_request_target" | "push";

interface Context {
	github: {
		event_name: Event;
		sha: string;
		ref: string;
		base_ref: string;
		head_ref: string;
		repository: string;
		server_url: string;
		token: string;
		event: {
			pull_request?: { number: number; head: { sha: string; ref: string }; base: { sha: string; ref: string } };
			/** A push's previous tip of the branch. */
			before?: string;
		};
	};
}

interface JobRun {
	event: Event;
	job: string;
	exitCode: number;
	output: string;
}

type Yaml = Record<string, unknown>;

/** The value of `github.event.pull_request.head.sha` and the like; anything else is not simulated. */
function lookup(expression: string, context: Context): string {
	let value: unknown = context;
	for (const key of expression.trim().split(".")) value = isRecord(value) ? value[key] : undefined;
	if (typeof value !== "string" && typeof value !== "number") throw new Error(`unsupported expression: ${expression}`);
	return String(value);
}

function substitute(text: string, context: Context): string {
	return text.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => lookup(expression, context));
}

/** A job `if:` of `a == 'b'` and `a != 'b'` terms joined by `&&`. */
function condition(expression: string, context: Context): boolean {
	const body = expression.replace(/^\s*\$\{\{(.*)\}\}\s*$/s, "$1");
	return body.split("&&").every(term => {
		const match = /^\s*([\w.]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(term);
		if (!match) throw new Error(`unsupported condition: ${expression}`);
		return (lookup(match[1], context) === match[3]) === (match[2] === "==");
	});
}

/**
 * Whether the workflow's `on:` starts it for this event on main (a pull request into main, or a push
 * to main), given the files it changes.
 */
function triggers(workflow: Yaml, event: Event, changed: readonly string[]): boolean {
	// YAML 1.1 reads the `on` key as `true`.
	const on = workflow.on ?? workflow.true;
	if (typeof on === "string") return on === event;
	if (Array.isArray(on)) return on.includes(event);
	if (!isRecord(on) || !(event in on)) return false;
	const filter = on[event] ?? {};
	if (!isRecord(filter)) throw new Error(`unsupported ${event} filter`);
	for (const key of Object.keys(filter)) {
		const known = ["branches", "types", "paths", "paths-ignore"];
		if (event === "push") known.push("branches-ignore", "tags", "tags-ignore");
		if (!known.includes(key)) throw new Error(`unsupported filter ${key}`);
	}
	const matches = (patterns: unknown, file: string) =>
		Array.isArray(patterns) && patterns.some(pattern => new Bun.Glob(String(pattern)).match(file));
	if (Array.isArray(filter.branches) && !filter.branches.some(branch => new Bun.Glob(String(branch)).match("main"))) {
		return false;
	}
	if (matches(filter["branches-ignore"], "main")) return false;
	// A push filter that names only tags starts nothing for a branch.
	const namesTags = filter.tags !== undefined || filter["tags-ignore"] !== undefined;
	if (namesTags && filter.branches === undefined && filter["branches-ignore"] === undefined) return false;
	if (Array.isArray(filter.types) && !filter.types.includes("opened")) return false;
	if (filter.paths && !changed.some(file => matches(filter.paths, file))) return false;
	if (filter["paths-ignore"] && changed.every(file => matches(filter["paths-ignore"], file))) return false;
	return true;
}

function stepEnv(env: unknown, context: Context): Record<string, string> {
	if (env === undefined) return {};
	if (!isRecord(env)) throw new Error("unsupported env");
	return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, substitute(String(value), context)]));
}

/** `NAME=value` lines a step appended to `$GITHUB_ENV`. */
async function githubEnv(file: string): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const line of (await Bun.file(file).text()).split("\n")) {
		if (line.length === 0) continue;
		const equals = line.indexOf("=");
		if (equals <= 0 || line.includes("<<")) throw new Error(`unsupported GITHUB_ENV line: ${line}`);
		env[line.slice(0, equals)] = line.slice(equals + 1);
	}
	return env;
}

async function runJob(fixture: Fixture, context: Context, workflow: Yaml, id: string, job: Yaml): Promise<JobRun> {
	const event = context.github.event_name;
	const workspace = path.join(fixture.root, `${event}-${id}`);
	const envFile = path.join(fixture.root, `${event}-${id}.env`);
	await Bun.write(envFile, "");
	const env = {
		...GIT_ENV,
		PATH: [fixture.bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
		GITHUB_ACTIONS: "true",
		GITHUB_EVENT_NAME: event,
		GITHUB_SHA: context.github.sha,
		GITHUB_REF: context.github.ref,
		GITHUB_BASE_REF: context.github.base_ref,
		GITHUB_HEAD_REF: context.github.head_ref,
		GITHUB_REPOSITORY: context.github.repository,
		GITHUB_SERVER_URL: context.github.server_url,
		GITHUB_WORKSPACE: workspace,
		GITHUB_ENV: envFile,
		...stepEnv(workflow.env, context),
		...stepEnv(job.env, context),
	};
	let output = "";
	const steps = Array.isArray(job.steps) ? job.steps : [];
	for (const step of steps) {
		if (!isRecord(step)) throw new Error("unsupported step");
		if (step.if !== undefined || step["working-directory"] !== undefined) throw new Error("unsupported step keys");
		const uses = typeof step.uses === "string" ? step.uses : undefined;
		if (uses?.startsWith("actions/checkout@")) {
			const inputs = isRecord(step.with) ? step.with : {};
			for (const key of Object.keys(inputs)) {
				if (!["ref", "fetch-depth", "persist-credentials"].includes(key))
					throw new Error(`unsupported input ${key}`);
			}
			const ref = inputs.ref === undefined ? context.github.sha : substitute(String(inputs.ref), context);
			const depth = Number(inputs["fetch-depth"] ?? 1);
			await git(fixture.root, "init", "-q", workspace);
			await git(workspace, "remote", "add", "origin", `file://${fixture.origin}`);
			await git(workspace, "fetch", "-q", "--no-tags", ...(depth > 0 ? [`--depth=${depth}`] : []), "origin", ref);
			await git(workspace, "checkout", "-q", "--detach", "FETCH_HEAD");
			continue;
		}
		// Bun is already on PATH.
		if (uses?.startsWith("oven-sh/setup-bun@")) continue;
		if (uses !== undefined) throw new Error(`unsupported action ${uses}`);
		if (typeof step.run !== "string" || (step.shell !== undefined && step.shell !== "bash")) {
			throw new Error("unsupported run step");
		}
		const script = path.join(fixture.root, `${event}-${id}-step.sh`);
		await Bun.write(script, substitute(step.run, context));
		const result = await $`bash --noprofile --norc -eo pipefail ${script}`
			.cwd(workspace)
			.env({ ...env, ...(await githubEnv(envFile)), ...stepEnv(step.env, context) })
			.quiet()
			.nothrow();
		output += `${result.stdout}${result.stderr}`;
		if (result.exitCode !== 0) return { event, job: id, exitCode: result.exitCode, output };
	}
	return { event, job: id, exitCode: 0, output };
}

/** Runs every job of the workflows at `context.github.sha` that `context`'s event starts and that runs the check. */
async function runCheckJobs(fixture: Fixture, context: Context, changed: readonly string[]): Promise<JobRun[]> {
	const runs: JobRun[] = [];
	const sha = context.github.sha;
	const listed = await git(fixture.origin, "ls-tree", "-z", "--name-only", sha, "--", ".github/workflows/");
	for (const file of listed.split("\0").filter(name => /\.ya?ml$/.test(name))) {
		const workflow = Bun.YAML.parse(await git(fixture.origin, "show", `${sha}:${file}`));
		if (!isRecord(workflow) || !triggers(workflow, context.github.event_name, changed) || !isRecord(workflow.jobs)) {
			continue;
		}
		for (const [id, job] of Object.entries(workflow.jobs)) {
			if (!isRecord(job) || !Array.isArray(job.steps)) continue;
			const checks = job.steps.some(step => isRecord(step) && String(step.run ?? "").includes(CHECKER));
			if (!checks || (typeof job.if === "string" && !condition(job.if, context))) continue;
			if (job.needs !== undefined) throw new Error(`unsupported needs in ${id}`);
			runs.push(await runJob(fixture, context, workflow, id, job));
		}
	}
	return runs;
}

/** Every job GitHub would start for the opened pull request that runs the released-changelog check. */
async function runReleasedChangelogJobs(fixture: Fixture): Promise<JobRun[]> {
	const changed = (await git(fixture.origin, "diff", "--name-only", "-z", `${fixture.base}...${fixture.head}`))
		.split("\0")
		.filter(file => file.length > 0);
	const runs: JobRun[] = [];
	for (const event of ["pull_request", "pull_request_target"] as const) {
		// GITHUB_SHA and GITHUB_REF for each event, from "Events that trigger workflows".
		const context: Context = {
			github: {
				event_name: event,
				sha: event === "pull_request" ? fixture.merge : fixture.base,
				ref: event === "pull_request" ? `refs/pull/${PULL_REQUEST.number}/merge` : "refs/heads/main",
				base_ref: "main",
				head_ref: PULL_REQUEST.branch,
				repository: PULL_REQUEST.repository,
				server_url: "https://github.com",
				token: "simulated-token",
				event: {
					pull_request: {
						number: PULL_REQUEST.number,
						head: { sha: fixture.head, ref: PULL_REQUEST.branch },
						base: { sha: fixture.base, ref: "main" },
					},
				},
			},
		};
		runs.push(...(await runCheckJobs(fixture, context, changed)));
	}
	return runs;
}

/** Every job GitHub would start for a push that moves main from `before` to `after` that runs the check. */
async function runPushJobs(fixture: Fixture, before: string, after: string): Promise<JobRun[]> {
	const changed = (await git(fixture.origin, "diff", "--name-only", "-z", before, after))
		.split("\0")
		.filter(file => file.length > 0);
	const context: Context = {
		github: {
			event_name: "push",
			sha: after,
			ref: "refs/heads/main",
			base_ref: "",
			head_ref: "",
			repository: PULL_REQUEST.repository,
			server_url: "https://github.com",
			token: "simulated-token",
			event: { before },
		},
	};
	return runCheckJobs(fixture, context, changed);
}

/**
 * Stands in for `gh` in the fixture's jobs: `gh pr list` prints `listed`, as its `--jq` filter would,
 * and every other call prints nothing. Returns the calls made, one argument list per line.
 */
async function fakeGh(fixture: Fixture, listed: string): Promise<() => Promise<string[]>> {
	const log = path.join(fixture.root, "gh-calls");
	const answer = path.join(fixture.root, "gh-pr-list");
	await Bun.write(answer, listed);
	await Bun.write(
		path.join(fixture.bin, "gh"),
		`#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2" = "pr list" ]; then cat '${answer}'; fi\n`,
	);
	await fs.chmod(path.join(fixture.bin, "gh"), 0o755);
	return async () => {
		const text = await Bun.file(log)
			.text()
			.catch(() => "");
		return text.split("\n").filter(line => line.length > 0);
	};
}

/** The defect the check exists for: an entry put into a released section. */
async function moveEntryIntoRelease(work: string): Promise<void> {
	await Bun.write(
		path.join(work, CHANGELOG),
		BASE_CHANGELOG.replace("- Fixed an old bug\n", `- Fixed an old bug\n${MOVED_ENTRY}\n`),
	);
}

/** Replaces `search` in a file of the pull request, failing when the file no longer holds it. */
async function rewrite(work: string, file: string, search: string, replacement: string): Promise<void> {
	const text = await Bun.file(path.join(work, file)).text();
	if (!text.includes(search)) throw new Error(`${file} no longer holds ${search}`);
	await Bun.write(path.join(work, file), text.replaceAll(search, replacement));
}

/** A pull request that adds a second level-1 heading, `# Notes`, under the changelog's title. */
const SECOND_TITLE = (work: string) => rewrite(work, CHANGELOG, "# Changelog\n", "# Changelog\n\n# Notes\n");

/**
 * Main as it was before a commit that tightened the check: from `start`, a commit whose fixer reads any level-1
 * heading above the first release as the title, so `# Notes` passes; then `change`, if given, as a commit; then the
 * commit that requires one `# Changelog` title again and changes no released section. Returns both commits.
 */
async function tightenedAfter(
	fixture: Fixture,
	start: string,
	change?: (work: string) => Promise<void>,
): Promise<{ older: string; tightened: string }> {
	await git(fixture.work, "checkout", "-q", "--detach", start);
	await rewrite(
		fixture.work,
		"scripts/fix-changelogs.ts",
		"} else if (!titled && line === CHANGELOG_TITLE) {",
		"} else if (/^# \\S/.test(line)) {",
	);
	await git(fixture.work, "commit", "-qam", "chore: the check before it required one title");
	if (change) {
		await change(fixture.work);
		await git(fixture.work, "commit", "-qam", "chore: release");
	}
	const older = (await git(fixture.work, "rev-parse", "HEAD")).trim();
	await git(fixture.work, "checkout", "-q", start, "--", "scripts/fix-changelogs.ts");
	await git(fixture.work, "commit", "-qm", "ci: require one # Changelog title");
	return { older, tightened: (await git(fixture.work, "rev-parse", "HEAD")).trim() };
}

/** The merge GitHub builds of `head` on `base`; its objects reach the fixture's origin under a ref of its own. */
async function mergeOn(fixture: Fixture, base: string, head: string, name: string): Promise<string> {
	await git(fixture.work, "checkout", "-q", "--detach", base);
	await git(fixture.work, "merge", "-q", "--no-ff", "--no-edit", head);
	const merge = (await git(fixture.work, "rev-parse", "HEAD")).trim();
	await git(fixture.work, "push", "-q", fixture.origin, `${merge}:refs/released-changelogs/${name}`);
	return merge;
}

/**
 * Stands in for `sleep` in the fixture's jobs: it returns at once, records the seconds asked for,
 * and first runs `onSleep`, the part of GitHub that acts while a job waits.
 */
async function fakeSleep(fixture: Fixture, onSleep: string): Promise<() => Promise<number[]>> {
	const log = path.join(fixture.root, "sleeps");
	await Bun.write(path.join(fixture.bin, "sleep"), `#!/bin/sh\necho "$1" >> '${log}'\n${onSleep}\n`);
	await fs.chmod(path.join(fixture.bin, "sleep"), 0o755);
	return async () => {
		const text = await Bun.file(log)
			.text()
			.catch(() => "");
		return text
			.split("\n")
			.filter(line => line.length > 0)
			.map(Number);
	};
}

describe("released changelog check in CI", () => {
	test(
		"passes a pull request that adds an [Unreleased] entry",
		async () => {
			const fixture = await pullRequest(work =>
				rewrite(work, CHANGELOG, "## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${MOVED_ENTRY}\n`),
			);
			const runs = await runReleasedChangelogJobs(fixture);
			expect(runs.length).toBeGreaterThan(0);
			expect(runs.filter(run => run.exitCode !== 0)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test.each([
		{ name: "and nothing else", tamper: async () => {} },
		{
			name: "and replaces the checker with one that always passes",
			tamper: (work: string) =>
				Bun.write(path.join(work, CHECKER), 'console.log("Released changelog sections match.");\n'),
		},
		{
			name: "and makes normalizeSection, which the checker imports, drop every line",
			tamper: (work: string) =>
				rewrite(
					work,
					"scripts/fix-changelogs.ts",
					"export function normalizeSection(section: ReleaseSection): FixCounters {\n",
					"export function normalizeSection(section: ReleaseSection): FixCounters {\n\tsection.leadingLines = [];\n\tsection.subsections = [];\n",
				),
		},
		{
			name: "and edits every workflow that runs the check to run nothing",
			tamper: async (work: string) => {
				let edited = 0;
				for await (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scan(work)) {
					const text = await Bun.file(path.join(work, file)).text();
					if (!text.includes(`bun ${CHECKER}`)) continue;
					await Bun.write(path.join(work, file), text.replaceAll(`bun ${CHECKER}`, `true ${CHECKER}`));
					edited++;
				}
				expect(edited).toBeGreaterThan(0);
			},
		},
	])(
		"fails a pull request that puts an entry into a released section $name",
		async ({ tamper }) => {
			const fixture = await pullRequest(async work => {
				await moveEntryIntoRelease(work);
				await tamper(work);
			});
			const runs = await runReleasedChangelogJobs(fixture);
			// The real checker names the line; a pull request's tampered copy passes, or never runs.
			const failed = runs.filter(run => run.exitCode !== 0 && run.output.includes(`    ${MOVED_ENTRY}\n`));
			expect(failed).not.toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"waits while the merge ref is still the merge of an earlier head, then checks the merge of this head",
		async () => {
			const fixture = await pullRequest(moveEntryIntoRelease);
			// Until GitHub builds the new merge, refs/pull/1/merge is that of an earlier head, which passes.
			await git(fixture.work, "checkout", "-q", "-b", "earlier", fixture.base);
			await rewrite(
				fixture.work,
				CHANGELOG,
				"## [Unreleased]\n",
				`## [Unreleased]\n\n### Added\n\n${MOVED_ENTRY}\n`,
			);
			await git(fixture.work, "commit", "-qam", "feat: earlier head");
			await git(fixture.work, "checkout", "-q", "--detach", fixture.base);
			await git(fixture.work, "merge", "-q", "--no-ff", "--no-edit", "earlier");
			const earlier = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			const ref = `refs/pull/${PULL_REQUEST.number}/merge`;
			await git(fixture.work, "push", "-q", "--force", fixture.origin, `${earlier}:${ref}`);
			// GitHub builds the merge of this head while the job sleeps.
			const sleeps = await fakeSleep(
				fixture,
				`git --git-dir='${fixture.origin}' update-ref ${ref} ${fixture.merge}`,
			);

			const runs = await runReleasedChangelogJobs(fixture);
			const failed = runs.filter(run => run.exitCode !== 0 && run.output.includes(`    ${MOVED_ENTRY}\n`));
			expect(failed.map(run => run.event)).toEqual(["pull_request_target"]);
			expect(await sleeps()).toEqual([10]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"waits while the merge ref is built on a base older than the base branch's tip, then checks the merge on the tip",
		async () => {
			const first = "- Added the first entry";
			const withEntry = BASE_CHANGELOG.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${first}\n`);
			// The pull request adds an entry after the first; merged on the old base, it stays unreleased.
			const fixture = await pullRequest(
				work => rewrite(work, CHANGELOG, `${first}\n`, `${first}\n${MOVED_ENTRY}\n`),
				withEntry,
			);
			// Then main releases 1.1.0. Merged on that tip, git puts the entry under the release, with no conflict.
			await git(fixture.work, "checkout", "-q", "--detach", fixture.base);
			await rewrite(
				fixture.work,
				CHANGELOG,
				"## [Unreleased]\n\n",
				"## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n",
			);
			await git(fixture.work, "commit", "-qam", "chore: release 1.1.0");
			const released = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			await git(fixture.work, "merge", "-q", "--no-ff", "--no-edit", fixture.head);
			const current = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			// The rebuilt merge's objects reach GitHub with it; its ref appears only during the wait below.
			const pending = "refs/released-changelogs/pending";
			await git(fixture.work, "push", "-q", fixture.origin, `${released}:refs/heads/main`, `${current}:${pending}`);
			const ref = `refs/pull/${PULL_REQUEST.number}/merge`;
			// GitHub rebuilds the merge on the new tip while the job sleeps; until then it is the stale one.
			const sleeps = await fakeSleep(fixture, `git --git-dir='${fixture.origin}' update-ref ${ref} ${current}`);

			const runs = await runReleasedChangelogJobs({ ...fixture, base: released, merge: current });
			const failed = runs.filter(run => run.exitCode !== 0 && run.output.includes(`    ${MOVED_ENTRY}\n`));
			expect(failed.map(run => run.event)).toEqual(["pull_request_target"]);
			expect(await sleeps()).toEqual([10]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"re-checks each open pull request after a push to main releases, and fails for one whose merge now moves an entry into the release",
		async () => {
			const first = "- Added the first entry";
			const withEntry = BASE_CHANGELOG.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n${first}\n`);
			const fixture = await pullRequest(
				work => rewrite(work, CHANGELOG, `${first}\n`, `${first}\n${MOVED_ENTRY}\n`),
				withEntry,
			);
			// Merged on the base it was opened against, the pull request keeps every released section.
			const opened = (await runReleasedChangelogJobs(fixture)).filter(run => run.event === "pull_request_target");
			expect(opened.map(run => run.exitCode)).toEqual([0]);

			// Then main releases 1.1.0. The pull request's head does not change, so GitHub runs nothing for it.
			await git(fixture.work, "checkout", "-q", "--detach", fixture.base);
			await rewrite(
				fixture.work,
				CHANGELOG,
				"## [Unreleased]\n\n",
				"## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n",
			);
			await git(fixture.work, "commit", "-qam", "chore: release 1.1.0");
			const released = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			await git(fixture.work, "merge", "-q", "--no-ff", "--no-edit", fixture.head);
			const current = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			const pending = "refs/released-changelogs/pending";
			await git(fixture.work, "push", "-q", fixture.origin, `${released}:refs/heads/main`, `${current}:${pending}`);
			// GitHub rebuilds pull request 1's merge on the new tip while the job waits. Pull request 2
			// conflicts with main, so GitHub builds no merge for it.
			const ref = `refs/pull/${PULL_REQUEST.number}/merge`;
			await fakeSleep(fixture, `git --git-dir='${fixture.origin}' update-ref ${ref} ${current}`);
			const calls = await fakeGh(fixture, `${PULL_REQUEST.number} ${fixture.head}\n2 ${"b".repeat(40)}\n`);

			const runs = await runPushJobs(fixture, fixture.base, released);
			expect(runs.map(run => run.exitCode)).toEqual([1]);
			const output = runs[0]?.output ?? "";
			expect(output).toContain(`    ${MOVED_ENTRY}\n`);
			expect(output).toContain(`::error title=Released changelogs, pull request #${PULL_REQUEST.number}::`);
			expect(output).toContain("::warning title=Released changelogs, pull request #2::");
			// Open pull requests into main are the ones a merge button can still merge.
			const listed = (await calls()).filter(call => call.startsWith("pr list "));
			expect(listed.map(call => call.includes("--base main --state open"))).toEqual([true]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"leaves open pull requests alone after a push to main that changes no released section",
		async () => {
			const fixture = await pullRequest(moveEntryIntoRelease);
			await git(fixture.work, "checkout", "-q", "--detach", fixture.base);
			await rewrite(
				fixture.work,
				CHANGELOG,
				"## [Unreleased]\n",
				`## [Unreleased]\n\n### Added\n\n${MOVED_ENTRY}\n`,
			);
			await git(fixture.work, "commit", "-qam", "feat: an unreleased entry");
			const tip = (await git(fixture.work, "rev-parse", "HEAD")).trim();
			await git(fixture.work, "push", "-q", fixture.origin, `${tip}:refs/heads/main`);
			const calls = await fakeGh(fixture, `${PULL_REQUEST.number} ${fixture.head}\n`);

			const runs = await runPushJobs(fixture, fixture.base, tip);
			expect(runs.map(run => run.exitCode)).toEqual([0]);
			expect(runs[0]?.output).toContain("No released changelog section changed");
			expect(await calls()).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"judges the merge with the check of the base branch's tip it waited for, not that of the older commit the event names",
		async () => {
			const fixture = await pullRequest(SECOND_TITLE);
			// The event names `older`; before the job runs, main gets a commit that only tightens the check.
			const { older, tightened } = await tightenedAfter(fixture, fixture.base);
			const stale = await mergeOn(fixture, older, fixture.head, "stale");
			const current = await mergeOn(fixture, tightened, fixture.head, "current");
			const ref = `refs/pull/${PULL_REQUEST.number}/merge`;
			await git(
				fixture.work,
				"push",
				"-q",
				"--force",
				fixture.origin,
				`${tightened}:refs/heads/main`,
				`${stale}:${ref}`,
			);
			// GitHub rebuilds the merge on the new tip while the job waits.
			const sleeps = await fakeSleep(fixture, `git --git-dir='${fixture.origin}' update-ref ${ref} ${current}`);

			const runs = await runReleasedChangelogJobs({ ...fixture, base: older, merge: current });
			const target = runs.filter(run => run.event === "pull_request_target");
			// Only the tightened check refuses `# Notes`; the older one passes it.
			expect(target.map(run => run.exitCode)).toEqual([1]);
			expect(target[0]?.output).toContain('"# Notes": Markdown shows a level-1 heading "Notes"');
			expect(await sleeps()).toEqual([10]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"checks open pull requests after a release with the check of main's tip, when a later commit tightened it",
		async () => {
			const fixture = await pullRequest(SECOND_TITLE);
			// A release under the older check, then a commit that only tightens the check; the push of the
			// tightening changes no released section, so only the release's run checks the pull request.
			const release = (work: string) =>
				rewrite(
					work,
					CHANGELOG,
					"## [Unreleased]\n\n",
					"## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Added\n\n- Added in 1.1.0\n\n",
				);
			const { older: released, tightened } = await tightenedAfter(fixture, fixture.base, release);
			const current = await mergeOn(fixture, tightened, fixture.head, "current");
			const ref = `refs/pull/${PULL_REQUEST.number}/merge`;
			await git(fixture.work, "push", "-q", "--force", fixture.origin, `${tightened}:refs/heads/main`);
			await git(fixture.origin, "update-ref", "-d", ref);
			await fakeSleep(fixture, `git --git-dir='${fixture.origin}' update-ref ${ref} ${current}`);
			await fakeGh(fixture, `${PULL_REQUEST.number} ${fixture.head}\n`);

			const before = (await git(fixture.work, "rev-parse", `${released}^`)).trim();
			const runs = await runPushJobs(fixture, before, released);
			expect(runs.map(run => run.exitCode)).toEqual([1]);
			expect(runs[0]?.output).toContain('"# Notes": Markdown shows a level-1 heading "Notes"');
			expect(runs[0]?.output).toContain(`::error title=Released changelogs, pull request #${PULL_REQUEST.number}::`);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails within its two-minute wait, and says why, when GitHub builds no merge, as for a pull request that conflicts",
		async () => {
			const fixture = await pullRequest(moveEntryIntoRelease);
			await git(fixture.origin, "update-ref", "-d", `refs/pull/${PULL_REQUEST.number}/merge`);
			const sleeps = await fakeSleep(fixture, ":");

			const runs = await runReleasedChangelogJobs(fixture);
			const target = runs.filter(run => run.event === "pull_request_target");
			expect(target.map(run => run.exitCode)).toEqual([1]);
			expect(target[0]?.output).toContain(
				"::error title=Released changelog check could not run::GitHub has not built the merge of this pull request's head",
			);
			expect((await sleeps()).reduce((total, seconds) => total + seconds, 0)).toBe(120);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"fails a pull request whose merge holds a package path that is not UTF-8, which would read as another package's",
		async () => {
			const unreleased = BASE_CHANGELOG.slice(0, BASE_CHANGELOG.indexOf("## [1.0.0]"));
			const fabricated = `${unreleased}## [9.9.9] - 2026-01-01\n\n### Added\n\n- Fabricated release\n`;
			// Byte 0x80 decodes, lossily, to U+FFFD: the name of the package beside it.
			const script = [
				`raw="packages/$(printf '\\200')"`,
				`replacement="packages/$(printf '\\357\\277\\275')"`,
				`mkdir -p "$raw" "$replacement"`,
				`printf '%s' "$1" > "$raw/CHANGELOG.md"`,
				`printf '%s' "$2" > "$replacement/CHANGELOG.md"`,
			].join("\n");
			const fixture = await pullRequest(async work => {
				await $`bash -c ${script} _ ${fabricated} ${unreleased}`.cwd(work).quiet();
			});

			const runs = await runReleasedChangelogJobs(fixture);
			const target = runs.filter(run => run.event === "pull_request_target");
			expect(target.map(run => run.exitCode)).toEqual([2]);
			expect(target[0]?.output).toContain("that is not UTF-8");
		},
		TEST_TIMEOUT_MS,
	);

	// Markdown shows each of these as a level-2 release heading; the checker reads only `## [`.
	test.each([
		{ name: "two spaces after the #s", heading: "##  [9.9.9] - 2026-11-02" },
		{ name: "a tab after the #s", heading: "##\t[9.9.9] - 2026-11-02" },
		{ name: "one space before the #s", heading: " ## [9.9.9] - 2026-11-02" },
		{ name: "a dashed underline", heading: "[9.9.9] - 2026-11-02\n---------" },
	])(
		"fails a pull request that adds a release written with $name, and one that deletes such a release from main",
		async ({ heading }) => {
			const fabricated = await pullRequest(work =>
				rewrite(work, CHANGELOG, "## [1.0.0]", `${heading}\n\n### Added\n\n- Fabricated as shipped\n\n## [1.0.0]`),
			);
			const added = (await runReleasedChangelogJobs(fabricated)).filter(run => run.event === "pull_request_target");
			expect(added.map(run => run.exitCode)).toEqual([1]);
			expect(added[0]?.output).toContain("Markdown shows a level-2 heading");

			const published = BASE_CHANGELOG.replace("## [1.0.0]", `${heading}\n\n### Fixed\n\n- Published\n\n## [1.0.0]`);
			const deleted = await pullRequest(async work => {
				await Bun.write(path.join(work, CHANGELOG), BASE_CHANGELOG);
			}, published);
			const removed = (await runReleasedChangelogJobs(deleted)).filter(run => run.event === "pull_request_target");
			expect(removed.map(run => run.exitCode)).toEqual([2]);
			expect(removed[0]?.output).toContain(`${CHANGELOG} at the base, line`);
		},
		2 * TEST_TIMEOUT_MS,
	);
});
