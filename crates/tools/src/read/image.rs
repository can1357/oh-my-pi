//! Pure image classification and model-boundary normalization.

use std::{
	collections::HashMap,
	env,
	io::{self, Cursor, Read as _},
	path::Path,
	sync::LazyLock,
};

use bytes::Bytes;
use flate2::read::GzDecoder;
use image::{
	AnimationDecoder, DynamicImage, ImageEncoder, ImageFormat,
	codecs::{
		gif::GifDecoder,
		jpeg::JpegEncoder,
		png::PngEncoder,
		webp::{WebPDecoder, WebPEncoder},
	},
	error::DecodingError,
	imageops::FilterType,
};
use omp_core::{Hash32, Str, base64, sf};
use parking_lot::Mutex;

/// Largest image accepted by the read tool (20 MiB).
pub const MAX_IMAGE_INPUT_BYTES: usize = 20 * 1024 * 1024;
/// Longest allowed output edge in pixels.
pub const MAX_IMAGE_WIDTH: u32 = 1_568;
/// Longest allowed output edge in pixels.
pub const MAX_IMAGE_HEIGHT: u32 = 1_568;
/// Smallest edge accepted reliably by vision backends.
pub const MIN_IMAGE_DIMENSION: u32 = 200;
/// Preferred encoded output budget (500 KiB).
pub const MAX_IMAGE_OUTPUT_BYTES: usize = 500 * 1024;
/// Largest decoded source accepted by the image normalization boundary.
///
/// Encoded bytes alone do not bound a compressed image's pixel allocation.
pub const MAX_IMAGE_DECODE_PIXELS: u64 = 64 * 1024 * 1024;

const IMAGE_METADATA_HEADER_BYTES: usize = 256 * 1024;
const DATA_URL_HEADER_MAX_BYTES: usize = 1_024;
const IMAGE_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRIES: usize = 128;
const SVG_IMAGE_MAX_EDGE: u32 = 2_048;
const COMFORTABLE_IMAGE_BYTES: usize = MAX_IMAGE_OUTPUT_BYTES / 4;
const JPEG_QUALITY: u8 = 80;
const QUALITY_STEPS: [u8; 4] = [70, 60, 50, 40];
const SCALE_STEPS: [f64; 5] = [1.0, 0.75, 0.5, 0.35, 0.25];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ImageCacheKey {
	digest:       Hash32,
	auto_resize:  bool,
	exclude_webp: bool,
}

#[derive(Clone, Debug)]
struct ImageCacheEntry {
	image: ProcessedImage,
	bytes: usize,
	used:  u64,
}

#[derive(Debug, Default)]
struct ImageCache {
	entries: HashMap<ImageCacheKey, ImageCacheEntry>,
	bytes:   usize,
	clock:   u64,
}

impl ImageCache {
	fn get(&mut self, key: ImageCacheKey) -> Option<ProcessedImage> {
		let entry = self.entries.get_mut(&key)?;
		self.clock = self.clock.wrapping_add(1);
		entry.used = self.clock;
		Some(entry.image.clone())
	}

	fn insert(&mut self, key: ImageCacheKey, image: &ProcessedImage) {
		let bytes = image.data.len().max(1);
		if bytes > IMAGE_CACHE_MAX_BYTES {
			return;
		}
		if let Some(previous) = self.entries.remove(&key) {
			self.bytes = self.bytes.saturating_sub(previous.bytes);
		}
		while self.entries.len() >= IMAGE_CACHE_MAX_ENTRIES
			|| self.bytes.saturating_add(bytes) > IMAGE_CACHE_MAX_BYTES
		{
			let Some(oldest) = self
				.entries
				.iter()
				.min_by_key(|(_, entry)| entry.used)
				.map(|(key, _)| *key)
			else {
				break;
			};
			if let Some(removed) = self.entries.remove(&oldest) {
				self.bytes = self.bytes.saturating_sub(removed.bytes);
			}
		}
		self.clock = self.clock.wrapping_add(1);
		self.bytes += bytes;
		self
			.entries
			.insert(key, ImageCacheEntry { image: image.clone(), bytes, used: self.clock });
	}
}

static IMAGE_CACHE: LazyLock<Mutex<ImageCache>> =
	LazyLock::new(|| Mutex::new(ImageCache::default()));

/// Supported image encoding discovered from file bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageKind {
	/// Portable Network Graphics.
	Png,
	/// Joint Photographic Experts Group image.
	Jpeg,
	/// Graphics Interchange Format image.
	Gif,
	/// WebP image.
	WebP,
}

impl ImageKind {
	/// Model-facing media type for this encoding.
	pub const fn media_type(self) -> &'static str {
		match self {
			Self::Png => "image/png",
			Self::Jpeg => "image/jpeg",
			Self::Gif => "image/gif",
			Self::WebP => "image/webp",
		}
	}

	const fn format(self) -> ImageFormat {
		match self {
			Self::Png => ImageFormat::Png,
			Self::Jpeg => ImageFormat::Jpeg,
			Self::Gif => ImageFormat::Gif,
			Self::WebP => ImageFormat::WebP,
		}
	}
}

