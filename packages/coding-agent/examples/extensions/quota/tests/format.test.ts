import { describe, expect, it } from "bun:test";
import {
	classifyHealth,
	formatDuration,
	formatPercent,
	padEndVisible,
	renderRemainingBarPlain,
	renderRemainingBarStyled,
	visibleWidth,
} from "../src/format";

const mockTheme = {
	fg: (color: string, text: string) => `[fg:${color}]${text}[/fg]`,
	bold: (text: string) => `[bold]${text}[/bold]`,
};

describe("format helpers", () => {
	describe("classifyHealth", () => {
		it("1. classifies 51-100% as healthy (✓, success)", () => {
			const h100 = classifyHealth(1.0);
			expect(h100.status).toBe("healthy");
			expect(h100.symbol).toBe("✓");
			expect(h100.color).toBe("success");

			const h51 = classifyHealth(0.51);
			expect(h51.status).toBe("healthy");
			expect(h51.symbol).toBe("✓");
			expect(h51.color).toBe("success");
		});

		it("2. classifies 21-50% as low (⚠, warning)", () => {
			const h50 = classifyHealth(0.5);
			expect(h50.status).toBe("low");
			expect(h50.symbol).toBe("⚠");
			expect(h50.color).toBe("warning");

			const h21 = classifyHealth(0.21);
			expect(h21.status).toBe("low");
			expect(h21.symbol).toBe("⚠");
		});

		it("3. classifies 1-20% as critical (!, error)", () => {
			const h20 = classifyHealth(0.2);
			expect(h20.status).toBe("critical");
			expect(h20.symbol).toBe("!");
			expect(h20.color).toBe("error");

			const h1 = classifyHealth(0.01);
			expect(h1.status).toBe("critical");
			expect(h1.symbol).toBe("!");
			expect(h1.color).toBe("error");

			// Sub-0.5% boundary: must be critical (!), not exhausted (✕)
			const hSubHalf = classifyHealth(0.004);
			expect(hSubHalf.status).toBe("critical");
			expect(hSubHalf.symbol).toBe("!");
			expect(hSubHalf.color).toBe("error");
		});

		it("4. classifies 0% as exhausted (✕, error)", () => {
			const h0 = classifyHealth(0);
			expect(h0.status).toBe("exhausted");
			expect(h0.symbol).toBe("✕");
			expect(h0.color).toBe("error");
		});

		it("4b. treats explicit isExhaustedFlag as exhausted even with positive fraction", () => {
			const h = classifyHealth(0.15, true);
			expect(h.status).toBe("exhausted");
			expect(h.symbol).toBe("✕");
			expect(h.color).toBe("error");
		});

		it("5. classifies undefined fraction as unknown (?, muted)", () => {
			const h = classifyHealth(undefined);
			expect(h.status).toBe("unknown");
			expect(h.symbol).toBe("?");
			expect(h.color).toBe("muted");
		});
	});

	describe("renderRemainingBarPlain (12 cells)", () => {
		it("14. renders 100%, partial, and 0% bars accurately", () => {
			expect(renderRemainingBarPlain(1.0, 12)).toBe("████████████");
			expect(renderRemainingBarPlain(0.93, 12)).toBe("███████████░");
			expect(renderRemainingBarPlain(0.42, 12)).toBe("█████░░░░░░░");
			expect(renderRemainingBarPlain(0.25, 12)).toBe("███░░░░░░░░░");
			expect(renderRemainingBarPlain(0.12, 12)).toBe("█░░░░░░░░░░░");
			expect(renderRemainingBarPlain(0, 12)).toBe("░░░░░░░░░░░░");
			expect(renderRemainingBarPlain(undefined, 12)).toBe("············");
		});
	});

	describe("renderRemainingBarStyled", () => {
		it("styles filled portion with health color and empty portion with dim", () => {
			const health = classifyHealth(0.5);
			const bar = renderRemainingBarStyled(0.5, health, mockTheme, 12);
			expect(bar).toBe("[fg:warning]██████[/fg][fg:dim]░░░░░░[/fg]");
		});

		it("renders exhausted bar with all dim cells", () => {
			const health = classifyHealth(0);
			const bar = renderRemainingBarStyled(0, health, mockTheme, 12);
			expect(bar).toBe("[fg:dim]░░░░░░░░░░░░[/fg]");
		});

		it("renders unknown bar with all muted dots", () => {
			const health = classifyHealth(undefined);
			const bar = renderRemainingBarStyled(undefined, health, mockTheme, 12);
			expect(bar).toBe("[fg:muted]············[/fg]");
		});
	});

	describe("formatPercent", () => {
		it("formats percentages with clean rounding", () => {
			expect(formatPercent(1.0)).toBe("100%");
			expect(formatPercent(0.93)).toBe("93%");
			expect(formatPercent(0.29)).toBe("29%");
			expect(formatPercent(0.667)).toBe("66.7%");
			expect(formatPercent(0.004)).toBe("0.4%");
			expect(formatPercent(0)).toBe("0%");
		});
	});

	describe("formatDuration", () => {
		it("13. formats countdown durations compactly", () => {
			expect(formatDuration(45_000)).toBe("45s");
			expect(formatDuration(32 * 60_000)).toBe("32m");
			expect(formatDuration(4 * 3600_000)).toBe("4h");
			expect(formatDuration(6 * 24 * 3600_000)).toBe("6d");
		});
	});

	describe("visibleWidth and padding", () => {
		it("pads strings to target visual width", () => {
			const padded = padEndVisible("\x1b[32mhi\x1b[0m", 6);
			expect(visibleWidth(padded)).toBe(6);
		});
	});
});
