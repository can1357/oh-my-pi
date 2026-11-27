//! Classify web response bodies without decoding the whole payload.

use encoding_rs::{Encoding, UTF_8};
use url::Url;

use crate::decode::charset;

/// Content class used to choose a reader or hand the bytes to a converter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	/// HTML document or fragment, including XHTML.
	Html,
	/// Markdown source.
	Markdown,
	/// Plain text or another textual media type.
	Text,
	/// JSON data other than notebooks.
	Json,
	/// RSS, Atom or RSS 1.0 RDF feed.
	Feed,
	/// XML data that is not an HTML document or known feed.
	Xml,
	/// Non-text payload or a format handled by an external converter.
	Blob,
}

fn starts(bytes: &[u8], prefix: &[u8]) -> bool {
	bytes
		.get(..prefix.len())
		.is_some_and(|s| s.eq_ignore_ascii_case(prefix))
}

fn tag_prefix(bytes: &[u8], name: &[u8]) -> bool {
	starts(bytes, name)
		&& bytes
			.get(name.len())
			.is_some_and(|b| b.is_ascii_whitespace() || matches!(b, b'>' | b'/'))
}

fn html_prefix(bytes: &[u8]) -> bool {
	[
		b"<html".as_slice(),
		b"<head",
		b"<body",
		b"<meta",
		b"<title",
		b"<script",
		b"<iframe",
		b"<h1",
		b"<div",
		b"<font",
		b"<table",
		b"<a",
		b"<style",
		b"<b",
		b"<br",
		b"<p",
		b"<form",
		b"<article",
		b"<main",
		b"<section",
		b"<ul",
		b"<ol",
		b"<pre",
	]
	.into_iter()
	.any(|name| tag_prefix(bytes, name))
		|| starts(bytes, b"<!doctype")
			&& bytes
				.get(9..)
				.is_some_and(|tail| tag_prefix(tail.trim_ascii_start(), b"html"))
}

fn one_of(value: &str, candidates: &[&str]) -> bool {
	candidates.iter().any(|s| value.eq_ignore_ascii_case(s))
}

fn ends(value: &str, suffix: &str) -> bool {
	value
		.as_bytes()
		.get(value.len().saturating_sub(suffix.len())..)
		.is_some_and(|s| s.eq_ignore_ascii_case(suffix.as_bytes()))
}

fn binary_extension(ext: &str) -> bool {
	one_of(ext, &[
		"ipynb", "pdf", "docx", "pptx", "xlsx", "epub", "sqlite", "sqlite3", "db", "db3", "zip",
		"tar", "tgz", "gz", "png", "jpg", "jpeg", "gif", "webp",
	])
}

fn sample_looks_binary(bytes: &[u8], encoding: Option<&'static Encoding>) -> bool {
	if memchr::memchr(0, bytes).is_some() {
		return true;
	}
	if encoding.is_some_and(|e| e != UTF_8) {
		return false;
	}
	let (mut chars, mut replacements) = (0, 0);
	for chunk in bytes.utf8_chunks() {
		for c in chunk.valid().chars() {
			chars += 1;
			replacements += usize::from(c == '\u{fffd}');
		}
		if !chunk.invalid().is_empty() {
			chars += 1;
			replacements += 1;
		}
	}
	replacements >= 3 && replacements * 100 > chars
}

/// True when up to 4096 leading bytes of a body hold bytes no text decoding
/// reads, such as a compressed body served despite `Accept-Encoding: identity`.
/// A declared UTF-16 body is never binary.
pub fn looks_binary(content_type: Option<&str>, prefix: &[u8]) -> bool {
	let sample = &prefix[..prefix.len().min(4096)];
	let bom = Encoding::for_bom(sample);
	let encoding = bom
		.map(|(enc, _)| enc)
		.or_else(|| content_type.and_then(charset));
	if encoding.is_some_and(|enc| enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE) {
		return false;
	}
	let sample = bom.map_or(sample, |(_, skip)| &sample[skip..]);
	sample_looks_binary(sample, encoding)
}

