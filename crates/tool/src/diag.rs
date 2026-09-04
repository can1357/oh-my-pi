//! Structured harness notices attached to a tool call (ADR 0008, 0009).
//!
//! A [`Diag`] is protocol data on the call element: the fold materializes it
//! as a `<diag>` child, the model projection renders every diag as one
//! uniform trailing part, and cards present it beside the result. Tools
//! yield [`crate::Ev::Diag`] instead of appending prose to their output;
//! extension tools emit the same JSON envelope (`{"diag": {…}}`) as an update.

use omp_core::Str;
use serde::{Deserialize, Serialize};

/// Severity of a harness notice.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum Severity {
	/// Context the model may use; no action needed.
	#[default]
	Info,
	/// The result is complete but degraded or surprising; the model should
	/// adapt.
	#[serde(alias = "warning")]
	#[strum(serialize = "warning", to_string = "warn")]
	Warn,
	/// The call faulted; carried by the terminal diag only.
	Error,
}

/// Closed vocabulary of native harness notice kinds.
///
/// Extension tools may emit other kinds; the DOM stores the string. Native
/// tools MUST pick a variant so the model learns one stable vocabulary.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum DiagKind {
	/// Output exceeded the inline bound; the full result lives at `artifact`.
	OutputBounded,
	/// The result is one page of a larger set; `continuation` fetches the next.
	Pagination,
	/// A requested range or offset lies beyond the end of the resource.
	RangeOutOfBounds,
	/// A structural summary elided bodies; `continuation` names the ranges to
	/// re-read.
	SummaryElided,
	/// A fixed result cap was hit; `omitted` counts what was dropped.
	LimitReached,
	/// Work stopped at a deadline with partial results.
	Timeout,
	/// Requested paths did not exist and were skipped.
	MissingPaths,
	/// Inputs were skipped because the tool cannot process them.
	Skipped,
	/// Only a prefix of the input was examined.
	PartialScan,
	/// The authored path did not exist; the tool resolved a different one.
	PathRecovered,
	/// The resource holds unresolved merge conflicts.
	Conflicts,
	/// Where or how the content was obtained.
	Provenance,
	/// A degraded fallback source or renderer produced the content.
	Fallback,
	/// Fetching the resource failed; the result is a substitute.
	FetchFailed,
	/// Cached content was served because a live refresh failed.
	StaleCache,
	/// The tool rewrote the supplied content before applying it.
	ContentNormalized,
	/// Execute bits were added because the content starts with a shebang.
	MadeExecutable,
	/// An edit broke parsing and the harness repaired it automatically.
	SyntaxRepaired,
	/// An edit left the document unparseable.
	SyntaxBroken,
	/// Anchors drifted from the authored text and were remapped.
	AnchorDrift,
	/// Non-blocking advice from a structural tool.
	Advisory,
	/// A file failed to parse in its language.
	ParseIssue,
	/// A recovery snapshot was recorded for an applied change.
	Snapshot,
	/// The upstream provider attached a warning to its response.
	ProviderWarning,
	/// The host applied a sandbox policy to the command.
	Sandbox,
}

/// Unit of elided content reported by [`Diag::omitted`].
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Unit {
	/// Text lines.
	Lines,
	/// Table rows.
	Rows,
	/// Listing entries.
	Entries,
	/// Files.
	Files,
	/// Bytes.
	Bytes,
	/// Characters.
	Chars,
	/// Generic items.
	Items,
}

/// Count of content elided from the inline result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct Omitted {
	/// Number of units not shown.
	pub count: u64,
	/// What was counted.
	pub unit:  Unit,
}

/// One harness notice attached to a tool call.
///
/// `text` is the human/model sentence; the optional fields are the typed
/// facts a consumer acts on without parsing prose. Native tools construct
/// through [`Diag::info`]/[`Diag::warn`] and the builder methods.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Diag {
	/// Notice severity.
	#[serde(default)]
	pub severity:     Severity,
	/// Stable machine-readable kind; native tools use [`DiagKind`].
	#[serde(default = "default_kind")]
	pub kind:         Str,
	/// Human-readable sentence.
	#[serde(default, alias = "message")]
	pub text:         Str,
	/// Selector or argument that fetches the next slice of a bounded result.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub continuation: Option<Str>,
	/// Full-result recovery address (`artifact://…`).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub artifact:     Option<Str>,
	/// Content elided from the inline result.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub omitted:      Option<Omitted>,
}

