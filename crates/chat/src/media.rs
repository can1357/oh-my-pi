//! Typed, bounded normalization for composer-staged image and video inputs.
//!
//! The composer keeps source paths and atom state until this module has
//! prepared every item. Callers can therefore refuse the whole batch without
//! reconstructing a draft or losing positional marker order.

use std::{fs, io::Cursor};

use bytes::Bytes;
use image::{
	DynamicImage, GenericImageView as _, ImageDecoder as _, ImageFormat, ImageReader,
	imageops::FilterType, metadata::Orientation,
};
use omp_core::Str;
use thiserror::Error;

use crate::composer::{ComposerMediaKind, ComposerMediaSource};

/// Maximum encoded bytes accepted from one local media source.
pub const MAX_MEDIA_INPUT_BYTES: u64 = 20 * 1024 * 1024;
/// Maximum decoded image pixels admitted before allocating a raster.
pub const MAX_IMAGE_DECODED_PIXELS: u64 = 100_000_000;
/// Longest image edge sent to a model.
pub const MAX_IMAGE_EDGE: u32 = 1_568;
/// Smallest image edge sent to a model.
pub const MIN_IMAGE_EDGE: u32 = 200;
/// Preferred encoded image budget after normalization.
pub const TARGET_IMAGE_BYTES: usize = 500 * 1024;

/// A typed media-ingress refusal.
#[derive(Debug, Error)]
pub enum MediaInputError {
	/// A local source could not be inspected or read.
	#[error("could not {operation} media {path}")]
	Io {
		/// Failed filesystem operation.
		operation: &'static str,
		/// Source path.
		path:      Str,
		/// Filesystem failure.
		#[source]
		source:    std::io::Error,
	},
	/// Encoded input exceeds the admission bound.
	#[error("media {path} is {bytes} bytes, exceeding the {max_bytes}-byte input limit")]
	InputTooLarge {
		/// Source path.
		path:      Str,
		/// Observed encoded size.
		bytes:     u64,
		/// Admission bound.
		max_bytes: u64,
	},
	/// The image container is unknown or disabled.
	#[error("unsupported image format in {path}")]
	UnsupportedImage {
		/// Source path.
		path: Str,
	},
	/// The video container could not be identified from its bytes.
	#[error("unsupported or mislabeled video format in {path}")]
	UnsupportedVideo {
		/// Source path.
		path: Str,
	},
	/// Header dimensions exceed the bounded decoder admission limit.
	#[error("image {path} is {width}x{height}, exceeding the {max_pixels}-pixel decode limit")]
	DecodedImageTooLarge {
		/// Source path.
		path:       Str,
		/// Header width.
		width:      u32,
		/// Header height.
		height:     u32,
		/// Admission bound.
		max_pixels: u64,
	},
	/// Full image decode or re-encoding failed.
	#[error("image codec failed for {path}")]
	ImageCodec {
		/// Source path.
		path:   Str,
		/// Codec failure.
		#[source]
		source: image::ImageError,
	},
	/// A transformed image unexpectedly exceeded the hard input bound.
	#[error("normalized image {path} is {bytes} bytes, exceeding the {max_bytes}-byte limit")]
	NormalizedImageTooLarge {
		/// Source path.
		path:      Str,
		/// Encoded output size.
		bytes:     u64,
		/// Hard bound.
		max_bytes: u64,
	},
}

/// One normalized item, retaining its source link and positional media kind.
#[derive(Clone, Debug)]
pub struct PreparedMedia {
	/// Composer classification, unchanged by normalization.
	pub kind:                ComposerMediaKind,
	/// Original local source/link. Conversion never replaces it.
	pub source:              Str,
	/// Typed bytes handed to the session controller.
	pub input:               omp_session::AttachmentInput,
	/// Decoded source dimensions for an image.
	pub original_dimensions: Option<(u32, u32)>,
	/// Model-bound dimensions after orientation and resizing.
	pub dimensions:          Option<(u32, u32)>,
}

/// Reads and normalizes a complete media batch in composer marker order.
///
/// Preparation is atom-safe: no composer/session state is touched, and no
/// partial result is returned. A refusal leaves the caller's exact draft and
/// attachment atoms available for retry.
pub fn prepare_media_sources(
	media: &[ComposerMediaSource],
) -> Result<Vec<PreparedMedia>, MediaInputError> {
	let mut prepared = Vec::with_capacity(media.len());
	for source in media {
		prepared.push(prepare_one(source)?);
	}
	Ok(prepared)
}

