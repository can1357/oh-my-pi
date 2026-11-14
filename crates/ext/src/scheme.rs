//! URL schemes an extension manifest claims (ADR 0050 S1).
//!
//! A deployment manifest may claim the URL schemes its extension serves in the
//! optional `[[schemes]]` table array:
//!
//! ```toml
//! [[schemes]]
//! name = "widget"
//! description = "Widget records by id"
//! immutable = true
//! ```
//!
//! Each claim has one canonical spelling (ADR 0050 D1). The declared text is
//! ASCII-lowercased, then matched byte-wise against `^[a-z][a-z0-9+.-]*$`, and
//! must fit [`MAX_SCHEME_BYTES`]. A manifest claims at most [`MAX_SCHEMES`]
//! schemes, unique after normalization. This crate has no dependency on the
//! built-in URL vocabulary, so refusing a built-in wire name such as `https`
//! or `pr` belongs to `omp-py`, which packs `crates/tools/url-vocab.json`.
//!
//! Claims are carried into the extension-host snapshot; ADR 0050 S2 folds live
//! registrations into the envd-owned scheme generation served by
//! `HostUriResolver`.

use std::fmt;

use omp_core::Str;
use serde::{Deserialize, Serialize, Serializer};

/// Longest accepted scheme spelling, in bytes.
///
/// Equals `omp_rpc::protocol::MAX_HOST_URI_SCHEME_BYTES`, the limit of the host
/// URI generation that ADR 0050 S2 publishes claims through.
pub const MAX_SCHEME_BYTES: usize = 64;

/// Most schemes one manifest may claim.
///
/// Equals `omp_rpc::protocol::MAX_HOST_URI_SCHEMES`, the size of one host URI
/// generation.
pub const MAX_SCHEMES: usize = 32;

/// Longest accepted scheme description, in bytes.
///
/// Equals `omp_rpc::protocol::MAX_HOST_URI_DESCRIPTION_BYTES`.
pub const MAX_SCHEME_DESCRIPTION_BYTES: usize = 4 * 1024;

/// A refused URL-scheme claim.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SchemeError {
	/// The declared spelling is empty.
	#[error("a declared URL scheme must not be empty")]
	Empty,
	/// The declared spelling is longer than [`MAX_SCHEME_BYTES`].
	#[error("a declared URL scheme is {bytes} bytes; the limit is {} bytes", MAX_SCHEME_BYTES)]
	TooLong {
		/// Byte length of the declared spelling.
		bytes: usize,
	},
	/// The ASCII-lowercased spelling does not match `^[a-z][a-z0-9+.-]*$`.
	#[error("declared URL scheme {scheme:?} does not match ^[a-z][a-z0-9+.-]*$")]
	Grammar {
		/// The declared spelling, as written.
		scheme: Str,
	},
	/// A claim's description is longer than [`MAX_SCHEME_DESCRIPTION_BYTES`].
	#[error(
		"the description of URL scheme {scheme} is {bytes} bytes; the limit is {} bytes",
		MAX_SCHEME_DESCRIPTION_BYTES
	)]
	DescriptionTooLong {
		/// The claimed scheme.
		scheme: SchemeName,
		/// Byte length of the description.
		bytes:  usize,
	},
	/// Two claims share one spelling after normalization.
	#[error("URL scheme {scheme} is claimed more than once")]
	Duplicate {
		/// The repeated canonical spelling.
		scheme: SchemeName,
	},
	/// The manifest claims more than [`MAX_SCHEMES`] schemes.
	#[error("{count} URL schemes are claimed; the limit is {}", MAX_SCHEMES)]
	TooMany {
		/// Number of claims in the manifest.
		count: usize,
	},
	/// A registration names a scheme the manifest did not claim.
	#[error("URL scheme {scheme} is not claimed by the manifest")]
	Unclaimed {
		/// The canonical spelling that was asked for.
		scheme: SchemeName,
	},
}