/// Header metadata used to classify an image before decoding it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageMetadata {
	/// Encoding identified by magic bytes.
	pub kind:   ImageKind,
	/// Header width when present and valid.
	pub width:  Option<u32>,
	/// Header height when present and valid.
	pub height: Option<u32>,
}

/// Processed image ready for the executor to place in blob storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessedImage {
	/// Encoded image bytes. An unchanged input reuses the caller's allocation.
	pub data:                Bytes,
	/// Media type matching `data`.
	pub media_type:          Str,
	/// Encoded byte count.
	pub bytes:               usize,
	/// Decoded source width, when decoding succeeded.
	pub original_width:      Option<u32>,
	/// Decoded source height, when decoding succeeded.
	pub original_height:     Option<u32>,
	/// Displayed width, when decoding succeeded.
	pub width:               Option<u32>,
	/// Displayed height, when decoding succeeded.
	pub height:              Option<u32>,
	/// Whether the image was re-encoded by the resize pipeline.
	pub was_resized:         bool,
	/// Whether the source contained multiple animation frames.
	pub was_animated:        bool,
	/// Whether the output retains the source animation.
	pub animation_preserved: bool,
	/// Model-visible text accompanying the blob part.
	pub description:         Str,
}

/// Typed image-processing failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ImageFault {
	/// The string is an image data URL but its header is malformed.
	#[error("Invalid image data URL.")]
	InvalidDataUrl,
	/// The data URL payload is not valid padded standard Base64.
	#[error("Invalid Base64 image data.")]
	InvalidBase64,
	/// The encoded input exceeds the hard read limit.
	#[error(
		"Image file too large: {actual} exceeds {maximum} limit.",
		actual = format_bytes(*bytes),
		maximum = format_bytes(*max_bytes)
	)]
	TooLarge {
		/// Actual encoded byte count.
		bytes:     usize,
		/// Maximum accepted byte count.
		max_bytes: usize,
	},
	/// Header dimensions would require an excessive decoded pixel allocation.
	#[error(
		"Image dimensions too large: {width}x{height} exceeds the {max_pixels} pixel decode limit."
	)]
	DimensionsTooLarge {
		/// Source width.
		width:      u32,
		/// Source height.
		height:     u32,
		/// Maximum accepted decoded pixel count.
		max_pixels: u64,
	},
	/// The encoded bytes advertise an image format but do not decode.
	#[error("Invalid or truncated image data.")]
	InvalidImageData,
	/// A WebP image required by an STB-backed model could not be decoded and
	/// converted to PNG.
	#[error("WebP image could not be converted for this model.")]
	WebpConversionFailed,
}

