import { describe, expect, it } from "bun:test";
import {
	JsRuntime,
	type RuntimeCallIdentity,
	type RuntimeHooks,
	shadowSnapshotDigest,
} from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";

const GLOBAL_KEYS = ["__omp_import__", "read"] as const;

type GlobalKey = (typeof GLOBAL_KEYS)[number];

interface GlobalSnapshot {
	exists: boolean;
	value: unknown;
}

function snapshotGlobals(): Record<GlobalKey, GlobalSnapshot> {
	const globals = globalThis as Record<string, unknown>;
	return {
		__omp_import__: { exists: "__omp_import__" in globals, value: globals.__omp_import__ },
		read: { exists: "read" in globals, value: globals.read },
	};
}

function restoreGlobals(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) globals[key] = state.value;
		else delete globals[key];
	}
}

function expectGlobalsRestored(snapshot: Record<GlobalKey, GlobalSnapshot>): void {
	const globals = globalThis as Record<string, unknown>;
	for (const key of GLOBAL_KEYS) {
		const state = snapshot[key];
		if (state.exists) expect(globals[key]).toBe(state.value);
		else expect(key in globals).toBe(false);
	}
}

const hooks: RuntimeHooks = {
	onText: () => {},
	onDisplay: () => {},
	callTool: async () => undefined,
};