/// Classify a response using the declared media type, URL suffix and up to
/// 4096 leading bytes. An HTML signature can correct a plain-text or blob
/// label.
pub fn classify(content_type: Option<&str>, url: &Url, prefix: &[u8]) -> Kind {
	let content_type = content_type.unwrap_or_default();
	let media = content_type
		.split(';')
		.next()
		.unwrap_or_default()
		.trim_ascii();
	let ext = url
		.path()
		.rsplit('/')
		.next()
		.and_then(|s| s.rsplit_once('.'))
		.map_or("", |(_, ext)| ext);
	if one_of(media, &["text/html", "application/xhtml+xml"]) {
		return Kind::Html;
	}
	let generic = media.is_empty()
		|| one_of(media, &[
			"application/octet-stream",
			"binary/octet-stream",
			"application/x-download",
		]);
	let json = one_of(media, &["application/json", "text/json"]) || ends(media, "+json");
	let svg = media.eq_ignore_ascii_case("image/svg+xml");
	let blob = !svg && starts(media.as_bytes(), b"image/")
		|| one_of(media, &[
			"application/x-ipynb+json",
			"application/pdf",
			"application/epub+zip",
			"application/vnd.sqlite3",
			"application/x-sqlite3",
			"application/sqlite3",
			"application/sqlite",
			"application/zip",
			"application/x-zip-compressed",
			"application/x-tar",
			"application/tar",
			"application/gzip",
			"application/x-gzip",
		])
		|| starts(media.as_bytes(), b"application/vnd.openxmlformats-officedocument.")
		|| binary_extension(ext)
			&& (generic
				|| media.eq_ignore_ascii_case("text/plain")
				|| json && ext.eq_ignore_ascii_case("ipynb"));
	if json && !blob {
		return Kind::Json;
	}
	if one_of(media, &["application/rss+xml", "application/atom+xml", "application/feed+xml"]) {
		return Kind::Feed;
	}

	let sample = &prefix[..prefix.len().min(4096)];
	let bom = Encoding::for_bom(sample);
	let encoding = bom.map(|(enc, _)| enc).or_else(|| charset(content_type));
	let sample = bom.map_or(sample, |(_, skip)| &sample[skip..]);
	let decoded;
	let sample = if let Some(enc) =
		encoding.filter(|&enc| enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE)
	{
		decoded = enc.decode_without_bom_handling(sample).0;
		decoded.as_bytes()
	} else {
		sample
	};
	let mut leading = sample.trim_ascii_start();
	let xml = starts(leading, b"<?xml");
	loop {
		let end = if leading.starts_with(b"<!--") {
			b"-->".as_slice()
		} else if leading.starts_with(b"<?") {
			b"?>"
		} else {
			break;
		};
		let Some(index) = memchr::memmem::find(leading, end) else {
			break;
		};
		leading = leading[index + end.len()..].trim_ascii_start();
	}
	let xml_mime = one_of(media, &["application/xml", "text/xml"]) || ends(media, "+xml");
	if (blob || svg || !xml_mime) && html_prefix(leading) {
		return Kind::Html;
	}
	if blob {
		return Kind::Blob;
	}
	if svg {
		return Kind::Xml;
	}
	if tag_prefix(leading, b"<rss")
		|| tag_prefix(leading, b"<feed")
		|| tag_prefix(leading, b"<rdf:rdf")
			&& memchr::memmem::find(leading, b"http://purl.org/rss/1.0/").is_some()
	{
		return Kind::Feed;
	}
	if xml_mime {
		return Kind::Xml;
	}
	if generic && one_of(ext, &["html", "htm", "xhtml"]) {
		return Kind::Html;
	}
	if xml || (generic && ext.eq_ignore_ascii_case("xml")) {
		return Kind::Xml;
	}
	if sample_looks_binary(sample, encoding) {
		return Kind::Blob;
	}
	if one_of(media, &["text/markdown", "text/x-markdown", "application/markdown"])
		|| (generic || media.eq_ignore_ascii_case("text/plain"))
			&& one_of(ext, &["md", "markdown", "mdown"])
	{
		return Kind::Markdown;
	}
	if generic && ext.eq_ignore_ascii_case("json") {
		return Kind::Json;
	}
	if generic && one_of(ext, &["rss", "atom"]) {
		return Kind::Feed;
	}
	if media.is_empty()
		|| starts(media.as_bytes(), b"text/")
		|| one_of(media, &[
			"application/javascript",
			"application/x-javascript",
			"application/x-www-form-urlencoded",
		])
		|| generic && one_of(ext, &["txt", "text", "csv", "tsv", "log"])
	{
		Kind::Text
	} else {
		Kind::Blob
	}
}

#[cfg(test)]
mod tests {
	use super::{Kind, Url, classify};

	fn kind(mime: Option<&str>, path: &str, bytes: &[u8]) -> Kind {
		let base = Url::parse("https://example.org/").unwrap();
		classify(mime, &base.join(path).unwrap(), bytes)
	}

	#[test]
	fn incorrect_text_headers_do_not_hide_html_or_binary() {
		assert_eq!(
			kind(Some("text/plain"), "/", b"\xef\xbb\xbf <!-- leading comment --> <DiV>"),
			Kind::Html
		);
		assert_eq!(kind(Some("text/plain"), "/", b"\xff\xff\xffbinary"), Kind::Blob);
		assert_eq!(kind(Some("text/plain; charset=utf-16le"), "/", b"a\0b\0"), Kind::Text);
	}

	#[test]
	fn svg_stays_text_and_html_gateways_override_blob_mimes() {
		assert_eq!(
			kind(Some("image/svg+xml"), "/diagram.svg", b"<?xml version='1.0'?><svg/>"),
			Kind::Xml
		);
		assert_eq!(
			kind(Some("image/png"), "/photo.png", b"<!DOCTYPE html><title>Gateway error</title>"),
			Kind::Html
		);
		assert_eq!(kind(Some("image/png"), "/photo.png", b"\x89PNG\r\n\x1a\n"), Kind::Blob);
		assert_eq!(
			kind(Some("application/pdf"), "/download.pdf", b"<html><title>Gateway error</title>"),
			Kind::Html
		);
		assert_eq!(
			kind(Some("application/octet-stream"), "/download.pdf", b"<h1>Gateway error</h1>"),
			Kind::Html
		);
	}

	#[test]
	fn xml_and_converter_payloads_keep_their_own_handlers() {
		assert_eq!(kind(Some("application/xml"), "/v", b"<?xml version='1.0'?><feed>"), Kind::Feed);
		assert_eq!(kind(Some("application/xml"), "/v", b"<?xml version='1.0'?><items>"), Kind::Xml);
		assert_eq!(kind(Some("application/json"), "/demo.IPYNB?raw", b"{}"), Kind::Blob);
		assert_eq!(kind(Some("application/x-ipynb+json"), "/v", b"{}"), Kind::Blob);
		assert_eq!(kind(Some("application/octet-stream"), "/README.md", b"# Hello"), Kind::Markdown);
	}
}