/// Typed SVG/SVGZ rasterization failure.
#[derive(Debug, thiserror::Error)]
pub enum SvgRasterFault {
	/// The compressed or decoded SVG exceeds the read image boundary.
	#[error("SVG source exceeds the 20MB image input limit")]
	TooLarge,
	/// A gzip-compressed SVG could not be decoded.
	#[error("Could not decompress SVGZ source")]
	Decompression(#[source] io::Error),
	/// The decoded source was not a valid supported SVG document.
	#[error("Could not parse SVG source")]
	Parse(#[source] resvg::usvg::Error),
	/// The SVG dimensions could not be represented by the bounded raster.
	#[error("SVG dimensions cannot be rasterized")]
	Dimensions,
	/// The rendered pixels could not be encoded as PNG.
	#[error("Could not encode rasterized SVG as PNG")]
	Encode,
}

impl ImageFault {
	/// Exact model-facing failure text used by pi.
	pub fn message(&self) -> Str {
		match *self {
			Self::InvalidDataUrl => sf!("Invalid image data URL."),
			Self::InvalidBase64 => sf!("Invalid Base64 image data."),
			Self::TooLarge { bytes, max_bytes } => sf!(
				"Image file too large: {} exceeds {} limit.",
				format_bytes(bytes),
				format_bytes(max_bytes)
			),
			Self::DimensionsTooLarge { width, height, max_pixels } => sf!(
				"Image dimensions too large: {width}x{height} exceeds the {max_pixels} pixel decode \
				 limit."
			),
			Self::InvalidImageData => sf!("Invalid or truncated image data."),
			Self::WebpConversionFailed => sf!("WebP image could not be converted for this model."),
		}
	}
}

/// Returns whether a path has one of the supported image extensions.
///
/// Byte sniffing remains authoritative: an image may be recognized without one
/// of these extensions, and a file with one of these extensions may not decode
/// as an image.
pub fn is_supported_extension(path: &Path) -> bool {
	path
		.extension()
		.and_then(|extension| extension.to_str())
		.is_some_and(|extension| {
			["png", "jpg", "jpeg", "gif", "webp"]
				.into_iter()
				.any(|supported| extension.eq_ignore_ascii_case(supported))
		})
}

/// Rasterizes SVG or gzip-compressed SVGZ bytes to a bounded PNG.
///
/// The source is rejected above the ordinary image input limit, including
/// after decompression, and is proportionally scaled so neither output edge
/// exceeds 2048 pixels.
pub fn rasterize_svg(source: &[u8], gzip: bool) -> Result<Bytes, SvgRasterFault> {
	if source.len() > MAX_IMAGE_INPUT_BYTES {
		return Err(SvgRasterFault::TooLarge);
	}
	let mut decoded = Vec::new();
	let source = if gzip {
		let mut decoder = GzDecoder::new(source).take((MAX_IMAGE_INPUT_BYTES + 1) as u64);
		decoder
			.read_to_end(&mut decoded)
			.map_err(SvgRasterFault::Decompression)?;
		if decoded.len() > MAX_IMAGE_INPUT_BYTES {
			return Err(SvgRasterFault::TooLarge);
		}
		decoded.as_slice()
	} else {
		source
	};
	let tree = resvg::usvg::Tree::from_data(source, &resvg::usvg::Options::default())
		.map_err(SvgRasterFault::Parse)?;
	let size = tree.size();
	let scale = (SVG_IMAGE_MAX_EDGE as f32 / size.width().max(size.height())).min(1.0);
	let width = (size.width() * scale)
		.round()
		.clamp(1.0, SVG_IMAGE_MAX_EDGE as f32) as u32;
	let height = (size.height() * scale)
		.round()
		.clamp(1.0, SVG_IMAGE_MAX_EDGE as f32) as u32;
	let mut pixmap =
		resvg::tiny_skia::Pixmap::new(width, height).ok_or(SvgRasterFault::Dimensions)?;
	resvg::render(
		&tree,
		resvg::tiny_skia::Transform::from_scale(scale, scale),
		&mut pixmap.as_mut(),
	);
	pixmap
		.encode_png()
		.map(Bytes::from)
		.map_err(|_| SvgRasterFault::Encode)
}

/// Classifies PNG, JPEG, GIF, and WebP bytes.
///
/// Extracts dimensions available in their headers. This intentionally
/// recognizes truncated images after a valid magic signature.
pub fn sniff_metadata(header: &[u8]) -> Option<ImageMetadata> {
	parse_png(header)
		.or_else(|| parse_jpeg(header))
		.or_else(|| parse_gif(header))
		.or_else(|| parse_webp(header))
}

/// Extracts one bounded Base64 image data URL.
///
/// Non-data URLs, non-image media types, and non-Base64 data URLs return
/// `Ok(None)`. Image data URLs reject malformed headers and oversized payloads
/// before allocating decoded storage.
pub fn extract_base64_image_data_url(input: &str) -> Result<Option<Bytes>, ImageFault> {
	if !input
		.as_bytes()
		.get(..5)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"data:"))
	{
		return Ok(None);
	}
	let comma = input.find(',').ok_or(ImageFault::InvalidDataUrl)?;
	if comma > DATA_URL_HEADER_MAX_BYTES {
		return Err(ImageFault::InvalidDataUrl);
	}
	let mut fields = input[5..comma].split(';');
	let media_type = fields.next().unwrap_or_default().trim();
	if !media_type
		.get(..6)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("image/"))
	{
		return Ok(None);
	}
	if !fields.any(|field| field.trim().eq_ignore_ascii_case("base64")) {
		return Ok(None);
	}

	let encoded = input[comma + 1..].as_bytes();
	let max_encoded = MAX_IMAGE_INPUT_BYTES.div_ceil(3).saturating_mul(4);
	if encoded.len() > max_encoded {
		return Err(ImageFault::TooLarge {
			bytes:     base64::decode_len(encoded.len()),
			max_bytes: MAX_IMAGE_INPUT_BYTES,
		});
	}
	let decoded = base64::decode(encoded)
		.into_vec()
		.map_err(|_| ImageFault::InvalidBase64)?;
	if decoded.len() > MAX_IMAGE_INPUT_BYTES {
		return Err(ImageFault::TooLarge {
			bytes:     decoded.len(),
			max_bytes: MAX_IMAGE_INPUT_BYTES,
		});
	}
	Ok(Some(Bytes::from(decoded)))
}

/// Extracts and normalizes a Base64 image data URL through the shared bounded
/// decoded/resized-result cache.
pub fn process_image_data_url(
	input: &str,
	auto_resize: bool,
) -> Result<Option<ProcessedImage>, ImageFault> {
	let Some(bytes) = extract_base64_image_data_url(input)? else {
		return Ok(None);
	};
	process_image_with_policy(bytes, auto_resize)
}

