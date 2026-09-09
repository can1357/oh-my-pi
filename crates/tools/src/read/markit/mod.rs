//! In-memory document-to-Markdown conversion.

use std::{path::Path, str};

use bytes::Bytes;
use omp_core::{Hash32, IntoStr, Str};
use serde::{Deserialize, Serialize};
use strum::{EnumString, IntoStaticStr};

use super::web::types::{CachedDocument, DocumentCacheLocation, DocumentCacheRequest, HttpClient};

const CONVERSION_CACHE_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+markit.2");

mod doc;
mod docx;
mod epub;
mod odf;
mod odp;
mod ods;
mod odt;
mod ooxml;
mod pdf;
mod ppt;
mod pptx;
mod rtf;
mod xls;
mod xlsx;

#[derive(Clone, Copy, Debug, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(ascii_case_insensitive, serialize_all = "lowercase")]
enum Format {
	Pdf,
	Doc,
	#[strum(serialize = "docx", serialize = "docm")]
	Docx,
	Xls,
	#[strum(serialize = "xlsx", serialize = "xlsm")]
	Xlsx,
	Odt,
	Ods,
	Odp,
	Ppt,
	Pptx,
	Rtf,
	Epub,
	Html,
	Xml,
}

/// Metadata used to select a converter.
///
/// A recognized MIME type is authoritative and is considered before the path
/// extension, preventing a misleading filename from selecting the wrong
/// parser.
#[derive(Clone, Copy, Debug)]
pub struct DocumentMetadata<'a> {
	/// Authored or synthetic source path.
	pub path:       &'a Path,
	/// Normalized or parameterized media type supplied by the source.
	pub media_type: Option<&'a str>,
}

impl<'a> DocumentMetadata<'a> {
	/// Creates metadata for a source without a trusted media type.
	pub const fn from_path(path: &'a Path) -> Self {
		Self { path, media_type: None }
	}
}

/// Conversion behavior that affects output bytes and cache identity.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ConversionOptions {
	/// Return embedded document media for an authority-owned atomic commit.
	///
	/// Extraction is deliberately never cached: attachment bytes and link
	/// destinations belong to the invoking authority and must be committed as
	/// one transaction.
	pub extract_media: bool,
}

/// One safe embedded attachment produced by document conversion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Attachment {
	/// Sanitized basename, unique within this conversion.
	pub name:       Str,
	/// Sniffed or extension-derived media type.
	pub media_type: Str,
	/// Original embedded bytes.
	pub bytes:      Bytes,
}

/// Markdown and optional attachments produced from a supported document.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Conversion {
	/// Converted document text.
	pub text:        Str,
	/// Optional model-facing qualification of the converted text.
	pub note:        Option<Str>,
	/// Optional title supplied by document metadata.
	///
	/// Metadata stays separate from `text`, preserving the converter's source
	/// order and model-facing Markdown.
	pub title:       Option<Str>,
	/// Embedded attachments requested by the caller.
	#[serde(default)]
	pub attachments: Vec<Attachment>,
}

impl Conversion {
	const fn plain(text: Str) -> Self {
		Self { text, note: None, title: None, attachments: Vec::new() }
	}

	/// Borrows converted Markdown.
	pub fn as_str(&self) -> &str {
		self.text.as_str()
	}
}

/// Whether a successful conversion came from persistent cache.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversionCacheStatus {
	/// Serialized conversion was decoded from a cache hit.
	Hit,
	/// Conversion ran and was offered for atomic cache publication.
	Miss,
	/// Attachment extraction ran without a cache lookup or publication.
	Bypassed,
}

/// One typed conversion with its cache outcome and durable location.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversionResult {
	/// Typed converter output, identical on cache hits and misses.
	pub conversion: Conversion,
	/// Cache lookup outcome.
	pub status:     ConversionCacheStatus,
	/// Durable cache location when lookup or publication succeeded.
	pub location:   Option<DocumentCacheLocation>,
}

/// A typed document conversion failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MarkitError {
	/// A converter accepted the document but could not produce Markdown.
	#[error("{format} conversion failed: {message}")]
	Conversion {
		/// Stable converter name.
		format:  &'static str,
		/// Converter-specific failure detail.
		message: Str,
	},
}

impl MarkitError {
	/// Build a failure reported by a specific document converter.
	pub fn conversion(format: &'static str, message: impl IntoStr) -> Self {
		Self::Conversion { format, message: message.into_str() }
	}

