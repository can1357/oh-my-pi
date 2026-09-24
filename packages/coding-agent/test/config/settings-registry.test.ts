import { describe, expect, it } from "bun:test";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { all, bindEffects, combine, effect, effectsSettings } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { cfgTemperature, cfgTopK, cfgTopP } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgEditFuzzyMatch } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

const tick = () => Promise.resolve();

describe("settings registry", () => {
	it("lets an override env beat every layer while a fallback env only replaces the default", () => {
		const saved: Record<string, string | undefined> = {
			PI_EDIT_FUZZY: Bun.env.PI_EDIT_FUZZY,
			SEARXNG_ENDPOINT: Bun.env.SEARXNG_ENDPOINT,
		};
		try {
			Bun.env.PI_EDIT_FUZZY = "0";
			Bun.env.SEARXNG_ENDPOINT = "https://env.example";
			const configured = Settings.isolated({ "edit.fuzzyMatch": true, "searxng.endpoint": "https://cfg.example" });
			expect(cfgEditFuzzyMatch.get(configured)).toBe(false);
			expect(cfgEditFuzzyMatch.provenance(configured)).toBe("env");
			expect(cfgSearxngEndpoint.get(configured)).toBe("https://cfg.example");
			expect(cfgSearxngEndpoint.provenance(configured)).toBe("runtime");

			const bare = Settings.isolated();
			expect(cfgSearxngEndpoint.get(bare)).toBe("https://env.example");
			expect(cfgSearxngEndpoint.isConfigured(bare)).toBe(true);

			// Unparseable text counts as unset rather than coercing to a wrong value.
			Bun.env.PI_EDIT_FUZZY = "auto";
			expect(cfgEditFuzzyMatch.get(configured)).toBe(true);
		} finally {
			for (const name in saved) {
				const value = saved[name];
				if (value === undefined) delete Bun.env[name];
				else Bun.env[name] = value;
			}
		}
	});

	it("recomputes a derivation only when one of its inputs changes", () => {
		const settings = Settings.isolated();
		let computations = 0;
		const sampling = combine({ temperature: cfgTemperature, topP: cfgTopP }, values => {
			computations++;
			return { ...values };
		});

		const first = sampling.get(settings);
		expect(sampling.get(settings)).toBe(first);
		cfgTopK.override(settings, 7);
		expect(sampling.get(settings)).toBe(first);
		expect(computations).toBe(1);

		cfgTemperature.override(settings, 0.3);
		expect(sampling.get(settings)).toEqual({ temperature: 0.3, topP: first.topP });
		expect(computations).toBe(2);
	});

	it("coalesces listener notifications per tick and skips no-op changes", async () => {
		const settings = Settings.isolated();
		const seen: [number, number][] = [];
		cfgTemperature.listen(settings, (next, previous) => {
			seen.push([next, previous]);
		});

		const initial = cfgTemperature.get(settings);
		cfgTemperature.override(settings, 0.4);
		cfgTemperature.override(settings, 0.6);
		await tick();
		expect(seen).toEqual([[0.6, initial]]);

		cfgTemperature.override(settings, 0.6);
		cfgTopP.override(settings, 0.5);
		await tick();
		expect(seen).toHaveLength(1);
	});

	it("drops listeners with the owning scope", async () => {
		const settings = Settings.isolated();
		const disposers: (() => void)[] = [];
		const scope = { settings, addDisposer: (dispose: () => void) => disposers.push(dispose) };
		let calls = 0;
		cfgTemperature.listen(scope, () => {
			calls++;
		});

		for (const dispose of disposers) dispose();
		cfgTemperature.override(settings, 0.9);
		await tick();
		expect(calls).toBe(0);
	});

	it("reads an overlay through to its parent while keeping overlay writes local", async () => {
		const parent = Settings.isolated({ temperature: 0.2 });
		const child = parent.overlay({ topP: 0.5 });
		const childTemperatures: number[] = [];
		cfgTemperature.listen(child, next => {
			childTemperatures.push(next);
		});

		cfgTemperature.override(parent, 0.7);
		await tick();
		expect(cfgTemperature.get(child)).toBe(0.7);
		expect(childTemperatures).toEqual([0.7]);

		cfgTemperature.set(child, 0.1);
		expect(cfgTemperature.get(child)).toBe(0.1);
		expect(cfgTemperature.get(parent)).toBe(0.7);

		// The child's own value now pins temperature: parent edits no longer reach it.
		cfgTemperature.override(parent, 0.8);
		await tick();
		expect(cfgTemperature.get(child)).toBe(0.1);
		expect(childTemperatures).toEqual([0.7, 0.1]);
		expect(cfgTopP.get(parent)).not.toBe(0.5);
	});

	it("applies effects synchronously for the bound instance only", () => {
		const previous = effectsSettings();
		const applied: number[] = [];
		effect(cfgTemperature, value => {
			applied.push(value);
		});
		const primary = Settings.isolated({ temperature: 0.2 });
		const staleUnbind = bindEffects(Settings.isolated());
		const unbind = bindEffects(primary);
		try {
			expect(applied.at(-1)).toBe(0.2);
			cfgTemperature.override(primary, 0.4);
			expect(applied.at(-1)).toBe(0.4);

			const seen = applied.length;
			cfgTemperature.override(primary.overlay(), 0.9);
			cfgTemperature.override(Settings.isolated(), 0.9);
			staleUnbind();
			cfgTemperature.override(primary, 0.5);
			expect(applied.slice(seen)).toEqual([0.5]);

			unbind();
			cfgTemperature.override(primary, 0.6);
			expect(applied.at(-1)).toBe(0.5);
		} finally {
			unbind();
			if (previous) bindEffects(previous);
		}
	});

	it("lists every registered setting exactly once in panel order", () => {
		const ordered = orderedSettings();
		expect(new Set(ordered).size).toBe(ordered.length);
		expect(new Set(ordered)).toEqual(new Set(all()));
	});

	it("rejects overrides for unknown setting ids", () => {
		expect(() => Settings.isolated({ temprature: 0.2 })).toThrow('Unknown setting "temprature"');
		expect(() => Settings.isolated().overlay({ "nope.nope": 1 })).toThrow('Unknown setting "nope.nope"');
	});
});