/// Produces session attachment inputs in the same positional order as the
/// composer's numbered image/video markers.
pub fn read_attachments(
	media: &[ComposerMediaSource],
) -> Result<Vec<omp_session::AttachmentInput>, MediaInputError> {
	let mut attachments = Vec::with_capacity(media.len());
	for source in media {
		attachments.push(prepare_one(source)?.input);
	}
	Ok(attachments)
}

fn prepare_one(source: &ComposerMediaSource) -> Result<PreparedMedia, MediaInputError> {
	let path = source.source.clone();
	let metadata = fs::metadata(path.as_str()).map_err(|source| MediaInputError::Io {
		operation: "inspect",
		path: path.clone(),
		source,
	})?;
	if metadata.len() > MAX_MEDIA_INPUT_BYTES {
		return Err(MediaInputError::InputTooLarge {
			path,
			bytes: metadata.len(),
			max_bytes: MAX_MEDIA_INPUT_BYTES,
		});
	}
	let bytes = fs::read(path.as_str())
		.map(Bytes::from)
		.map_err(|source| MediaInputError::Io { operation: "read", path: path.clone(), source })?;
	let byte_len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
	if byte_len > MAX_MEDIA_INPUT_BYTES {
		return Err(MediaInputError::InputTooLarge {
			path,
			bytes: byte_len,
			max_bytes: MAX_MEDIA_INPUT_BYTES,
		});
	}

	match source.kind {
		ComposerMediaKind::Image => prepare_image(path, bytes),
		ComposerMediaKind::Video => prepare_video(path, bytes),
	}
}

fn prepare_image(path: Str, bytes: Bytes) -> Result<PreparedMedia, MediaInputError> {
	let format = image::guess_format(&bytes)
		.map_err(|_| MediaInputError::UnsupportedImage { path: path.clone() })?;
	let reader = ImageReader::with_format(Cursor::new(bytes.as_ref()), format);
	let mut decoder = reader
		.into_decoder()
		.map_err(|source| MediaInputError::ImageCodec { path: path.clone(), source })?;
	let original = decoder.dimensions();
	let pixels = u64::from(original.0).saturating_mul(u64::from(original.1));
	if pixels > MAX_IMAGE_DECODED_PIXELS {
		return Err(MediaInputError::DecodedImageTooLarge {
			path,
			width: original.0,
			height: original.1,
			max_pixels: MAX_IMAGE_DECODED_PIXELS,
		});
	}
	let orientation = decoder
		.orientation()
		.map_err(|source| MediaInputError::ImageCodec { path: path.clone(), source })?;
	// A real decode is the validity oracle. Signatures and dimensions alone do
	// not reject middle-elided PNG/JPEG streams that providers cannot consume.
	let mut image = DynamicImage::from_decoder(decoder)
		.map_err(|source| MediaInputError::ImageCodec { path: path.clone(), source })?;
	image.apply_orientation(orientation);
	let oriented = image.dimensions();
	let direct_mime = supported_image_mime(format);
	let must_convert_webp = format == ImageFormat::WebP && webp_excluded();
	let comfortable = bytes.len() <= TARGET_IMAGE_BYTES / 4;
	let within_edges = oriented.0 >= MIN_IMAGE_EDGE
		&& oriented.1 >= MIN_IMAGE_EDGE
		&& oriented.0 <= MAX_IMAGE_EDGE
		&& oriented.1 <= MAX_IMAGE_EDGE;
	if orientation == Orientation::NoTransforms && !must_convert_webp && comfortable && within_edges
	{
		if let Some(mime) = direct_mime {
			return Ok(PreparedMedia {
				kind:                ComposerMediaKind::Image,
				source:              path,
				input:               omp_session::AttachmentInput {
					mime: Str::new_static(mime),
					bytes,
				},
				original_dimensions: Some(original),
				dimensions:          Some(oriented),
			});
		}
	}

	let target = fitted_dimensions(oriented.0, oriented.1);
	if target != oriented {
		image = image.resize_exact(target.0, target.1, FilterType::Lanczos3);
	}
	let (encoded, dimensions) = encode_bounded(&image, path.as_str())?;
	let output_len = u64::try_from(encoded.bytes.len()).unwrap_or(u64::MAX);
	if output_len > MAX_MEDIA_INPUT_BYTES {
		return Err(MediaInputError::NormalizedImageTooLarge {
			path,
			bytes: output_len,
			max_bytes: MAX_MEDIA_INPUT_BYTES,
		});
	}
	Ok(PreparedMedia {
		kind:                ComposerMediaKind::Image,
		source:              path,
		input:               omp_session::AttachmentInput {
			mime:  Str::new_static(encoded.mime),
			bytes: Bytes::from(encoded.bytes),
		},
		original_dimensions: Some(original),
		dimensions:          Some(dimensions),
	})
}

