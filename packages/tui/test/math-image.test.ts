import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	beginMathImageDocument,
	getMathImageGeneration,
	getImageRenderContext,
	ImageBudget,
	mathImageOwnerPending,
	measureRender,
	releaseMathImageOwner,
	renderMathImage,
	renderForScrollback,
	setMathImageRenderer,
	withImageRenderContext,
	withMathImageOwner,
	type Component,
	type MathImageRenderRequest,
} from "@oh-my-pi/pi-tui";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
withoutTerminalMultiplexer();
const protocol = TERMINAL.imageProtocol;
const cell = getCellDimensions();
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const request: MathImageRenderRequest = {
	tex: "x",
	display: true,
	inkHex: "#ffffff",
	cellWidthPx: 10,
	cellHeightPx: 20,
	pixelsPerEx: 10,
	maxWidthPx: 100,
};
const svg = {
	svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="1ex" height="1ex"><rect width="10" height="10" fill="white"/></svg>',
	widthEx: 1,
	heightEx: 1,
};
const owner: Component = { render: () => [], invalidate: () => {} };
let changed = 0;
let budget: ImageBudget;
let completion = Promise.withResolvers<void>();
function render(value = request, occurrence = "0") {
	if (!mathImageOwnerPending(owner)) completion = Promise.withResolvers<void>();
	return withImageRenderContext(
		{
			budget,
			requestRender: () => {
				changed++;
				completion.resolve();
			},
		},
		() =>
			withMathImageOwner(
				owner,
				() => {
					changed++;
					completion.resolve();
				},
				() => renderMathImage(value, 200, beginMathImageDocument(), occurrence),
			),
	);
}
async function settled() {
	if (mathImageOwnerPending(owner)) await completion.promise;
	completion = Promise.withResolvers<void>();
	expect(mathImageOwnerPending(owner)).toBe(false);
}
beforeEach(() => {
	completion = Promise.withResolvers<void>();
	changed = 0;
	budget = new ImageBudget(8, () => changed++);
	terminal.imageProtocol = ImageProtocol.Kitty;
	setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => {
	releaseMathImageOwner(owner);
	setMathImageRenderer(undefined);
	terminal.imageProtocol = protocol;
	setCellDimensions(cell);
});
it("exports contracts and restores nested context after exceptions", () => {
	expect(getImageRenderContext()).toBeUndefined();
	expect(() =>
		withImageRenderContext({ budget, requestRender: () => {} }, () => {
			expect(getImageRenderContext()?.budget).toBe(budget);
			throw Error("scope");
		}),
	).toThrow("scope");
	expect(getImageRenderContext()).toBeUndefined();
	expect(render().pending).toBe(false);
});
it("defers, coalesces exact requests and repaints a ready exact-cell image", async () => {
	const received: MathImageRenderRequest[] = [];
	setMathImageRenderer({
		id: "test",
		render: value => {
			received.push(value);
			return svg;
		},
	});
	expect(render().pending).toBe(true);
	expect(render().pending).toBe(true);
	expect(received).toHaveLength(0);
	await settled();
	expect(received).toEqual([request]);
	expect(changed).toBe(1);
	budget.beginPass();
	const ready = render();
	expect(ready.graphic).toBe(true);
	expect(ready.lines.length).toBe(1);
	budget.endPass();
	budget.beginPass();
	expect(render().lines).toEqual(ready.lines);
	budget.endPass();
});

for (const lostMapping of ["reset", "eviction"] as const) {
	for (const retirement of ["off-screen handler", "owner release"] as const) {
		it(`retires retained math through ${retirement} after ${lostMapping}`, async () => {
			const graphics = getKittyGraphics();
			const otherOwner: Component = { render: () => [], invalidate: () => {} };
			try {
				setKittyGraphics({ unicodePlaceholders: false });
				setMathImageRenderer({ id: "lifecycle", render: () => svg });
				render();
				await settled();
				budget.beginPass();
				const initial = render();
				const id = Number(initial.lines.join("").match(/\bi=(\d+)/)![1]);
				budget.endPass();
				budget.takeTransmits();
				budget.limitResidentImages();
				if (lostMapping === "reset") {
					expect(budget.takeAllTransmittedIds()).toContain(id);
				} else {
					budget.beginPass();
					withImageRenderContext({ budget, requestRender: () => {} }, () =>
						withMathImageOwner(
							otherOwner,
							() => {},
							() => {
								for (let i = 0; i < 512; i++)
									renderMathImage(request, 200, beginMathImageDocument(), String(i));
							},
						),
					);
					budget.endPass();
					budget.takeTransmits();
					budget.limitResidentImages();
					expect(budget.takePurgeIds()).toContain(id);
				}
				budget.beginPass();
				const restored = render();
				expect(restored.lines.join("")).toContain(`i=${id},`);
				budget.endPass();
				budget.takeTransmits();
				budget.limitResidentImages();
				if (retirement === "off-screen handler") {
					budget.setPlacementViewport([]);
					budget.beginPass();
					expect(render().lines.join("")).not.toContain(`i=${id},`);
					budget.endPass();
				} else {
					releaseMathImageOwner(owner);
					budget.beginPass();
					budget.endPass();
					budget.limitResidentImages();
					expect(budget.takePurgeIds()).toContain(id);
				}
			} finally {
				releaseMathImageOwner(otherOwner);
				setKittyGraphics(graphics);
			}
		});
	}
}

for (const imageProtocol of [ImageProtocol.Kitty, ImageProtocol.Iterm2, ImageProtocol.Sixel]) {
	it(`preserves single-row math cursors on ${JSON.stringify(imageProtocol)}`, async () => {
		const graphics = getKittyGraphics();
		try {
			setKittyGraphics({ unicodePlaceholders: false });
			terminal.imageProtocol = imageProtocol;
			setMathImageRenderer({ id: "cursor", render: () => svg });
			render();
			await settled();
			const ready = renderForScrollback(() => render());
			expect(ready.graphic).toBe(true);
			const line = ready.lines[0]!;
			expect(line.startsWith("\x1b7")).toBe(true);
			expect(line.endsWith("\x1b8")).toBe(true);
			if (imageProtocol === ImageProtocol.Iterm2) {
				expect(line).toContain("doNotMoveCursor=1");
				expect(line).not.toContain("size=");
			}
		} finally {
			setKittyGraphics(graphics);
		}
	});
}

it("retains failed identities without retries and permits changed context", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "fail",
		render: () => {
			calls++;
			throw Error("invalid");
		},
	});
	render();
	await settled();
	expect(render().pending).toBe(false);
	expect(calls).toBe(1);
	render({ ...request, inkHex: "#000000" });
	await settled();
	expect(calls).toBe(2);
});
it("rejects oversized SVG and tall inline geometry as settled fallback", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "huge",
		render: () => {
			calls++;
			return { ...svg, svg: svg.svg + " ".repeat(600000) };
		},
	});
	render();
	await settled();
	expect(render().graphic).toBe(false);
	expect(calls).toBe(1);
	setMathImageRenderer({ id: "tall", render: () => ({ ...svg, heightEx: 3 }) });
	render({ ...request, display: false });
	await settled();
	expect(render({ ...request, display: false }).pending).toBe(false);
});
it("replacement advances generation and disposed queued work cannot repaint", async () => {
	let calls = 0;
	const generation = getMathImageGeneration();
	setMathImageRenderer({
		id: "same",
		render: () => {
			calls++;
			return svg;
		},
	});
	expect(getMathImageGeneration()).toBe(generation + 1);
	render();
	releaseMathImageOwner(owner);
	expect(changed).toBe(0);
	setMathImageRenderer({
		id: "same",
		render: () => {
			calls++;
			return svg;
		},
	});
	render();
	await settled();
	expect(calls).toBe(1);
});
it("measurement does not sweep live slots; empty complete render releases owners", async () => {
	setMathImageRenderer({ id: "test", render: () => svg });
	render();
	await settled();
	budget.beginPass();
	const lines = render().lines;
	budget.endPass();
	measureRender(() =>
		withMathImageOwner(
			owner,
			() => changed++,
			() => [],
		),
	);
	budget.beginPass();
	expect(render().lines).toEqual(lines);
	budget.endPass();
	withMathImageOwner(
		owner,
		() => changed++,
		() => [],
	);
	expect(mathImageOwnerPending(owner)).toBe(false);
});
it("negative cache evicts at its entry bound", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "fail",
		render: () => {
			calls++;
			throw Error("invalid");
		},
	});
	for (let i = 0; i < 257; i++) {
		render({ ...request, tex: String(i) });
		await settled();
	}
	render({ ...request, tex: "0" });
	await settled();
	expect(calls).toBe(258);
});

