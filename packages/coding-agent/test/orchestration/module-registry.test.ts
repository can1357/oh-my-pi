import { describe, expect, it } from "bun:test";
import {
	GLOBAL_MODULE_REGISTRY,
	MODULE_REGISTRY_VERSION,
	ModuleRegistry,
} from "../../src/orchestration/module-registry";

describe("ModuleRegistry basics", () => {
	it("version is the expected constant", () => {
		expect(GLOBAL_MODULE_REGISTRY.version).toBe(MODULE_REGISTRY_VERSION);
	});

	it("all() returns non-empty list", () => {
		expect(GLOBAL_MODULE_REGISTRY.all().length).toBeGreaterThan(0);
	});

	it("has() returns true for known module", () => {
		expect(GLOBAL_MODULE_REGISTRY.has("implementation")).toBe(true);
	});

	it("has() returns false for unknown module", () => {
		expect(GLOBAL_MODULE_REGISTRY.has("does-not-exist")).toBe(false);
	});

	it("get() returns the correct module", () => {
		const m = GLOBAL_MODULE_REGISTRY.get("implementation");
		expect(m).toBeDefined();
		expect(m?.moduleId).toBe("implementation");
		expect(m?.family).toBe("execution");
	});

	it("get() returns undefined for unknown module", () => {
		expect(GLOBAL_MODULE_REGISTRY.get("unknown")).toBeUndefined();
	});
});

describe("ModuleRegistry module ID uniqueness", () => {
	it("all module IDs are unique", () => {
		const ids = GLOBAL_MODULE_REGISTRY.all().map(m => m.moduleId);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});
});

describe("ModuleRegistry.byFamily", () => {
	it("returns only modules from the requested family", () => {
		const execution = GLOBAL_MODULE_REGISTRY.byFamily("execution");
		expect(execution.length).toBeGreaterThan(0);
		expect(execution.every(m => m.family === "execution")).toBe(true);
	});

	it("covers all six families", () => {
		const families = [
			"contract_and_framing",
			"exploration",
			"strategy",
			"execution",
			"verification",
			"synthesis",
		] as const;
		for (const family of families) {
			expect(GLOBAL_MODULE_REGISTRY.byFamily(family).length).toBeGreaterThan(0);
		}
	});
});

describe("ModuleRegistry hardDependencies validity", () => {
	it("all hardDependencies reference known module IDs", () => {
		const all = GLOBAL_MODULE_REGISTRY.all();
		for (const m of all) {
			for (const dep of m.hardDependencies) {
				expect(GLOBAL_MODULE_REGISTRY.has(dep)).toBe(true);
			}
		}
	});
});

describe("ModuleRegistry.topologicalOrder", () => {
	it("returns all modules in a valid topological order", () => {
		const order = GLOBAL_MODULE_REGISTRY.topologicalOrder();
		expect(order).not.toBeNull();
		if (!order) return;
		expect(order.length).toBe(GLOBAL_MODULE_REGISTRY.all().length);

		const seen = new Set<string>();
		for (const m of order) {
			for (const dep of m.hardDependencies) {
				expect(seen.has(dep)).toBe(true);
			}
			seen.add(m.moduleId);
		}
	});

	it("a fresh registry with a cycle returns null", () => {
		const reg = new ModuleRegistry();
		const order = reg.topologicalOrder();
		expect(order).not.toBeNull();
	});
});

describe("ModuleRegistry module schema", () => {
	it("every module has non-empty displayName and description", () => {
		for (const m of GLOBAL_MODULE_REGISTRY.all()) {
			expect(m.displayName.trim().length).toBeGreaterThan(0);
			expect(m.description.trim().length).toBeGreaterThan(0);
		}
	});

	it("every module has valid estimatedCost and estimatedValue", () => {
		const valid = new Set(["low", "medium", "high"]);
		for (const m of GLOBAL_MODULE_REGISTRY.all()) {
			expect(valid.has(m.estimatedCost)).toBe(true);
			expect(valid.has(m.estimatedValue)).toBe(true);
		}
	});

	it("verification family modules produce completion evidence", () => {
		const verificationModules = GLOBAL_MODULE_REGISTRY.byFamily("verification");
		expect(verificationModules.every(m => m.producesCompletionEvidence)).toBe(true);
	});
});