describe("JsRuntime global disposal", () => {
	it("keeps newer same-realm runtime globals after disposing an older runtime", () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first" });
		const firstImport = globals.__omp_import__;
		const firstRead = globals.read;
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second" });
		const secondImport = globals.__omp_import__;

		try {
			expect(typeof firstImport).toBe("function");
			expect(typeof firstRead).toBe("function");
			expect(secondImport).not.toBe(firstImport);
			expect(typeof globals.read).toBe("function");

			first.dispose();

			expect(globals.__omp_import__).toBe(secondImport);
			expect(globals.__omp_helpers__).toBe(second.helpers);
			expect(typeof globals.read).toBe("function");

			second.dispose();
			expectGlobalsRestored(before);
		} finally {
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("snapshots only JSON-safe globals published after runtime initialization", async () => {
		const globals = globalThis as Record<string, unknown>;
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-snapshot" });
		try {
			globals.shadowSnapshotProbe = { nested: ["safe"] };
			globals.shadowSnapshotUnsupported = () => undefined;

			expect(runtime.snapshotUserGlobals()).toEqual({
				revision: 0,
				values: { shadowSnapshotProbe: { nested: ["safe"] } },
				initialGlobals: {
					String: true,
					JSON: true,
					"JSON.stringify": true,
					"Array.prototype.join": true,
					"Object.prototype.toString": true,
					__omp_call_tool__: true,
				},
			});

			await runtime.run("undefined;", undefined, hooks);
			expect(runtime.snapshotUserGlobals().revision).toBe(1);
		} finally {
			delete globals.shadowSnapshotProbe;
			delete globals.shadowSnapshotUnsupported;
			runtime.dispose();
		}
	});

	it("bounds shadow snapshot string data across the whole retained namespace", () => {
		const globals = globalThis as Record<string, unknown>;
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-snapshot-budget" });
		try {
			globals.shadowSnapshotBudgetA = "a".repeat(5 * 1024 * 1024);
			globals.shadowSnapshotBudgetB = "b".repeat(5 * 1024 * 1024);
			const values = runtime.snapshotUserGlobals().values;
			expect(values.shadowSnapshotBudgetA).toBe(globals.shadowSnapshotBudgetA);
			expect(values.shadowSnapshotBudgetB).toBeUndefined();
		} finally {
			delete globals.shadowSnapshotBudgetA;
			delete globals.shadowSnapshotBudgetB;
			runtime.dispose();
		}
	});

	it("changes the snapshot digest when retained state changes", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-digest" });
		const globals = globalThis as Record<string, unknown>;
		try {
			globals.shadowDigestProbe = "before";
			const before = shadowSnapshotDigest(runtime.snapshotUserGlobals());
			globals.shadowDigestProbe = "after";
			expect(shadowSnapshotDigest(runtime.snapshotUserGlobals())).not.toBe(before);
		} finally {
			delete globals.shadowDigestProbe;
			runtime.dispose();
		}
	});

	it("changes the snapshot digest when a retained intrinsic is replaced", async () => {
		const globals = globalThis as Record<string, unknown>;
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-intrinsics" });
		const genuineString = globals.String;
		try {
			const before = shadowSnapshotDigest(runtime.snapshotUserGlobals());
			globals.String = null;
			const after = runtime.snapshotUserGlobals();
			expect(after.initialGlobals).toMatchObject({ String: false });
			expect(shadowSnapshotDigest(after)).not.toBe(before);
		} finally {
			globals.String = genuineString;
			runtime.dispose();
		}
	});
	it("reports the installed bridge dispatcher identity in snapshots", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-call-tool" });
		try {
			// The dispatcher is an owned global installed by every runtime, so
			// the identity flag is always present; the exact-shape assertion
			// above pins the full key set.
			expect(runtime.snapshotUserGlobals().initialGlobals).toMatchObject({ __omp_call_tool__: true });
		} finally {
			runtime.dispose();
		}
	});
	it("changes the snapshot digest when Object.prototype.toString is replaced", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "shadow-tostring" });
		const genuineToString = Object.prototype.toString;
		try {
			const before = shadowSnapshotDigest(runtime.snapshotUserGlobals());
			Object.prototype.toString = function toString() {
				return "spoofed";
			};
			const after = runtime.snapshotUserGlobals();
			expect(after.initialGlobals).toMatchObject({ "Object.prototype.toString": false });
			expect(shadowSnapshotDigest(after)).not.toBe(before);
		} finally {
			Object.prototype.toString = genuineToString;
			runtime.dispose();
		}
	});

	it("tags repeated tool calls with source-stable site occurrences", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "runtime-call-identity" });
		const identities: Array<RuntimeCallIdentity | undefined> = [];
		const code = "for (let index = 0; index < 2; index++) await tool.read({ path: String(index) });";
		try {
			await runtime.run(code, "identity.ts", {
				onText: () => {},
				onDisplay: () => {},
				callTool: async (_name, _args, identity) => {
					identities.push(identity);
					return "";
				},
			});
			const siteId = `js:${code.indexOf("tool.read")}`;
			expect(identities).toEqual([
				{ siteId, occurrence: 0 },
				{ siteId, occurrence: 1 },
			]);
		} finally {
			runtime.dispose();
		}
	});

	it("tags whitespace-separated tool reads with a source identity", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "runtime-spaced-call-identity" });
		const identities: Array<RuntimeCallIdentity | undefined> = [];
		const code = 'await tool \n. read({ path: "formatted.txt" });';
		try {
			await runtime.run(code, "identity.ts", {
				onText: () => {},
				onDisplay: () => {},
				callTool: async (_name, _args, identity) => {
					identities.push(identity);
					return "";
				},
			});
			expect(identities).toEqual([{ siteId: `js:${code.indexOf("tool")}`, occurrence: 0 }]);
		} finally {
			runtime.dispose();
		}
	});

	it("reactivates older same-realm runtime globals when no other run is active", async () => {
		const globals = globalThis as Record<string, unknown>;
		const before = snapshotGlobals();
		const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "first-reactivated" });
		const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "second-reactivated" });

		try {
			expect(globals.__omp_helpers__).toBe(second.helpers);
			first.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(first.helpers);
			first.setRunScope({ reactivatedProbe: 7 });
			expect(globals.reactivatedProbe).toBe(7);
			expect(await first.run("1 + 6;", undefined, hooks)).toBe(7);
			second.setCwd(process.cwd());
			expect(globals.__omp_helpers__).toBe(second.helpers);
		} finally {
			delete globals.reactivatedProbe;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("defers cross-runtime setCwd while another same-realm runtime is running", async () => {
		const before = snapshotGlobals();
		const globals = globalThis as Record<string, unknown>;
		const firstCwd = process.cwd();
		const secondCwd = process.cwd();
		const first = new JsRuntime({ initialCwd: firstCwd, sessionId: "first-overlap" });
		const second = new JsRuntime({ initialCwd: secondCwd, sessionId: "second-overlap" });
		const gate = Promise.withResolvers<void>();
		let activeSecond: Promise<unknown> | undefined;
		const pendingCwd = `${firstCwd}/pending-same-realm-cwd`;

		try {
			second.setRunScope({ gate: gate.promise });
			activeSecond = second.run("await gate;", undefined, hooks);
			// Local cwd may be stamped without stealing the active realm.
			first.setCwd(pendingCwd);
			expect(first.cwd).toBe(pendingCwd);
			expect(globals.__omp_helpers__).toBe(second.helpers);
			await first.run("1", undefined, hooks).then(
				() => {
					throw new Error("expected active runtime rejection");
				},
				error =>
					expect(error).toHaveProperty(
						"message",
						"Cannot run code while another same-realm JS runtime is running",
					),
			);
			gate.resolve();
			await activeSecond;
			// The deferred cwd must reach this runtime's next run WITHOUT a second
			// setCwd: the saved __omp_session__ stack entry carries the new value.
			expect(await first.run("__omp_session__.cwd", undefined, hooks)).toBe(pendingCwd);
			expect(first.cwd).toBe(pendingCwd);
			expect(globals.__omp_helpers__).toBe(first.helpers);
			expect(globals.__omp_session__).toMatchObject({ cwd: pendingCwd });
		} finally {
			gate.resolve();
			if (activeSecond) await activeSecond.catch(() => undefined);
			delete globals.gate;
			first.dispose();
			second.dispose();
			restoreGlobals(before);
		}
	});

	it("setCwd on a disposed runtime still throws", () => {
		const before = snapshotGlobals();
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "disposed-setcwd" });
		try {
			runtime.dispose();
			expect(() => runtime.setCwd(process.cwd())).toThrow("Cannot set cwd on a disposed JS runtime");
		} finally {
			restoreGlobals(before);
		}
	});
});
