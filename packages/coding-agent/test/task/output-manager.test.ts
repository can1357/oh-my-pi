import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Contract: subagent output ids are the requested name, used verbatim the first
// time and suffixed (`-2`, `-3`, …) only when the same name recurs. A parent
// prefix nests ids under it. On resume the manager scans existing output and
// child-session files so it never reuses a name that would clobber prior state.

describe("AgentOutputManager", () => {
	it("uses the requested name verbatim and suffixes only on repeat", async () => {
		const mgr = new AgentOutputManager(() => null);

		expect(await mgr.allocate("Anna")).toBe("Anna");
		expect(await mgr.allocate("Anna")).toBe("Anna-2");
		expect(await mgr.allocate("Anna")).toBe("Anna-3");
		// A distinct name is untouched — no prefix, no suffix.
		expect(await mgr.allocate("Bob")).toBe("Bob");
	});

	it("de-duplicates repeated names while preserving order", async () => {
		const mgr = new AgentOutputManager(() => null);

		const ids: string[] = [];
		for (const name of ["Auth", "Auth", "Api", "Auth"]) {
			ids.push(await mgr.allocate(name));
		}
		expect(ids).toEqual(["Auth", "Auth-2", "Api", "Auth-3"]);
	});

	it("nests ids under a parent prefix and still suffixes repeats", async () => {
		const mgr = new AgentOutputManager(() => null, { parentPrefix: "Anna" });

		expect(await mgr.allocate("Bob")).toBe("Anna.Bob");
		expect(await mgr.allocate("Bob")).toBe("Anna.Bob-2");
		expect(await mgr.allocate("Carol")).toBe("Anna.Carol");
	});

	it("scans existing output files so a resume never clobbers prior outputs", async () => {
		using tmp = TempDir.createSync("@omp-output-manager-");
		const dir = tmp.path();
		await Bun.write(path.join(dir, "Anna.md"), "prior");
		await Bun.write(path.join(dir, "Anna-2.md"), "prior");
		await Bun.write(path.join(dir, "Bob.jsonl"), "persisted child session");
		// Unrelated tool artifacts (numeric `.log` ids) must not be mistaken for names.
		await Bun.write(path.join(dir, "7.bash.log"), "noise");

		const mgr = new AgentOutputManager(() => dir);

		expect(await mgr.allocate("Anna")).toBe("Anna-3");
		// A child JSONL without a result markdown still reserves its worker id.
		expect(await mgr.allocate("Bob")).toBe("Bob-2");
	});

	it("awaits one disk scan before concurrent allocations", async () => {
		using tmp = TempDir.createSync("@omp-output-manager-");
		const dir = tmp.path();
		await Bun.write(path.join(dir, "Anna.jsonl"), "persisted child session");
		const mgr = new AgentOutputManager(() => dir);

		expect(await Promise.all([mgr.allocate("Anna"), mgr.allocate("Anna")])).toEqual(["Anna-2", "Anna-3"]);
	});

	it("only counts files within its own prefix scope on resume", async () => {
		using tmp = TempDir.createSync("@omp-output-manager-");
		const dir = tmp.path();
		await Bun.write(path.join(dir, "Anna.Bob.md"), "child");
		await Bun.write(path.join(dir, "Anna.Bob.Carol.md"), "grandchild");
		// A different parent's child must be ignored by Anna's manager.
		await Bun.write(path.join(dir, "Other.Bob.md"), "elsewhere");

		const mgr = new AgentOutputManager(() => dir, { parentPrefix: "Anna" });

		expect(await mgr.allocate("Bob")).toBe("Anna.Bob-2");
		expect(await mgr.allocate("Dave")).toBe("Anna.Dave");
	});

	it("reserves lifecycle-known ids that no longer have files on disk", async () => {
		const mgr = new AgentOutputManager(() => null);
		await mgr.reserve(["Gone", "Other"]);

		expect(await mgr.allocate("Gone")).toBe("Gone-2");
		expect(await mgr.allocate("Fresh")).toBe("Fresh");
	});

	it("reserves the advisor transcript stem so a task can't clobber __advisor.jsonl", async () => {
		const mgr = new AgentOutputManager(() => null);
		// A subagent allocated `__advisor` would write `__advisor.jsonl`, colliding with
		// the advisor transcript in the same artifacts dir; the stem is pre-reserved.
		expect(await mgr.allocate("__advisor")).toBe("__advisor-2");
		// Unrelated names sharing the prefix are unaffected.
		expect(await mgr.allocate("__advisor-notes")).toBe("__advisor-notes");
	});
});
