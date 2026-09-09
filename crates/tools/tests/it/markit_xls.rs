//! Synthetic Excel 97-2003 workbook conversion coverage.
//!
//! The compact BIFF8/CFB fixture construction follows the structures used by
//! firecrawl/anydoc's MIT-licensed fixture generator, without vendoring a
//! producer-generated binary.

use std::path::Path;

use omp_tools::read::markit;

const END_OF_CHAIN: u32 = 0xffff_fffe;
const FAT_SECTOR: u32 = 0xffff_fffd;
const FREE_SECTOR: u32 = 0xffff_ffff;

fn push_u16(out: &mut Vec<u8>, value: u16) {
	out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
	out.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
	out.extend_from_slice(&value.to_le_bytes());
}

fn record(kind: u16, body: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(4 + body.len());
	push_u16(&mut out, kind);
	push_u16(&mut out, body.len().try_into().expect("compact BIFF record"));
	out.extend_from_slice(body);
	out
}

fn bof(kind: u16) -> Vec<u8> {
	let mut body = vec![0; 16];
	body[..2].copy_from_slice(&0x0600u16.to_le_bytes());
	body[2..4].copy_from_slice(&kind.to_le_bytes());
	record(0x0809, &body)
}

fn bound_sheet(offset: u32, visibility: u8, name: &str) -> Vec<u8> {
	let mut body = Vec::with_capacity(8 + name.len());
	push_u32(&mut body, offset);
	body.push(visibility);
	body.push(0); // worksheet, never a VBA or macro sheet
	body.push(name.len().try_into().expect("short sheet name"));
	body.push(0); // compressed BIFF8 Unicode: ASCII bytes
	body.extend_from_slice(name.as_bytes());
	record(0x0085, &body)
}

fn dimensions(rows: u32, columns: u16) -> Vec<u8> {
	let mut body = Vec::with_capacity(14);
	push_u32(&mut body, 0);
	push_u32(&mut body, rows);
	push_u16(&mut body, 0);
	push_u16(&mut body, columns);
	push_u16(&mut body, 0);
	record(0x0200, &body)
}

fn label(row: u16, column: u16, text: &str) -> Vec<u8> {
	let utf16 = text.encode_utf16().collect::<Vec<_>>();
	let mut body = Vec::with_capacity(9 + utf16.len() * 2);
	push_u16(&mut body, row);
	push_u16(&mut body, column);
	push_u16(&mut body, 0); // default cell format
	push_u16(&mut body, utf16.len().try_into().expect("short fixture string"));
	body.push(1); // uncompressed UTF-16LE
	for code_unit in utf16 {
		push_u16(&mut body, code_unit);
	}
	record(0x0204, &body)
}

fn number(row: u16, column: u16, value: f64) -> Vec<u8> {
	let mut body = Vec::with_capacity(14);
	push_u16(&mut body, row);
	push_u16(&mut body, column);
	push_u16(&mut body, 0);
	body.extend_from_slice(&value.to_le_bytes());
	record(0x0203, &body)
}

fn bool_or_error(row: u16, column: u16, value: u8, is_error: bool) -> Vec<u8> {
	let mut body = Vec::with_capacity(8);
	push_u16(&mut body, row);
	push_u16(&mut body, column);
	push_u16(&mut body, 0);
	body.push(value);
	body.push(u8::from(is_error));
	record(0x0205, &body)
}

fn cached_formula(row: u16, column: u16, value: f64) -> Vec<u8> {
	let mut body = Vec::with_capacity(29);
	push_u16(&mut body, row);
	push_u16(&mut body, column);
	push_u16(&mut body, 0);
	body.extend_from_slice(&value.to_le_bytes());
	push_u16(&mut body, 0); // formula flags
	push_u32(&mut body, 0); // calculation chain id
	push_u16(&mut body, 7); // token byte count
	body.extend_from_slice(&[0x1e, 1, 0, 0x1e, 2, 0, 0x03]); // 1 + 2
	record(0x0006, &body)
}

