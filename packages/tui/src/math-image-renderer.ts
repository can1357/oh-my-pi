/** Dependency-free host seam. SVG dimensions are intrinsic ex units, never fitted pixels. */
export interface MathImageRenderRequest {
	tex: string;
	display: boolean;
	inkHex: string;
	cellWidthPx: number;
	cellHeightPx: number;
	pixelsPerEx: number;
	maxWidthPx: number;
}
export interface MathImageSvg {
	svg: string;
	widthEx: number;
	heightEx: number;
}
export interface MathImageRenderer {
	readonly id: string;
	render(request: MathImageRenderRequest): MathImageSvg;
}
let renderer: MathImageRenderer | undefined;
let generation = 0;
const changes = new Set<() => void>();
export function setMathImageRenderer(value: MathImageRenderer | undefined): void {
	renderer = value;
	generation++;
	for (const change of changes) change();
}
export function getMathImageRenderer(): MathImageRenderer | undefined {
	return renderer;
}
export function getMathImageGeneration(): number {
	return generation;
}
/** Lifecycle subscribers are module infrastructure, not component observers. */
export function onMathImageRendererChange(change: () => void): void {
	changes.add(change);
}
