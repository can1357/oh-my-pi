import { describe, expect, it } from "bun:test";

import { parseAgentEvent, serializeAgentEvent, TaskEventChannel } from "../src/events";
import type { AgentEvent, ContextPacket } from "../src/types";

describe("TaskEventChannel", () => {
	it("replays events published before subscription in order", async () => {
		const channel = new TaskEventChannel();
		const events: AgentEvent[] = [
			{ type: "task.started", taskId: "t1" },
			{ type: "agent.message.delta", text: "hello" },
		];
		for (const event of events) channel.push(event);
		channel.close();

		const received = await Array.fromAsync(channel.subscribe());
		expect(received).toEqual(events);
	});

	it("multicasts the full ordered stream to simultaneous subscribers", async () => {
		const channel = new TaskEventChannel();
		const first = Array.fromAsync(channel.subscribe());
		const second = Array.fromAsync(channel.subscribe());
		const events: AgentEvent[] = [
			{ type: "task.started", taskId: "t1" },
			{ type: "agent.message.delta", text: "one" },
			{ type: "agent.message.delta", text: "two" },
		];

		for (const event of events) channel.push(event);
		channel.close();

		expect(await first).toEqual(events);
		expect(await second).toEqual(events);
	});

	it("closes a waiting iterator without fabricating an event", async () => {
		const channel = new TaskEventChannel();
		const iterator = channel.subscribe()[Symbol.asyncIterator]();
		const next = iterator.next();

		channel.close();

		expect(await next).toEqual({ done: true, value: undefined });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
	});

	it("aborts one subscriber without interfering with another", async () => {
		const channel = new TaskEventChannel();
		const controller = new AbortController();
		const aborted = channel.subscribe(controller.signal)[Symbol.asyncIterator]();
		const active = channel.subscribe()[Symbol.asyncIterator]();
		const abortedNext = aborted.next();
		const activeNext = active.next();

		controller.abort();
		channel.push({ type: "agent.message.delta", text: "still active" });

		expect(await abortedNext).toEqual({ done: true, value: undefined });
		expect(await activeNext).toEqual({
			done: false,
			value: { type: "agent.message.delta", text: "still active" },
		});

		channel.close();
		expect(await active.next()).toEqual({ done: true, value: undefined });
	});
});