fn prepare_video(path: Str, bytes: Bytes) -> Result<PreparedMedia, MediaInputError> {
	let mime = sniff_video_mime(&bytes)
		.ok_or_else(|| MediaInputError::UnsupportedVideo { path: path.clone() })?;
	Ok(PreparedMedia {
		kind:                ComposerMediaKind::Video,
		source:              path,
		input:               omp_session::AttachmentInput { mime: Str::new_static(mime), bytes },
		original_dimensions: None,
		dimensions:          None,
	})
}

fn supported_image_mime(format: ImageFormat) -> Option<&'static str> {
	matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP)
		.then(|| format.to_mime_type())
}

fn webp_excluded() -> bool {
	std::env::var("OMP_NO_WEBP")
		.ok()
		.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn fitted_dimensions(width: u32, height: u32) -> (u32, u32) {
	let max_scale = (f64::from(MAX_IMAGE_EDGE) / f64::from(width))
		.min(f64::from(MAX_IMAGE_EDGE) / f64::from(height))
		.min(1.0);
	let mut width = (f64::from(width) * max_scale).round().max(1.0) as u32;
	let mut height = (f64::from(height) * max_scale).round().max(1.0) as u32;
	if width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE {
		let short = width.min(height);
		let upscale = (f64::from(MIN_IMAGE_EDGE) / f64::from(short))
			.min(f64::from(MAX_IMAGE_EDGE) / f64::from(width))
			.min(f64::from(MAX_IMAGE_EDGE) / f64::from(height));
		if upscale > 1.0 {
			width = (f64::from(width) * upscale).round() as u32;
			height = (f64::from(height) * upscale).round() as u32;
		}
		width = width.clamp(MIN_IMAGE_EDGE, MAX_IMAGE_EDGE);
		height = height.clamp(MIN_IMAGE_EDGE, MAX_IMAGE_EDGE);
	}
	(width, height)
}

struct EncodedImage {
	bytes: Vec<u8>,
	mime:  &'static str,
}

fn encode_bounded(
	image: &DynamicImage,
	path: &str,
) -> Result<(EncodedImage, (u32, u32)), MediaInputError> {
	let path = Str::new(path);
	let mut best = encode_smallest(image, 80, &path)?;
	let mut dimensions = image.dimensions();
	if best.bytes.len() <= TARGET_IMAGE_BYTES {
		return Ok((best, dimensions));
	}
	for quality in [70, 60, 50, 40] {
		let candidate = encode_jpeg(image, quality, &path)?;
		if candidate.bytes.len() < best.bytes.len() {
			best = candidate;
		}
		if best.bytes.len() <= TARGET_IMAGE_BYTES {
			return Ok((best, dimensions));
		}
	}

	let initial = image.dimensions();
	for (numerator, denominator) in [(3, 4), (1, 2), (35, 100), (1, 4)] {
		let width = initial.0.saturating_mul(numerator) / denominator;
		let height = initial.1.saturating_mul(numerator) / denominator;
		if width < 100 || height < 100 {
			break;
		}
		let scaled = image.resize_exact(width, height, FilterType::Lanczos3);
		for quality in [70, 60, 50, 40] {
			let candidate = encode_jpeg(&scaled, quality, &path)?;
			if candidate.bytes.len() < best.bytes.len() {
				best = candidate;
				dimensions = (width, height);
			}
			if best.bytes.len() <= TARGET_IMAGE_BYTES {
				return Ok((best, dimensions));
			}
		}
	}
	Ok((best, dimensions))
}

fn encode_smallest(
	image: &DynamicImage,
	quality: u8,
	path: &Str,
) -> Result<EncodedImage, MediaInputError> {
	let png = encode_png(image, path)?;
	let jpeg = encode_jpeg(image, quality, path)?;
	Ok(if jpeg.bytes.len() < png.bytes.len() {
		jpeg
	} else {
		png
	})
}

fn encode_png(image: &DynamicImage, path: &Str) -> Result<EncodedImage, MediaInputError> {
	let mut output = Cursor::new(Vec::new());
	image
		.write_to(&mut output, ImageFormat::Png)
		.map_err(|source| MediaInputError::ImageCodec { path: path.clone(), source })?;
	Ok(EncodedImage { bytes: output.into_inner(), mime: "image/png" })
}

fn encode_jpeg(
	image: &DynamicImage,
	quality: u8,
	path: &Str,
) -> Result<EncodedImage, MediaInputError> {
	let mut output = Cursor::new(Vec::new());
	let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality);
	image
		.write_with_encoder(encoder)
		.map_err(|source| MediaInputError::ImageCodec { path: path.clone(), source })?;
	Ok(EncodedImage { bytes: output.into_inner(), mime: "image/jpeg" })
}

