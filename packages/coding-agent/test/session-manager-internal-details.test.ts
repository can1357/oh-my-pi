/**
 * Phase 6 — F layer.
 *
 * Direct unit tests on:
 *   - `SessionManager.appendCustomMessageEntry` — the single chokepoint that
 *     routes `details` through `stripInternalDetailsFields` before persistence;
 *   - `stripInternalDetailsFields` itself — the helper that enforces the
 *     `INTERNAL_DETAILS_FIELDS` allowlist.
 *
 * The contract under test is the explicit-allowlist regression guard: only the
 * fields named in `INTERNAL_DETAILS_FIELDS` are removed; anything else (even
 * `__`-prefixed fields not in the allowlist) is preserved verbatim.
 */
import { describe, expect, it } from "bun:test";
import { type SkillPromptDetails, stripInternalDetailsFields } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { CustomMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const SKILL_TYPE = "skill-prompt";

function readPersistedCustomMessageEntry<T>(session: SessionManager, id: string): CustomMessageEntry<T> {
	const branch = session.getBranch();
	const entry = branch.find(e => e.id === id);
	if (entry?.type !== "custom_message") {
		throw new Error(`Expected custom_message entry with id ${id}, got ${entry?.type ?? "none"}`);
	}
	return entry as CustomMessageEntry<T>;
}

describe("SessionManager.appendCustomMessageEntry (allowlist strip + persistence contract)", () => {
	it("F1: strips __queueChipText from persisted details while preserving all other SkillPromptDetails fields", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry<SkillPromptDetails>(
			SKILL_TYPE,
			"skill body",
			true,
			{
				name: "foo",
				path: "/s.md",
				args: "bar",
				lineCount: 10,
				__queueChipText: "omp-cmd-1-0",
			},
			"user",
		);

		const entry = readPersistedCustomMessageEntry<SkillPromptDetails>(session, id);
		expect(entry.details).toEqual({
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 10,
		});
		// Explicit absence assertion — defends against `toEqual` semantics drift
		// where an `undefined`-valued key would still satisfy deep equality.
		expect(Object.hasOwn(entry.details!, "__queueChipText")).toBe(false);
	});

	it("F2: persists details deep-equal to the input when no allowlisted field is present", () => {
		const session = SessionManager.inMemory();
		const input: SkillPromptDetails = {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 10,
		};
		const id = session.appendCustomMessageEntry<SkillPromptDetails>(SKILL_TYPE, "skill body", true, input, "user");
		const entry = readPersistedCustomMessageEntry<SkillPromptDetails>(session, id);
		// Deep equality on shape only — the contract intentionally does NOT couple
		// to whether the helper clones or short-circuits internally. Future
		// refactors (defensive cloning, JSON round-trip) cannot break this test.
		expect(entry.details).toEqual(input);
	});

	it("F3: does NOT strip __-prefixed fields that are not in INTERNAL_DETAILS_FIELDS (explicit-allowlist guard)", () => {
		// Regression guard against an over-broad strip — only allowlisted keys go.
		// Future internal fields that haven't been added to the allowlist must be
		// preserved verbatim until that change ships intentionally.
		const session = SessionManager.inMemory();
		const id = session.appendCustomMessageEntry<Record<string, unknown>>(
			SKILL_TYPE,
			"skill body",
			true,
			{
				name: "foo",
				path: "/s.md",
				args: "bar",
				lineCount: 10,
				__future_field: "preserve-me",
			},
			"user",
		);
		const entry = readPersistedCustomMessageEntry<Record<string, unknown>>(session, id);
		expect(entry.details).toEqual({
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 10,
			__future_field: "preserve-me",
		});
	});

	it("F4: stripInternalDetailsFields treats undefined / null / non-object details as identity", () => {
		expect(stripInternalDetailsFields(undefined)).toBeUndefined();
		// `null as never` here only because the public signature is `T | undefined`,
		// but the runtime contract has to tolerate `null` defensively.
		expect(stripInternalDetailsFields(null as unknown as undefined)).toBeNull();
		expect(stripInternalDetailsFields("string" as unknown as undefined)).toBe("string" as unknown as undefined);
	});

	it("F5: stripInternalDetailsFields preserves the input shape verbatim when no allowlisted field is present", () => {
		// Shape-preservation contract: the helper returns a value deep-equal to
		// the input when no allowlisted key is present. The plan's original
		// `Object.is` identity claim was deliberately weakened here to a
		// shape-preservation assertion so a future defensive-clone refactor
		// (e.g. structured-clone-on-read) cannot break this test without a real
		// behavioral regression. Identity / allocation strategy is an internal
		// implementation detail of the helper, not a public contract.
		const input = { name: "foo", lineCount: 1 };
		const result = stripInternalDetailsFields(input);
		expect(result).toEqual(input);
		// Every input key survives — no allowlisted field touched, so no key
		// dropped. Iterating the input's keys defends against a regression that
		// silently drops one even when the shape happens to match deep-equality
		// (e.g. via an extra `undefined` member).
		for (const key of Object.keys(input)) {
			expect(Object.hasOwn(result as object, key)).toBe(true);
		}
	});
});