describe("serializeAgentEvent / parseAgentEvent", () => {
	const contextPacket: ContextPacket = {
		captureId: "capture-1",
		timestamp: "2026-07-10T12:00:00.000Z",
		userRequest: "Explain this window",
		captureMode: "region",
		visual: {
			screenshotPath: "C:/tmp/capture.png",
			screenshotImage: { type: "image", data: "aW1hZ2U=", mimeType: "image/png", detail: "high" },
			selectedRegion: { x: -10, y: 20, width: 640, height: 480 },
			displayScale: 1.25,
			annotations: [{ id: "annotation-1", type: "rectangle", bounds: [1, 2, 3, 4], label: "target" }],
		},
		foregroundApp: {
			processName: "example.exe",
			windowTitle: "Example",
			executablePath: "C:/Example/example.exe",
		},
		browser: {
			url: "https://example.com",
			title: "Example",
			tabId: "tab-1",
			domSnapshotRef: "dom-1",
			accessibilityTreeRef: "a11y-1",
		},
		selection: { text: "selected", clipboardText: "copied" },
		availableCapabilities: ["capture", "browser"],
	};

	const validEvents: AgentEvent[] = [
		{ type: "task.started", taskId: "task-1" },
		{ type: "agent.message.delta", text: "hello" },
		{
			type: "plan.updated",
			steps: [
				{
					id: "step-1",
					executorId: "executor-1",
					capability: "capture",
					arguments: { target: "window", retries: 2 },
					level: 2,
					description: "Capture the active window",
					requiresApproval: true,
				},
			],
		},
		{ type: "tool.requested", callId: "call-1", toolName: "capture", arguments: { mode: "window" } },
		{
			type: "approval.requested",
			request: {
				actionId: "action-1",
				stepId: "step-1",
				level: 3,
				toolName: "shell",
				arguments: { command: "example" },
				effects: "Runs a command",
				scope: "once",
			},
		},
		{ type: "tool.started", callId: "call-1", toolName: "capture" },
		{ type: "tool.completed", callId: "call-1", result: { path: "capture.png" }, isError: false },
		{ type: "observation.updated", screenshotRef: "capture.png", contextPacket },
		{ type: "task.blocked", taskId: "task-1", reason: "Approval required" },
		{ type: "task.completed", taskId: "task-1", summary: "Done" },
		{ type: "task.failed", taskId: "task-1", error: "Failed" },
	];

	it.each(validEvents.map(event => [event.type, event] as const))("round-trips valid %s events", (_type, event) => {
		expect(parseAgentEvent(serializeAgentEvent(event))).toEqual(event);
	});

	const malformedEvents: ReadonlyArray<readonly [string, unknown]> = [
		["null payloads", null],
		["array payloads", []],
		["primitive payloads", "task.started"],
		["objects without a type", { taskId: "task-1" }],
		["unknown discriminants", { type: "task.paused", taskId: "task-1" }],
		["task.started without a task id", { type: "task.started" }],
		["agent.message.delta with non-string text", { type: "agent.message.delta", text: 1 }],
		["plan.updated with non-array steps", { type: "plan.updated", steps: {} }],
		[
			"plan.updated with malformed step arguments",
			{
				type: "plan.updated",
				steps: [
					{
						id: "step-1",
						executorId: "executor-1",
						capability: "capture",
						arguments: [],
						level: 2,
						description: "Capture",
						requiresApproval: true,
					},
				],
			},
		],
		[
			"plan.updated with an invalid action level",
			{
				type: "plan.updated",
				steps: [
					{
						id: "step-1",
						executorId: "executor-1",
						capability: "capture",
						arguments: {},
						level: 4,
						description: "Capture",
						requiresApproval: true,
					},
				],
			},
		],
		[
			"plan.updated with a non-boolean approval flag",
			{
				type: "plan.updated",
				steps: [
					{
						id: "step-1",
						executorId: "executor-1",
						capability: "capture",
						arguments: {},
						level: 1,
						description: "Capture",
						requiresApproval: "true",
					},
				],
			},
		],
		[
			"tool.requested with non-record arguments",
			{ type: "tool.requested", callId: "call-1", toolName: "capture", arguments: [] },
		],
		[
			"approval.requested with malformed nested fields",
			{
				type: "approval.requested",
				request: {
					actionId: "action-1",
					stepId: "step-1",
					level: "3",
					toolName: "shell",
					arguments: {},
					effects: "Runs a command",
					scope: "forever",
				},
			},
		],
		[
			"approval.requested with non-record arguments",
			{
				type: "approval.requested",
				request: {
					actionId: "action-1",
					stepId: "step-1",
					level: 2,
					toolName: "shell",
					arguments: [],
					effects: "Runs a command",
				},
			},
		],
		["tool.started with a missing tool name", { type: "tool.started", callId: "call-1" }],
		["tool.completed with a missing result", { type: "tool.completed", callId: "call-1", isError: false }],
		[
			"tool.completed with a non-boolean error flag",
			{ type: "tool.completed", callId: "call-1", result: null, isError: "false" },
		],
		[
			"observation.updated with a malformed visual context",
			{
				type: "observation.updated",
				contextPacket: {
					...contextPacket,
					visual: {
						...contextPacket.visual,
						annotations: [{ id: "annotation-1", type: "rectangle", bounds: [1, 2, 3] }],
					},
				},
			},
		],
		[
			"observation.updated with a malformed image",
			{
				type: "observation.updated",
				contextPacket: {
					...contextPacket,
					visual: {
						...contextPacket.visual,
						screenshotImage: { type: "image", data: 42, mimeType: "image/png" },
					},
				},
			},
		],
		[
			"observation.updated with a malformed capture mode",
			{ type: "observation.updated", contextPacket: { ...contextPacket, captureMode: "application" } },
		],
		[
			"observation.updated with malformed capabilities",
			{
				type: "observation.updated",
				contextPacket: { ...contextPacket, availableCapabilities: ["capture", false] },
			},
		],
		[
			"observation.updated with a malformed selected region",
			{
				type: "observation.updated",
				contextPacket: {
					...contextPacket,
					visual: {
						...contextPacket.visual,
						selectedRegion: { x: 0, y: 0, width: "640", height: 480 },
					},
				},
			},
		],
		["task.blocked without a reason", { type: "task.blocked", taskId: "task-1" }],
		["task.completed with a non-string summary", { type: "task.completed", taskId: "task-1", summary: true }],
		["task.failed with a non-string error", { type: "task.failed", taskId: "task-1", error: {} }],
	];

	it.each(malformedEvents)("rejects %s", (_name, event) => {
		expect(parseAgentEvent(JSON.stringify(event))).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseAgentEvent("not json")).toBeUndefined();
	});
});
