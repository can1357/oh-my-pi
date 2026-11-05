/**
 * File extensions Tern's media viewer shows, mirrored from Tern's `crates/editor/src/kind.rs`
 * (IMAGE, SVG, MODEL, MODEL_GZ, PLATFORM). A read of such a disk file names it to a native
 * TSP host as a `media` node by path (`ReadToolDetails.mediaPath`); what the model receives is
 * unaffected. Sidecars (`.mtl`, textures) are absent: the model viewer loads them itself,
 * relative to the model's path.
 */
const TERN_MEDIA_EXTENSIONS: Record<string, true> = {
	// Raster images.
	png: true,
	apng: true,
	jpg: true,
	jpeg: true,
	jpe: true,
	jfif: true,
	gif: true,
	webp: true,
	// Vector.
	svg: true,
	// 3D models.
	obj: true,
	ply: true,
	wrl: true,
	vrml: true,
	wrz: true,
	x3dv: true,
	x3dvz: true,
	stl: true,
	gltf: true,
	glb: true,
	fbx: true,
	usd: true,
	usda: true,
	usdc: true,
	usdz: true,
	"3ds": true,
	// Platform reader/player.
	pdf: true,
	mp4: true,
	m4v: true,
	mov: true,
	webm: true,
	mp3: true,
	m4a: true,
	wav: true,
	aac: true,
	flac: true,
	ogg: true,
	oga: true,
	opus: true,
};

/** 3D models Tern also opens gzip-compressed (`<ext>.gz`). */
const TERN_MODEL_GZ_EXTENSIONS: Record<string, true> = {
	obj: true,
	ply: true,
	wrl: true,
	vrml: true,
	x3dv: true,
	stl: true,
	gltf: true,
	glb: true,
	fbx: true,
	usd: true,
	usda: true,
	usdc: true,
	"3ds": true,
};

/** A file name's extension as Rust's `Path::extension` reads it: after the last dot, none for `.hidden`. */
function extensionOf(name: string): string | undefined {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : undefined;
}

/** Whether Tern's media viewer shows the file at `filePath`, judged by its extension as Tern does. */
export function ternShowsMedia(filePath: string): boolean {
	const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1).toLowerCase();
	const ext = extensionOf(name);
	if (ext === undefined) return false;
	if (ext !== "gz") return TERN_MEDIA_EXTENSIONS[ext] === true;
	const inner = extensionOf(name.slice(0, name.lastIndexOf(".")));
	return inner !== undefined && TERN_MODEL_GZ_EXTENSIONS[inner] === true;
}
