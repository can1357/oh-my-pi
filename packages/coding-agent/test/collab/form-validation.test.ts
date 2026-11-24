import { describe, expect, it } from "bun:test";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { validateFormData } from "../../src/collab/form-validation";

describe("Collab form response validation", () => {
	it("validates every field and reconstructs typed values and hidden defaults", () => {
		const form = parseHtmlForm(
			'<form><input type="hidden" name="token" value="trusted"><input type="radio" name="target" value="a" required><input type="radio" name="target" value="b"><input name="count" type="number" min="1" required></form>',
		);
		expect({ ...validateFormData(form, { fields: [{ checked: [1] }, "3"] }) }).toEqual({
			token: "trusted",
			target: "b",
			count: 3,
		});
		expect(() => validateFormData(form, { target: "b", count: 3 })).toThrow();
		expect(() => validateFormData(form, { fields: [{ checked: [1] }, "0"] })).toThrow();
	});
	it("checks earlier required same-name fields even when their value is overwritten", () => {
		const form = parseHtmlForm('<form><input name="x" required minlength="3"><input name="x" maxlength="2"></form>');
		expect({ ...validateFormData(form, { fields: ["valid", "ok"] }) }).toEqual({ x: "ok" });
		expect(() => validateFormData(form, { fields: ["", "ok"] })).toThrow();
		expect(() => validateFormData(form, { fields: ["valid", "long"] })).toThrow();
	});
	it("preserves earlier data when a later choice is unchecked", () => {
		const form = parseHtmlForm(
			'<form><input type="hidden" name="x" value="off"><input name="x" value="draft"><input type="checkbox" name="x" value="on"></form>',
		);
		expect({ ...validateFormData(form, { fields: ["draft", { checked: [] }] }) }).toEqual({ x: "draft" });
		expect({ ...validateFormData(form, { fields: ["draft", { checked: [0] }] }) }).toEqual({ x: "on" });
	});
	it("keeps the last defined choice and trusted hidden defaults", () => {
		const form = parseHtmlForm(
			'<form><input type="hidden" name="x" value="off"><input type="radio" name="x" value="r"><input type="checkbox" name="x" value="c"></form>',
		);
		expect({ ...validateFormData(form, { fields: [{ checked: [] }, { checked: [] }] }) }).toEqual({ x: "off" });
		expect({ ...validateFormData(form, { fields: [{ checked: [0] }, { checked: [] }] }) }).toEqual({ x: "r" });
		expect({ ...validateFormData(form, { fields: [{ checked: [0] }, { checked: [0] }] }) }).toEqual({ x: "c" });
	});
	it("allows duplicate option values and Other matching a checked value", () => {
		const form = parseHtmlForm(
			'<form><input type="checkbox" name="x" value="a"><input type="checkbox" name="x" value="a"></form>',
		);
		expect({ ...validateFormData(form, { fields: [{ checked: [0, 1], other: " a " }] }) }).toEqual({
			x: ["a", "a", "a"],
		});
	});
	it("accepts Other matching an enabled duplicate but rejects a disabled-only value", () => {
		const form = parseHtmlForm(
			'<form><input type="checkbox" name="x" value="a" disabled><input type="checkbox" name="x" value="a"><input type="checkbox" name="x" value="b" disabled></form>',
		);
		expect({ ...validateFormData(form, { fields: [{ checked: [1], other: " a " }] }) }).toEqual({
			x: ["a", "a"],
		});
		expect(() => validateFormData(form, { fields: [{ checked: [], other: " b " }] })).toThrow(
			'Disabled option for "x"',
		);
		expect(() => validateFormData(form, { fields: [{ checked: [0] }] })).toThrow('Invalid option for "x"');
	});
	it("rejects malformed field states without accepting extra properties", () => {
		const form = parseHtmlForm('<form><input type="checkbox" name="x" value="a"></form>');
		for (const value of [
			{ fields: [null] },
			{ fields: [[]] },
			{ fields: [{ other: "custom" }] },
			{ fields: [{ checked: "0" }] },
			{ fields: [{ checked: [], other: 1 }] },
			{ fields: [{ checked: [], extra: true }] },
		])
			expect(() => validateFormData(form, value)).toThrow();
	});
	it("rejects forged states and disabled options", () => {
		const form = parseHtmlForm(
			'<form><input type="checkbox" name="x" value="a"><input type="checkbox" name="x" value="b" disabled></form>',
		);
		for (const value of [
			null,
			{},
			{ fields: [] },
			{ fields: [{ checked: [1] }] },
			{ fields: [{ checked: [0, 0] }] },
			{ fields: [{ checked: [-1] }] },
			{ fields: [{ checked: [0], other: " b " }] },
			{ fields: [{ checked: [], forged: true }] },
			{ fields: [{ checked: [] }], forged: true },
		])
			expect(() => validateFormData(form, value)).toThrow();
	});
	it("keeps prototype-like names as own keys", () => {
		const form = parseHtmlForm('<form><input name="__proto__"><input name="constructor"></form>');
		expect(JSON.stringify(validateFormData(form, { fields: ["safe", ""] }))).toBe(
			'{"__proto__":"safe","constructor":""}',
		);
	});
});
