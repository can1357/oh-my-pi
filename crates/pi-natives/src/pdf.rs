//! PDF inspection and Markdown conversion backed by `pdf-inspector`.

use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use pdf_inspector::{MarkdownOptions, PdfOptions, process_pdf_mem_with_options};

use crate::task;

/// Markdown and inspection metadata produced from a PDF document.
#[napi(object)]
pub struct PdfMarkdownResult {
	/// Extracted document content in Markdown format.
	pub markdown:            String,
	/// Document title from PDF metadata, when present.
	pub title:               Option<String>,
	/// Total number of pages in the document.
	pub page_count:          u32,
	/// One-indexed page numbers whose content requires OCR.
	pub pages_needing_ocr:   Vec<u32>,
	/// Whether the document contains text encoding problems.
	pub has_encoding_issues: bool,
}

/// Convert an in-memory PDF to Markdown and return its inspection metadata.
///
/// Conversion copies the typed array before dispatch so JavaScript mutation
/// cannot race the native worker.
///
/// # Errors
/// Returns an error prefixed with `PDF conversion failed:` when the PDF cannot
/// be parsed or converted.
#[napi(js_name = "pdfToMarkdown")]
pub fn pdf_to_markdown(input: Uint8Array) -> task::Promise<PdfMarkdownResult> {
	let input = input.to_vec();
	task::blocking("pdf.to_markdown", (), move |_| convert_pdf(&input))
}

fn convert_pdf(input: &[u8]) -> Result<PdfMarkdownResult> {
	let options = PdfOptions::new()
		.markdown(MarkdownOptions { include_page_numbers: true, ..Default::default() });
	let converted = process_pdf_mem_with_options(input, options)
		.map_err(|error| napi::Error::from_reason(format!("PDF conversion failed: {error}")))?;
	let markdown = match converted.markdown {
		Some(markdown) => markdown,
		None if !converted.pages_needing_ocr.is_empty() => String::new(),
		None => {
			return Err(napi::Error::from_reason(
				"PDF conversion failed: converter returned no Markdown",
			));
		},
	};

	Ok(PdfMarkdownResult {
		markdown,
		title: converted.title,
		page_count: converted.page_count,
		pages_needing_ocr: converted.pages_needing_ocr,
		has_encoding_issues: converted.has_encoding_issues,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn pdf_fixture(page_contents: &[&str], title: Option<&str>) -> Vec<u8> {
		let font_id = 3 + page_contents.len() * 2;
		let info_id = title.map(|_| font_id + 1);
		let mut objects = Vec::with_capacity(font_id + usize::from(info_id.is_some()));
		objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());

		let kids = (0..page_contents.len())
			.map(|index| format!("{} 0 R", 3 + index * 2))
			.collect::<Vec<_>>()
			.join(" ");
		objects.push(format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", page_contents.len()));

		for (index, content) in page_contents.iter().enumerate() {
			let content_id = 4 + index * 2;
			objects.push(format!(
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 \
				 {font_id} 0 R >> >> /Contents {content_id} 0 R >>"
			));
			objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
		}

		objects.push(
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
				.to_string(),
		);
		if let Some(title) = title {
			objects.push(format!("<< /Title ({title}) >>"));
		}

		let mut pdf = b"%PDF-1.4\n".to_vec();
		let mut offsets = Vec::with_capacity(objects.len());
		for (index, object) in objects.iter().enumerate() {
			offsets.push(pdf.len());
			pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
		}

		let xref_offset = pdf.len();
		pdf.extend_from_slice(
			format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
		);
		for offset in offsets {
			pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
		}
		let info = info_id.map_or_else(String::new, |id| format!(" /Info {id} 0 R"));
		pdf.extend_from_slice(
			format!(
				"trailer\n<< /Size {} /Root 1 0 R{info} >>\nstartxref\n{xref_offset}\n%%EOF\n",
				objects.len() + 1
			)
			.as_bytes(),
		);
		pdf
	}

	#[test]
	fn converts_text_title_and_page_markers() {
		let pdf = pdf_fixture(
			&[
				"BT /F1 12 Tf 72 720 Td (First page text) Tj 0 -18 Td (More first page text) Tj 0 -18 \
				 Td (End first page) Tj ET",
				"BT /F1 12 Tf 72 720 Td (Second page text) Tj 0 -18 Td (More second page text) Tj 0 \
				 -18 Td (End second page) Tj ET",
			],
			Some("Fixture Title"),
		);

		let result = convert_pdf(&pdf).expect("fixture PDF should convert");

		assert_eq!(result.title.as_deref(), Some("Fixture Title"));
		assert_eq!(result.page_count, 2);
		assert!(result.markdown.contains("First page text"), "{}", result.markdown);
		assert!(result.markdown.contains("Second page text"), "{}", result.markdown);
		assert!(result.markdown.contains("<!-- Page 1 -->"), "{}", result.markdown);
		assert!(result.markdown.contains("<!-- Page 2 -->"), "{}", result.markdown);
		assert!(!result.has_encoding_issues);
	}

	#[test]
	fn reports_empty_pages_as_needing_ocr() {
		let pdf = pdf_fixture(&[""], None);

		let result = convert_pdf(&pdf).expect("empty-page PDF should still convert");

		assert_eq!(result.page_count, 1);
		assert_eq!(result.pages_needing_ocr, vec![1]);
	}

	#[test]
	fn prefixes_malformed_pdf_errors() {
		let error = convert_pdf(b"not a PDF")
			.err()
			.expect("malformed input should fail");

		assert!(
			error.reason.starts_with("PDF conversion failed:"),
			"unexpected error: {}",
			error.reason
		);
	}
}
