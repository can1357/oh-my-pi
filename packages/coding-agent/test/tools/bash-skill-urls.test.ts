import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	HistoryProtocolHandler,
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type LocalProtocolOptions,
	type ProtocolHandler,
	type ResolveContext,
	resolveLocalUrlToPath,
	type SchemeSpec,
	VaultProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { UrlContainmentError } from "@oh-my-pi/pi-coding-agent/internal-urls/filesystem-resource";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

/** File-backed test scheme: locates URLs from a fixed table; `error`/`escape` entries throw plain/containment errors. */
class FixtureProtocolHandler implements ProtocolHandler {
	readonly scheme = "fixture";
	readonly spec: SchemeSpec = { backing: "file", selectors: "lines", immutable: true, shellOperand: true };

	readonly #entries: Record<string, { path?: string; error?: string; escape?: string }>;

	constructor(entries: Record<string, { path?: string; error?: string; escape?: string }>) {
		this.#entries = entries;
	}

	async resolve(): Promise<InternalResource> {
		throw new Error("fixture:// is locate-only");
	}

	async locate(url: InternalUrl): Promise<string | null> {
		const entry = this.#entries[url.rawHref ?? url.href];
		if (entry?.error) throw new Error(entry.error);
		if (entry?.escape) throw new UrlContainmentError(entry.escape);
		return entry?.path ?? null;
	}
}

let tempDir: string;
let skill: Skill;
let localOptions: LocalProtocolOptions;
let context: ResolveContext;
/** Session artifact #0 (`artifact://0`). */
let artifactLog: string;

beforeAll(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-url-expand-")));
	const baseDir = path.join(tempDir, "skills", "valid-skill");
	await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
	await fs.writeFile(path.join(baseDir, "SKILL.md"), "---\nname: valid-skill\ndescription: d\n---\nBody\n");
	await fs.writeFile(path.join(baseDir, "scripts", "init.py"), "print('hi')\n");
	skill = {
		name: "valid-skill",
		description: "valid-skill description",
		filePath: path.join(baseDir, "SKILL.md"),
		baseDir,
		source: "test",
	};
	artifactLog = path.join(tempDir, "artifacts", "0.bash.log");
	await fs.mkdir(path.dirname(artifactLog), { recursive: true });
	await fs.writeFile(artifactLog, "log\n");
	localOptions = {
		getArtifactsDir: () => path.join(tempDir, "artifacts"),
		getSessionId: () => "session-1",
	};
	context = { skills: [skill], localProtocolOptions: localOptions };
	InternalUrlRouter.instance().register(
		new FixtureProtocolHandler({
			"fixture://12": { path: "/tmp/artifacts/12.bash.log" },
			"fixture://7": { path: "/tmp/artifacts/with'quote.log" },
			"fixture://reviewer?q=needle": { path: "/tmp/session/reviewer.md" },
			"fixture://missing": { error: "Fixture file not found" },
			"fixture://escape": { escape: "fixture:// escaped" },
			"fixture://escape-text": { error: "fixture:// URL escapes fixture root" },
		}),
	);
});

