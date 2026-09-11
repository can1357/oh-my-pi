// This file's import order is the contract under test: `config/settings-schema`
// MUST be loadable before `config/settings`. Do not add imports above it.
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { expect, it } from "bun:test";

it("loads the schema when imported before config/settings", () => {
	// A value import that reaches back into `config/settings` (e.g. pulling STT
	// constants from the runtime transcription client instead of the
	// dependency-free `stt/cloud-models` leaf) closes a cycle in which
	// `settings.ts` evaluates `Object.keys(SETTINGS_SCHEMA)` while the binding
	// is still uninitialized, throwing a ReferenceError before any consumer can
	// start.
	expect(Object.keys(SETTINGS_SCHEMA).length).toBeGreaterThan(0);
	expect(SETTINGS_SCHEMA["stt.backend"]?.default).toBe("local");
});
