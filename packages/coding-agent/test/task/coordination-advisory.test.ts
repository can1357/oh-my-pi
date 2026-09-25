import { describe, expect, it } from "bun:test";
import { buildCoordinationAdvisory, composeSpawnAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-tui/tools/task";

const item = (): TaskItem => ({ task: "do the thing" });

describe("buildCoordinationAdvisory", () => {
	it("suggests coordination when multiple siblings can message each other", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, true)).toBeDefined();
	});

	it("stays silent for a single spawn", () => {
		expect(buildCoordinationAdvisory([item()], true, true)).toBeUndefined();
	});

	it("stays silent when messaging is unavailable", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, false)).toBeUndefined();
	});

	it("stays silent without spawn capacity", () => {
		expect(buildCoordinationAdvisory([item(), item()], false, true)).toBeUndefined();
	});
});

describe("composeSpawnAdvisory", () => {
	const genericFanout = {
		agents: ["task", "task"],
		items: [item(), item()],
		depthCapacity: true,
	};

	it("adds peer coordination only while siblings still run asynchronously", () => {
		const noMessaging = composeSpawnAdvisory({ ...genericFanout, ircEnabled: false, willRunAsync: true });
		const synchronous = composeSpawnAdvisory({ ...genericFanout, ircEnabled: true, willRunAsync: false });
		const asynchronous = composeSpawnAdvisory({ ...genericFanout, ircEnabled: true, willRunAsync: true });

		expect(noMessaging).toBeDefined();
		expect(synchronous).toEqual(noMessaging);
		expect(asynchronous).not.toEqual(noMessaging);
	});

	it("returns no advisory for a single specialist or exhausted spawn capacity", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["reviewer"],
				items: [item()],
				depthCapacity: true,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
		expect(
			composeSpawnAdvisory({
				...genericFanout,
				depthCapacity: false,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});
});