fn far_away_merge() -> Vec<u8> {
	let mut body = Vec::with_capacity(10);
	push_u16(&mut body, 1);
	push_u16(&mut body, u16::MAX);
	push_u16(&mut body, u16::MAX);
	push_u16(&mut body, u8::MAX.into());
	push_u16(&mut body, u8::MAX.into());
	record(0x00e5, &body)
}

fn worksheet(records: impl IntoIterator<Item = Vec<u8>>) -> Vec<u8> {
	let mut out = bof(0x0010);
	for item in records {
		out.extend(item);
	}
	out.extend(record(0x000a, &[]));
	out
}

fn workbook_stream(sheets: &[(u8, &str, Vec<u8>)], extra_globals: &[Vec<u8>]) -> Vec<u8> {
	let global_len = bof(0x0005).len()
		+ sheets
			.iter()
			.map(|(_, name, _)| bound_sheet(0, 0, name).len())
			.sum::<usize>()
		+ extra_globals.iter().map(Vec::len).sum::<usize>()
		+ record(0x000a, &[]).len();
	let mut offset = global_len as u32;
	let mut out = bof(0x0005);
	for (visibility, name, sheet) in sheets {
		out.extend(bound_sheet(offset, *visibility, name));
		offset += u32::try_from(sheet.len()).expect("compact worksheet");
	}
	for item in extra_globals {
		out.extend(item);
	}
	out.extend(record(0x000a, &[]));
	for (_, _, sheet) in sheets {
		out.extend_from_slice(sheet);
	}
	out
}

fn directory_entry(name: &str, object_type: u8, child: u32, start: u32, size: u64) -> Vec<u8> {
	let mut out = Vec::with_capacity(128);
	let mut encoded_name = name
		.encode_utf16()
		.flat_map(u16::to_le_bytes)
		.collect::<Vec<_>>();
	encoded_name.extend_from_slice(&[0, 0]);
	assert!(encoded_name.len() <= 64);
	out.extend_from_slice(&encoded_name);
	out.resize(64, 0);
	push_u16(&mut out, encoded_name.len() as u16);
	out.push(object_type);
	out.push(1); // black directory node
	push_u32(&mut out, FREE_SECTOR); // left sibling
	push_u32(&mut out, FREE_SECTOR); // right sibling
	push_u32(&mut out, child);
	out.extend_from_slice(&[0; 16]); // CLSID
	push_u32(&mut out, 0); // state bits
	push_u64(&mut out, 0); // creation time
	push_u64(&mut out, 0); // modification time
	push_u32(&mut out, start);
	push_u64(&mut out, size);
	assert_eq!(out.len(), 128);
	out
}

fn cfb_workbook(mut workbook: Vec<u8>) -> Vec<u8> {
	assert!(workbook.len() <= 4096, "fixture remains a compact regular CFB stream");
	workbook.resize(4096, 0);

	let mut directory = directory_entry("Root Entry", 5, 1, END_OF_CHAIN, 0);
	directory.extend(directory_entry("Workbook", 2, FREE_SECTOR, 0, 4096));
	directory.resize(512, 0);

	let mut fat = Vec::with_capacity(512);
	for sector in 0..8u32 {
		push_u32(
			&mut fat,
			if sector == 7 {
				END_OF_CHAIN
			} else {
				sector + 1
			},
		);
	}
	push_u32(&mut fat, END_OF_CHAIN); // directory sector 8
	push_u32(&mut fat, FAT_SECTOR); // FAT sector 9
	while fat.len() < 512 {
		push_u32(&mut fat, FREE_SECTOR);
	}

	let mut header = Vec::with_capacity(512);
	header.extend_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
	header.extend_from_slice(&[0; 16]); // CLSID
	for value in [0x003e, 0x0003, 0xfffe, 9, 6, 0] {
		push_u16(&mut header, value);
	}
	push_u32(&mut header, 0); // remaining reserved bytes
	push_u32(&mut header, 0); // directory sectors (CFB v3)
	push_u32(&mut header, 1); // FAT sectors
	push_u32(&mut header, 8); // first directory sector
	push_u32(&mut header, 0); // transaction signature
	push_u32(&mut header, 4096); // mini-stream cutoff
	push_u32(&mut header, END_OF_CHAIN);
	push_u32(&mut header, 0); // mini-FAT sectors
	push_u32(&mut header, END_OF_CHAIN);
	push_u32(&mut header, 0); // DIFAT sectors
	push_u32(&mut header, 9); // first DIFAT entry: FAT sector
	for _ in 1..109 {
		push_u32(&mut header, FREE_SECTOR);
	}
	assert_eq!(header.len(), 512);

	header.extend(workbook);
	header.extend(directory);
	header.extend(fat);
	header
}

