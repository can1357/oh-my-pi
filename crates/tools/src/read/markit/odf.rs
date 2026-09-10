//! Shared `OpenDocument` package validation and conversion.
//!
//! ODT, ODS, and ODP use the same bounded ZIP/XML parser. Keeping the
//! package identity check and error adaptation here prevents the three
//! format frontends from growing subtly different container rules.

use omp_core::Str;
use quick_xml::events::Event;

use super::{
	MarkitError, convert_with_anydoc,
	ooxml::{Archive, attribute, decode_xml_bytes, local_name, xml_reader},
};

/// Converts one `OpenDocument` package after validating its declared identity.
///
/// `mimetype` is mandatory in conforming ODF packages, but real producers
/// occasionally omit it and identify the package in the manifest instead.
/// The shared anydoc parser accepts that recovery case. When `mimetype` is
/// present, however, a conflicting package kind is rejected rather than
/// interpreting (for example) a spreadsheet through an `.odt` extension.
pub(super) fn convert(
	bytes: &[u8],
	format: anydoc::Format,
	format_name: &'static str,
	expected_mimetype: &'static str,
) -> Result<Str, MarkitError> {
	let mut archive =
		Archive::open(bytes).map_err(|error| MarkitError::conversion(format_name, error))?;
	// Parse the optional manifest once. Encryption has precedence over
	// content validation because encrypted content.xml bytes are not XML.
	// A syntactically corrupt optional manifest proves nothing; archive and
	// entity-expansion limit failures from `read_xml` still propagate.
	let manifest = archive
		.read_xml("META-INF/manifest.xml")
		.map_err(|error| MarkitError::conversion(format_name, error))?
		.and_then(|xml| parse_manifest(&xml).ok())
		.unwrap_or_default();
	if manifest.encrypted {
		return Err(MarkitError::conversion(format_name, "document is encrypted"));
	}
	let declared = if let Some(mimetype) = archive
		.read_xml("mimetype")
		.map_err(|error| MarkitError::conversion(format_name, error))?
	{
		Some(
			decode_xml_bytes(&mimetype)
				.map_err(|error| {
					MarkitError::conversion(
						format_name,
						format!("mimetype is not valid UTF text: {error}"),
					)
				})?
				.trim()
				.to_owned(),
		)
	} else {
		manifest.root_mimetype
	};
	if let Some(declared) = declared {
		validate_mimetype(&declared, expected_mimetype)
			.map_err(|error| MarkitError::conversion(format_name, error))?;
	}
	let content = archive
		.read_xml("content.xml")
		.map_err(|error| MarkitError::conversion(format_name, error))?
		.ok_or_else(|| {
			MarkitError::conversion(format_name, "Invalid OpenDocument package: missing content.xml")
		})?;
	validate_content_body(&content, format)
		.map_err(|error| MarkitError::conversion(format_name, error))?;
	drop(archive);

	convert_with_anydoc(bytes, format, format_name)
}

fn validate_mimetype(declared: &str, expected: &str) -> Result<(), String> {
	if declared == expected
		|| declared
			.strip_suffix("-template")
			.is_some_and(|base| base == expected)
	{
		return Ok(());
	}
	Err(format!("unexpected OpenDocument mimetype '{declared}'"))
}

/// Ensures a package selected as one ODF kind does not silently render a
/// different office body. This matters when both package identity parts are
/// absent or stale because anydoc deliberately shares one ODF parser.
fn validate_content_body(xml: &[u8], format: anydoc::Format) -> Result<(), String> {
	let expected = match format {
		anydoc::Format::Odt => "text",
		anydoc::Format::Ods => "spreadsheet",
		anydoc::Format::Odp => "presentation",
		_ => return Err("unsupported OpenDocument format selector".into()),
	};
	let mut reader = xml_reader(xml);
	let mut in_body = false;
	loop {
		match reader.read_event() {
			Ok(Event::Start(event)) => {
				let qname = event.name();
				let name = local_name(qname.as_ref());
				if in_body {
					if name == expected {
						return Ok(());
					}
					if is_odf_body(name) {
						return Err(format!("unexpected OpenDocument body '{name}'"));
					}
				} else if name == "body" {
					in_body = true;
				}
			},
			Ok(Event::Empty(event)) if in_body => {
				let qname = event.name();
				let name = local_name(qname.as_ref());
				if name == expected {
					return Ok(());
				}
				if is_odf_body(name) {
					return Err(format!("unexpected OpenDocument body '{name}'"));
				}
			},
			Ok(Event::End(event)) if local_name(event.name().as_ref()) == "body" => {
				return Err("content.xml has no recognized OpenDocument body".into());
			},
			Ok(Event::Eof) => return Err("content.xml has no OpenDocument body".into()),
			Ok(_) => {},
			Err(error) => return Err(format!("invalid content.xml: {error}")),
		}
	}
}

fn is_odf_body(name: &str) -> bool {
	name == "text" || name == "spreadsheet" || name == "presentation"
}

/// Identity and encryption facts carried by an ODF package manifest.
#[derive(Default)]
struct ManifestInfo {
	root_mimetype: Option<String>,
	encrypted:     bool,
}

/// Parses package-wide manifest facts without depending on namespace
/// prefixes. It deliberately scans to EOF after finding the root entry
/// because encryption data may occur on a later file entry.
fn parse_manifest(xml: &[u8]) -> Result<ManifestInfo, String> {
	let mut reader = xml_reader(xml);
	let mut info = ManifestInfo::default();
	loop {
		match reader.read_event() {
			Ok(Event::Start(event) | Event::Empty(event)) => {
				let qname = event.name();
				let name = local_name(qname.as_ref());
				if name == "encryption-data" {
					info.encrypted = true;
				} else if name == "file-entry"
					&& attribute(&reader, &event, b"full-path")?.as_deref() == Some("/")
				{
					info.root_mimetype = attribute(&reader, &event, b"media-type")?;
				}
			},
			Ok(Event::Eof) => return Ok(info),
			Ok(_) => {},
			Err(error) => return Err(format!("invalid manifest XML: {error}")),
		}
	}
}