it("PNG eviction rerasterizes while retaining the shared SVG conversion", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "cache",
		render: () => {
			calls++;
			return svg;
		},
	});
	for (let i = 0; i < 257; i++) {
		render({ ...request, tex: String(i) });
		await settled();
	}
	expect(calls).toBe(257);
	expect(render({ ...request, tex: "0" }).pending).toBe(true);
	await settled();
	expect(calls).toBe(257);
});

it("a conversion failure survives row-limit changes but not renderer replacement", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "failed-context",
		render: () => {
			calls++;
			throw Error("bad TeX");
		},
	});
	render();
	await settled();
	const presentation = withImageRenderContext({ budget, requestRender: () => {} }, () =>
		withMathImageOwner(
			owner,
			() => {},
			() => renderMathImage(request, 100, beginMathImageDocument(), "0"),
		),
	);
	expect(presentation.pending).toBe(false);
	expect(calls).toBe(1);
	setMathImageRenderer({
		id: "failed-context",
		render: () => {
			calls++;
			return svg;
		},
	});
	render();
	await settled();
	expect(calls).toBe(2);
});

it("geometry rejects unrepresentable cells without scheduling conversion", () => {
	let calls = 0;
	setMathImageRenderer({
		id: "geometry",
		render: () => {
			calls++;
			return svg;
		},
	});
	expect(render({ ...request, cellWidthPx: 0 }).pending).toBe(false);
	expect(render({ ...request, cellHeightPx: 1.5 }).pending).toBe(false);
	expect(render({ ...request, cellWidthPx: 5000 }).pending).toBe(false);
	expect(calls).toBe(0);
});