/// The canonical spelling of one claimed URL scheme, without `://`.
///
/// ASCII lowercase, matching `^[a-z][a-z0-9+.-]*$`, at most
/// [`MAX_SCHEME_BYTES`] bytes. The only constructor is [`Self::parse`] (and
/// deserialization, which calls it), so a value always holds a valid spelling.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Deserialize)]
#[serde(try_from = "Str")]
pub struct SchemeName(Str);

impl SchemeName {
	/// Normalizes and validates one declared spelling.
	///
	/// The text is ASCII-lowercased first. Every other byte stays as written, so
	/// a non-ASCII letter that Unicode would fold to ASCII (U+212A KELVIN SIGN)
	/// misses the grammar, as does surrounding or trailing whitespace.
	pub fn parse(spelling: &str) -> Result<Self, SchemeError> {
		Self::normalize(Str::new(spelling))
	}

	/// The canonical spelling.
	pub fn as_str(&self) -> &str {
		&self.0
	}

	fn normalize(spelling: Str) -> Result<Self, SchemeError> {
		let bytes = spelling.len();
		if bytes == 0 {
			return Err(SchemeError::Empty);
		}
		if bytes > MAX_SCHEME_BYTES {
			return Err(SchemeError::TooLong { bytes });
		}
		let canonical = if spelling.bytes().any(|byte| byte.is_ascii_uppercase()) {
			Str::from(spelling.to_ascii_lowercase())
		} else {
			spelling.clone()
		};
		if !grammar_matches(canonical.as_bytes()) {
			return Err(SchemeError::Grammar { scheme: spelling });
		}
		Ok(Self(canonical))
	}
}

impl TryFrom<Str> for SchemeName {
	type Error = SchemeError;

	fn try_from(spelling: Str) -> Result<Self, Self::Error> {
		Self::normalize(spelling)
	}
}

impl Serialize for SchemeName {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.serialize_str(&self.0)
	}
}

impl fmt::Display for SchemeName {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

/// Byte-wise `^[a-z][a-z0-9+.-]*$`.
fn grammar_matches(spelling: &[u8]) -> bool {
	let [first, rest @ ..] = spelling else {
		return false;
	};
	first.is_ascii_lowercase()
		&& rest.iter().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
		})
}

/// One URL scheme a manifest claims (ADR 0050 D4).
///
/// Effects (fetch hosts, credentials) are not part of the claim: they ride the
/// manifest's capability declaration.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SchemeDeclaration {
	/// Canonical scheme spelling.
	pub name:        SchemeName,
	/// Short model-facing description.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<Str>,
	/// Whether a resource under this scheme never changes once read.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub immutable:   bool,
	/// Whether the extension accepts writes under this scheme.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub writable:    bool,
}

/// The URL schemes one manifest claims, in manifest order.
///
/// At most [`MAX_SCHEMES`] claims, unique after normalization, each
/// description within [`MAX_SCHEME_DESCRIPTION_BYTES`]. Deserialization
/// refuses a list that breaks any of these rules.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize)]
#[serde(try_from = "Vec<SchemeDeclaration>")]
pub struct SchemeDeclarations(Vec<SchemeDeclaration>);

impl SchemeDeclarations {
	/// Validates a claim list.
	pub fn new(claims: Vec<SchemeDeclaration>) -> Result<Self, SchemeError> {
		if claims.len() > MAX_SCHEMES {
			return Err(SchemeError::TooMany { count: claims.len() });
		}
		for (index, claim) in claims.iter().enumerate() {
			if let Some(description) = &claim.description
				&& description.len() > MAX_SCHEME_DESCRIPTION_BYTES
			{
				return Err(SchemeError::DescriptionTooLong {
					scheme: claim.name.clone(),
					bytes:  description.len(),
				});
			}
			if claims[..index].iter().any(|prior| prior.name == claim.name) {
				return Err(SchemeError::Duplicate { scheme: claim.name.clone() });
			}
		}
		Ok(Self(claims))
	}

	/// Whether the manifest claims no scheme.
	pub const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Number of claimed schemes.
	pub const fn len(&self) -> usize {
		self.0.len()
	}

