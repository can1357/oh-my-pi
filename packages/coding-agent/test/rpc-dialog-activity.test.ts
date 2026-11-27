import { afterEach, expect, test, vi } from "bun:test";
import { requestRpcDialog, requestRpcFormDialog, RpcPendingExtensionRequests } from "../src/modes/rpc/rpc-mode";
import type { RpcExtensionUIActivity } from "../src/modes/rpc/rpc-types";
const html =
	'<form><label>Code<input name="code" value="AB" required pattern="[A-Z]{2}"></label><label><input name="env" type="radio" value="prod" checked>Production</label><label><input name="env" type="radio" value="old" disabled>Old</label></form>';
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function form(onTimeoutReset?: () => void) {
	const pending = new RpcPendingExtensionRequests();
	const frames: object[] = [];
	const result = requestRpcFormDialog(pending, frame => frames.push(frame), 1048575, html, {
		timeout: 1000,
		onTimeoutReset,
	});
	const id = [...pending.keys()][0]!;
	return { pending, frames, result, id };
}
test("activity extends the actual timer and timeout returns the latest partial form, not defaults", async () => {
	vi.useFakeTimers();
	const a = form();
	vi.advanceTimersByTime(900);
	a.pending.get(a.id)!.activity!({ type: "extension_ui_activity", id: a.id, data: { code: "draft", env: "prod" } });
	expect(a.frames).toContainEqual(
		expect.objectContaining({ type: "extension_ui_state", id: a.id, expiresAt: expect.any(Number) }),
	);
	vi.advanceTimersByTime(200);
	expect(a.pending.has(a.id)).toBe(true);
	vi.advanceTimersByTime(800);
	expect(await a.result).toEqual({ data: { code: "draft", env: "prod" }, timedOut: true });
	expect(a.pending.size).toBe(0);
});
test("restore does not prolong the deadline and malformed activity cannot cancel or overwrite its last valid draft", async () => {
	vi.useFakeTimers();
	const a = form();
	vi.advanceTimersByTime(900);
	a.pending.get(a.id)!.activity!({
		type: "extension_ui_activity",
		id: a.id,
		reset: false,
		data: { code: "restored", env: "prod" },
	});
	a.pending.get(a.id)!.activity!({
		type: "extension_ui_activity",
		id: a.id,
		data: { code: "bad" },
		cancelled: true,
		timedOut: true,
	} as unknown as RpcExtensionUIActivity);
	a.pending.get(a.id)!.activity!({ type: "extension_ui_activity", id: a.id, data: { env: "old" } });
	a.pending.get(a.id)!.activity!({
		type: "extension_ui_activity",
		id: a.id,
		reset: "false",
	} as unknown as RpcExtensionUIActivity);
	expect(a.frames.filter(f => (f as { type: string }).type === "extension_ui_activity_error")).toHaveLength(3);
	expect(a.frames.some(f => (f as { type: string }).type === "extension_ui_state")).toBe(false);
	vi.advanceTimersByTime(100);
	expect(await a.result).toEqual({ data: { code: "restored", env: "prod" }, timedOut: true });
});
test("only accepted activity that extends the deadline invokes the reset callback", async () => {
	vi.useFakeTimers();
	const onTimeoutReset = vi.fn();
	const a = form(onTimeoutReset);
	const activity = a.pending.get(a.id)!.activity!;
	expect(onTimeoutReset).not.toHaveBeenCalled();
	vi.advanceTimersByTime(100);
	activity({ type: "extension_ui_activity", id: a.id, reset: false, data: { code: "restored" } });
	activity({ type: "extension_ui_activity", id: a.id, data: { env: "old" } });
	expect(onTimeoutReset).not.toHaveBeenCalled();

	activity({ type: "extension_ui_activity", id: a.id });
	expect(onTimeoutReset).toHaveBeenCalledTimes(1);
	activity({ type: "extension_ui_activity", id: a.id, reset: true });
	expect(onTimeoutReset).toHaveBeenCalledTimes(2);

	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
	activity({ type: "extension_ui_activity", id: a.id, reset: true });
	expect(await a.result).toEqual({ data: { code: "restored" }, timedOut: true });
	expect(onTimeoutReset).toHaveBeenCalledTimes(2);
});
test("an already disconnected map cannot revive a timer or emit a dialog", async () => {
	vi.useFakeTimers();
	const pending = new RpcPendingExtensionRequests();
	pending.rejectAll("disconnected");
	const frames: object[] = [];
	await expect(
		requestRpcDialog(
			pending,
			f => frames.push(f),
			{ timeout: 1000 },
			false,
			{ method: "confirm" },
			() => true,
		),
	).rejects.toThrow("disconnected");
	vi.advanceTimersByTime(2000);
	expect(frames).toEqual([]);
});
test.each(["abort", "disconnect"] as const)(
	"%s removes a timed dialog and late activity cannot restart it",
	async how => {
		vi.useFakeTimers();
		const pending = new RpcPendingExtensionRequests(),
			frames: object[] = [];
		const controller = new AbortController();
		const result = requestRpcDialog(
			pending,
			f => frames.push(f),
			{ timeout: 1000, signal: controller.signal },
			false,
			{ method: "confirm" },
			() => true,
		);
		const id = [...pending.keys()][0]!,
			late = pending.get(id)!.activity!;
		if (how === "abort") {
			controller.abort();
			expect(await result).toBe(false);
		} else {
			pending.rejectAll("gone");
			await expect(result).rejects.toThrow("gone");
		}
		const count = frames.length;
		late({ type: "extension_ui_activity", id });
		vi.advanceTimersByTime(2000);
		expect(frames).toHaveLength(count);
		expect(pending.size).toBe(0);
	},
);
test("activity only moves its own dialog and data drafts are rejected for a non-form dialog", async () => {
	vi.useFakeTimers();
	const a = form();
	const b = requestRpcDialog(
		a.pending,
		f => a.frames.push(f),
		{ timeout: 1000 },
		false,
		{ method: "confirm" },
		() => true,
	);
	const id = [...a.pending.keys()].find(id => id !== a.id)!;
	vi.advanceTimersByTime(900);
	a.pending.get(a.id)!.activity!({ type: "extension_ui_activity", id: a.id });
	a.pending.get(id)!.activity!({ type: "extension_ui_activity", id, data: { code: "wrong" } });
	vi.advanceTimersByTime(100);
	expect(await b).toBe(false);
	expect(a.pending.has(a.id)).toBe(true);
	vi.advanceTimersByTime(900);
	expect(await a.result).toEqual({ data: { code: "AB", env: "prod" }, timedOut: true });
});

