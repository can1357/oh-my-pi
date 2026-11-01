import { afterEach, describe, expect, it } from "bun:test";
import {
	configureRecallFeatures,
	enhancedRecallEnabled,
	polyphonicRecallEnabled,
	proactiveLinkingEnabled,
} from "@oh-my-pi/pi-mnemopi/config";
import { polyphonicRecallIsEnabled } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { isEnhancedRecallEnabled, isQueryCacheEnabled } from "@oh-my-pi/pi-mnemopi/core/query-cache";

afterEach(() => {
	configureRecallFeatures({ polyphonicRecall: false, enhancedRecall: false, proactiveLinking: false });
});

describe("configureRecallFeatures", () => {
	it("keeps all recall gates off by default", () => {
		expect(polyphonicRecallEnabled({})).toBe(false);
		expect(enhancedRecallEnabled({})).toBe(false);
		expect(proactiveLinkingEnabled({})).toBe(false);
		expect(isEnhancedRecallEnabled({})).toBe(false);
		expect(isQueryCacheEnabled(true, {})).toBe(false);
	});

	it("enables the gates from host configuration when the env vars are unset", () => {
		configureRecallFeatures({ polyphonicRecall: true, enhancedRecall: true, proactiveLinking: true });
		expect(polyphonicRecallEnabled({})).toBe(true);
		expect(polyphonicRecallIsEnabled({})).toBe(true);
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(true);
		expect(isEnhancedRecallEnabled({})).toBe(true);
		expect(isQueryCacheEnabled(true, {})).toBe(true);
		expect(isQueryCacheEnabled(false, {})).toBe(false);
	});

	it("lets the env vars override the configured value in both directions", () => {
		configureRecallFeatures({ polyphonicRecall: true, enhancedRecall: true, proactiveLinking: true });
		expect(polyphonicRecallEnabled({ MNEMOPI_POLYPHONIC_RECALL: "0" })).toBe(false);
		expect(enhancedRecallEnabled({ MNEMOPI_ENHANCED_RECALL: "0" })).toBe(false);
		expect(proactiveLinkingEnabled({ MNEMOPI_PROACTIVE_LINKING: "0" })).toBe(false);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "0" })).toBe(false);

		configureRecallFeatures({ polyphonicRecall: false, enhancedRecall: false, proactiveLinking: false });
		expect(polyphonicRecallEnabled({ MNEMOPI_POLYPHONIC_RECALL: "1" })).toBe(true);
		expect(enhancedRecallEnabled({ MNEMOPI_ENHANCED_RECALL: "1" })).toBe(true);
		expect(proactiveLinkingEnabled({ MNEMOPI_PROACTIVE_LINKING: "1" })).toBe(true);
		expect(isQueryCacheEnabled(true, { MNEMOPI_ENHANCED_RECALL: "1" })).toBe(true);
	});

	it("reads 1/true/yes/on as on and 0/false/no/off as off, and falls back on any other value", () => {
		const gates = [
			["MNEMOPI_POLYPHONIC_RECALL", polyphonicRecallEnabled],
			["MNEMOPI_ENHANCED_RECALL", enhancedRecallEnabled],
			["MNEMOPI_PROACTIVE_LINKING", proactiveLinkingEnabled],
		] as const;
		for (const [name, enabled] of gates) {
			for (const value of ["1", "true", "YES", " on "]) expect(enabled({ [name]: value }, false)).toBe(true);
			for (const value of ["0", "False", "no", "OFF"]) expect(enabled({ [name]: value }, true)).toBe(false);
			for (const configured of [false, true]) expect(enabled({ [name]: "maybe" }, configured)).toBe(configured);
		}
	});

	it("updates only the flags that are present", () => {
		configureRecallFeatures({ polyphonicRecall: true });
		expect(polyphonicRecallEnabled({})).toBe(true);
		expect(enhancedRecallEnabled({})).toBe(false);
		expect(proactiveLinkingEnabled({})).toBe(false);
		configureRecallFeatures({ enhancedRecall: true });
		expect(polyphonicRecallEnabled({})).toBe(true);
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(false);
		configureRecallFeatures({ proactiveLinking: true });
		expect(polyphonicRecallEnabled({})).toBe(true);
		expect(enhancedRecallEnabled({})).toBe(true);
		expect(proactiveLinkingEnabled({})).toBe(true);
	});

	it("lets a per-instance value override the process default while the env vars still win", () => {
		configureRecallFeatures({ polyphonicRecall: true, enhancedRecall: true });
		expect(polyphonicRecallEnabled({}, false)).toBe(false);
		expect(isQueryCacheEnabled(true, {}, false)).toBe(false);
		expect(polyphonicRecallEnabled({ MNEMOPI_POLYPHONIC_RECALL: "1" }, false)).toBe(true);

		configureRecallFeatures({ polyphonicRecall: false, enhancedRecall: false });
		expect(polyphonicRecallIsEnabled({}, true)).toBe(true);
		expect(enhancedRecallEnabled({}, true)).toBe(true);
		expect(enhancedRecallEnabled({ MNEMOPI_ENHANCED_RECALL: "0" }, true)).toBe(false);
	});
});