	/// The claims, in manifest order.
	pub fn iter(&self) -> std::slice::Iter<'_, SchemeDeclaration> {
		self.0.iter()
	}

	/// Returns the claim for `spelling`, normalized first.
	///
	/// Refuses a grammar miss and a name the manifest did not claim.
	pub fn claim(&self, spelling: &str) -> Result<&SchemeDeclaration, SchemeError> {
		let name = SchemeName::parse(spelling)?;
		self
			.0
			.iter()
			.find(|claim| claim.name == name)
			.ok_or(SchemeError::Unclaimed { scheme: name })
	}
}

impl TryFrom<Vec<SchemeDeclaration>> for SchemeDeclarations {
	type Error = SchemeError;

	fn try_from(claims: Vec<SchemeDeclaration>) -> Result<Self, Self::Error> {
		Self::new(claims)
	}
}

impl Serialize for SchemeDeclarations {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		self.0.serialize(serializer)
	}
}

impl<'a> IntoIterator for &'a SchemeDeclarations {
	type IntoIter = std::slice::Iter<'a, SchemeDeclaration>;
	type Item = &'a SchemeDeclaration;

	fn into_iter(self) -> Self::IntoIter {
		self.0.iter()
	}
}

#[cfg(test)]
mod tests {
	use std::fmt::{Display, Write as _};

	use omp_core::Str;

	use super::{
		MAX_SCHEME_BYTES, MAX_SCHEME_DESCRIPTION_BYTES, MAX_SCHEMES, SchemeDeclaration,
		SchemeDeclarations, SchemeError, SchemeName,
	};
	use crate::{ExtensionCode, ExtensionError, config::DeploymentManifest};

	const FIXTURE: &str = r#"
id = "acme.widgets"
entry = "acme_widgets"
capabilities = ["env.net.fetch"]

[[schemes]]
name = "widget"
description = "Widget records by id"
immutable = true

[[schemes]]
name = "widget-draft"
writable = true
"#;

	fn name(spelling: &str) -> SchemeName {
		SchemeName::parse(spelling).expect("valid scheme spelling")
	}

	fn declaration(spelling: &str) -> SchemeDeclaration {
		SchemeDeclaration {
			name:        name(spelling),
			description: None,
			immutable:   false,
			writable:    false,
		}
	}

	fn manifest_with(schemes: &str) -> Result<DeploymentManifest, ExtensionError> {
		DeploymentManifest::parse(&format!(
			"id = \"acme.widgets\"\nentry = \"acme_widgets\"\n{schemes}"
		))
	}

	fn claims<T: Display>(spellings: impl IntoIterator<Item = T>) -> String {
		let mut text = String::new();
		for spelling in spellings {
			writeln!(text, "[[schemes]]\nname = \"{spelling}\"").expect("write to a String");
		}
		text
	}

	#[test]
	fn fixture_manifest_round_trips() {
		let manifest = DeploymentManifest::parse(FIXTURE).expect("fixture parses");
		manifest.validate().expect("fixture validates");
		assert_eq!(manifest.schemes.iter().collect::<Vec<_>>(), [
			&SchemeDeclaration {
				name:        name("widget"),
				description: Some(Str::new_static("Widget records by id")),
				immutable:   true,
				writable:    false,
			},
			&SchemeDeclaration { writable: true, ..declaration("widget-draft") },
		]);
		let toml_text = toml::to_string(&manifest).expect("manifest serializes to TOML");
		assert_eq!(DeploymentManifest::parse(&toml_text).expect("TOML round trip parses"), manifest);
		let json = serde_json::to_string(&manifest).expect("manifest serializes to JSON");
		assert_eq!(
			serde_json::from_str::<DeploymentManifest>(&json).expect("JSON round trip parses"),
			manifest
		);
	}

