//! In-memory document conversion contracts for `read`.

use std::{
	fmt::Write as _,
	future::{Future, ready},
	io::Write as _,
	path::Path,
	sync::Arc,
};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_ar::zip::Writer;
use omp_core::{Str, sf};
use omp_tool::{
	BlobRef, CapsBase, Diag, DiagKind, Ev, IncomingParams, ModelClass, Part, PromptCaps, Severity,
	Tool, ToolTerminal, Unit,
};
use omp_tools::read::{
	self, DirectorySource, Fault, ReadBlobs, ReadLease, ReadSources, SnapshotRecord, SourceKind,
	SourceStat, StoredArtifact, markit,
	web::types::{HttpClient, HttpRequest, HttpResponse, WebError},
};
use parking_lot::Mutex;
use serde_json::json;

fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
	let mut writer = Writer::new(Vec::new());
	for (path, content) in entries {
		writer
			.add_file(path, content.as_bytes())
			.expect("fixture member adds");
	}
	writer.finish().expect("fixture archive finishes")
}

#[derive(Clone)]
struct DocumentSources {
	path:  Str,
	bytes: Bytes,
}

#[derive(Clone)]
struct DocumentLease {
	canonical_path: Str,
	revision:       Str,
	bytes:          Bytes,
}

impl ReadLease for DocumentLease {
	fn revision(&self) -> &Str {
		&self.revision
	}

	fn canonical_path(&self) -> &Str {
		&self.canonical_path
	}

	fn read_all(&self) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		ready(Ok(self.bytes.clone()))
	}
}

impl HttpClient for DocumentSources {
	fn get(
		&self,
		_request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		ready(Err(WebError::request("document fixtures must not use HTTP")))
	}
}

impl ReadSources for DocumentSources {
	type Lease = DocumentLease;

	fn stat(&self, path: Str) -> impl Future<Output = Result<SourceStat, Fault>> + Send + '_ {
		let result = if path == self.path {
			Ok(SourceStat {
				canonical_path: self.path.clone(),
				display_path:   self.path.clone(),
				kind:           SourceKind::File,
				byte_len:       self.bytes.len() as u64,
				modified_ms:    None,
			})
		} else {
			Err(Fault::source(format!("fixture path not found: {path}")))
		};
		ready(result)
	}

	fn resolve_suffix(
		&self,
		_path: Str,
	) -> impl Future<Output = Result<Option<SourceStat>, Fault>> + Send + '_ {
		ready(Ok(None))
	}

	fn open(&self, path: Str) -> impl Future<Output = Result<Self::Lease, Fault>> + Send + '_ {
		let result = if path == self.path {
			Ok(DocumentLease {
				canonical_path: self.path.clone(),
				revision:       sf!("document-revision"),
				bytes:          self.bytes.clone(),
			})
		} else {
			Err(Fault::source(format!("fixture path not found: {path}")))
		};
		ready(result)
	}

	fn read_bytes(&self, path: Str) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		let result = if path == self.path {
			Ok(self.bytes.clone())
		} else {
			Err(Fault::source(format!("fixture path not found: {path}")))
		};
		ready(result)
	}

	fn list_directory(
		&self,
		_path: Str,
		_max_depth: usize,
	) -> impl Future<Output = Result<DirectorySource, Fault>> + Send + '_ {
		ready(Err(Fault::source("document fixture has no directories")))
	}

	fn record_snapshot(&self, _record: SnapshotRecord) -> Result<Option<Str>, Fault> {
		Ok(Some(sf!("A1B2")))
	}
}

#[derive(Clone)]
struct NoBlobs;