/// Processes an image according to the invocation-time resize policy.
///
/// Disabling resize performs only bounded header inspection and returns the
/// original allocation unchanged; it never decodes or re-encodes pixels.
pub fn process_image_with_policy(
	input: Bytes,
	auto_resize: bool,
) -> Result<Option<ProcessedImage>, ImageFault> {
	if auto_resize {
		return process_image(input);
	}
	if input.len() > MAX_IMAGE_INPUT_BYTES {
		return Err(ImageFault::TooLarge {
			bytes:     input.len(),
			max_bytes: MAX_IMAGE_INPUT_BYTES,
		});
	}
	let Some(metadata) = sniff_metadata(&input[..input.len().min(IMAGE_METADATA_HEADER_BYTES)])
	else {
		return Ok(None);
	};
	let cache_key =
		ImageCacheKey { digest: Hash32::sum(&input), auto_resize: false, exclude_webp: false };
	if let Some(cached) = IMAGE_CACHE.lock().get(cache_key) {
		return Ok(Some(cached));
	}
	let processed = unchanged_image(input, metadata, false);
	IMAGE_CACHE.lock().insert(cache_key, &processed);
	Ok(Some(processed))
}

/// Projects an image for an STB-backed model, converting WebP input to PNG.
///
/// Non-WebP inputs retain the ordinary resize policy. The conversion is
/// request-specific and does not depend on the process-wide `OMP_NO_WEBP`
/// override.
pub fn process_image_for_stb(input: Bytes) -> Result<Option<ProcessedImage>, ImageFault> {
	if input.len() > MAX_IMAGE_INPUT_BYTES {
		return Err(ImageFault::TooLarge {
			bytes:     input.len(),
			max_bytes: MAX_IMAGE_INPUT_BYTES,
		});
	}
	let Some(metadata) = sniff_metadata(&input[..input.len().min(IMAGE_METADATA_HEADER_BYTES)])
	else {
		return Ok(None);
	};
	validate_decode_dimensions(metadata)?;
	if metadata.kind != ImageKind::WebP {
		return process_image(input);
	}
	let cache_key =
		ImageCacheKey { digest: Hash32::sum(&input), auto_resize: false, exclude_webp: true };
	if let Some(cached) = IMAGE_CACHE.lock().get(cache_key) {
		return Ok(Some(cached));
	}
	let (image, was_animated) =
		decode_image(&input, ImageKind::WebP).map_err(|_| ImageFault::WebpConversionFailed)?;
	let width = image.width();
	let height = image.height();
	let channels = image.color().channel_count();
	let has_alpha = image.color().has_alpha();
	let encoded = encode_png(&image).map_err(|_| ImageFault::WebpConversionFailed)?;
	let processed = ProcessedImage {
		bytes: encoded.len(),
		data: Bytes::from(encoded),
		media_type: sf!(ImageKind::Png.media_type()),
		original_width: Some(width),
		original_height: Some(height),
		width: Some(width),
		height: Some(height),
		was_resized: false,
		was_animated,
		animation_preserved: false,
		description: image_description(
			ImageKind::Png.media_type(),
			Some((width, height)),
			Some(channels),
			Some(has_alpha),
			None,
		),
	};
	IMAGE_CACHE.lock().insert(cache_key, &processed);
	Ok(Some(processed))
}

/// Normalizes an in-memory image for a model.
///
/// The hard input-size limit is enforced before format sniffing; smaller inputs
/// return `None` when their bytes are not one of the four supported image
/// encodings. Inputs within the dimension bounds and at most one quarter of the
/// output budget are retained verbatim. Other inputs are resized/recompressed
/// using the configured dimension, quality, and scale ladders. GIF/WebP
/// animation is retained on the verbatim path; re-encoding produces the decoded
/// first frame.
pub fn process_image(input: Bytes) -> Result<Option<ProcessedImage>, ImageFault> {
	if input.len() > MAX_IMAGE_INPUT_BYTES {
		return Err(ImageFault::TooLarge {
			bytes:     input.len(),
			max_bytes: MAX_IMAGE_INPUT_BYTES,
		});
	}
	let Some(metadata) = sniff_metadata(&input[..input.len().min(IMAGE_METADATA_HEADER_BYTES)])
	else {
		return Ok(None);
	};
	validate_decode_dimensions(metadata)?;

	let exclude_webp = webp_is_excluded();
	let cache_key = ImageCacheKey { digest: Hash32::sum(&input), auto_resize: true, exclude_webp };
	if let Some(cached) = IMAGE_CACHE.lock().get(cache_key) {
		return Ok(Some(cached));
	}
	let (image, was_animated) =
		decode_image(&input, metadata.kind).map_err(|_| ImageFault::InvalidImageData)?;
	let original_width = image.width();
	let original_height = image.height();
	let channels = image.color().channel_count();
	let has_alpha = image.color().has_alpha();
	let within_dimensions = original_width >= MIN_IMAGE_DIMENSION
		&& original_height >= MIN_IMAGE_DIMENSION
		&& original_width <= MAX_IMAGE_WIDTH
		&& original_height <= MAX_IMAGE_HEIGHT;
	if within_dimensions
		&& input.len() <= COMFORTABLE_IMAGE_BYTES
		&& !(exclude_webp && metadata.kind == ImageKind::WebP)
	{
		let processed = unchanged_decoded_image(
			input,
			metadata.kind,
			original_width,
			original_height,
			channels,
			has_alpha,
			was_animated,
		);
		IMAGE_CACHE.lock().insert(cache_key, &processed);
		return Ok(Some(processed));
	}

	let Some(encoded) = resize_and_encode(&image, exclude_webp, was_animated) else {
		let processed = unchanged_decoded_image(
			input,
			metadata.kind,
			original_width,
			original_height,
			channels,
			has_alpha,
			was_animated,
		);
		IMAGE_CACHE.lock().insert(cache_key, &processed);
		return Ok(Some(processed));
	};
	let bytes = encoded.data.len();
	let dimension_note =
		dimension_note(original_width, original_height, encoded.width, encoded.height);
	let description = image_description(
		encoded.kind.media_type(),
		Some((original_width, original_height)),
		Some(channels),
		Some(has_alpha),
		dimension_note.as_deref(),
	);
	let processed = ProcessedImage {
		data: Bytes::from(encoded.data),
		media_type: sf!(encoded.kind.media_type()),
		bytes,
		original_width: Some(original_width),
		original_height: Some(original_height),
		width: Some(encoded.width),
		height: Some(encoded.height),
		was_resized: encoded.was_resized,
		was_animated: encoded.was_animated,
		animation_preserved: encoded.animation_preserved,
		description,
	};
	IMAGE_CACHE.lock().insert(cache_key, &processed);
	Ok(Some(processed))
}