it("SVG aggregate bounds evict successful conversion data", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "svg-cache",
		render: () => {
			calls++;
			return { ...svg, svg: svg.svg.replace("</svg>", `<!--${" ".repeat(400000)}--></svg>`) };
		},
	});
	for (let i = 0; i < 12; i++) {
		render({ ...request, tex: String(i) });
		await settled();
	}
	// Use a new raster-height identity to expose the evicted SVG instead of the PNG hit.
	completion = Promise.withResolvers<void>();
	withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
		withMathImageOwner(
			owner,
			() => completion.resolve(),
			() => renderMathImage({ ...request, tex: "0" }, 180, beginMathImageDocument(), "0"),
		),
	);
	await settled();
	expect(calls).toBe(13);
});

it("same-owner nested scopes preserve document order and use custom landing callbacks", async () => {
	let inner = 0;
	setMathImageRenderer({ id: "nested", render: () => svg });
	withImageRenderContext({ budget, requestRender: () => {} }, () =>
		withMathImageOwner(
			owner,
			() => completion.resolve(),
			() => {
				expect(beginMathImageDocument()).toBe(0);
				withMathImageOwner(
					owner,
					() => {
						inner++;
						completion.resolve();
					},
					() => {
						expect(beginMathImageDocument()).toBe(1);
						renderMathImage(request, 200, 1, "0");
					},
				);
				expect(beginMathImageDocument()).toBe(2);
			},
		),
	);
	await settled();
	expect(inner).toBe(1);
});

it("absorbs floating-point overflow at the fitted whole-cell width ceiling", async () => {
	setMathImageRenderer({ id: "rounding", render: () => ({ ...svg, widthEx: 205.445, heightEx: 1 }) });
	const value = { ...request, maxWidthPx: 1700, cellWidthPx: 20 };
	render(value);
	await settled();
	budget.beginPass();
	expect(render(value).graphic).toBe(true);
	budget.endPass();
});

it("more than cache-sized owner occurrences settle without eviction repaint loops", async () => {
	setMathImageRenderer({ id: "dense", render: () => svg });
	const paint = () =>
		withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
			withMathImageOwner(
				owner,
				() => completion.resolve(),
				() => {
					const document = beginMathImageDocument();
					return Array.from({ length: 600 }, (_, index) =>
						renderMathImage({ ...request, tex: String(index) }, 200, document, String(index)),
					);
				},
			),
		);
	paint();
	let frames = 0;
	while (mathImageOwnerPending(owner)) {
		await completion.promise;
		completion = Promise.withResolvers<void>();
		paint();
		expect(++frames).toBeLessThanOrEqual(601);
	}
	expect(paint().filter(value => value.pending)).toHaveLength(0);
	expect(paint().filter(value => value.graphic).length).toBe(600);
});

it("queued conversions across many owners eventually become graphics", async () => {
	const documents = Array.from({ length: 30 }, () => ({ render: () => [], invalidate: () => {} }));
	setMathImageRenderer({ id: "many-owners", render: () => svg });
	const paint = () =>
		withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
			documents.flatMap((document, index) =>
				withMathImageOwner(
					document,
					() => completion.resolve(),
					() =>
						Array.from({ length: 10 }, (_, occurrence) =>
							renderMathImage({ ...request, tex: `${index}:${occurrence}` }, 200, 0, String(occurrence)),
						),
				),
			),
		);
	try {
		paint();
		let frames = 0;
		while (documents.some(document => mathImageOwnerPending(document))) {
			await completion.promise;
			completion = Promise.withResolvers<void>();
			paint();
			expect(++frames).toBeLessThanOrEqual(301);
		}
		expect(paint().filter(value => value.graphic)).toHaveLength(300);
	} finally {
		for (const document of documents) releaseMathImageOwner(document);
	}
});