	/// Stable name of the converter that failed.
	pub const fn format(&self) -> &'static str {
		match self {
			Self::Conversion { format, .. } => format,
		}
	}

	/// Converter-specific failure detail.
	pub fn message(&self) -> &str {
		match self {
			Self::Conversion { message, .. } => message.as_ref(),
		}
	}
}

fn convert_with_anydoc(
	bytes: &[u8],
	format: anydoc::Format,
	format_name: &'static str,
) -> Result<Str, MarkitError> {
	anydoc::to_markdown_bytes(bytes, format)
		.map(Str::new)
		.map_err(|error| MarkitError::conversion(format_name, error.to_string()))
}

fn format_from_extension(extension: &str) -> Option<Format> {
	extension.trim_start_matches('.').parse().ok()
}

fn format_from_mime(media_type: &str) -> Option<Format> {
	let media_type = media_type.split(';').next().unwrap_or(media_type).trim();
	Some(match media_type {
		"application/pdf" => Format::Pdf,
		"application/msword" => Format::Doc,
		"application/vnd.ms-word.document.macroenabled.12" => Format::Docx,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Format::Docx,
		"application/vnd.ms-excel" => Format::Xls,
		"application/vnd.ms-excel.sheet.macroenabled.12" => Format::Xlsx,
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Format::Xlsx,
		"application/vnd.oasis.opendocument.text" => Format::Odt,
		"application/vnd.oasis.opendocument.spreadsheet" => Format::Ods,
		"application/vnd.oasis.opendocument.presentation" => Format::Odp,
		"application/vnd.ms-powerpoint" => Format::Ppt,
		"application/vnd.openxmlformats-officedocument.presentationml.presentation" => Format::Pptx,
		"application/rtf" | "application/x-rtf" | "text/rtf" => Format::Rtf,
		"application/epub+zip" => Format::Epub,
		"text/html" | "application/xhtml+xml" => Format::Html,
		"application/xml" | "text/xml" => Format::Xml,
		_ => return None,
	})
}

fn select_format(metadata: &DocumentMetadata<'_>) -> Option<Format> {
	metadata.media_type.and_then(format_from_mime).or_else(|| {
		metadata
			.path
			.extension()
			.and_then(|extension| extension.to_str())
			.and_then(format_from_extension)
	})
}

/// Whether a path names a supported in-memory document format.
pub(crate) fn supports_path(path: &Path) -> bool {
	path
		.extension()
		.and_then(|extension| extension.to_str())
		.and_then(format_from_extension)
		.is_some()
}

/// Whether an extension names a supported in-memory document format.
///
/// Both `docx` and `.docx` forms are accepted.
pub(crate) fn supports_extension(extension: &str) -> bool {
	format_from_extension(extension).is_some()
}

fn cache_request(
	format: Format,
	bytes: &[u8],
	options: &ConversionOptions,
) -> DocumentCacheRequest {
	DocumentCacheRequest {
		source_digest:     Hash32::sum(bytes),
		options_digest:    Hash32::sum([u8::from(options.extract_media)]),
		converter:         format.into(),
		converter_version: CONVERSION_CACHE_VERSION,
	}
}

fn decode_cached(cached: CachedDocument) -> Option<ConversionResult> {
	let conversion = serde_json::from_slice(&cached.content).ok()?;
	Some(ConversionResult {
		conversion,
		status: ConversionCacheStatus::Hit,
		location: Some(cached.location),
	})
}

/// Converts through the application-owned persistent cache.
///
/// Only successfully typed conversions are published. Corrupt cache payloads
/// are treated as misses and replaced by the fresh successful conversion.
pub async fn convert_cached<C: HttpClient + Sync>(
	cache: &C,
	metadata: DocumentMetadata<'_>,
	bytes: &[u8],
	options: ConversionOptions,
) -> Result<Option<ConversionResult>, MarkitError> {
	let Some(format) = select_format(&metadata) else {
		return Ok(None);
	};
	if options.extract_media {
		return convert_format(format, bytes, options).map(|conversion| {
			conversion.map(|conversion| ConversionResult {
				conversion,
				status: ConversionCacheStatus::Bypassed,
				location: None,
			})
		});
	}

	let request = cache_request(format, bytes, &options);
	if let Some(cached) = cache.document_cache_get(request).await
		&& let Some(converted) = decode_cached(cached)
	{
		return Ok(Some(converted));
	}

	let Some(conversion) = convert_format(format, bytes, options)? else {
		return Ok(None);
	};
	let location = if let Ok(serialized) = serde_json::to_vec(&conversion) {
		cache
			.document_cache_put(request, Bytes::from(serialized))
			.await
			.map(|cached| cached.location)
	} else {
		None
	};
	Ok(Some(ConversionResult { conversion, status: ConversionCacheStatus::Miss, location }))
}

