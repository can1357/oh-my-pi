//! Native visualization of canonical bash syntax and actual trace events.
pub(crate) mod analysis;
pub(crate) mod embedded;
pub mod model;
pub(crate) mod printer;
pub(crate) mod raw;
pub(crate) mod runtime;
pub(crate) mod source;
pub(crate) mod words;

use std::borrow::Cow;

use bstr::{BStr, BString};
pub use model::Options;
use runtime::{Runtime, SourceUnit, VizSource};
use serde::Deserialize;

use super::{
	Inner, Node,
	history::HistoryEvent,
	syntax::{RootKind, SyntaxTree, UnitSyntax},
};
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

	// A row the presentation parsed ahead of the engine names no unit; its
	// index is left as it is.
	fn unit_key(&self, index: usize) -> u32 {
		self.units.get(index).map_or(index as u32, |unit| unit.key)
	}

	fn unit_position(&self, key: u32) -> Option<usize> {
		self.units.binary_search_by_key(&key, |unit| unit.key).ok()
	}
}

pub(super) fn live(inner: &Inner, options: &Options) -> Result<String, VizError> {
	let options = indexed_options(inner, options);
	let runtime = Runtime::reduce(
		inner,
		inner.journal.entries.iter(),
		&options,
		inner.status,
		inner.root_vpid,
		inner.t_ns,
		inner.journal.truncated,
	);
	render_json(inner, &runtime, &options)
}

#[derive(Deserialize)]
struct StoredUnit {
	key:        Option<u32>,
	at:         Option<u32>,
	#[serde(default = "first_line")]
	line:       u32,
	bytes:      Option<u32>,
	source:     Option<BString>,
	#[serde(default)]
	nodes:      Vec<Node>,
	#[serde(default, rename = "syntax")]
	archived:   Option<Archived>,
	#[serde(skip)]
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
/// A unit's syntax archive as saved: this build's, or (a session saved
/// before an upgrade) another build's, of which only the root kind is
/// read; that unit is parsed again from its source.
enum Archived {
	Current(UnitSyntax),
	Other(Option<RootKind>),
}
impl<'de> Deserialize<'de> for Archived {
	fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		let encoded = String::deserialize(d)?;
		Ok(
			match UnitSyntax::deserialize(serde::de::value::StrDeserializer::<D::Error>::new(&encoded))
			{
				Ok(syntax) => Self::Current(syntax),
				Err(_) => Self::Other(UnitSyntax::archived_kind(&encoded)),
			},
		)
	}
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
	/// Rejects malformed trace JSON, invalid source bounds, and legacy units
	/// that cannot be parsed with their retained context.
	pub fn from_snapshot_json(json: &str) -> Result<Self, VizError> {
		let mut trace: StoredTrace = serde_json::from_str(json)?;
		for unit in &mut trace.units {
			let other = match unit.archived.take() {
				Some(Archived::Current(syntax)) => {
					unit.syntax = Some(syntax);
					None
				},
				Some(Archived::Other(kind)) => Some(kind),
				None => None,
			};
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
				let source = unit
					.source
					.as_ref()
					.map_or_default(|source| source.as_slice());
				match other {
					// Older traces did not carry canonical syntax, and another
					// build's command list parses again the same: restore at
					// precisely the announced boundary, never by parsing the
					// not-yet-compiled remainder.
					None | Some(Some(RootKind::List)) => {
						let mut input = ir::Unit::empty(source, ModeId::Bash, unit.features);
						input.aliases = std::mem::take(&mut unit.aliases);
						input.line = unit.line;
						unit.syntax = UnitSyntax::restore(&input);
						if unit.syntax.is_none() && !unit.nodes.is_empty() && other.is_none() {
							return Err(VizError(
								"legacy trace cannot restore its announced command without its original \
								 parser context"
									.into(),
							));
						}
					},
					// Another build's run-time parsed text: a here-document
					// body, as this build parses one (an arithmetic operand,
					// the other kind, rarely is a unit of its own).
					Some(Some(RootKind::Word)) => {
						unit.syntax = crate::bash::syntax::parse_text(
							source,
							crate::bash::syntax::Features::NONE,
							crate::bash::syntax::TextMode::HereDoc,
						)
						.ok()
						.map(|(tree, root)| {
							UnitSyntax::new(0, SyntaxTree::from_word(tree, root))
								.with_context(ModeId::Bash, unit.features)
						});
					},
					// A function body compiled on use, or no readable header:
					// drawn without syntax rather than failing the trace.
					Some(_) => {},
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
		let options = indexed_options(self, options);
		let trace = &self.trace;
		let runtime = Runtime::reduce(
			self,
			trace.history.iter(),
			&options,
			trace.status,
			trace.root_vpid,
			trace.t_ns,
			trace.history_truncated,
		);
		render_json(self, &runtime, &options)
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

	fn unit_key(&self, index: usize) -> u32 {
		self
			.trace
			.units
			.get(index)
			.and_then(|unit| unit.key)
			.unwrap_or(index as u32)
	}

	// A stored table is read once per presentation of a persisted trace, not
	// on a poll, and it is bounded by the same caps as the live one.
	fn unit_position(&self, key: u32) -> Option<usize> {
		self
			.trace
			.units
			.iter()
			.enumerate()
			.position(|(index, unit)| unit.key.unwrap_or(index as u32) == key)
	}
}

// Journal indices are snapshot-local. Inspector controls cross that boundary
// with stable keys, so a removed source cannot redirect an existing selection.
// A row the presentation parsed ahead of the engine names no compiled unit
// (`printer::AHEAD`): it has no key to translate and keeps its identity.
fn indexed_options<'a>(source: &impl VizSource, options: &'a Options) -> Cow<'a, Options> {
	if options.selected_node.is_none() && options.expanded_nodes.is_empty() {
		return Cow::Borrowed(options);
	}
	let index = |node: &mut model::NodeKey| {
		if node.unit == printer::AHEAD {
			return true;
		}
		match source.unit_position(node.unit) {
			Some(index) => {
				node.unit = index as u32;
				true
			},
			None => false,
		}
	};
	let mut indexed = options.clone();
	indexed.selected_node = indexed
		.selected_node
		.and_then(|mut node| index(&mut node).then_some(node));
	indexed.expanded_nodes.retain_mut(index);
	Cow::Owned(indexed)
}

fn render_json(
	source: &impl VizSource,
	runtime: &Runtime<'_>,
	options: &Options,
) -> Result<String, VizError> {
	let mut presentation = printer::render(source, runtime, options);
	let map = |key: &mut Option<model::NodeKey>| {
		if let Some(key) = key {
			key.unit = source.unit_key(key.unit as usize);
		}
	};
	map(&mut presentation.preferences.selected_node);
	for key in &mut presentation.preferences.expanded_nodes {
		key.unit = source.unit_key(key.unit as usize);
	}
	for row in presentation
		.rows
		.iter_mut()
		.chain(&mut presentation.original)
	{
		map(&mut row.node);
		for segment in &mut row.segments {
			map(&mut segment.node);
			map(&mut segment.execution_node);
		}
		if let Some(watches) = &mut row.annotations {
			for watch in watches {
				map(&mut watch.node);
			}
		}
	}
	for watch in &mut presentation.watches {
		map(&mut watch.node);
	}
	Ok(serde_json::to_string(&presentation)?)
}
