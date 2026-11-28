/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `snapcompact.shape` preview: what the highlighted variant resolves to
 * (for `auto`, per the active model), the full-frame geometry and its cost,
 * and a zoomed sample page from the real rasterizer.
 *
 * Samples render asynchronously, once per variant ({@link SnapcompactSamples});
 * the preview shows a spinner until its sample is ready. The sample is an
 * `image` node; the terminal draws a notice instead.
 */
import { type Accessor, type JSXNode, type Signal, signal } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import {
	DIM_OFF,
	DIM_ON,
	geometry,
	isShapeVariantName,
	normalize,
	renderMany,
	resolveShape,
	SHAPE_VARIANT_NAMES,
	SHAPE_VARIANTS,
	type Shape,
	type ShapeGeometry,
	type ShapeTarget,
	type ShapeVariantName,
} from "@oh-my-pi/snapcompact";
import "../../styles/panels/snapcompact-shape-preview";
import sampleDoc from "./snapcompact-sample.md" with { type: "text" };

/** Edge of the rasterized sample page (px): a small page ≈ a zoomed crop. */
const SAMPLE_EDGE_PX = 128;
/** Nearest-neighbor upscale keeping glyph pixels crisp. */
const ZOOM = 4;
const MAX_COLS = 28;
const MAX_ROWS = 14;

/** The sample transcript, tool output bodies in dim ink. */
const SAMPLE_TEXT = sampleDoc
	.trim()
	.replace(/<out>\n([\s\S]*?)\n<\/out>/g, (_match, body: string) => `<out>\n${DIM_ON}${body}${DIM_OFF}\n</out>`);

/** A variant's sample page. */
export type SampleState =
	| { readonly state: "rendering" }
	| { readonly state: "failed" }
	| { readonly state: "ready"; readonly blob: string; readonly edgePx: number };

/** Sample pages by variant, rendered once each. */
export class SnapcompactSamples {
	readonly #entries = new Map<ShapeVariantName, Signal<SampleState>>();
	readonly #pending = new Set<Promise<void>>();

	/** The sample of `name` (rendering starts on first ask). */
	get(name: ShapeVariantName, shape: Shape): Accessor<SampleState> {
		let entry = this.#entries.get(name);
		if (!entry) {
			const created = signal<SampleState>({ state: "rendering" });
			entry = created;
			this.#entries.set(name, created);
			const job = renderSample(shape).then(
				sample => created.set(sample),
				() => created.set({ state: "failed" }),
			);
			this.#pending.add(job);
			void job.finally(() => this.#pending.delete(job));
		}
		return entry;
	}

	/** Resolves once every started render has finished. */
	async settled(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
	}
}

async function renderSample(shape: Shape): Promise<SampleState> {
	// Fill the page so every variant shows a fully inked window.
	const capacity = geometry(shape, SAMPLE_EDGE_PX).capacity;
	let text = SAMPLE_TEXT;
	while (normalize(text).length < capacity) text += ` ${SAMPLE_TEXT}`;
	const frame = (await renderMany(text, { shape, frameSize: SAMPLE_EDGE_PX, maxFrames: 1 }))[0];
	if (!frame) throw new Error("empty sample frame");
	const edgePx = SAMPLE_EDGE_PX * ZOOM;
	const png = await new Bun.Image(Buffer.from(frame.data, "base64"))
		.resize(edgePx, edgePx, { filter: "nearest" })
		.png()
		.bytes();
	return { state: "ready", blob: registerBlob(png, "image/png"), edgePx };
}

/** The table variant `shape` was resolved from (`auto` hands out table geometries only). */
function variantOf(shape: Shape): ShapeVariantName {
	for (const name of SHAPE_VARIANT_NAMES) {
		const v: ShapeGeometry = SHAPE_VARIANTS[name];
		if (
			v.cellWidth === shape.cellWidth &&
			v.cellHeight === shape.cellHeight &&
			v.wideCells === shape.wideCells &&
			v.variant === shape.variant &&
			v.stopwordDim === shape.stopwordDim &&
			v.columns === shape.columns &&
			v.lineRepeat === shape.lineRepeat
		) {
			return name;
		}
	}
	return "5x8-sent";
}

/** `1234` → `1.2k`. */
function compactCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface SnapcompactShapePreviewProps {
	/** The highlighted setting value (a variant name or `auto`; anything else counts as `auto`). */
	readonly value: Accessor<string>;
	/** The active model: what `auto` resolves to. */
	readonly model?: ShapeTarget;
	readonly samples: SnapcompactSamples;
	/** The terminal can display the sample graphic. */
	readonly graphics?: boolean;
}

export function SnapcompactShapePreview(props: SnapcompactShapePreviewProps): JSXNode {
	const view = () => {
		const value = props.value();
		const choice = isShapeVariantName(value) ? value : "auto";
		const shape = resolveShape(props.model, choice);
		const name = choice === "auto" ? variantOf(shape) : choice;
		const geo = geometry(shape);
		const label = choice === "auto" ? `auto → ${name}` : name;
		const stats = `full frame ${geo.cols}×${geo.rows} cells ≈ ${compactCount(geo.capacity)} chars ≈ ${compactCount(shape.frameTokenEstimate)} tokens`;
		return { caption: `Sample (zoomed) · ${label} · ${stats}`, label, sample: props.samples.get(name, shape) };
	};
	return (
		<col
			role="omp.preview.snapcompact-shape"
			gap="sm"
			term={() => ({ graphics: props.graphics ?? false, state: view().sample().state })}
		>
			<text wrap="word" spans={() => [{ s: "muted", t: view().caption }]} />
			{() => {
				const { label, sample } = view();
				const entry = sample();
				if (entry.state === "rendering") return <spinner label={[{ s: "dim", t: "rendering sample…" }]} />;
				if (entry.state === "failed") return <text spans={[{ s: "dim", t: "(sample render failed)" }]} />;
				return (
					<image
						alt={`snapcompact ${label} sample`}
						blob={entry.blob}
						w={entry.edgePx}
						h={entry.edgePx}
						max={{ w: `${MAX_COLS}ch`, h: `${MAX_ROWS}lines` }}
					/>
				);
			}}
		</col>
	);
}
