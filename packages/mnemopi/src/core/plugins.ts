import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PLUGIN_DIR = join(homedir(), ".hermes", "mnemopi", "plugins");

export type PluginConfig = Record<string, unknown>;
export type MemoryDict = Record<string, unknown>;

export class MnemopiPlugin {
	static readonly abstractBase = true;
	name = "";
	version = "1.0.0";
	enabled = true;
	protected initialized = false;
	readonly config: PluginConfig;

	constructor(config: PluginConfig = {}) {
		if (new.target === MnemopiPlugin) throw new TypeError("MnemopiPlugin is abstract");
		this.config = config;
		const ctor = this.constructor as typeof MnemopiPlugin;
		this.name =
			(ctor.prototype.name as string | undefined) ?? (ctor as unknown as { name?: string }).name ?? this.name;
		this.version = (ctor.prototype.version as string | undefined) ?? this.version;
		this.enabled = (ctor.prototype.enabled as boolean | undefined) ?? this.enabled;
	}

	initialize(): void {
		this.initialized = true;
	}

	shutdown(): void {
		this.initialized = false;
	}

	onRemember(_memory: MemoryDict): void {
		throw new TypeError("Plugin must implement onRemember");
	}
	onRecall(_memory: MemoryDict): void {
		throw new TypeError("Plugin must implement onRecall");
	}
	onConsolidate(_summary: MemoryDict): void {
		throw new TypeError("Plugin must implement onConsolidate");
	}
	onInvalidate(_memoryId: string): void {
		throw new TypeError("Plugin must implement onInvalidate");
	}
	toDict(): Record<string, unknown> {
		return {
			name: this.name,
			version: this.version,
			enabled: this.enabled,
			initialized: this.initialized,
			config: this.config,
		};
	}
}

