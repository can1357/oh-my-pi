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
});