fn sniff_video_mime(bytes: &[u8]) -> Option<&'static str> {
	if bytes.get(4..8) == Some(b"ftyp") {
		return if bytes.get(8..12) == Some(b"qt  ") {
			Some("video/quicktime")
		} else {
			Some("video/mp4")
		};
	}
	if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
		let probe = &bytes[..bytes.len().min(256)];
		return Some(
			if probe
				.windows(4)
				.any(|window| window.eq_ignore_ascii_case(b"webm"))
			{
				"video/webm"
			} else {
				"video/x-matroska"
			},
		);
	}
	if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"AVI ") {
		return Some("video/x-msvideo");
	}
	const ASF: [u8; 16] = [
		0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce,
		0x6c,
	];
	if bytes.starts_with(&ASF) {
		return Some("video/x-ms-wmv");
	}
	if bytes.starts_with(&[0x00, 0x00, 0x01, 0xba]) {
		return Some("video/mpeg");
	}
	None
}

#[cfg(test)]
mod tests {
	use std::io::Write as _;

	use image::{Rgb, RgbImage};

	use super::*;

	fn write_image(path: &std::path::Path, image: DynamicImage, format: ImageFormat) {
		let mut output = Cursor::new(Vec::new());
		image.write_to(&mut output, format).expect("encode fixture");
		fs::write(path, output.into_inner()).expect("write fixture");
	}

	fn source(kind: ComposerMediaKind, path: &std::path::Path) -> ComposerMediaSource {
		ComposerMediaSource { kind, source: Str::new(path.to_string_lossy()) }
	}