/// Convert one of the approved document formats to Markdown.
///
/// Unsupported extensions return `Ok(None)`. Once an extension is recognized,
/// converter failures remain typed so the caller can truthfully render the
/// original binary size rather than treating the bytes as text.
pub fn convert(path: &Path, bytes: &[u8]) -> Result<Option<Conversion>, MarkitError> {
	convert_with_options(DocumentMetadata::from_path(path), bytes, ConversionOptions::default())
}

/// Converts with explicit source metadata and behavior.
pub fn convert_with_options(
	metadata: DocumentMetadata<'_>,
	bytes: &[u8],
	options: ConversionOptions,
) -> Result<Option<Conversion>, MarkitError> {
	let Some(format) = select_format(&metadata) else {
		return Ok(None);
	};
	convert_format(format, bytes, options)
}

fn convert_format(
	format: Format,
	bytes: &[u8],
	options: ConversionOptions,
) -> Result<Option<Conversion>, MarkitError> {
	let conversion = match format {
		Format::Pdf => pdf::convert(bytes)?,
		Format::Doc => Conversion::plain(doc::convert(bytes)?),
		Format::Docx => docx::convert(bytes, options.extract_media)?,
		Format::Xls => Conversion::plain(xls::convert(bytes)?),
		Format::Xlsx => Conversion::plain(xlsx::convert(bytes)?),
		Format::Odt => Conversion::plain(odt::convert(bytes)?),
		Format::Ods => Conversion::plain(ods::convert(bytes)?),
		Format::Odp => Conversion::plain(odp::convert(bytes)?),
		Format::Ppt => Conversion::plain(ppt::convert(bytes)?),
		Format::Pptx => pptx::convert(bytes, options.extract_media)?,
		Format::Rtf => Conversion::plain(rtf::convert(bytes)?),
		Format::Epub => {
			let (text, title) = epub::convert(bytes)?;
			Conversion { text, note: None, title, attachments: Vec::new() }
		},
		Format::Html | Format::Xml => {
			let source = str::from_utf8(bytes)
				.map_err(|error| MarkitError::conversion("html/xml", error.to_string()))?;
			let converted = html_to_markdown_rs::convert(source, None)
				.map_err(|error| MarkitError::conversion("html/xml", error.to_string()))?;
			let text = Str::new(converted.content.unwrap_or_default());
			Conversion::plain(text)
		},
	};
	Ok(Some(conversion))
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::{
		ConversionOptions, DocumentMetadata, cache_request, convert, convert_with_options,
		format_from_extension, supports_path,
	};

	#[test]
	fn converts_local_html_and_xml_as_documents() {
		for (path, source, needle) in [
			("page.html", "<h1>Title</h1><p>Body</p>", "# Title"),
			("feed.xml", "<article><h2>Entry</h2><p>Text</p></article>", "## Entry"),
		] {
			assert!(supports_path(Path::new(path)));
			let converted = convert(Path::new(path), source.as_bytes())
				.unwrap()
				.expect("recognized document");
			assert!(converted.text.contains(needle), "{path}: {}", converted.text);
		}
	}

	#[test]
	fn trusted_mime_precedes_misleading_extension() {
		let converted = convert_with_options(
			DocumentMetadata {
				path:       Path::new("payload.pdf"),
				media_type: Some("text/html; charset=utf-8"),
			},
			b"<h1>MIME wins</h1>",
			ConversionOptions::default(),
		)
		.unwrap()
		.expect("recognized MIME type");
		assert!(converted.text.contains("# MIME wins"));
	}

	#[test]
	fn cache_identity_includes_conversion_options() {
		let format = format_from_extension("docx").unwrap();
		let ordinary = cache_request(format, b"same", &ConversionOptions::default());
		let extraction = cache_request(format, b"same", &ConversionOptions { extract_media: true });
		assert_ne!(ordinary.options_digest, extraction.options_digest);
		assert_eq!(ordinary.source_digest, extraction.source_digest);
	}
}
