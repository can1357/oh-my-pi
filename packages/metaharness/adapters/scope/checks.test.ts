import { describe, expect, it } from "bun:test";
import { analyzeCalls, classifySegment, commandSegments } from "./checks";

const bash = (command: string, ms = 1) => ({ name: "bash", args: { command }, ms });
const edit = (file: string) => ({ name: "edit", args: { input: `*** Edit File: ${file}\n…` }, ms: 1 });
const FILES = ["src/config.ts", "src/client.ts", "test/config.test.ts", "README.md"];

/** `[kinds, phase]` per check call, plus the run's verified flag. */
function phases(calls: Parameters<typeof analyzeCalls>[0], changed: string[] = ["src/config.ts"]) {
	const analysis = analyzeCalls(calls, { changed, paths: FILES });
	return { checks: analysis.checks.map(check => [check.kinds.join("+"), check.phase]), verified: analysis.verified };
}

describe("scope benchmark check accounting", () => {
	it("classifies segments by their leading program, past wrappers and env assignments", () => {
		const kinds = commandSegments(
			"cd app && FOO=1 timeout 60 bunx tsc --noEmit; bun test test/slug.test.ts | tail -5\nbun src/main.ts; bun run ci; bun run check; git diff",
		).map(classifySegment);
		expect(kinds).toEqual([[], ["typecheck", "install"], ["test"], [], ["run"], ["run"], ["typecheck"], []]);
	});

	it("classifies searches rooted at the filesystem or home, not at the workspace", () => {
		const kinds = commandSegments(
			"find / -name duration.ts 2>/dev/null; find ~ -maxdepth 6 -name x; find /var/folders/ws/app -name x; rg foo .",
		).map(classifySegment);
		expect(kinds).toEqual([["scan"], ["scan"], [], []]);
	});

	it("splits checks at the last edit: before the first is reproduction, after the last is verification", () => {
		expect(phases([bash("bun test"), edit("src/config.ts"), bash("bun run check"), bash("bun test")])).toEqual({
			checks: [
				["test", "before"],
				["typecheck", "final"],
				["test", "final"],
			],
			verified: true,
		});
	});

	it("marks checks between edits as during the work", () => {
		expect(
			phases([bash("bun test"), edit("src/config.ts"), bash("bun test"), edit("src/config.ts"), bash("bun test")]),
		).toEqual({
			checks: [
				["test", "before"],
				["test", "during"],
				["test", "final"],
			],
			verified: true,
		});
	});

	it("leaves a change unverified when nothing runs after the last edit", () => {
		expect(phases([edit("src/config.ts"), bash("bun test"), edit("test/config.test.ts")])).toEqual({
			checks: [["test", "during"]],
			verified: false,
		});
		expect(phases([edit("src/config.ts"), bash("grep -rn TIMEOUT .")]).verified).toBe(false);
	});

	it("has nothing to verify when the run changed no code", () => {
		expect(phases([bash("bun test")], [])).toEqual({ checks: [["test", "before"]], verified: null });
		expect(phases([edit("README.md")], ["README.md"]).verified).toBeNull();
	});

	it("keeps a change verified through a docs edit after the check", () => {
		expect(
			phases([edit("src/config.ts"), bash("bun test"), edit("README.md")], ["src/config.ts", "README.md"]),
		).toEqual({ checks: [["test", "final"]], verified: true });
	});

	it("sees a program run inside a shell function definition", () => {
		expect(phases([edit("src/config.ts"), bash('cli() { bun src/cli.ts "$@" 2>&1; }\ncli init')]).verified).toBe(
			true,
		);
	});

	it("never counts installs or scans as verification", () => {
		expect(phases([edit("src/config.ts"), bash("npx vitest --version; find / -name '*.ts' | head")])).toEqual({
			checks: [["test+install+scan", "final"]],
			verified: true,
		});
		expect(phases([edit("src/config.ts"), bash("bun install")])).toEqual({
			checks: [["install", "during"]],
			verified: false,
		});
	});

	it("treats shell rewrites of changed files as edits, in command order", () => {
		const sd = "sd MAX_RETRIES RETRY_LIMIT src/config.ts src/client.ts";
		expect(phases([bash(`${sd} && bun test`)], ["src/config.ts", "src/client.ts"]).verified).toBe(true);
		expect(phases([bash(`bun test && ${sd}`)], ["src/config.ts", "src/client.ts"]).verified).toBe(false);
		expect(phases([bash("bun test"), bash("cat > src/config.ts <<'EOF'\nexport const A = 1;\nEOF")]).verified).toBe(
			false,
		);
		expect(
			phases([
				bash("bun test"),
				bash("python3 - <<'EOF'\nimport pathlib\npathlib.Path('src/config.ts').write_text('x')\nEOF"),
			]).verified,
		).toBe(false);
	});

	it("keeps a change verified through throwaway check scripts and scratch cleanup", () => {
		const script = "import { run } from './src/cli';\nconst f = (x) => x > 1;\nconsole.log(run(['list']));";
		expect(
			phases([
				edit("src/config.ts"),
				bash(`cat > /tmp/check.ts <<'EOF'\n${script}\nEOF\nbun /tmp/check.ts; rm -f /tmp/check.ts`),
			]),
		).toEqual({ checks: [["run", "final"]], verified: true });
		expect(
			phases([
				edit("src/config.ts"),
				bash(`cat > .check.ts <<'EOF'\n${script}\nEOF\nbun .check.ts`),
				bash("rm .check.ts"),
			]).verified,
		).toBe(true);
		expect(
			phases([edit("src/config.ts"), bash('bun test 2>&1 | tee /tmp/out.txt; echo "exit -> $?"')]).verified,
		).toBe(true);
	});

	it("finds commands inside eval cells", () => {
		expect(phases([edit("src/config.ts"), { name: "eval", args: { code: 'await sh("bun test")' }, ms: 5 }])).toEqual({
			checks: [["test", "final"]],
			verified: true,
		});
	});

	it("counts reads of a file only after it was edited", () => {
		const { postEditReads } = analyzeCalls(
			[
				{ name: "read", args: { path: "/tmp/ws/src/config.ts" }, ms: 1 },
				edit("src/config.ts"),
				{ name: "read", args: { path: "/tmp/ws/src/client.ts" }, ms: 1 },
				bash("cat src/config.ts"),
				{ name: "read", args: { path: "src/config.ts" }, ms: 1 },
			],
			{ changed: ["src/config.ts"], paths: FILES },
		);
		expect(postEditReads).toBe(2);
	});
});
