//! Native visualization of canonical bash syntax and actual trace events.
pub(crate) mod analysis;
pub(crate) mod embedded;
pub mod model;
pub(crate) mod printer;
pub(crate) mod raw;
pub(crate) mod runtime;
pub(crate) mod source;
pub(crate) mod words;

use bstr::{BStr, BString};
pub use model::Options;
use runtime::{Runtime, SourceUnit, VizSource};
use serde::Deserialize;

use super::{Inner, Node, history::HistoryEvent, syntax::UnitSyntax};
use crate::bash::{
	ids::{ModeId, Vpid},
	ir,
};

#[cfg(test)]
mod runtime_tests;

/// Invalid persisted syntax, trace JSON, or presentation serialization.
#[derive(Debug)]
pub struct VizError(String);
impl std::fmt::Display for VizError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}
impl std::error::Error for VizError {}
impl From<serde_json::Error> for VizError {
	fn from(error: serde_json::Error) -> Self {
		Self(error.to_string())
	}
}

impl VizSource for Inner {
	fn script(&self) -> &BStr {
		BStr::new(&self.script)
	}

	fn unit_count(&self) -> usize {
		self.units.len()
	}

	fn unit(&self, index: usize) -> Option<SourceUnit<'_>> {
		let unit = self.units.get(index)?;
		Some(SourceUnit {
			index:      index as u32,
			source:     BStr::new(&unit.source),
			at:         unit.at,
			line:       unit.line,
			syntax:     unit.syntax.as_deref(),
			projection: unit.projection,
			nodes:      &unit.nodes,
			callout:    unit.callout,
		})
	}

	fn cache(&self) -> &printer::Cache {
		&self.viz_cache
	}
}

pub(super) fn live(inner: &Inner, options: &Options) -> Result<String, VizError> {
	let runtime = Runtime::reduce(
		inner,
		inner.journal.entries.iter(),
		options,
		inner.status,
		inner.root_vpid,
		inner.t_ns,
		inner.journal.truncated,
	);
	Ok(serde_json::to_string(&printer::render(inner, &runtime, options))?)
}

#[derive(Deserialize)]
struct StoredUnit {
	at:         Option<u32>,
	#[serde(default = "first_line")]
	line:       u32,
	bytes:      Option<u32>,
	source:     Option<BString>,
	#[serde(default)]
	nodes:      Vec<Node>,
	syntax:     Option<UnitSyntax>,
	#[serde(default)]
	projection: u32,
	#[serde(default)]
	features:   u32,
	#[serde(default)]
	aliases:    Vec<(BString, BString)>,
	#[serde(default)]
	callout:    bool,
}
const fn first_line() -> u32 {
	1
}
#[derive(Deserialize)]
struct StoredTrace {
	script:            BString,
	#[serde(default)]
	units:             Vec<StoredUnit>,
	#[serde(default)]
	history:           Vec<HistoryEvent>,
	status:            Option<i32>,
	#[serde(rename = "rootVpid")]
	root_vpid:         Option<Vpid>,
	#[serde(default)]
	t_ns:              u64,
	#[serde(default, rename = "historyTruncated")]
	history_truncated: bool,
}

/// A persisted native trace, decoded once and sharing the same native renderer
/// as live runs.
pub struct StoredVisualization {
	trace: StoredTrace,
	cache: printer::Cache,
}
impl StoredVisualization {
	/// Restore persisted native syntax once for historical presentation.
	///
	/// # Errors
	/// Rejects malformed trace JSON, invalid source bounds, unsupported syntax
	/// archives, and legacy units that cannot be parsed with their retained
	/// context.
	pub fn from_snapshot_json(json: &str) -> Result<Self, VizError> {
		let mut trace: StoredTrace = serde_json::from_str(json)?;
		for unit in &mut trace.units {
			if unit.source.is_none() {
				let at = unit
					.at
					.ok_or_else(|| VizError("trace unit has neither source nor script origin".into()))?
					as usize;
				let available = trace
					.script
					.get(at..)
					.ok_or_else(|| VizError("trace unit lies outside script".into()))?;
				let bytes = if let Some(bytes) = unit.bytes {
					bytes as usize
				} else if unit.syntax.is_none() {
					let (syntax, bytes) =
						UnitSyntax::parse_boundary(available, unit.features, &unit.aliases, unit.line)
							.ok_or_else(|| {
								VizError(
									"legacy trace cannot restore its announced command without its \
									 original parser context"
										.into(),
								)
							})?;
					unit.syntax = Some(syntax);
					bytes
				} else {
					unit
						.nodes
						.iter()
						.map(|node| node.hi as usize)
						.max()
						.unwrap_or(0)
				};
				unit.source = Some(BString::from(
					available
						.get(..bytes)
						.ok_or_else(|| VizError("trace unit lies outside script".into()))?,
				));
			}
			if unit.syntax.is_none() {
				// Older traces did not carry canonical syntax. Restore at precisely
				// the announced boundary, never by parsing the
				// not-yet-compiled remainder.
				let mut input = ir::Unit::empty(
					unit
						.source
						.as_ref()
						.map_or_default(|source| source.as_slice()),
					ModeId::Bash,
					unit.features,
				);
				input.aliases = std::mem::take(&mut unit.aliases);
				input.line = unit.line;
				unit.syntax = UnitSyntax::restore(&input);
				if unit.syntax.is_none() && !unit.nodes.is_empty() {
					return Err(VizError(
						"legacy trace cannot restore its announced command without its original parser \
						 context"
							.into(),
					));
				}
			}
		}
		Ok(Self { trace, cache: printer::Cache::default() })
	}

	/// Serialize semantic rows over the selected real journal prefix.
	///
	/// # Errors
	/// Reports JSON serialization failures.
	pub fn presentation_json(&self, options: &Options) -> Result<String, VizError> {
		let trace = &self.trace;
		let runtime = Runtime::reduce(
			self,
			trace.history.iter(),
			options,
			trace.status,
			trace.root_vpid,
			trace.t_ns,
			trace.history_truncated,
		);
		Ok(serde_json::to_string(&printer::render(self, &runtime, options))?)
	}
}
impl VizSource for StoredVisualization {
	fn script(&self) -> &BStr {
		BStr::new(&self.trace.script)
	}

	fn unit_count(&self) -> usize {
		self.trace.units.len()
	}

	fn unit(&self, index: usize) -> Option<SourceUnit<'_>> {
		let unit = self.trace.units.get(index)?;
		Some(SourceUnit {
			index:      index as u32,
			source:     BStr::new(
				unit
					.source
					.as_ref()
					.map_or_default(|source| source.as_slice()),
			),
			at:         unit.at,
			line:       unit.line,
			syntax:     unit.syntax.as_ref(),
			projection: unit.projection,
			nodes:      &unit.nodes,
			callout:    unit.callout,
		})
	}

	fn cache(&self) -> &printer::Cache {
		&self.cache
	}
}
