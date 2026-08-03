import { describe, expect, it } from "bun:test";
import { ExecutableUpdateMonitor } from "../../src/session/auto-restart";

describe("ExecutableUpdateMonitor", () => {
	it("restarts only after an executable change stays stable", async () => {
		const snapshots = ["old", "new", "new"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => true,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		await monitor.poll();
		expect(restarts).toBe(0);
		await monitor.poll();

		expect(restarts).toBe(1);
		expect(monitor.updatePending).toBe(true);
	});

	it("drops a transient fingerprint instead of restarting", async () => {
		const snapshots = ["old", "building", "old"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => true,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		await monitor.poll();
		await monitor.poll();

		expect(restarts).toBe(0);
		expect(monitor.updatePending).toBe(false);
	});

	it("waits for the setting to be enabled before establishing its baseline", async () => {
		let enabled = false;
		const snapshots = ["old", "new", "new"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => enabled,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		enabled = true;
		await monitor.poll();
		await monitor.poll();
		await monitor.poll();

		expect(restarts).toBe(1);
	});
});
