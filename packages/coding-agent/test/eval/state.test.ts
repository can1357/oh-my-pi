import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import { formatEvalStateContext, getEvalState, updateEvalState } from "../../src/eval/state";
import type { ToolSession } from "../../src/tools";

function toolSession(sessionId: string, cwd: string, ownerId?: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getEvalSessionId: () => sessionId,
		getEvalKernelOwnerId: () => ownerId ?? null,
	} as ToolSession;
}

describe("eval state registry", () => {
	it("shares an actual kernel identity without leaking across sessions or Python cwd variants", () => {
		const cwd = path.resolve("state-contract", "shared");
		const owner = toolSession("state-contract-shared", cwd);
		const child = toolSession("state-contract-shared", cwd);
		const other = toolSession("state-contract-other", cwd);
		const otherCwd = toolSession("state-contract-shared", path.resolve("state-contract", "other-cwd"));

		updateEvalState(owner, {
			language: "python",
			kernelId: "python-kernel-1",
			alive: true,
			environment: "managed",
			interpreter: "/managed/python",
			loadedPath: path.join(cwd, "first.py"),
		});

		expect(getEvalState(child)?.runtimes[0]).toMatchObject({
			kernelId: "python-kernel-1",
			generation: 1,
			alive: true,
			loadedPaths: [path.join(cwd, "first.py")],
		});
		expect(getEvalState(other)).toBeUndefined();
		expect(getEvalState(otherCwd)).toBeUndefined();
	});

	it("isolates an owner-scoped reset fork while preserving shared-kernel state", () => {
		const cwd = path.resolve("state-contract", "owner-fork");
		const parent = toolSession("state-contract-owner-fork", cwd, "parent");
		const child = toolSession("state-contract-owner-fork", cwd, "child");
		updateEvalState(parent, {
			language: "js",
			kernelId: "shared-js",
			alive: true,
			loadedPath: path.join(cwd, "parent.ts"),
		});
		expect(getEvalState(child)?.runtimes[0]?.kernelId).toBe("shared-js");

		updateEvalState(child, {
			language: "js",
			kernelId: "shared-js",
			alive: true,
			loadedPath: path.join(cwd, "shared-child.ts"),
		});
		updateEvalState(child, {
			language: "js",
			kernelId: "child-fork-js",
			alive: true,
			loadedPath: path.join(cwd, "child.ts"),
		});

		expect(getEvalState(parent)?.runtimes[0]).toMatchObject({
			kernelId: "shared-js",
			loadedPaths: [path.join(cwd, "parent.ts"), path.join(cwd, "shared-child.ts")],
		});
		expect(getEvalState(child)?.runtimes[0]).toMatchObject({
			kernelId: "child-fork-js",
			generation: 2,
			loadedPaths: [path.join(cwd, "child.ts")],
		});

		updateEvalState(parent, { language: "js", kernelId: "shared-js", alive: false });
		expect(getEvalState(parent)?.runtimes[0]?.alive).toBe(false);
		expect(getEvalState(child)?.runtimes[0]?.alive).toBe(true);
	});

	it("clears loaded scripts on replacement and ignores a late death from the old kernel", () => {
		const cwd = path.resolve("state-contract", "generation");
		const session = toolSession("state-contract-generation", cwd);
		const interpreter = "/managed/python";
		updateEvalState(session, {
			language: "python",
			kernelId: "old-kernel",
			alive: true,
			interpreter,
			loadedPath: path.join(cwd, "old.py"),
		});
		updateEvalState(session, {
			language: "python",
			kernelId: "new-kernel",
			alive: true,
			interpreter,
			loadedPath: path.join(cwd, "new.py"),
		});
		updateEvalState(session, {
			language: "python",
			kernelId: "old-kernel",
			alive: false,
			interpreter,
		});

		expect(getEvalState(session)?.runtimes).toEqual([
			expect.objectContaining({
				kernelId: "new-kernel",
				generation: 2,
				alive: true,
				loadedPaths: [path.join(cwd, "new.py")],
			}),
		]);
	});

	it("partitions Python runtimes by effective interpreter and bounds loaded paths", () => {
		const cwd = path.resolve("state-contract", "interpreters");
		const session = toolSession("state-contract-interpreters", cwd);
		for (let index = 0; index < 14; index++) {
			updateEvalState(session, {
				language: "python",
				kernelId: "python-a",
				alive: true,
				interpreter: "/managed/python-a",
				loadedPath: path.join(cwd, `script-${index}.py`),
			});
		}
		updateEvalState(session, {
			language: "python",
			kernelId: "python-b",
			alive: true,
			interpreter: "/managed/python-b",
		});

		const runtimes = getEvalState(session)?.runtimes;
		expect(runtimes).toHaveLength(2);
		expect(runtimes?.find(runtime => runtime.kernelId === "python-a")).toMatchObject({
			loadedPaths: Array.from({ length: 12 }, (_, index) => path.join(cwd, `script-${index + 2}.py`)),
			loadedPathsOmitted: 2,
		});
	});

	it("marks a dead runtime unavailable and explains an empty fresh-process resume", () => {
		const cwd = path.resolve("state-contract", "format");
		const session = toolSession("state-contract-format", cwd);
		updateEvalState(session, {
			language: "js",
			kernelId: "js-kernel",
			alive: true,
			environment: "managed",
			interpreter: "Bun",
			loadedPath: path.join(cwd, "loaded.ts"),
		});
		updateEvalState(session, { language: "js", kernelId: "js-kernel", alive: false });

		const deadContext = formatEvalStateContext(session);
		expect(deadContext).toContain("JavaScript: dead; state is unavailable");
		expect(deadContext).toContain("loaded.ts");

		const resumed = toolSession("state-contract-fresh-host", cwd);
		const resumeContext = formatEvalStateContext(resumed, { historyHasEval: true });
		expect(resumeContext).toContain("were not restored");
		expect(resumeContext).toContain("re-run required setup");
	});
});