fn validate_decode_dimensions(metadata: ImageMetadata) -> Result<(), ImageFault> {
	let Some((width, height)) = metadata.width.zip(metadata.height) else {
		return Ok(());
	};
	let pixels = u64::from(width).saturating_mul(u64::from(height));
	if pixels > MAX_IMAGE_DECODE_PIXELS {
		return Err(ImageFault::DimensionsTooLarge {
			width,
			height,
			max_pixels: MAX_IMAGE_DECODE_PIXELS,
		});
	}
	Ok(())
}

struct EncodedImage {
	data:                Vec<u8>,
	kind:                ImageKind,
	width:               u32,
	height:              u32,
	was_resized:         bool,
	was_animated:        bool,
	animation_preserved: bool,
}

fn unchanged_image(input: Bytes, metadata: ImageMetadata, was_animated: bool) -> ProcessedImage {
	let bytes = input.len();
	let dimensions = metadata.width.zip(metadata.height);
	ProcessedImage {
		data: input,
		media_type: sf!(metadata.kind.media_type()),
		bytes,
		original_width: metadata.width,
		original_height: metadata.height,
		width: metadata.width,
		height: metadata.height,
		was_resized: false,
		was_animated,
		animation_preserved: was_animated,
		description: image_description(metadata.kind.media_type(), dimensions, None, None, None),
	}
}

fn unchanged_decoded_image(
	input: Bytes,
	kind: ImageKind,
	width: u32,
	height: u32,
	channels: u8,
	has_alpha: bool,
	was_animated: bool,
) -> ProcessedImage {
	let bytes = input.len();
	ProcessedImage {
		data: input,
		media_type: sf!(kind.media_type()),
		bytes,
		original_width: Some(width),
		original_height: Some(height),
		width: Some(width),
		height: Some(height),
		was_resized: false,
		was_animated,
		animation_preserved: was_animated,
		description: image_description(
			kind.media_type(),
			Some((width, height)),
			Some(channels),
			Some(has_alpha),
			None,
		),
	}
}

fn image_description(
	media_type: &str,
	dimensions: Option<(u32, u32)>,
	channels: Option<u8>,
	has_alpha: Option<bool>,
	dimension_note: Option<&str>,
) -> Str {
	let dimensions = dimensions
		.map_or_else(|| "unknown".to_owned(), |(width, height)| format!("{width}x{height}"));
	let channels = channels.map_or_else(|| "unknown".to_owned(), |count| count.to_string());
	let alpha = has_alpha.map_or("unknown", |present| if present { "yes" } else { "no" });
	let mut description = format!(
		"Read image file [{media_type}]\n[Inspection: MIME {media_type}; dimensions {dimensions}; \
		 channels {channels}; alpha {alpha}]"
	);
	if let Some(note) = dimension_note {
		description.push('\n');
		description.push_str(note);
	}
	Str::new(description)
}

fn decode_image(input: &[u8], kind: ImageKind) -> image::ImageResult<(DynamicImage, bool)> {
	match kind {
		ImageKind::Gif => {
			let decoder = GifDecoder::new(Cursor::new(input))?;
			let mut frames = decoder.into_frames();
			let first = frames.next().transpose()?.ok_or_else(|| {
				image::ImageError::Decoding(DecodingError::new(
					ImageFormat::Gif.into(),
					io::Error::new(io::ErrorKind::InvalidData, "GIF contains no image frames"),
				))
			})?;
			let animated = frames.next().transpose()?.is_some();
			Ok((DynamicImage::ImageRgba8(first.into_buffer()), animated))
		},
		ImageKind::WebP => {
			let decoder = WebPDecoder::new(Cursor::new(input))?;
			let animated = decoder.has_animation();
			if animated {
				let mut frames = decoder.into_frames();
				let first = frames.next().transpose()?.ok_or_else(|| {
					image::ImageError::Decoding(DecodingError::new(
						ImageFormat::WebP.into(),
						io::Error::new(io::ErrorKind::InvalidData, "WebP contains no image frames"),
					))
				})?;
				Ok((DynamicImage::ImageRgba8(first.into_buffer()), true))
			} else {
				Ok((DynamicImage::from_decoder(decoder)?, false))
			}
		},
		_ => image::load_from_memory_with_format(input, kind.format()).map(|image| (image, false)),
	}
}