	#[test]
	fn manifest_without_schemes_serializes_exactly_as_before() {
		let manifest = DeploymentManifest::parse(
			"id = \"acme.plain\"\nentry = \"acme_plain\"\ncapabilities = [\"env.fs.read\"]\n",
		)
		.expect("plain manifest parses");
		assert!(manifest.schemes.is_empty());
		let json = serde_json::to_value(&manifest).expect("manifest serializes to JSON");
		let keys = json
			.as_object()
			.expect("manifest serializes to an object")
			.keys()
			.map(String::as_str)
			.collect::<Vec<_>>();
		assert_eq!(keys, [
			"id",
			"entry",
			"settings",
			"requires",
			"capabilities",
			"features",
			"binaries",
			"declarations",
		]);
		let toml_text = toml::to_string(&manifest).expect("manifest serializes to TOML");
		assert!(!toml_text.contains("schemes"), "{toml_text}");
		assert_eq!(DeploymentManifest::parse(&toml_text).expect("TOML round trip parses"), manifest);
	}

	#[test]
	fn declared_spellings_are_ascii_lowercased() {
		for (spelling, canonical) in [
			("widget", "widget"),
			("Widget", "widget"),
			("WIDGET", "widget"),
			("a", "a"),
			("x1", "x1"),
			("a+b.c-d", "a+b.c-d"),
			("Z9-", "z9-"),
		] {
			assert_eq!(
				SchemeName::parse(spelling).as_ref().map(SchemeName::as_str),
				Ok(canonical),
				"{spelling:?}"
			);
		}
		let manifest = manifest_with(&claims(["WiDgEt"])).expect("mixed case parses");
		assert_eq!(
			manifest
				.schemes
				.iter()
				.map(|claim| claim.name.as_str())
				.collect::<Vec<_>>(),
			["widget"]
		);
	}

	#[test]
	fn grammar_misses_are_refused_with_the_declared_spelling() {
		for spelling in [
			"1widget",
			"-widget",
			"+widget",
			".widget",
			"wid get",
			" widget",
			"widget ",
			"widget\n",
			"\twidget",
			"wid_get",
			"wid/get",
			"wid:get",
			"widget://",
			"wid\0get",
			"\u{212A}elvin",
			"widg\u{e9}t",
			"\u{ff57}idget",
			"wid\u{2010}get",
		] {
			assert_eq!(
				SchemeName::parse(spelling),
				Err(SchemeError::Grammar { scheme: Str::new(spelling) }),
				"{spelling:?}"
			);
		}
		assert_eq!(SchemeName::parse(""), Err(SchemeError::Empty));
		for schemes in [
			"[[schemes]]\nname = \"wid get\"\n",
			"[[schemes]]\nname = \"\\u212Aelvin\"\n",
			"[[schemes]]\nname = \"widget\\n\"\n",
			"[[schemes]]\nname = \"\"\n",
		] {
			let error = manifest_with(schemes).expect_err(schemes);
			assert_eq!(error.code, ExtensionCode::EManifestParse, "{schemes}");
		}
		let error = manifest_with(&claims(["wid_get"])).expect_err("grammar miss refused");
		assert!(error.detail.contains("does not match ^[a-z][a-z0-9+.-]*$"), "{error}");
	}

	#[test]
	fn duplicate_claims_are_refused_after_lowercasing() {
		let error = manifest_with(&claims(["widget", "Widget"])).expect_err("duplicate refused");
		assert_eq!(error.code, ExtensionCode::EManifestParse);
		assert!(
			error
				.detail
				.contains("URL scheme widget is claimed more than once"),
			"{error}"
		);
		assert_eq!(
			SchemeDeclarations::new(vec![declaration("widget"), declaration("WIDGET")]),
			Err(SchemeError::Duplicate { scheme: name("widget") })
		);
	}

	#[test]
	fn thirty_two_claims_fit_and_thirty_three_are_refused() {
		let spellings = |count: usize| (0..count).map(|index| format!("s{index}"));
		let manifest = manifest_with(&claims(spellings(MAX_SCHEMES))).expect("32 claims fit");
		assert_eq!(manifest.schemes.len(), MAX_SCHEMES);
		let error =
			manifest_with(&claims(spellings(MAX_SCHEMES + 1))).expect_err("33 claims refused");
		assert_eq!(error.code, ExtensionCode::EManifestParse);
		assert!(error.detail.contains("33 URL schemes are claimed"), "{error}");
		assert_eq!(
			SchemeDeclarations::new(
				spellings(MAX_SCHEMES + 1)
					.map(|spelling| declaration(&spelling))
					.collect()
			),
			Err(SchemeError::TooMany { count: MAX_SCHEMES + 1 })
		);
	}

