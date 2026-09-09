//! Focused PDF-to-Markdown conversion contracts.

use std::{io::Write as _, path::Path};

use omp_tools::read::{
	format::{TextFormatOptions, format_text},
	markit,
	selector::ParsedSelector,
};

const TEXT_LAYER_NOTE: &str = "This PDF is scanned or image-based and has no usable text layer. \
                               OCR is required to extract its text.";

fn escape_pdf_string(value: &str) -> String {
	value
		.replace('\\', "\\\\")
		.replace('(', "\\(")
		.replace(')', "\\)")
}

/// Build a deterministic, classic-xref PDF fixture with one text stream per
/// page. Empty page text deliberately produces a page without a text layer.
fn text_pdf(pages: &[&str], title: Option<&str>) -> Vec<u8> {
	assert!(!pages.is_empty(), "a PDF fixture needs at least one page");

	let page_ids: Vec<usize> = (0..pages.len()).map(|index| 4 + index * 2).collect();
	let kids = page_ids
		.iter()
		.map(|id| format!("{id} 0 R"))
		.collect::<Vec<_>>()
		.join(" ");
	let mut objects = vec![
		"<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
		format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
	];

	for (index, page_text) in pages.iter().enumerate() {
		let page_id = page_ids[index];
		let content_id = page_id + 1;
		objects.push(format!(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R \
			 >> >> /Contents {content_id} 0 R >>"
		));
		let stream = if page_text.is_empty() {
			String::new()
		} else {
			format!("BT /F1 12 Tf 72 720 Td ({}) Tj ET", escape_pdf_string(page_text))
		};
		objects.push(format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()));
	}

	let info_id = title.map(|title| {
		objects.push(format!("<< /Title ({}) >>", escape_pdf_string(title)));
		objects.len()
	});
	let mut pdf = b"%PDF-1.4\n".to_vec();
	let mut offsets = Vec::with_capacity(objects.len());
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
	let info = info_id.map_or_else(String::new, |id| format!(" /Info {id} 0 R"));
	write!(
		&mut pdf,
		"trailer\n<< /Size {} /Root 1 0 R{info} >>\nstartxref\n{xref}\n%%EOF\n",
		objects.len() + 1
	)
	.expect("writes PDF trailer");
	pdf
}

#[test]
fn text_pdf_preserves_page_marker_text_and_metadata_separately() {
	let bytes = text_pdf(&["Hello PDF"], Some("Fixture title"));
	let conversion = markit::convert(Path::new("hello.pdf"), &bytes)
		.expect("PDF conversion succeeds")
		.expect("PDF is supported");

	assert_eq!(conversion.text.as_str(), "<!-- Page 1 -->\n\n## Hello PDF\n");
	assert_eq!(conversion.title.as_deref(), Some("Fixture title"));
	assert_eq!(
		conversion.note.as_deref(),
		Some("1 of 1 PDF pages may need OCR; extracted text may be incomplete.")
	);
}

#[test]
fn multi_page_pdf_preserves_source_order_and_marks_every_page() {
	let bytes = text_pdf(&["First page", "Second page"], None);
	let conversion = markit::convert(Path::new("two-pages.PDF"), &bytes)
		.expect("PDF conversion succeeds")
		.expect("case-insensitive PDF extension is supported");

	assert_eq!(
		conversion.text.as_str(),
		"<!-- Page 1 -->\n\n## First page\n\n<!-- Page 2 -->\n\n## Second page\n"
	);
	assert_eq!(conversion.title, None);
	assert_eq!(
		conversion.note.as_deref(),
		Some("2 of 2 PDF pages may need OCR; extracted text may be incomplete.")
	);
}

#[test]
fn empty_scanned_pdf_is_a_qualified_empty_conversion() {
	let bytes = text_pdf(&[""], Some("Image-only fixture"));
	let conversion = markit::convert(Path::new("scan.pdf"), &bytes)
		.expect("classification succeeds")
		.expect("PDF is supported");

	assert_eq!(conversion.text.as_str(), "");
	assert_eq!(conversion.title.as_deref(), Some("Image-only fixture"));
	assert_eq!(conversion.note.as_deref(), Some(TEXT_LAYER_NOTE));
}

#[test]
fn malformed_pdf_retains_a_typed_converter_failure() {
	let error = markit::convert(Path::new("broken.pdf"), b"definitely not a PDF")
		.expect_err("plain text with a PDF suffix is malformed");

	assert_eq!(error.format(), "pdf");
	assert_eq!(error.message(), "Not a PDF: file appears to be plain text");
	assert_eq!(error.to_string(), "pdf conversion failed: Not a PDF: file appears to be plain text");
}

#[test]
fn converted_pdf_projection_keeps_an_oversized_line_complete() {
	// A single 60 KiB line exceeds the former 50 KiB read cap; the projection
	// must still carry it whole and leave bounding to the dispatcher.
	let long_line = "A".repeat(60 * 1024);
	let bytes = text_pdf(&[&long_line], None);
	let conversion = markit::convert(Path::new("large.pdf"), &bytes)
		.expect("PDF conversion succeeds")
		.expect("PDF is supported");
	let formatted = format_text(
		conversion.text.as_str(),
		&ParsedSelector::None,
		TextFormatOptions::new("document"),
	);

	assert_eq!(formatted.total_lines, 3);
	assert!(formatted.text.starts_with("1:<!-- Page 1 -->\n2:\n3:"), "{}", formatted.text);
	assert!(formatted.text.contains(&long_line), "the oversized line must be carried whole");
	assert!(!formatted.text.contains("[Showing lines"));
	assert!(!formatted.text.contains("[truncated:"));
}