impl ReadBlobs for NoBlobs {
	fn store(
		&self,
		_bytes: Bytes,
		_media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_ {
		ready(Err(Fault::source("small document fixtures must not spill to blobs")))
	}

	fn store_artifact(
		&self,
		_bytes: Bytes,
		_media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, Fault>> + Send + '_ {
		ready(Err(Fault::source("small document fixtures must not spill to artifacts")))
	}
}

#[derive(Clone, Default)]
struct RecordingBlobs {
	stored: Arc<Mutex<Vec<(Bytes, Str)>>>,
}

impl ReadBlobs for RecordingBlobs {
	fn store(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_ {
		self.stored.lock().push((bytes.clone(), media_type.clone()));
		ready(Ok(BlobRef { hash: sf!("document-blob"), media_type, byte_len: bytes.len() as u64 }))
	}

	fn store_artifact(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, Fault>> + Send + '_ {
		self.stored.lock().push((bytes.clone(), media_type.clone()));
		ready(Ok(StoredArtifact {
			blob: BlobRef { hash: sf!("document-blob"), media_type, byte_len: bytes.len() as u64 },
			uri:  sf!("artifact://1"),
		}))
	}
}

async fn read_document_tool_text_with_blobs_and_diags<B: ReadBlobs>(
	path: &str,
	document_path: &str,
	bytes: Vec<u8>,
	blobs: B,
) -> (String, Vec<Diag>) {
	let tool = read::tool(
		DocumentSources { path: Str::new(document_path), bytes: Bytes::from(bytes) },
		blobs,
	);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(json!({ "path": path }).to_string()))
		.expect("read invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let mut diags = Vec::new();
	let mut terminal = None;
	for event in events {
		match event {
			Ev::Diag(diag) => diags.push(diag),
			Ev::Done(ToolTerminal::Done { result, .. }) => terminal = Some(result),
			other => panic!("unexpected document read event: {other:?}"),
		}
	}
	let result = terminal.expect("one terminal document read event");
	let parts = tool.prompt(
		result.as_ref(),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      8,
				maximum_text_bytes: u32::MAX,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	let [Part::Text { text }] = parts.as_slice() else {
		panic!("expected one model-facing document text part: {parts:?}");
	};
	(text.to_string(), diags)
}

async fn read_document_tool_text_with_blobs<B: ReadBlobs>(
	path: &str,
	document_path: &str,
	bytes: Vec<u8>,
	blobs: B,
) -> String {
	read_document_tool_text_with_blobs_and_diags(path, document_path, bytes, blobs)
		.await
		.0
}

async fn read_document_tool_text(path: &str, document_path: &str, bytes: Vec<u8>) -> String {
	read_document_tool_text_with_blobs(path, document_path, bytes, NoBlobs).await
}

async fn read_document_tool_text_and_diags(
	path: &str,
	document_path: &str,
	bytes: Vec<u8>,
) -> (String, Vec<Diag>) {
	read_document_tool_text_with_blobs_and_diags(path, document_path, bytes, NoBlobs).await
}

#[test]
fn docx_headings_lists_paragraphs_and_tables_become_markdown() {
	let bytes = zip(&[
		(
			"word/styles.xml",
			r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>"#,
		),
		(
			"word/numbering.xml",
			r#"<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#,
		),
		(
			"word/document.xml",
			r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Plain paragraph.</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>7</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>"#,
		),
	]);

	let conversion = markit::convert(Path::new("report.docx"), &bytes)
		.expect("DOCX conversion succeeds")
		.expect("DOCX is supported");
	assert_eq!(
		conversion.text.as_str(),
		"# Quarterly Report\n\nPlain paragraph.\n\n- First item\n\n| Name | Value |\n| --- | --- \
		 |\n| alpha | 7 |"
	);
	assert_eq!(conversion.note, None);
}

fn selector_fixture_docx() -> Vec<u8> {
	zip(&[
		(
			"word/styles.xml",
			r#"<w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>"#,
		),
		(
			"word/document.xml",
			r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Range Fixture</w:t></w:r></w:p>
<w:p><w:r><w:t>alpha</w:t></w:r></w:p>
<w:p><w:r><w:t>beta</w:t></w:r></w:p>
<w:p><w:r><w:t>gamma</w:t></w:r></w:p>
<w:p><w:r><w:t>delta</w:t></w:r></w:p>
</w:body></w:document>"#,
		),
	])
}

#[tokio::test]
async fn read_tool_dispatches_docx_bytes_and_applies_line_selectors_to_converted_text() {
	let (output, diags) = read_document_tool_text_and_diags(
		"fixture.docx:3-3",
		"fixture.docx",
		selector_fixture_docx(),
	)
	.await;
	assert_eq!(output, "2:# Range Fixture\n3:\n4:alpha\n5:\n6:beta");
	let [diag] = diags.as_slice() else {
		panic!("document range emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some(":7"));
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 4, unit: Unit::Lines }));
}

#[tokio::test]
async fn raw_document_reads_bypass_numbering_but_not_document_conversion() {
	let output =
		read_document_tool_text("fixture.docx:raw", "fixture.docx", selector_fixture_docx()).await;
	assert_eq!(
		output,
		"Content-Type: text/markdown\n# Range Fixture\n\nalpha\n\nbeta\n\ngamma\n\ndelta"
	);
}

#[tokio::test]
async fn read_tool_routes_new_document_extensions_through_markit() {
	let output = read_document_tool_text(
		"fixture.rtf:raw",
		"fixture.rtf",
		br"{\rtf1\ansi Local RTF document\par}".to_vec(),
	)
	.await;
	assert_eq!(output, "Content-Type: text/markdown\nLocal RTF document\n");
}

#[tokio::test]
async fn oversized_converted_document_returns_the_complete_numbered_markdown() {
	let mut document = String::from(
		r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
	);
	for line in 1..=3200 {
		write!(document, "<w:p><w:r><w:t>Converted line {line}</w:t></w:r></w:p>").unwrap();
	}
	document.push_str("</w:body></w:document>");
	let bytes = zip(&[("word/document.xml", &document)]);
	let converted = markit::convert(Path::new("large.docx"), &bytes)
		.expect("large DOCX conversion succeeds")
		.expect("DOCX is supported");
	let framed = format!("Content-Type: text/markdown\n{}", converted.text);
	let numbered = framed
		.split('\n')
		.enumerate()
		.map(|(index, line)| format!("{}:{line}", index + 1))
		.collect::<Vec<_>>()
		.join("\n");
	let full = numbered;
	assert!(full.lines().count() > 3000, "fixture must exceed the former 3,000-line read cap");
	let blobs = RecordingBlobs::default();

	let output =
		read_document_tool_text_with_blobs("large.docx", "large.docx", bytes, blobs.clone()).await;
	assert!(!output.contains("[truncated:"), "read must not append its own notice: {output}");
	let last_line_at = full
		.find("Converted line 3200")
		.expect("fixture renders its final converted line");
	assert!(
		output.starts_with(&full[..last_line_at])
			&& output
				.get(last_line_at..)
				.is_some_and(|tail| tail.starts_with("Converted line 3200")),
		"converted output must be complete through its final line"
	);
	assert!(
		blobs.stored.lock().is_empty(),
		"read must not spill its own artifact; the dispatcher bounds output once"
	);
}

#[tokio::test]
async fn docx_missing_document_member_has_exact_error_and_binary_projection() {
	let bytes = zip(&[]);
	let error = markit::convert(Path::new("broken.docx"), &bytes)
		.expect_err("missing DOCX document member fails");
	assert_eq!(error.to_string(), "docx conversion failed: Invalid DOCX: missing word/document.xml");
	let output = read_document_tool_text("broken.docx", "broken.docx", bytes).await;
	assert_eq!(
		output,
		"[Cannot read binary file 'broken.docx' (22B); not valid UTF-8 text. Use ':raw' to read \
		 bytes verbatim.]"
	);
}

#[test]
fn xlsx_preserves_sheet_order_shared_strings_inline_strings_numbers_and_booleans() {
	let bytes = zip(&[
		(
			"xl/workbook.xml",
			r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
		),
		(
			"xl/_rels/workbook.xml.rels",
			r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
		),
		(
			"xl/sharedStrings.xml",
			r"<sst><si><t>Name</t></si><si><r><t>Val</t></r><r><t>ue</t></r></si><si><t>alpha</t></si></sst>",
		),
		(
			"xl/worksheets/sheet1.xml",
			r#"<worksheet><sheetData>
<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="inlineStr"><is><t>Enabled</t></is></c></row>
<row><c t="s"><v>2</v></c><c><v>7</v></c><c t="b"><v>1</v></c></row>
</sheetData></worksheet>"#,
		),
	]);

	let conversion = markit::convert(Path::new("book.xlsx"), &bytes)
		.expect("XLSX conversion succeeds")
		.expect("XLSX is supported");
	assert_eq!(
		conversion.text.as_str(),
		"## Summary\n\n| Name | Value | Enabled |\n| --- | --- | --- |\n| alpha | 7 | TRUE |"
	);
	assert_eq!(conversion.note, None);
}

#[test]
fn pptx_preserves_slide_order_and_promotes_the_first_shape_to_a_title() {
	let bytes = zip(&[
		(
			"ppt/presentation.xml",
			r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>"#,
		),
		(
			"ppt/_rels/presentation.xml.rels",
			r#"<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>"#,
		),
		(
			"ppt/slides/slide1.xml",
			r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:r><a:t>First</a:t></a:r></a:p><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"#,
		),
	]);

	let conversion = markit::convert(Path::new("deck.pptx"), &bytes)
		.expect("PPTX conversion succeeds")
		.expect("PPTX is supported");
	assert_eq!(conversion.text.as_str(), "<!-- Slide 1 -->\n# Hello\nFirst\nSecond");
	assert_eq!(conversion.note, None);
}

#[test]
fn epub_preserves_metadata_title_spine_navigation_and_body_formatting() {
	let bytes = zip(&[
		(
			"META-INF/container.xml",
			r#"<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#,
		),
		(
			"OPS/content.opf",
			r#"<package xmlns:dc="dc"><metadata><dc:title>Tiny &amp; Book</dc:title><dc:creator>Ada</dc:creator><dc:creator>Grace</dc:creator><dc:language>en</dc:language><dc:publisher>Example Press</dc:publisher><dc:date>2026</dc:date><dc:description>A compact fixture.</dc:description></metadata><manifest><item id="two" href="two.xhtml"/><item id="nav" href="nav.xhtml" properties="nav"/><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="nav"/><itemref idref="two"/></spine></package>"#,
		),
		("OPS/one.xhtml", "<html><body><h1>One</h1><p>First chapter.</p></body></html>"),
		(
			"OPS/nav.xhtml",
			"<html><head><style>nav { display: none \
			 }</style></head><body><nav><h2>Contents</h2><ol><li><a \
			 href=\"one.xhtml\">One</a></li><li><a href=\"two.xhtml\">Two &amp; \
			 More</a></li></ol></nav><script>ignored()</script></body></html>",
		),
		(
			"OPS/two.xhtml",
			"<html><body><h1>Two</h1><p>Second <strong>chapter</strong>.<br/>Next \
			 line.</p></body></html>",
		),
	]);

	let conversion = markit::convert(Path::new("book.epub"), &bytes)
		.expect("EPUB conversion succeeds")
		.expect("EPUB is supported");
	assert_eq!(
		conversion.text.as_str(),
		"**Title:** Tiny & Book\n**Authors:** Ada, Grace\n**Language:** en\n**Publisher:** Example \
		 Press\n**Date:** 2026\n**Description:** A compact fixture.\n\n# One\n\nFirst \
		 chapter.\n\n## Contents\n\n1. [One](one.xhtml)\n2. [Two & More](two.xhtml)\n\n# \
		 Two\n\nSecond **chapter**.  \nNext line."
	);
	assert_eq!(conversion.note, None);
	assert_eq!(conversion.title.as_deref(), Some("Tiny & Book"));
}

#[tokio::test]
async fn epub_missing_container_member_has_exact_error_and_binary_projection() {
	let bytes = zip(&[]);
	let error = markit::convert(Path::new("broken.epub"), &bytes)
		.expect_err("missing EPUB container member fails");
	assert_eq!(error.to_string(), "epub conversion failed: Invalid EPUB: missing container.xml");
	let output = read_document_tool_text("broken.epub", "broken.epub", bytes).await;
	assert_eq!(
		output,
		"[Cannot read binary file 'broken.epub' (22B); not valid UTF-8 text. Use ':raw' to read \
		 bytes verbatim.]"
	);
}

fn pdf(objects: &[String], trailer_entries: &str) -> Vec<u8> {
	let mut pdf = b"%PDF-1.4\n".to_vec();
	let mut offsets = Vec::new();
	for (index, object) in objects.iter().enumerate() {
		offsets.push(pdf.len());
		write!(&mut pdf, "{} 0 obj\n{}\nendobj\n", index + 1, object).expect("writes PDF object");
	}
	let xref = pdf.len();
	write!(&mut pdf, "xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1)
		.expect("writes xref header");
	for offset in offsets {
		writeln!(&mut pdf, "{offset:010} 00000 n ").expect("writes xref row");
	}
	write!(
		&mut pdf,
		"trailer\n<< /Size {} /Root 1 0 R {trailer_entries} >>\nstartxref\n{xref}\n%%EOF\n",
		objects.len() + 1
	)
	.expect("writes PDF trailer");
	pdf
}

fn text_pdf_objects(text: &str) -> Vec<String> {
	let escaped = text
		.replace('\\', "\\\\")
		.replace('(', "\\(")
		.replace(')', "\\)");
	let stream = format!("BT /F1 18 Tf 72 720 Td ({escaped}) Tj ET");
	vec![
		"<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> \
		 >> /Contents 4 0 R >>"
			.to_owned(),
		format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
	]
}

fn minimal_text_pdf(text: &str) -> Vec<u8> {
	pdf(&text_pdf_objects(text), "")
}

fn image_only_pdf() -> Vec<u8> {
	let image = "x";
	let stream = "q 612 0 0 792 0 0 cm /Im1 Do Q";
	pdf(
		&[
			"<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 \
			 R >> >> /Contents 4 0 R >>"
				.to_owned(),
			format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
			format!(
				"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray \
				 /BitsPerComponent 8 /Length {} >>\nstream\n{image}\nendstream",
				image.len()
			),
		],
		"",
	)
}

fn encrypted_pdf() -> Vec<u8> {
	let mut objects = text_pdf_objects("Encrypted text");
	let owner = "41".repeat(32);
	let user = "42".repeat(32);
	objects.push(format!("<< /Filter /Standard /V 1 /R 2 /O <{owner}> /U <{user}> /P -4 >>"));
	let id = "0123456789abcdef0123456789abcdef";
	pdf(&objects, &format!("/Encrypt 6 0 R /ID [<{id}> <{id}>]"))
}

#[test]
fn pdf_text_layer_is_converted_in_memory_with_page_markers_and_final_newline() {
	let text = "Hello PDF with enough natural-language text to make the extracted text layer \
	            useful without recommending OCR.";
	let bytes = minimal_text_pdf(text);
	let conversion = markit::convert(Path::new("hello.pdf"), &bytes)
		.expect("PDF conversion succeeds")
		.expect("PDF is supported");
	assert!(conversion.text.contains(text), "{}", conversion.text);
	assert!(conversion.text.contains("<!-- Page 1 -->"), "{}", conversion.text);
	assert!(conversion.text.ends_with('\n'), "{}", conversion.text);
	assert_eq!(conversion.note, None);
}

#[test]
fn pdf_image_only_document_returns_an_ocr_qualification_without_fake_text() {
	let conversion = markit::convert(Path::new("scan.pdf"), &image_only_pdf())
		.expect("image-only PDF classification succeeds")
		.expect("PDF is supported");
	assert_eq!(conversion.text.as_str(), "");
	assert_eq!(
		conversion.note.as_deref(),
		Some(
			"This PDF is scanned or image-based and has no usable text layer. OCR is required to \
			 extract its text."
		)
	);
}

#[test]
fn pdf_page_markers_alone_do_not_count_as_extracted_text() {
	let error = markit::convert(Path::new("empty-layer.pdf"), &minimal_text_pdf(""))
		.expect_err("an empty text operator has no extractable text");
	assert_eq!(
		error.to_string(),
		"pdf conversion failed: PDF has no extractable text (TextBased, 1 pages): OCR is required"
	);
}

#[test]
fn pdf_reports_pages_that_may_need_ocr_without_discarding_usable_text() {
	let text = "Brief text layer";
	let conversion = markit::convert(Path::new("sparse.pdf"), &minimal_text_pdf(text))
		.expect("sparse text remains a qualified conversion")
		.expect("PDF is supported");
	assert!(conversion.text.contains(text), "{}", conversion.text);
	assert_eq!(
		conversion.note.as_deref(),
		Some("1 of 1 PDF pages may need OCR; extracted text may be incomplete.")
	);
}

#[test]
fn pdf_reports_partial_ocr_and_broken_font_encoding_qualifications() {
	let garbled = "alpha$bravo$charlie$delta$echo$foxtrot$golf$hotel$india$juliet$kilo$lima$mike$\
	               november$oscar$papa$quebec$romeo$sierra$tango$uniform$victor";
	let conversion = markit::convert(Path::new("garbled.pdf"), &minimal_text_pdf(garbled))
		.expect("garbled text remains a qualified conversion")
		.expect("PDF is supported");
	assert!(conversion.text.contains(garbled), "{}", conversion.text);
	assert_eq!(
		conversion.note.as_deref(),
		Some(
			"1 of 1 PDF pages may need OCR, and broken font encodings were detected; extracted text \
			 may be incomplete or garbled."
		)
	);
}

#[test]
fn pdf_metadata_title_is_kept_separate_from_markdown() {
	let mut objects = text_pdf_objects(
		"Metadata-bearing PDF with enough body text to avoid a sparse text-layer qualification.",
	);
	objects.push("<< /Title (Quarterly PDF) >>".to_owned());
	let conversion = markit::convert(Path::new("titled.pdf"), &pdf(&objects, "/Info 6 0 R"))
		.expect("metadata-bearing PDF conversion succeeds")
		.expect("PDF is supported");
	assert_eq!(conversion.title.as_deref(), Some("Quarterly PDF"));
	assert!(!conversion.text.contains("Quarterly PDF"));
}

#[test]
fn pdf_non_pdf_bytes_and_encryption_remain_truthful_typed_errors() {
	let malformed = markit::convert(Path::new("wrong.pdf"), b"<html>not a PDF</html>")
		.expect_err("non-PDF bytes fail validation");
	assert_eq!(malformed.to_string(), "pdf conversion failed: Not a PDF: file appears to be HTML");

	let encrypted = markit::convert(Path::new("protected.pdf"), &encrypted_pdf())
		.expect_err("password-protected PDF cannot be extracted");
	assert_eq!(encrypted.to_string(), "pdf conversion failed: PDF is encrypted");
}

#[test]
fn pdf_structural_corruption_returns_a_pdf_conversion_error() {
	let error = markit::convert(Path::new("truncated.pdf"), b"%PDF-1.4\n")
		.expect_err("a truncated PDF cannot be converted");
	assert_eq!(error.format(), "pdf");
	assert_ne!(error.message(), "");
}

#[test]
fn unsupported_extension_is_not_misclassified_as_a_document() {
	assert_eq!(
		markit::convert(Path::new("notes.txt"), b"plain text").expect("dispatch succeeds"),
		None
	);
}