fn behavior_workbook() -> Vec<u8> {
	let hidden = worksheet([dimensions(1, 2), label(0, 0, "Secret"), label(0, 1, "shh")]);
	let types = worksheet([
		dimensions(4, 2),
		label(0, 0, "Kind"),
		label(0, 1, "Value"),
		label(1, 0, "Formula"),
		cached_formula(1, 1, 99.0),
		label(2, 0, "Boolean"),
		bool_or_error(2, 1, 1, false),
		label(3, 0, "Error"),
		bool_or_error(3, 1, 0x07, true),
	]);
	let text = worksheet([
		dimensions(2, 2),
		label(0, 0, "Text"),
		label(0, 1, "Number"),
		label(1, 0, "café"),
		number(1, 1, 5649.5599999999995),
		far_away_merge(),
	]);
	cfb_workbook(workbook_stream(
		&[(1, "Hidden", hidden), (0, "Types", types), (0, "Text", text)],
		&[],
	))
}

#[test]
fn xls_skips_hidden_sheets_preserves_order_cached_values_and_cell_types() {
	// Hidden sheet pins the omission; the visible Types sheet keeps the
	// cached-formula/boolean/error coverage the old Hidden sheet carried,
	// and the far-away merge lives in a visible sheet so the used-range
	// bound stays meaningful. Error literals follow Excel canonical form
	// (`#DIV/0!`) under anydoc 0.2; 0.1.9 Debug-formatted the error enum.
	let conversion = markit::convert(Path::new("legacy.xls"), &behavior_workbook())
		.expect("BIFF8 conversion succeeds")
		.expect("XLS is supported");
	assert_eq!(
		conversion.text.as_str(),
		"## Types\n\n| Kind | Value |\n| --- | --- |\n| Formula | 99 |\n| Boolean | TRUE |\n| Error \
		 | #DIV/0! |\n\n## Text\n\n| Text | Number |\n| --- | --- |\n| café | 5649.56 |\n"
	);
	assert!(conversion.text.len() < 512, "far-away merge must not expand the used range");
}

#[test]
fn xls_reports_encrypted_workbooks_without_attempting_to_execute_content() {
	let file_pass = record(0x002f, &1u16.to_le_bytes());
	let bytes = cfb_workbook(workbook_stream(&[(0, "Protected", worksheet([]))], &[file_pass]));
	let error = markit::convert(Path::new("protected.xls"), &bytes)
		.expect_err("password-protected BIFF must fail");
	assert_eq!(error.to_string(), "xls conversion failed: document is encrypted");
}

#[test]
fn xls_malformed_ole_or_biff_never_panics() {
	for bytes in [b"not an OLE workbook".as_slice(), &[0xd0, 0xcf, 0x11, 0xe0][..]] {
		let error = markit::convert(Path::new("broken.xls"), bytes)
			.expect_err("malformed XLS must return a typed error");
		assert_eq!(error.format(), "xls");
		assert_ne!(error.message(), "");
	}
}
