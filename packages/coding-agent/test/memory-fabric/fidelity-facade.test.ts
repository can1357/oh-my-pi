/**
 * Tests for the Adaptive-Fidelity Facade (ACF lane).
 *
 * Verifies the port composition: disabled-by-default, each injected stage
 * runs and is recorded, the planned state is used to derive route items
 * (unless explicit routeItems are given), and every stage is independently
 * fail-open (a throwing or null-returning port degrades only that stage).
 * Ports are stubs — the facade imports nothing. Offline; no clock.
 */

import { describe, expect, it } from "bun:test";
import {
	buildAdaptiveFidelityView,
	summarizeAdaptiveFidelityView,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/fidelity-facade";

describe("adaptive-fidelity facade", () => {
	it("is disabled by default — inert", () => {
		const v = buildAdaptiveFidelityView({}, {}, {});
		expect(v.enabled).toBe(false);
		expect(v.stages).toEqual([]);
	});

	it("is enabled but empty when no ports are supplied", () => {
		const v = buildAdaptiveFidelityView({}, {}, { enabled: true });
		expect(v.enabled).toBe(true);
		expect(v.stages).toEqual([]);
	});

	it("runs and records every supplied stage, deriving route items from the state", () => {
		const v = buildAdaptiveFidelityView(
			{
				items: [{ id: "a", tier: "full", local: true }],
				signals: [{ id: "s" }],
				sparsityInput: { activated: 1, eligible: 2 },
			},
			{
				planState: items => ({ items }),
				route: items => ({ assignments: items }),
				gate: signals => ({ decisions: signals }),
				measure: (input: unknown) => {
					const counts = input as { activated: number; eligible: number };
					return { ratio: counts.activated / counts.eligible };
				},
			},
			{ enabled: true },
		);
		expect(v.stages).toEqual(["state", "route", "gate", "sparsity"]);
		expect((v.routing as { assignments: Array<{ id: string }> }).assignments[0].id).toBe("a");
		expect((v.sparsity as { ratio: number }).ratio).toBe(0.5);
	});

	it("prefers explicit routeItems over deriving them from the state", () => {
		const v = buildAdaptiveFidelityView(
			{ routeItems: [{ id: "x" }] },
			{ route: items => ({ assignments: items }) },
			{ enabled: true },
		);
		expect(v.stages).toEqual(["route"]);
		expect((v.routing as { assignments: Array<{ id: string }> }).assignments[0].id).toBe("x");
	});

	it("is fail-open per stage — a throwing port degrades only that stage", () => {
		const v = buildAdaptiveFidelityView(
			{ items: [{ id: "a" }] },
			{
				planState: () => {
					throw new Error("boom");
				},
				gate: () => ({ ok: true }),
			},
			{ enabled: true },
		);
		expect(v.state).toBeNull();
		expect(v.stages).toEqual(["gate"]);
		expect((v.gate as { ok: boolean }).ok).toBe(true);
	});

	it("treats a null-returning port as not-run", () => {
		const v = buildAdaptiveFidelityView({}, { planState: () => null }, { enabled: true });
		expect(v.stages).toEqual([]);
		expect(v.state).toBeNull();
	});

	it("fails open on null request / null ports", () => {
		const v = buildAdaptiveFidelityView(null as unknown as never, null as unknown as never, { enabled: true });
		expect(v.enabled).toBe(true);
		expect(v.stages).toEqual([]);
	});

	it("summarizes disabled and enabled views", () => {
		const disabled = buildAdaptiveFidelityView({}, {}, {});
		expect(summarizeAdaptiveFidelityView(disabled)).toBe("adaptive-fidelity: disabled");
		const gated = buildAdaptiveFidelityView({}, { gate: () => ({ ok: true }) }, { enabled: true });
		expect(summarizeAdaptiveFidelityView(gated)).toBe("adaptive-fidelity: stages=[gate]");
	});
});