const _: () = assert!(size_of::<Diag>() <= 136, "Diag must stay compact");

const fn default_kind() -> Str {
	Str::new_static("notice")
}

impl Default for Diag {
	/// An informational `notice` with no text; the lenient decode baseline
	/// for extension-authored diags.
	fn default() -> Self {
		Self {
			severity:     Severity::Info,
			kind:         default_kind(),
			text:         Str::new_static(""),
			continuation: None,
			artifact:     None,
			omitted:      None,
		}
	}
}

impl Diag {
	/// Creates a notice with the given severity.
	#[must_use]
	pub fn new(severity: Severity, kind: DiagKind, text: impl Into<Str>) -> Self {
		Self {
			severity,
			kind: Str::new_static(kind.into()),
			text: text.into(),
			continuation: None,
			artifact: None,
			omitted: None,
		}
	}

	/// Creates an informational notice.
	#[must_use]
	pub fn info(kind: DiagKind, text: impl Into<Str>) -> Self {
		Self::new(Severity::Info, kind, text)
	}

	/// Creates a warning.
	#[must_use]
	pub fn warn(kind: DiagKind, text: impl Into<Str>) -> Self {
		Self::new(Severity::Warn, kind, text)
	}

	/// Attaches the selector or argument that fetches the next slice.
	#[must_use]
	pub fn continuation(mut self, continuation: impl Into<Str>) -> Self {
		self.continuation = Some(continuation.into());
		self
	}

	/// Attaches the full-result recovery address.
	#[must_use]
	pub fn artifact(mut self, artifact: impl Into<Str>) -> Self {
		self.artifact = Some(artifact.into());
		self
	}

	/// Records how much content the inline result elides.
	#[must_use]
	pub const fn omitted(mut self, count: u64, unit: Unit) -> Self {
		self.omitted = Some(Omitted { count, unit });
		self
	}

	/// Parsed native kind, when the diag uses the closed vocabulary.
	#[must_use]
	pub fn native_kind(&self) -> Option<DiagKind> {
		self.kind.as_str().parse().ok()
	}
}

/// Update envelope carrying one diag: `{"diag": {…}}`.
///
/// This is the wire shape native erasure and extension tools both emit, and
/// the shape the session fold recognizes.
#[derive(Debug, Deserialize, Serialize)]
pub struct DiagEnvelope<D = Diag> {
	/// The notice.
	pub diag: D,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn lenient_extension_envelope_decodes_with_defaults() {
		let json = r#"{"diag":{"kind":"annotation","message":"hi"}}"#;
		let envelope: DiagEnvelope = serde_json::from_str(json).expect("decodes");
		assert_eq!(envelope.diag.severity, Severity::Info);
		assert_eq!(envelope.diag.kind.as_str(), "annotation");
		assert_eq!(envelope.diag.text.as_str(), "hi");
		assert_eq!(envelope.diag.native_kind(), None);
	}

	#[test]
	fn native_diag_round_trips_typed_facts() {
		let diag = Diag::info(DiagKind::Pagination, "45 more lines")
			.continuation(":16")
			.omitted(45, Unit::Lines);
		let json = serde_json::to_string(&DiagEnvelope { diag: &diag }).expect("encodes");
		let decoded: DiagEnvelope = serde_json::from_str(&json).expect("decodes");
		assert_eq!(decoded.diag, diag);
		assert_eq!(decoded.diag.native_kind(), Some(DiagKind::Pagination));
		assert!(!json.contains("artifact"));
	}

	#[test]
	fn warning_alias_parses_as_warn() {
		let diag: Diag = serde_json::from_str(r#"{"kind":"x","severity":"warning"}"#).expect("ok");
		assert_eq!(diag.severity, Severity::Warn);
	}
}