function previewContent(content: unknown, maxLen = 80): string {
	const text = typeof content === "string" ? content : "";
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}...`;
}

export class LoggingPlugin extends MnemopiPlugin {
	override name = "logging";
	override version = "1.0.0";
	private readonly memoryLog: MemoryDict[] = [];
	private readonly maxEntries: number;
	constructor(config: PluginConfig = {}) {
		super(config);
		const configured = config.max_entries ?? config.maxEntries;
		this.maxEntries = typeof configured === "number" && Number.isFinite(configured) ? configured : 10000;
	}
	private append(entry: MemoryDict): void {
		this.memoryLog.push(entry);
		if (this.memoryLog.length > this.maxEntries) this.memoryLog.shift();
	}
	override onRemember(memory: MemoryDict): void {
		this.append({
			event: "remember",
			timestamp: new Date().toISOString(),
			memory_id: memory.id,
			content_preview: previewContent(memory.content),
		});
	}
	override onRecall(memory: MemoryDict): void {
		this.append({
			event: "recall",
			timestamp: new Date().toISOString(),
			memory_id: memory.id,
			content_preview: previewContent(memory.content),
		});
	}
	override onConsolidate(summary: MemoryDict): void {
		const ids = Array.isArray(summary.source_wm_ids) ? summary.source_wm_ids : [];
		this.append({
			event: "consolidate",
			timestamp: new Date().toISOString(),
			summary_preview: previewContent(summary.summary),
			source_count: ids.length,
		});
	}
	override onInvalidate(memoryId: string): void {
		this.append({ event: "invalidate", timestamp: new Date().toISOString(), memory_id: memoryId });
	}
	getLog(): MemoryDict[] {
		return this.memoryLog.slice();
	}
	clearLog(): void {
		this.memoryLog.length = 0;
	}
}

type MetricsEvent = "remember" | "recall" | "consolidate" | "invalidate";

export class MetricsPlugin extends MnemopiPlugin {
	override name = "metrics";
	override version = "1.0.0";
	private readonly counters: Record<MetricsEvent, number> = {
		remember: 0,
		recall: 0,
		consolidate: 0,
		invalidate: 0,
	};
	private readonly timings: Record<string, number[]> = {
		remember: [],
		recall: [],
		consolidate: [],
		invalidate: [],
	};
	private readonly maxTimingSamples: number;
	constructor(config: PluginConfig = {}) {
		super(config);
		const configured = config.max_timing_samples ?? config.maxTimingSamples;
		this.maxTimingSamples = typeof configured === "number" && Number.isFinite(configured) ? configured : 1000;
	}
	override onRemember(_memory: MemoryDict): void {
		this.counters.remember += 1;
	}
	override onRecall(_memory: MemoryDict): void {
		this.counters.recall += 1;
	}
	override onConsolidate(_summary: MemoryDict): void {
		this.counters.consolidate += 1;
	}
	override onInvalidate(_memoryId: string): void {
		this.counters.invalidate += 1;
	}
	recordTiming(event: string, durationMs: number): void {
		const samples = this.timings[event] ?? [];
		if (this.timings[event] === undefined) this.timings[event] = samples;
		samples.push(durationMs);
		if (samples.length > this.maxTimingSamples) samples.shift();
	}
	getCounters(): Record<string, number> {
		return { ...this.counters };
	}
	getTimings(event: string): number[] {
		return (this.timings[event] ?? []).slice();
	}
	getAverageTiming(event: string): number | null {
		const samples = this.timings[event] ?? [];
		if (samples.length === 0) return null;
		let total = 0;
		for (const sample of samples) total += sample;
		return total / samples.length;
	}
	reset(): void {
		for (const key of Object.keys(this.counters) as MetricsEvent[]) this.counters[key] = 0;
		for (const samples of Object.values(this.timings)) samples.length = 0;
	}
	getSummary(): Record<string, unknown> {
		const averages: Record<string, number | null> = {};
		for (const event of Object.keys(this.timings)) averages[event] = this.getAverageTiming(event);
		return { counters: this.getCounters(), averages };
	}
}

export type FilterRule = (item: MemoryDict) => boolean;

export class FilterPlugin extends MnemopiPlugin {
	override name = "filter";
	override version = "1.0.0";
	private readonly rules: FilterRule[] = [];
	private readonly blocked: MemoryDict[] = [];
	private readonly maxBlocked: number;
	constructor(config: PluginConfig = {}) {
		super(config);
		const configured = config.max_blocked ?? config.maxBlocked;
		this.maxBlocked = typeof configured === "number" && Number.isFinite(configured) ? configured : 1000;
	}
	addRule(rule: FilterRule): void {
		this.rules.push(rule);
	}
	removeRule(rule: FilterRule): void {
		const index = this.rules.indexOf(rule);
		if (index >= 0) this.rules.splice(index, 1);
	}
	clearRules(): void {
		this.rules.length = 0;
	}
	override onRemember(memory: MemoryDict): void {
		if (!this.passes(memory)) this.block(memory);
	}
	override onRecall(memory: MemoryDict): void {
		if (!this.passes(memory)) this.block(memory);
	}
	override onConsolidate(summary: MemoryDict): void {
		if (!this.passes(summary)) this.block(summary);
	}
	override onInvalidate(_memoryId: string): void {}
	private passes(item: MemoryDict): boolean {
		for (const rule of this.rules) {
			try {
				if (!rule(item)) return false;
			} catch {
				return false;
			}
		}
		return true;
	}
	private block(item: MemoryDict): void {
		this.blocked.push({ timestamp: new Date().toISOString(), item });
		if (this.blocked.length > this.maxBlocked) this.blocked.shift();
	}
	getBlocked(): MemoryDict[] {
		return this.blocked.slice();
	}
	isBlocked(memoryId: string): boolean {
		for (const entry of this.blocked) {
			const item = entry.item as MemoryDict | undefined;
			if (item?.id === memoryId) return true;
		}
		return false;
	}
}

export class CompressionPlugin extends MnemopiPlugin {
	override name = "compression";
	override version = "1.0.0";
	override enabled = false;
	private readonly threshold: number;
	constructor(config: PluginConfig = {}) {
		super(config);
		this.enabled = Boolean(config.enabled);
		const configured = config.threshold_chars ?? config.thresholdChars;
		this.threshold = typeof configured === "number" && Number.isFinite(configured) ? configured : 20;
	}
	compressLines(lines: string[]): string[] {
		if (!this.enabled || this.threshold < 0) return lines;
		return lines;
	}
	override onRemember(_memory: MemoryDict): void {}
	override onRecall(_memory: MemoryDict): void {}
	override onConsolidate(_summary: MemoryDict): void {}
	override onInvalidate(_memoryId: string): void {}
}

export type PluginConstructor<T extends MnemopiPlugin = MnemopiPlugin> = new (config?: PluginConfig) => T;

export class PluginManager {
	private readonly registry = new Map<string, PluginConstructor>();
	private readonly instances = new Map<string, MnemopiPlugin>();
	constructor(private readonly pluginDir = DEFAULT_PLUGIN_DIR) {
		this.registerPlugin("logging", LoggingPlugin);
		this.registerPlugin("metrics", MetricsPlugin);
		this.registerPlugin("filter", FilterPlugin);
		this.registerPlugin("compression", CompressionPlugin);
	}
	registerPlugin(name: string, pluginClass: PluginConstructor): void {
		if (typeof pluginClass !== "function" || !(pluginClass.prototype instanceof MnemopiPlugin)) {
			throw new TypeError("pluginClass must be a MnemopiPlugin subclass");
		}
		if (this.registry.has(name)) throw new ValueError(`Plugin '${name}' is already registered`);
		this.registry.set(name, pluginClass);
	}
	loadPlugin(name: string, config: PluginConfig = {}): MnemopiPlugin {
		const pluginClass = this.registry.get(name);
		if (pluginClass === undefined) throw new ValueError(`Plugin '${name}' is not registered`);
		if (this.instances.has(name)) throw new Error(`Plugin '${name}' is already loaded`);
		const instance = new pluginClass(config);
		instance.initialize();
		this.instances.set(name, instance);
		return instance;
	}
	unloadPlugin(name: string): void {
		const instance = this.instances.get(name);
		if (instance === undefined) throw new ValueError(`Plugin '${name}' is not loaded`);
		this.instances.delete(name);
		instance.shutdown();
	}
	listPlugins(): Array<Record<string, unknown>> {
		const result: Array<Record<string, unknown>> = [];
		for (const [name, pluginClass] of this.registry)
			result.push({
				name,
				class: pluginClass.name,
				loaded: this.instances.has(name),
				instance: this.instances.get(name) ?? null,
			});
		return result;
	}
	getPlugin(name: string): MnemopiPlugin | null {
		const loaded = this.instances.get(name);
		if (loaded !== undefined) return loaded;
		if (this.registry.has(name)) return this.loadPlugin(name);
		return null;
	}
	isLoaded(name: string): boolean {
		return this.instances.has(name);
	}
	isRegistered(name: string): boolean {
		return this.registry.has(name);
	}
	loadAll(configs: Record<string, PluginConfig> = {}): MnemopiPlugin[] {
		const loaded: MnemopiPlugin[] = [];
		for (const name of this.registry.keys())
			if (!this.instances.has(name)) loaded.push(this.loadPlugin(name, configs[name] ?? {}));
		return loaded;
	}
	unloadAll(): void {
		for (const name of Array.from(this.instances.keys())) this.unloadPlugin(name);
	}
	discoverPlugins(): string[] {
		if (!existsSync(this.pluginDir)) return [];
		return [];
	}
	notifyRemember(memory: MemoryDict): void {
		for (const instance of this.instances.values())
			if (instance.enabled) {
				try {
					instance.onRemember(memory);
				} catch {}
			}
	}
	notifyRecall(memory: MemoryDict): void {
		for (const instance of this.instances.values())
			if (instance.enabled) {
				try {
					instance.onRecall(memory);
				} catch {}
			}
	}
	notifyConsolidate(summary: MemoryDict): void {
		for (const instance of this.instances.values())
			if (instance.enabled) {
				try {
					instance.onConsolidate(summary);
				} catch {}
			}
	}
	notifyInvalidate(memoryId: string): void {
		for (const instance of this.instances.values())
			if (instance.enabled) {
				try {
					instance.onInvalidate(memoryId);
				} catch {}
			}
	}
}

export class ValueError extends Error {
	override name = "ValueError";
}

let defaultManager: PluginManager | null = null;
export function getManager(): PluginManager {
	if (defaultManager === null) defaultManager = new PluginManager();
	return defaultManager;
}
export function resetManager(): void {
	if (defaultManager !== null) defaultManager.unloadAll();
	defaultManager = null;
}
