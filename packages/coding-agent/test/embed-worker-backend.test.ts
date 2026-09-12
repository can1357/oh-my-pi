// Contract: the mnemopi embed worker routes to the ggml initializer exactly
// when MNEMOPI_EMBED_BACKEND=ggml, and stays on fastembed otherwise (including
// the unset default). This is the routing branch that the ggml-embedding unit
// tests never exercise — they import ggmlLocalModelInitializer directly. It is
// proven here WITHOUT loading either native addon: selectedInitializer() only
// selects a function reference, it never invokes an initializer, so neither
// node-llama-cpp nor fastembed/onnxruntime is pulled into the test process.
import { describe, expect, it } from "bun:test";
import { defaultLocalModelInitializer, ggmlLocalModelInitializer } from "@oh-my-pi/pi-mnemopi/core";
import { selectedInitializer } from "../src/mnemopi/embed-worker";

describe("embed-worker selectedInitializer backend routing", () => {
	it("selects the ggml initializer when MNEMOPI_EMBED_BACKEND=ggml", () => {
		const before = process.env.MNEMOPI_EMBED_BACKEND;
		process.env.MNEMOPI_EMBED_BACKEND = "ggml";
		try {
			expect(selectedInitializer()).toBe(ggmlLocalModelInitializer);
		} finally {
			if (before !== undefined) process.env.MNEMOPI_EMBED_BACKEND = before;
			else delete process.env.MNEMOPI_EMBED_BACKEND;
		}
	});

	it("keeps the fastembed initializer when the backend is unset or explicitly fastembed", () => {
		const before = process.env.MNEMOPI_EMBED_BACKEND;
		delete process.env.MNEMOPI_EMBED_BACKEND;
		try {
			expect(selectedInitializer()).toBe(defaultLocalModelInitializer);
			// An explicit fastembed spelling (or any typo that falls back) must
			// never route to the ggml initializer.
			process.env.MNEMOPI_EMBED_BACKEND = "fastembed";
			expect(selectedInitializer()).toBe(defaultLocalModelInitializer);
		} finally {
			if (before !== undefined) process.env.MNEMOPI_EMBED_BACKEND = before;
			else delete process.env.MNEMOPI_EMBED_BACKEND;
		}
	});
});