fn resize_and_encode(
	image: &DynamicImage,
	exclude_webp: bool,
	was_animated: bool,
) -> Option<EncodedImage> {
	resize_and_encode_to_limit(image, exclude_webp, was_animated, MAX_IMAGE_OUTPUT_BYTES)
}

fn resize_and_encode_to_limit(
	image: &DynamicImage,
	exclude_webp: bool,
	was_animated: bool,
	max_output_bytes: usize,
) -> Option<EncodedImage> {
	let (target_width, target_height) = target_dimensions(image.width(), image.height());
	let resized = image.resize_exact(target_width, target_height, FilterType::Lanczos3);
	let (data, kind) = encode_smallest(&resized, JPEG_QUALITY, exclude_webp)?;
	let mut best = encoded_image(data, kind, target_width, target_height, was_animated);
	if best.data.len() <= max_output_bytes {
		return Some(best);
	}

	for quality in QUALITY_STEPS {
		let (data, kind) = encode_lossy_smallest(&resized, quality, exclude_webp)?;
		best = encoded_image(data, kind, target_width, target_height, was_animated);
		if best.data.len() <= max_output_bytes {
			return Some(best);
		}
	}

	for scale in SCALE_STEPS {
		let width = ((target_width as f64) * scale).round() as u32;
		let height = ((target_height as f64) * scale).round() as u32;
		if width < 100 || height < 100 {
			break;
		}
		let scaled = image.resize_exact(width, height, FilterType::Lanczos3);
		for quality in QUALITY_STEPS {
			let (data, kind) = encode_lossy_smallest(&scaled, quality, exclude_webp)?;
			best = encoded_image(data, kind, width, height, was_animated);
			if best.data.len() <= max_output_bytes {
				return Some(best);
			}
		}
	}
	Some(best)
}

const fn encoded_image(
	data: Vec<u8>,
	kind: ImageKind,
	width: u32,
	height: u32,
	was_animated: bool,
) -> EncodedImage {
	EncodedImage {
		data,
		kind,
		width,
		height,
		was_resized: true,
		was_animated,
		animation_preserved: false,
	}
}

fn target_dimensions(original_width: u32, original_height: u32) -> (u32, u32) {
	let mut width = original_width;
	let mut height = original_height;
	if width > MAX_IMAGE_WIDTH {
		height = ((height as f64 * MAX_IMAGE_WIDTH as f64) / width as f64).round() as u32;
		width = MAX_IMAGE_WIDTH;
	}
	if height > MAX_IMAGE_HEIGHT {
		width = ((width as f64 * MAX_IMAGE_HEIGHT as f64) / height as f64).round() as u32;
		height = MAX_IMAGE_HEIGHT;
	}
	if width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION {
		let short_edge = width.min(height);
		let upscale = (MIN_IMAGE_DIMENSION as f64 / short_edge as f64)
			.min(MAX_IMAGE_WIDTH as f64 / width as f64)
			.min(MAX_IMAGE_HEIGHT as f64 / height as f64);
		if upscale > 1.0 {
			width = (width as f64 * upscale).round() as u32;
			height = (height as f64 * upscale).round() as u32;
		}
		width = width.clamp(MIN_IMAGE_DIMENSION, MAX_IMAGE_WIDTH);
		height = height.clamp(MIN_IMAGE_DIMENSION, MAX_IMAGE_HEIGHT);
	}
	(width, height)
}

fn encode_smallest(
	image: &DynamicImage,
	jpeg_quality: u8,
	exclude_webp: bool,
) -> Option<(Vec<u8>, ImageKind)> {
	let mut candidates = Vec::with_capacity(if exclude_webp { 2 } else { 3 });
	if let Ok(data) = encode_png(image) {
		candidates.push((data, ImageKind::Png));
	}
	if let Ok(data) = encode_jpeg(image, jpeg_quality) {
		candidates.push((data, ImageKind::Jpeg));
	}
	if !exclude_webp && let Ok(data) = encode_webp(image) {
		candidates.push((data, ImageKind::WebP));
	}
	candidates.into_iter().min_by_key(|(data, _)| data.len())
}

