import { describe, expect, it } from "bun:test";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

type MutableTerminalInfo = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

/** Run `fn` with the terminal image protocol pinned, restoring it afterwards. */
function withProtocol(initial: ImageProtocol | null, fn: () => void): void {
	const original = TERMINAL.imageProtocol;
	terminal.imageProtocol = initial;
	try {
		fn();
	} finally {
		terminal.imageProtocol = original;
	}
}

describe("ImageBudget transmit ledger vs. mid-session protocol changes (#10359)", () => {
	it("keeps the transmit-once ledger while the protocol is unchanged", () => {
		withProtocol(ImageProtocol.Kitty, () => {
			const budget = new ImageBudget(3, () => {});
			expect(budget.shouldTransmit(1)).toBe(true);
			budget.enqueueTransmit(1, "TX1");
			budget.enqueueTransmit(2, "TX2");
			expect([...budget.takeTransmits()]).toEqual(["TX1", "TX2"]);

			// Nothing changed, so the data is still believed to be loaded.
			expect(budget.shouldTransmit(1)).toBe(false);
			expect(budget.shouldTransmit(2)).toBe(false);
			expect([...budget.takeTransmits()]).toEqual([]);
		});
	});

	it("re-transmits every image when the protocol is re-resolved mid-session", () => {
		withProtocol(ImageProtocol.Kitty, () => {
			const budget = new ImageBudget(3, () => {});
			budget.enqueueTransmit(1, "TX1");
			budget.enqueueTransmit(2, "TX2");
			budget.takeTransmits();
			expect(budget.shouldTransmit(1)).toBe(false);
			expect(budget.shouldTransmit(2)).toBe(false);

			// The Sixel probe lands (or Kitty capabilities are re-detected). The
			// terminal's graphics store no longer holds what the old protocol
			// transmitted, so the ledger must be dropped rather than trusted.
			terminal.imageProtocol = ImageProtocol.Sixel;

			expect(budget.shouldTransmit(1)).toBe(true);
			expect(budget.shouldTransmit(2)).toBe(true);
		});
	});

	it("resets once per transition, so a re-transmit under the new protocol sticks", () => {
		withProtocol(ImageProtocol.Kitty, () => {
			const budget = new ImageBudget(3, () => {});
			budget.enqueueTransmit(1, "TX1");
			budget.takeTransmits();

			terminal.imageProtocol = ImageProtocol.Sixel;
			expect(budget.shouldTransmit(1)).toBe(true);

			budget.enqueueTransmit(1, "TX1-again");
			expect([...budget.takeTransmits()]).toEqual(["TX1-again"]);

			// Edge-triggered: repeated checks under the same (new) protocol must
			// not keep clearing the ledger, or every frame would re-send base64.
			expect(budget.shouldTransmit(1)).toBe(false);
			expect(budget.shouldTransmit(1)).toBe(false);
			expect([...budget.takeTransmits()]).toEqual([]);
		});
	});

	it("drops the ledger when the terminal loses graphics support entirely", () => {
		withProtocol(ImageProtocol.Kitty, () => {
			const budget = new ImageBudget(3, () => {});
			budget.enqueueTransmit(7, "TX7");
			budget.takeTransmits();
			expect(budget.shouldTransmit(7)).toBe(false);

			terminal.imageProtocol = null;
			expect(budget.shouldTransmit(7)).toBe(true);
		});
	});

	it("does not fire a spurious reset for a budget created under no protocol", () => {
		withProtocol(null, () => {
			const budget = new ImageBudget(3, () => {});
			expect(budget.shouldTransmit(1)).toBe(true);
			budget.enqueueTransmit(1, "TX1");
			expect(budget.shouldTransmit(1)).toBe(false);
			expect([...budget.takeTransmits()]).toEqual(["TX1"]);
		});
	});
});