	#[test]
	fn scheme_byte_cap_admits_the_limit_and_refuses_one_more() {
		let longest = "a".repeat(MAX_SCHEME_BYTES);
		assert_eq!(name(&longest).as_str(), longest);
		assert_eq!(name(&longest.to_ascii_uppercase()).as_str(), longest);
		let over = "a".repeat(MAX_SCHEME_BYTES + 1);
		assert_eq!(
			SchemeName::parse(&over),
			Err(SchemeError::TooLong { bytes: MAX_SCHEME_BYTES + 1 })
		);
		let multibyte_over = format!("{}\u{e9}", "a".repeat(MAX_SCHEME_BYTES - 1));
		assert_eq!(
			SchemeName::parse(&multibyte_over),
			Err(SchemeError::TooLong { bytes: MAX_SCHEME_BYTES + 1 })
		);
		let manifest = manifest_with(&claims([&longest])).expect("64-byte claim fits");
		assert_eq!(manifest.schemes.len(), 1);
		let error = manifest_with(&claims([&over])).expect_err("65-byte claim refused");
		assert_eq!(error.code, ExtensionCode::EManifestParse);
	}

	#[test]
	fn description_byte_cap_admits_the_limit_and_refuses_one_more() {
		let fits = SchemeDeclaration {
			description: Some(Str::new("d".repeat(MAX_SCHEME_DESCRIPTION_BYTES))),
			..declaration("widget")
		};
		assert!(SchemeDeclarations::new(vec![fits]).is_ok());
		let over = SchemeDeclaration {
			description: Some(Str::new("d".repeat(MAX_SCHEME_DESCRIPTION_BYTES + 1))),
			..declaration("widget")
		};
		assert_eq!(
			SchemeDeclarations::new(vec![over]),
			Err(SchemeError::DescriptionTooLong {
				scheme: name("widget"),
				bytes:  MAX_SCHEME_DESCRIPTION_BYTES + 1,
			})
		);
	}

	#[test]
	fn wrongly_typed_claims_are_refused() {
		for schemes in [
			"schemes = \"widget\"\n",
			"schemes = [\"widget\"]\n",
			"schemes = 7\n",
			"[schemes]\nname = \"widget\"\n",
			"[[schemes]]\nname = 7\n",
			"[[schemes]]\nname = [\"widget\"]\n",
			"[[schemes]]\ndescription = \"no name\"\n",
			"[[schemes]]\nname = \"widget\"\nimmutable = \"yes\"\n",
			"[[schemes]]\nname = \"widget\"\nwritable = 1\n",
			"[[schemes]]\nname = \"widget\"\ndescription = 5\n",
			"[[schemes]]\nname = \"widget\"\naliases = [\"w\"]\n",
		] {
			let error = manifest_with(schemes).expect_err(schemes);
			assert_eq!(error.code, ExtensionCode::EManifestParse, "{schemes}");
		}
	}

	#[test]
	fn claim_refuses_unclaimed_names_and_grammar_misses() {
		let manifest = DeploymentManifest::parse(FIXTURE).expect("fixture parses");
		let claimed = |spelling: &str| {
			manifest
				.schemes
				.claim(spelling)
				.map(|claim| claim.name.as_str())
		};
		assert_eq!(claimed("widget"), Ok("widget"));
		assert_eq!(claimed("WIDGET"), Ok("widget"));
		assert_eq!(claimed("gadget"), Err(SchemeError::Unclaimed { scheme: name("gadget") }));
		assert_eq!(claimed("wid get"), Err(SchemeError::Grammar { scheme: Str::new("wid get") }));
		assert_eq!(
			DeploymentManifest::default().schemes.claim("widget"),
			Err(SchemeError::Unclaimed { scheme: name("widget") })
		);
	}
}