afterAll(async () => {
	InternalUrlRouter.instance().unregister("fixture");
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("expandInternalUrls", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never expands locatable schemes that are not shell operands (proc://, history://, vault://)", async () => {
		// Each of these locates a real backing file (service log, transcript, vault note), but
		// the file is not what the URL means to a shell: `echo x > proc://web` sends stdin.
		for (const handler of [ProcProtocolHandler, HistoryProtocolHandler, VaultProtocolHandler]) {
			vi.spyOn(handler.prototype, "locate").mockResolvedValue("/tmp/backing/output.log");
		}
		for (const command of ["echo x > proc://web", "cat history://Worker", "cat vault://Work/note.md"]) {
			await expect(expandInternalUrls(command, { context, create: true })).resolves.toBe(command);
		}
	});

	it("expands URLs of different locatable schemes in one command", async () => {
		const command = "cat fixture://12 skill://valid-skill/scripts/init.py";

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape(path.join(skill.baseDir, "scripts/init.py"))}`,
		);
	});

	it("expands quoted URLs and shell-escapes quotes in paths", async () => {
		await expect(expandInternalUrls('cat "fixture://7"', { context })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
		await expect(expandInternalUrls("cmp 'fixture://12' fixture://12", { context })).resolves.toBe(
			`cmp ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/artifacts/12.bash.log")}`,
		);
	});

	it("keeps query parameters in an unquoted URL", async () => {
		await expect(expandInternalUrls("cat fixture://reviewer?q=needle", { context })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer.md")}`,
		);
	});

	it("leaves unregistered-scheme URLs unchanged", async () => {
		for (const command of ["curl https://example.com/a", "cat nosuchscheme://x"]) {
			await expect(expandInternalUrls(command, { context })).resolves.toBe(command);
		}
	});

	it("fails closed on shell operands that locate nothing or fail to locate", async () => {
		// Passed through raw, the shell would read `scheme:/…` as a relative path.
		await expect(expandInternalUrls("cat fixture://unknown", { context })).rejects.toThrow(
			"fixture://unknown does not exist",
		);
		await expect(expandInternalUrls("cat fixture://missing", { context })).rejects.toThrow("Fixture file not found");
		await expect(expandInternalUrls("cat fixture://escape-text", { context })).rejects.toThrow(
			"fixture:// URL escapes fixture root",
		);
	});

	it("fails closed on a missing artifact:// operand", async () => {
		await expect(expandInternalUrls("cat artifact://99", { context })).rejects.toThrow(
			"artifact://99 does not exist",
		);
	});

	it("leaves URL mentions in heredoc bodies and comments verbatim while expanding real operands", async () => {
		const artifact0 = shellEscape(artifactLog);
		const cases: Array<[string, string]> = [
			[
				"cat > notes.md <<EOF\nsee artifact://99 and artifact://0\nEOF\ncat artifact://0",
				`cat > notes.md <<EOF\nsee artifact://99 and artifact://0\nEOF\ncat ${artifact0}`,
			],
			[
				"cat > notes.md <<-'END'\n\tartifact://99\n\tEND\ncat artifact://0",
				`cat > notes.md <<-'END'\n\tartifact://99\n\tEND\ncat ${artifact0}`,
			],
			["cat artifact://0 # artifact://99 is gone", `cat ${artifact0} # artifact://99 is gone`],
			// An apostrophe in data text opens no quote that would hide later operands.
			[
				"cat > a.md <<EOF\nit's artifact://99\nEOF\ncat artifact://0",
				`cat > a.md <<EOF\nit's artifact://99\nEOF\ncat ${artifact0}`,
			],
			["true # don't\ncat artifact://0", `true # don't\ncat ${artifact0}`],
			// Arithmetic shifts and here-strings open no heredoc.
			["echo $((1<<2)); cat artifact://0", `echo $((1<<2)); cat ${artifact0}`],
			["grep x <<< hi; cat artifact://0", `grep x <<< hi; cat ${artifact0}`],
		];
		for (const [command, expected] of cases) {
			await expect(expandInternalUrls(command, { context })).resolves.toBe(expected);
		}
	});

	it("refuses line selectors on shell operands instead of silently addressing the whole file", async () => {
		for (const command of [
			"echo x > local://out.txt:5",
			"cat local://notes.md:1-5",
			"cat skill://valid-skill/SKILL.md:1-5",
		]) {
			await expect(expandInternalUrls(command, { context, create: true })).rejects.toThrow(/whole file/);
		}
		await expect(fs.stat(resolveLocalUrlToPath("local://out.txt", localOptions))).rejects.toThrow();
		await expect(expandInternalUrls("cat skill://valid-skill/SKILL.md:raw", { context })).resolves.toBe(
			`cat ${shellEscape(skill.filePath)}`,
		);
	});

	it("fails closed on containment violations instead of passing the token through", async () => {
		await expect(expandInternalUrls("cat fixture://escape", { context })).rejects.toThrow("fixture:// escaped");
	});

	it("leaves literal URLs embedded in quoted text unchanged", async () => {
		const command = `printf '%s\\n' 'copy fixture://12 to save the original'`;
		await expect(expandInternalUrls(command, { context })).resolves.toBe(command);
	});

	it("expands an unquoted URL inside a double-quoted command substitution", async () => {
		const command = 'echo "$(realpath skill://valid-skill/SKILL.md 2>&1)"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`echo "$(realpath ${shellEscape(skill.filePath)} 2>&1)"`,
		);
	});

	it("expands an unquoted URL inside a backtick substitution nested in double quotes", async () => {
		const command = 'echo "`cat skill://valid-skill/SKILL.md`"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`echo "\`cat ${shellEscape(skill.filePath)}\`"`,
		);
	});

	it("expands a top-level unquoted URL inside a backtick substitution", async () => {
		const command = "echo `cat skill://valid-skill/SKILL.md`";

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`echo \`cat ${shellEscape(skill.filePath)}\``,
		);
	});

	it("expands nested $() inside a double-quoted backtick substitution", async () => {
		const command = 'echo "`echo $(cat skill://valid-skill/SKILL.md)`"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`echo "\`echo $(cat ${shellEscape(skill.filePath)})\`"`,
		);
	});

	it("expands nested backticks inside a double-quoted $() substitution", async () => {
		const command = 'echo "$(echo `cat skill://valid-skill/SKILL.md`)"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(
			`echo "$(echo \`cat ${shellEscape(skill.filePath)}\`)"`,
		);
	});

	it("leaves a URL inside a single-quoted backtick string literal", async () => {
		const command = "echo '`cat skill://valid-skill/SKILL.md`'";

		await expect(expandInternalUrls(command, { context })).resolves.toBe(command);
	});

	it("leaves a URL behind an escaped backtick in double quotes literal", async () => {
		const command = 'echo "\\`skill://valid-skill/SKILL.md\\`"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(command);
	});

	it("leaves a URL inside escaped quotes within a double-quoted backtick substitution", async () => {
		const command = 'echo "`printf %s \\"literal skill://valid-skill/SKILL.md\\"`"';

		await expect(expandInternalUrls(command, { context })).resolves.toBe(command);
	});

	it("locates the directory form of a bare URL for directory callers", async () => {
		await expect(
			expandInternalUrls("skill://valid-skill", { context, noEscape: true, directory: true }),
		).resolves.toBe(skill.baseDir);
	});

	it("creates missing targets of mutable schemes and their parent directories", async () => {
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { context, create: true })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
		expect((await fs.stat(path.dirname(expectedPath))).isDirectory()).toBe(true);
	});

	it("never creates inside immutable schemes", async () => {
		for (const command of ["tee skill://valid-skill/new-dir/out.txt", "mkdir -p skill://valid-skill/new-dir"]) {
			await expect(expandInternalUrls(command, { context, create: true })).rejects.toThrow(
				"skill://valid-skill/new-dir",
			);
		}
		await expect(fs.stat(path.join(skill.baseDir, "new-dir"))).rejects.toThrow();
	});

	it("preserves an adjacent command separator after an unquoted URL", async () => {
		const command = 'bb review-packet gates --body-file local://body.txt; echo "exit=$?"';
		const expectedPath = resolveLocalUrlToPath("local://body.txt", localOptions);

		await expect(expandInternalUrls(command, { context, create: true })).resolves.toBe(
			`bb review-packet gates --body-file ${shellEscape(expectedPath)}; echo "exit=$?"`,
		);
	});

	it("expands the single-slash local:/ spelling bare and quoted", async () => {
		const expected = shellEscape(resolveLocalUrlToPath("local://PLAN.md", localOptions));

		for (const url of ["local:/PLAN.md", '"local:/PLAN.md"', "'local:/PLAN.md'"]) {
			await expect(expandInternalUrls(`cat ${url}`, { context, create: true })).resolves.toBe(`cat ${expected}`);
		}
	});

	it("does not match local:/ inside filesystem paths or longer words", async () => {
		for (const command of [
			"cat /repo/local:/PLAN.md",
			"cat ./local:/PLAN.md ../local:/other.md",
			"cat notlocal:/PLAN.md",
			"cat mylocal:/data.json",
			"cat not-local:/PLAN.md",
		]) {
			await expect(expandInternalUrls(command, { context, create: true })).resolves.toBe(command);
		}
	});
});