fn encode_lossy_smallest(
	image: &DynamicImage,
	jpeg_quality: u8,
	exclude_webp: bool,
) -> Option<(Vec<u8>, ImageKind)> {
	let jpeg = encode_jpeg(image, jpeg_quality)
		.ok()
		.map(|data| (data, ImageKind::Jpeg));
	if exclude_webp {
		return jpeg;
	}
	let webp = encode_webp(image).ok().map(|data| (data, ImageKind::WebP));
	match (jpeg, webp) {
		(Some(jpeg), Some(webp)) => Some(if webp.0.len() < jpeg.0.len() {
			webp
		} else {
			jpeg
		}),
		(Some(jpeg), None) => Some(jpeg),
		(None, Some(webp)) => Some(webp),
		(None, None) => None,
	}
}

fn encode_png(image: &DynamicImage) -> image::ImageResult<Vec<u8>> {
	let rgba = image.to_rgba8();
	let mut output = Vec::new();
	PngEncoder::new(&mut output).write_image(
		rgba.as_raw(),
		rgba.width(),
		rgba.height(),
		image::ExtendedColorType::Rgba8,
	)?;
	Ok(output)
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> image::ImageResult<Vec<u8>> {
	let rgb = image.to_rgb8();
	let mut output = Vec::new();
	JpegEncoder::new_with_quality(&mut output, quality).write_image(
		rgb.as_raw(),
		rgb.width(),
		rgb.height(),
		image::ExtendedColorType::Rgb8,
	)?;
	Ok(output)
}

fn encode_webp(image: &DynamicImage) -> image::ImageResult<Vec<u8>> {
	let rgba = image.to_rgba8();
	let mut output = Vec::new();
	WebPEncoder::new_lossless(&mut output).write_image(
		rgba.as_raw(),
		rgba.width(),
		rgba.height(),
		image::ExtendedColorType::Rgba8,
	)?;
	Ok(output)
}

fn dimension_note(
	original_width: u32,
	original_height: u32,
	width: u32,
	height: u32,
) -> Option<String> {
	if width == original_width && height == original_height {
		return None;
	}
	let scale = original_width as f64 / width as f64;
	Some(format!(
		"[Image: original {original_width}x{original_height}, displayed at {width}x{height}. \
		 Multiply coordinates by {scale:.2} to map to original image.]"
	))
}

fn webp_is_excluded() -> bool {
	env::var("OMP_NO_WEBP")
		.is_ok_and(|value| value.eq_ignore_ascii_case("1") || value.eq_ignore_ascii_case("true"))
}

fn parse_png(header: &[u8]) -> Option<ImageMetadata> {
	const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
	if !header.starts_with(MAGIC) {
		return None;
	}
	let dimensions = (header.len() >= 26 && &header[12..16] == b"IHDR").then(|| {
		(
			u32::from_be_bytes(header[16..20].try_into().unwrap()),
			u32::from_be_bytes(header[20..24].try_into().unwrap()),
		)
	});
	Some(ImageMetadata {
		kind:   ImageKind::Png,
		width:  dimensions.map(|value| value.0),
		height: dimensions.map(|value| value.1),
	})
}

fn parse_jpeg(header: &[u8]) -> Option<ImageMetadata> {
	if header.len() < 3 || header[..3] != [0xff, 0xd8, 0xff] {
		return None;
	}
	let mut offset = 2;
	while offset + 9 < header.len() {
		if header[offset] != 0xff {
			offset += 1;
			continue;
		}
		let mut marker_offset = offset + 1;
		while marker_offset < header.len() && header[marker_offset] == 0xff {
			marker_offset += 1;
		}
		if marker_offset >= header.len() {
			break;
		}
		let marker = header[marker_offset];
		let segment_offset = marker_offset + 1;
		if marker == 0xd8 || marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
			offset = segment_offset;
			continue;
		}
		if segment_offset + 1 >= header.len() {
			break;
		}
		let length =
			u16::from_be_bytes([header[segment_offset], header[segment_offset + 1]]) as usize;
		if length < 2 {
			break;
		}
		let is_start_of_frame =
			(0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
		if is_start_of_frame {
			if segment_offset + 7 >= header.len() {
				break;
			}
			return Some(ImageMetadata {
				kind:   ImageKind::Jpeg,
				width:  Some(u16::from_be_bytes([
					header[segment_offset + 5],
					header[segment_offset + 6],
				]) as u32),
				height: Some(u16::from_be_bytes([
					header[segment_offset + 3],
					header[segment_offset + 4],
				]) as u32),
			});
		}
		offset = segment_offset.saturating_add(length);
	}
	Some(ImageMetadata { kind: ImageKind::Jpeg, width: None, height: None })
}

fn parse_gif(header: &[u8]) -> Option<ImageMetadata> {
	if !header.starts_with(b"GIF87a") && !header.starts_with(b"GIF89a") {
		return None;
	}
	let dimensions = (header.len() >= 10).then(|| {
		(
			u16::from_le_bytes([header[6], header[7]]) as u32,
			u16::from_le_bytes([header[8], header[9]]) as u32,
		)
	});
	Some(ImageMetadata {
		kind:   ImageKind::Gif,
		width:  dimensions.map(|value| value.0),
		height: dimensions.map(|value| value.1),
	})
}

fn parse_webp(header: &[u8]) -> Option<ImageMetadata> {
	if header.len() < 12 || &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
		return None;
	}
	if header.len() < 30 {
		return Some(ImageMetadata { kind: ImageKind::WebP, width: None, height: None });
	}
	let dimensions = if &header[12..16] == b"VP8X" {
		Some((read_u24_le(&header[24..27]) + 1, read_u24_le(&header[27..30]) + 1))
	} else if &header[12..16] == b"VP8L" {
		let bits = u32::from_le_bytes(header[21..25].try_into().unwrap());
		Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
	} else if &header[12..16] == b"VP8 " {
		Some((
			u16::from_le_bytes([header[26], header[27]]) as u32 & 0x3fff,
			u16::from_le_bytes([header[28], header[29]]) as u32 & 0x3fff,
		))
	} else {
		None
	};
	Some(ImageMetadata {
		kind:   ImageKind::WebP,
		width:  dimensions.map(|value| value.0),
		height: dimensions.map(|value| value.1),
	})
}