test("activity metadata cannot push a form past the host's intact-frame budget or leave a timer behind", async () => {
	vi.useFakeTimers();
	const a = form();
	const frame = a.frames[0]!;
	const budget = new TextEncoder().encode(JSON.stringify(frame)).byteLength - 1;
	a.pending.get(a.id)!.resolve({ type: "extension_ui_response", id: a.id, cancelled: true });
	await a.result;
	const pending = new RpcPendingExtensionRequests(),
		frames: object[] = [];
	await expect(requestRpcFormDialog(pending, f => frames.push(f), budget, html, { timeout: 1000 })).rejects.toThrow(
		"Form is too large",
	);
	vi.advanceTimersByTime(2000);
	expect(pending.size).toBe(0);
	expect(frames).toEqual([]);
});

test.each([true, false])("overdue activity reset=%s cannot beat an unexecuted timer callback", async reset => {
	vi.useFakeTimers();
	const a = form();
	a.pending.get(a.id)!.activity!({ type: "extension_ui_activity", id: a.id, reset: false, data: { code: "saved" } });
	// Advancing wall time alone deliberately leaves the due timer callback unexecuted.
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1001);
	a.pending.get(a.id)!.activity!({ type: "extension_ui_activity", id: a.id, reset, data: { code: "too late" } });
	expect(a.pending.size).toBe(0);
	expect(await a.result).toEqual({ data: { code: "saved" }, timedOut: true });
	expect(a.frames.filter(f => (f as { type: string }).type === "extension_ui_state")).toEqual([]);
	vi.advanceTimersByTime(5000);
	expect(a.frames.filter(f => (f as { method?: string }).method === "cancel")).toHaveLength(1);
});

test.each(["host", "server"] as const)("%s timeout claims settlement before a reentrant abort", async source => {
	vi.useFakeTimers();
	const pending = new RpcPendingExtensionRequests();
	const frames: object[] = [];
	const controller = new AbortController();
	const onTimeout = vi.fn(() => controller.abort());
	const result = requestRpcFormDialog(pending, f => frames.push(f), 1048575, html, {
		timeout: 1000,
		signal: controller.signal,
		onTimeout,
	});
	const id = [...pending.keys()][0]!;
	if (source === "host")
		pending.get(id)!.resolve({ type: "extension_ui_response", id, cancelled: true, timedOut: true });
	else vi.advanceTimersByTime(1000);
	expect(await result).toEqual({ data: { code: "AB", env: "prod" }, timedOut: true });
	expect(onTimeout).toHaveBeenCalledTimes(1);
	expect(frames.filter(f => (f as { method?: string }).method === "cancel")).toHaveLength(source === "host" ? 0 : 1);
	expect(pending.size).toBe(0);
});

test("an explicitly empty draft clears a checked checkbox default on timeout", async () => {
	vi.useFakeTimers();
	const pending = new RpcPendingExtensionRequests();
	const result = requestRpcFormDialog(
		pending,
		() => {},
		1048575,
		'<form><label><input type="checkbox" name="enabled" value="yes" checked>Enabled</label></form>',
		{ timeout: 1000 },
	);
	const id = [...pending.keys()][0]!;
	pending.get(id)!.activity!({ type: "extension_ui_activity", id, data: {} });
	vi.advanceTimersByTime(1000);
	expect(await result).toEqual({ data: {}, timedOut: true });
});
