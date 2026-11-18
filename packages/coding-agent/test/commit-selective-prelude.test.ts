import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { createCommitPrelude } from "@oh-my-pi/pi-coding-agent/commit/selective/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";

/** The shipped JS facade, wired to a host that records every call it receives. */
function facade() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({}),
	};
	const calls: unknown[] = [];
	const context = createContext({
		__omp_log__: () => {},
		__omp_prelude__: async (_name: string, parameters: unknown) => {
			calls.push(parameters);
			return { text: "summary", details: { id: "d1", remaining: { id: "d2" } } };
		},
	});
	runInContext(createCommitPrelude(session).javascript, context);
	const run = (code: string): Promise<unknown> => runInContext(`(async () => { ${code} })()`, context);
	return { calls, run };
}

describe("commit JavaScript facade", () => {
	it("rejects option names it does not know instead of dropping them", async () => {
		const { calls, run } = facade();

		// A misnamed option must not silently draft the session's own checkout (#19440).
		await expect(run(`await commit.draft({ cwd: "../ws" })`)).rejects.toThrow(
			'draft(): unknown option "cwd"; expected agents, repo, silent',
		);
		// Python-style positional scope is not an options object.
		await expect(run(`await commit.draft("ParserFix")`)).rejects.toThrow("draft() takes an options object");
		expect(calls).toEqual([]);

		await run(`globalThis.d = await commit.draft({ repo: "../ws", agents: "self" })`);
		expect(calls).toEqual([{ action: "draft", agents: "self", repo: "../ws" }]);

		await expect(run(`await d.commit("fix: x", { no_verify: true })`)).rejects.toThrow(
			'commit(): unknown option "no_verify"; expected body, fixes, amend, noVerify, silent',
		);
		await expect(run(`await d.take("a.ts", { unit: ["1a"] })`)).rejects.toThrow('take(): unknown option "unit"');
		expect(calls).toHaveLength(1);
	});
});