	#[test]
	fn supported_comfortable_image_passes_through_byte_for_byte() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("comfortable.png");
		write_image(&path, DynamicImage::new_rgb8(200, 200), ImageFormat::Png);
		let original = fs::read(&path).expect("fixture");
		let prepared =
			prepare_media_sources(&[source(ComposerMediaKind::Image, &path)]).expect("normalize");
		assert_eq!(prepared[0].input.mime, "image/png");
		assert_eq!(prepared[0].input.bytes.as_ref(), original.as_slice());
		assert_eq!(prepared[0].dimensions, Some((200, 200)));
	}

	#[test]
	fn unsupported_bmp_is_converted_to_supported_image_bytes() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("mislabeled.png");
		write_image(&path, DynamicImage::new_rgb8(240, 200), ImageFormat::Bmp);
		let prepared =
			prepare_media_sources(&[source(ComposerMediaKind::Image, &path)]).expect("normalize");
		assert_eq!(prepared.len(), 1);
		assert!(matches!(prepared[0].input.mime.as_str(), "image/png" | "image/jpeg"));
		assert!(image::load_from_memory(&prepared[0].input.bytes).is_ok());
		assert_eq!(prepared[0].source.as_str(), path.to_string_lossy().as_ref());
	}

	#[test]
	fn large_image_is_downscaled_to_the_model_edge_bound() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("wide.png");
		write_image(&path, DynamicImage::new_rgb8(2_000, 1_500), ImageFormat::Png);
		let prepared =
			prepare_media_sources(&[source(ComposerMediaKind::Image, &path)]).expect("normalize");
		let (width, height) = prepared[0].dimensions.expect("dimensions");
		assert!(width <= MAX_IMAGE_EDGE && height <= MAX_IMAGE_EDGE);
		assert_eq!((width, height), (1_568, 1_176));
	}

	#[test]
	fn exif_orientation_is_applied_before_model_delivery() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("rotated.jpg");
		let pixels = RgbImage::from_pixel(300, 200, Rgb([200, 10, 10]));
		let mut jpeg = Cursor::new(Vec::new());
		DynamicImage::ImageRgb8(pixels)
			.write_to(&mut jpeg, ImageFormat::Jpeg)
			.expect("jpeg");
		let jpeg = jpeg.into_inner();
		let exif = [
			b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0,
			0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
		];
		let segment_len = u16::try_from(exif.len() + 2).expect("segment length");
		let mut oriented = Vec::with_capacity(jpeg.len() + exif.len() + 4);
		oriented.extend_from_slice(&jpeg[..2]);
		oriented.extend_from_slice(&[0xff, 0xe1]);
		oriented.extend_from_slice(&segment_len.to_be_bytes());
		oriented.extend_from_slice(&exif);
		oriented.extend_from_slice(&jpeg[2..]);
		fs::write(&path, oriented).expect("fixture");

		let prepared =
			prepare_media_sources(&[source(ComposerMediaKind::Image, &path)]).expect("normalize");
		assert_eq!(prepared[0].original_dimensions, Some((300, 200)));
		assert_eq!(prepared[0].dimensions, Some((200, 300)));
		let decoded = image::load_from_memory(&prepared[0].input.bytes).expect("normalized image");
		assert_eq!(decoded.dimensions(), (200, 300));
	}

	#[test]
	fn mixed_media_retains_marker_and_source_order() {
		let directory = tempfile::tempdir().expect("tempdir");
		let first = directory.path().join("first.png");
		let video = directory.path().join("mislabeled-middle.mp4");
		let last = directory.path().join("last.jpg");
		write_image(&first, DynamicImage::new_rgb8(200, 200), ImageFormat::Png);
		fs::write(&video, b"\0\0\0\x18ftypqt  \0\0\0\0qt  ").expect("video");
		write_image(&last, DynamicImage::new_rgb8(200, 200), ImageFormat::Jpeg);
		let sources = [
			source(ComposerMediaKind::Image, &first),
			source(ComposerMediaKind::Video, &video),
			source(ComposerMediaKind::Image, &last),
		];
		let prepared = prepare_media_sources(&sources).expect("normalize");
		assert_eq!(prepared.iter().map(|item| item.kind).collect::<Vec<_>>(), [
			ComposerMediaKind::Image,
			ComposerMediaKind::Video,
			ComposerMediaKind::Image,
		]);
		assert_eq!(prepared[0].source, sources[0].source);
		assert_eq!(prepared[1].source, sources[1].source);
		assert_eq!(prepared[2].source, sources[2].source);
		assert_eq!(prepared[1].input.mime, "video/quicktime");
	}

	#[test]
	fn encoded_size_is_bounded_before_reading_the_payload() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("oversized.png");
		let file = fs::File::create(&path).expect("fixture");
		file
			.set_len(MAX_MEDIA_INPUT_BYTES + 1)
			.expect("sparse fixture");
		let error = prepare_media_sources(&[source(ComposerMediaKind::Image, &path)])
			.expect_err("oversized input refused");
		assert!(matches!(error, MediaInputError::InputTooLarge {
			bytes,
			max_bytes: MAX_MEDIA_INPUT_BYTES,
			..
		} if bytes == MAX_MEDIA_INPUT_BYTES + 1));
	}

	#[test]
	fn header_valid_but_undecodable_image_is_refused() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("truncated.png");
		fs::write(&path, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\xc8\0\0\0\xc8").expect("fixture");
		let error = prepare_media_sources(&[source(ComposerMediaKind::Image, &path)])
			.expect_err("truncated stream refused");
		assert!(matches!(error, MediaInputError::ImageCodec { .. }));
	}

	#[test]
	fn refusal_is_typed_and_returns_no_partial_batch() {
		let directory = tempfile::tempdir().expect("tempdir");
		let valid = directory.path().join("valid.png");
		let invalid = directory.path().join("invalid.png");
		write_image(&valid, DynamicImage::new_rgb8(200, 200), ImageFormat::Png);
		fs::File::create(&invalid)
			.expect("invalid fixture")
			.write_all(b"not an image")
			.expect("invalid fixture");
		let error = prepare_media_sources(&[
			source(ComposerMediaKind::Image, &valid),
			source(ComposerMediaKind::Image, &invalid),
		])
		.expect_err("batch refuses atomically");
		assert!(matches!(error, MediaInputError::UnsupportedImage { .. }));
	}
}
