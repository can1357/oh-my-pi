import { beforeEach, describe, expect, it } from "bun:test";
import {
	FilterPlugin,
	getManager,
	LoggingPlugin,
	MetricsPlugin,
	MnemopiPlugin,
	PluginManager,
	resetManager,
} from "@oh-my-pi/pi-mnemopi/core/plugins";

class CountingPlugin extends MnemopiPlugin {
	override name = "counting";
	readonly calls: string[] = [];
	override onRemember(memory: Record<string, unknown>): void {
		this.calls.push(`remember:${String(memory.id)}`);
	}
	override onRecall(memory: Record<string, unknown>): void {
		this.calls.push(`recall:${String(memory.id)}`);
	}
	override onConsolidate(summary: Record<string, unknown>): void {
		this.calls.push(`consolidate:${String(summary.summary)}`);
	}
	override onInvalidate(memoryId: string): void {
		this.calls.push(`invalidate:${memoryId}`);
	}
}

describe("PluginManager", () => {
	beforeEach(() => resetManager());

	it("registers, loads, notifies, and unloads plugins", () => {
		const manager = new PluginManager();
		manager.registerPlugin("counting", CountingPlugin);
		const plugin = manager.loadPlugin("counting") as CountingPlugin;
		expect(plugin.toDict().initialized).toBe(true);
		manager.notifyRemember({ id: "m1", content: "hello" });
		manager.notifyRecall({ id: "m1" });
		manager.notifyConsolidate({ summary: "sum" });
		manager.notifyInvalidate("m1");
		expect(plugin.calls).toEqual(["remember:m1", "recall:m1", "consolidate:sum", "invalidate:m1"]);
		expect(manager.listPlugins().some(entry => entry.name === "counting" && entry.loaded === true)).toBe(true);
		manager.unloadPlugin("counting");
		expect(plugin.toDict().initialized).toBe(false);
	});

	it("lazy-loads registered plugins through get_plugin", () => {
		const manager = new PluginManager();
		expect(manager.isLoaded("logging")).toBe(false);
		expect(manager.getPlugin("logging")).toBeInstanceOf(LoggingPlugin);
		expect(manager.isLoaded("logging")).toBe(true);
	});

	it("global manager can be reset", () => {
		const first = getManager();
		first.loadPlugin("metrics");
		resetManager();
		const second = getManager();
		expect(second).not.toBe(first);
		expect(second.isLoaded("metrics")).toBe(false);
	});
});

describe("built-in plugins", () => {
	it("logging records bounded memory lifecycle entries", () => {
		const plugin = new LoggingPlugin({ max_entries: 2 });
		plugin.onRemember({ id: "m1", content: "x".repeat(100) });
		plugin.onRecall({ id: "m2", content: "short" });
		plugin.onInvalidate("m3");
		expect(plugin.getLog()).toHaveLength(2);
		expect(plugin.getLog()[1]?.event).toBe("invalidate");
	});

	it("metrics counts hooks and records timings", () => {
		const plugin = new MetricsPlugin();
		plugin.onRemember({ id: "m1" });
		plugin.onRecall({ id: "m1" });
		plugin.recordTiming("remember", 10);
		plugin.recordTiming("remember", 30);
		expect(plugin.getCounters()).toMatchObject({ remember: 1, recall: 1 });
		expect(plugin.getAverageTiming("remember")).toBe(20);
	});

	it("filter tracks blocked items when rules fail", () => {
		const plugin = new FilterPlugin();
		plugin.addRule(item => item.allow === true);
		plugin.onRemember({ id: "blocked", allow: false });
		plugin.onRemember({ id: "allowed", allow: true });
		expect(plugin.isBlocked("blocked")).toBe(true);
		expect(plugin.isBlocked("allowed")).toBe(false);
	});
});