fn read_u24_le(bytes: &[u8]) -> u32 {
	u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn format_bytes(bytes: usize) -> String {
	if bytes < 1024 {
		format!("{bytes}B")
	} else if bytes < 1024 * 1024 {
		format!("{:.1}KB", bytes as f64 / 1024.0)
	} else if bytes < 1024 * 1024 * 1024 {
		format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
	} else {
		format!("{:.1}GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
	}
}

#[cfg(test)]
mod tests {
	use std::io::Write as _;

	use flate2::{Compression, write::GzEncoder};

	use super::*;

	#[test]
	fn rasterizes_inline_svg_to_bounded_png() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7">
			<rect width="12" height="7" fill="red"/>
		</svg>"#;
		let png = rasterize_svg(svg, false).expect("tiny SVG rasterizes");

		assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
		assert_eq!(
			sniff_metadata(&png),
			Some(ImageMetadata { kind: ImageKind::Png, width: Some(12), height: Some(7) })
		);
	}

	#[test]
	fn rasterizes_gzip_compressed_svgz() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"></svg>"#;
		let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
		encoder.write_all(svg).expect("compress SVG");
		let svgz = encoder.finish().expect("finish compressed SVG");
		let png = rasterize_svg(&svgz, true).expect("tiny SVGZ rasterizes");

		assert_eq!(
			sniff_metadata(&png),
			Some(ImageMetadata { kind: ImageKind::Png, width: Some(3), height: Some(2) })
		);
	}

	#[test]
	fn decode_rejects_pixel_bombs_before_allocating_and_rejects_truncated_images() {
		let mut huge = vec![0; 26];
		huge[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
		huge[12..16].copy_from_slice(b"IHDR");
		huge[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
		huge[20..24].copy_from_slice(&100_000_u32.to_be_bytes());
		assert_eq!(
			process_image(Bytes::from(huge)),
			Err(ImageFault::DimensionsTooLarge {
				width:      100_000,
				height:     100_000,
				max_pixels: MAX_IMAGE_DECODE_PIXELS,
			})
		);

		let mut truncated = vec![0; 26];
		truncated[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
		truncated[12..16].copy_from_slice(b"IHDR");
		truncated[16..20].copy_from_slice(&8_u32.to_be_bytes());
		truncated[20..24].copy_from_slice(&6_u32.to_be_bytes());
		assert_eq!(process_image(Bytes::from(truncated)), Err(ImageFault::InvalidImageData));
	}

	fn assert_reported_dimensions_match_bytes(encoded: &EncodedImage) {
		let (decoded, animated) =
			decode_image(&encoded.data, encoded.kind).expect("encoded candidate must decode");
		assert_eq!((encoded.width, encoded.height), (decoded.width(), decoded.height()));
		assert!(!animated, "resize output contains only the decoded first frame");
	}

	#[test]
	fn ordinary_small_resize_keeps_webp_and_reports_its_decoded_dimensions() {
		let source = DynamicImage::new_rgba8(1, 1);
		let encoded = resize_and_encode_to_limit(&source, false, false, usize::MAX)
			.expect("small image must encode");

		assert_eq!(encoded.kind, ImageKind::WebP);
		assert_eq!((encoded.width, encoded.height), (200, 200));
		assert!(encoded.was_resized);
		assert!(!encoded.was_animated);
		assert!(!encoded.animation_preserved);
		assert_reported_dimensions_match_bytes(&encoded);
	}

	#[test]
	fn rejected_sub_100_edge_does_not_replace_last_encoded_candidate_dimensions() {
		let source = DynamicImage::new_rgba8(4_000, 400);
		let encoded = resize_and_encode_to_limit(&source, false, true, 0)
			.expect("the last accepted-size candidate is returned above an impossible byte limit");

		// The next ladder step is 549x70 and is rejected before encoding. The
		// returned bytes and metadata must therefore both remain at 784x100.
		assert_eq!((encoded.width, encoded.height), (784, 100));
		assert!(encoded.was_resized);
		assert!(encoded.was_animated);
		assert!(!encoded.animation_preserved);
		assert_reported_dimensions_match_bytes(&encoded);
	}
}
