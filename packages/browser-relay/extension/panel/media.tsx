/** Screenshot thumbnails with the click point marked, and the lightbox they open. */
import { type ReactNode, useState } from "react";
import type { Point } from "./describe";
import { useEscape } from "./ui";

/** What the lightbox shows: an image and, for pointer steps, where omp clicked or dragged in image pixels. */
export interface LightboxImage {
	src: string;
	alt: string;
	point?: Point;
	drag?: { from: Point; to: Point };
}

interface Natural {
	width: number;
	height: number;
}

const THUMB_W = 36;
const THUMB_H = 28;

/** 36×28 step thumbnail; the dot sits on the pixel omp clicked, following the image's cover crop. */
export function Thumb(props: { image: LightboxImage; onOpen(image: LightboxImage): void }): ReactNode {
	const { image } = props;
	const [natural, setNatural] = useState<Natural | null>(null);
	let dot: { left: number; top: number } | null = null;
	if (natural !== null && image.point !== undefined && natural.width > 0 && natural.height > 0) {
		// object-fit: cover scales by the larger ratio and crops the overflow evenly on both sides.
		const scale = Math.max(THUMB_W / natural.width, THUMB_H / natural.height);
		const left = (THUMB_W - natural.width * scale) / 2 + image.point.x * scale;
		const top = (THUMB_H - natural.height * scale) / 2 + image.point.y * scale;
		dot = { left: Math.max(3, Math.min(THUMB_W - 3, left)), top: Math.max(3, Math.min(THUMB_H - 3, top)) };
	}
	return (
		<button type="button" className="pn-thumb" aria-label={`Open ${image.alt}`} onClick={() => props.onOpen(image)}>
			<img
				src={image.src}
				alt=""
				draggable={false}
				onLoad={event =>
					setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
				}
			/>
			{dot !== null && <span className="pn-thumb-dot" style={{ left: dot.left, top: dot.top }} />}
		</button>
	);
}

/** Full-size view: 30% backdrop, image contained in 92vw × 80vh, click ring and drag arrow drawn over it. */
export function Lightbox(props: { image: LightboxImage; onClose(): void }): ReactNode {
	const { image, onClose } = props;
	useEscape(true, onClose);
	const [natural, setNatural] = useState<Natural | null>(null);
	const percent = (point: Point): { left: string; top: string } | null =>
		natural === null || natural.width === 0 || natural.height === 0
			? null
			: { left: `${(point.x / natural.width) * 100}%`, top: `${(point.y / natural.height) * 100}%` };
	const ring = image.point === undefined ? null : percent(image.point);
	const from = image.drag === undefined ? null : percent(image.drag.from);
	const to = image.drag === undefined ? null : percent(image.drag.to);
	return (
		<div className="pn-lightbox" role="dialog" aria-modal="true" aria-label={image.alt} onClick={onClose}>
			{/* The frame hugs the contained image, so percentages of it are percentages of the picture. */}
			<div className="pn-lightbox-frame" onClick={event => event.stopPropagation()}>
				<img
					src={image.src}
					alt={image.alt}
					onLoad={event =>
						setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
					}
				/>
				{ring !== null && <span className="pn-lightbox-ring" style={ring} />}
				{from !== null && to !== null && (
					<svg className="pn-lightbox-drag" aria-hidden="true">
						<defs>
							<marker
								id="pn-drag-head"
								markerWidth="10"
								markerHeight="7"
								refX="9"
								refY="3.5"
								orient="auto"
								markerUnits="userSpaceOnUse"
							>
								<path d="M0 0l10 3.5L0 7z" />
							</marker>
						</defs>
						<line x1={from.left} y1={from.top} x2={to.left} y2={to.top} markerEnd="url(#pn-drag-head)" />
						<circle cx={from.left} cy={from.top} r="4" />
						<circle cx={to.left} cy={to.top} r="4" />
					</svg>
				)}
			</div>
		</div>
	);
}
