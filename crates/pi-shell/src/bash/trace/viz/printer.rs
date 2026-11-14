//! Raw and Pseudo share canonical syntax, source identities and runtime
//! observations.
#[cfg(test)]
#[path = "semantic_tests.rs"]
mod semantic_tests;
use std::{
	collections::{HashMap, HashSet, hash_map::Entry},
	fmt::{NumBuffer, Write},
	sync::Arc,
};

use parking_lot::Mutex;

use super::{
	analysis::{self, Analysis, command_name, literal, literal_tail},
	embedded,
	model::*,
	raw,
	runtime::{Runtime, VizSource},
	source::{self, SourceMap},
	words::WordPrinter,
};
use crate::bash::{
	event::ResolvedKind,
	syntax::{
		AndOrOp, CaseTerm, Features, NO_ALIASES, NodeId, ParseErrorKind, Parser, Pos, RedirOp, Sep,
		Span,
		tree::{
			AndOr, Command, CommandKind, For, HereDoc, List, Part, Pipeline, RedirFd, RedirTarget,
			Seq, Simple, Tree, Word, WordPart,
		},
	},
	trace::{
		State,
		syntax::{Root, SyntaxTree},
	},
};

pub(super) fn raw_static(
	source: &impl VizSource,
	analysis: &Analysis,
	color: bool,
) -> Arc<raw::Static> {
	let identity = analysis as *const _ as usize;
	let slot = usize::from(color);
	if let Some((cached, prepared)) = &source.cache().inner.lock().raw[slot]
		&& *cached == identity
	{
		return Arc::clone(prepared);
	}
	let prepared = Arc::new(raw::prepare(source, analysis, color));
	source.cache().inner.lock().raw[slot] = Some((identity, Arc::clone(&prepared)));
	prepared
}
pub(super) fn script_utf16(source: &impl VizSource) -> Arc<[u32]> {
	let mut cache = source.cache().inner.lock();
	Arc::clone(
		cache
			.script_utf16
			.get_or_insert_with(|| source::utf16_map(source.script().as_ref()).into()),
	)
}
pub(super) fn source_map(
	source: &impl VizSource,
	unit: &super::runtime::SourceUnit<'_>,
) -> SourceMap {
	if let Some(map) = source.cache().inner.lock().maps.get(&unit.index) {
		return map.clone();
	}
	let map = source::unit_map(source, unit);
	source
		.cache()
		.inner
		.lock()
		.maps
		.insert(unit.index, map.clone());
	map
}

#[derive(Debug, Default)]
pub struct Cache {
	inner: Mutex<Cached>,
}
#[derive(Debug, Default)]
struct Cached {
	analysis:     Option<(Vec<UnitStamp>, Arc<Analysis>)>,
	maps:         HashMap<u32, SourceMap>,
	nested:       HashMap<NodeKey, Option<Arc<Nested>>>,
	raw:          [Option<(usize, Arc<raw::Static>)>; 2],
	docs:         HashMap<NodeKey, Arc<Vec<Option<Span>>>>,
	script_utf16: Option<Arc<[u32]>>,
	/// Parses of uncompiled script byte ranges; the script never changes.
	ahead:        HashMap<(usize, usize, bool), Option<Arc<Ahead>>>,
}
#[derive(Clone, Debug)]
struct UnitStamp {
	tree:       Option<SyntaxTree>,
	offset:     u32,
	parent:     Option<crate::bash::trace::syntax::SourceParent>,
	projection: u32,
	at:         Option<u32>,
	len:        usize,
}
impl UnitStamp {
	fn of(unit: Option<super::runtime::SourceUnit<'_>>) -> Self {
		unit.map_or(
			Self {
				tree:       None,
				offset:     0,
				parent:     None,
				projection: 0,
				at:         None,
				len:        0,
			},
			|unit| Self {
				tree:       unit.syntax.map(|syntax| syntax.tree.clone()),
				offset:     unit.syntax.map_or(0, |s| s.offset),
				parent:     unit.syntax.and_then(|s| s.parent),
				projection: unit.projection,
				at:         unit.at,
				len:        unit.source.len(),
			},
		)
	}

	fn matches(&self, unit: Option<super::runtime::SourceUnit<'_>>) -> bool {
		let Some(unit) = unit else {
			return self.tree.is_none() && self.len == 0;
		};
		self.projection == unit.projection
			&& self.at == unit.at
			&& self.len == unit.source.len()
			&& self.offset == unit.syntax.map_or(0, |s| s.offset)
			&& self.parent == unit.syntax.and_then(|s| s.parent)
			&& same_tree(self.tree.as_ref(), unit.syntax.map(|s| &s.tree))
	}
}
impl PartialEq for UnitStamp {
	fn eq(&self, other: &Self) -> bool {
		self.offset == other.offset
			&& self.parent == other.parent
			&& self.projection == other.projection
			&& self.at == other.at
			&& self.len == other.len
			&& same_tree(self.tree.as_ref(), other.tree.as_ref())
	}
}
impl Eq for UnitStamp {}
fn same_tree(a: Option<&SyntaxTree>, b: Option<&SyntaxTree>) -> bool {
	match (a, b) {
		(None, None) => true,
		(Some(a), Some(b)) => a.kind == b.kind && a.root == b.root && Arc::ptr_eq(&a.tree, &b.tree),
		_ => false,
	}
}
#[derive(Debug)]
struct Nested {
	body:     String,
	commands: Vec<(Tree, u32)>,
	ids:      Vec<u32>,
	remote:   bool,
	origin:   ByteOrigins,
	map:      SourceMap,
	analysis: Analysis,
}
/// Unit of script parsed ahead of the engine; no compiled unit has it.
const AHEAD: u32 = u32::MAX;
/// Script bytes the engine has not compiled yet, parsed statically.
#[derive(Debug)]
struct Ahead {
	commands: Vec<(Tree, u32)>,
	spans:    Vec<Span>,
	/// Source identity per command: one past its script byte offset.
	ids:      Vec<u32>,
	map:      SourceMap,
	analysis: Analysis,
	/// The text parsed when it is not the script's own: a streamed tail
	/// repaired by [`repair_tail`] or cut back by [`parsed_head`].
	repaired: Option<Box<[u8]>>,
	/// Bytes of the range `repaired` keeps as they are; what follows them
	/// in it was appended, past the script.
	kept:     usize,
	/// Bytes at the end of the range drawn nowhere: an unfinished end, a
	/// dangling operator or redirection, or the start of an awaited keyword.
	/// Bytes between `kept` and them stay literal.
	hidden:   usize,
}
#[derive(Clone, Debug)]
struct ByteOrigins {
	base: u32,
	map:  Option<Arc<[u32]>>,
}
impl ByteOrigins {
	fn at(&self, byte: u32) -> Option<u32> {
		self
			.map
			.as_ref()
			.map_or(Some(byte), |map| map.get(byte as usize).copied())
	}
}

/// Immutable typed facts shared by replay reduction and both display modes.
pub(crate) fn analyzed(source: &impl VizSource) -> Arc<Analysis> {
	let mut cache = source.cache().inner.lock();
	let changed = cache.analysis.as_ref().is_none_or(|(stamps, _)| {
		stamps.len() != source.unit_count()
			|| stamps
				.iter()
				.enumerate()
				.any(|(index, stamp)| !stamp.matches(source.unit(index)))
	});
	if changed {
		let stamps = (0..source.unit_count())
			.map(|index| UnitStamp::of(source.unit(index)))
			.collect::<Vec<_>>();
		let replaced = cache.analysis.as_ref().map_or_default(|(old, _)| {
			old.iter()
				.zip(&stamps)
				.enumerate()
				.filter_map(|(index, (a, b))| (a != b).then_some(index as u32))
				.collect::<Vec<_>>()
		});
		if !replaced.is_empty() {
			cache.maps.clear();
			cache.script_utf16 = None;
		}
		for unit in replaced {
			cache.nested.retain(|key, _| key.unit != unit);
			cache.docs.retain(|key, _| key.unit != unit);
		}
		cache.raw = [None, None];
		let mut next = analysis::analyze(source);
		if let Some((_, previous)) = &cache.analysis {
			next.arithmetic = Arc::clone(&previous.arithmetic);
		}
		cache.analysis = Some((stamps, Arc::new(next)));
	}
	Arc::clone(&cache.analysis.as_ref().unwrap().1)
}
/// Render announced syntax with its outcomes. Script the engine has not
/// compiled yet is parsed ahead and drawn without outcomes; what does not
/// parse stays literal.
pub fn render(source: &impl VizSource, runtime: &Runtime<'_>, options: &Options) -> Presentation {
	let analysis = analyzed(source);
	let original = if options.view == View::Pseudo && options.split {
		raw::render(source, runtime, options, &analysis)
	} else {
		Vec::new()
	};
	let mut rows = if options.view == View::Raw {
		raw::render(source, runtime, options, &analysis)
	} else {
		let mut p = Printer {
			source,
			runtime,
			options,
			analysis: &analysis,
			rows: Vec::new(),
			serial: 0,
			children: HashSet::new(),
		};
		p.root_units();
		// Dynamic units with no proven outer origin remain explicitly
		// unlocated; a callout's script is drawn by its calling command.
		for index in 0..source.unit_count() {
			let Some(unit) = source.unit(index) else {
				continue;
			};
			if unit.at.is_some()
				|| unit.callout
				|| p.children.contains(&unit.index)
				|| unit.syntax.and_then(|s| s.parent.as_ref()).is_some()
			{
				continue;
			}
			if let Some(syntax) = unit.syntax {
				let context = Context {
					unit:     unit.index,
					source:   0,
					bytes:    unit.source.as_ref(),
					map:      source_map(source, &unit),
					untraced: None,
					runner:   None,
					origin:   None,
					analysis: &analysis,
				};
				p.frame(unit.index, 0, "built at runtime · not in the command text", None, None);
				p.tree(&syntax.tree, &context, 1);
			}
		}
		p.rows
	};
	if options.view == View::Pseudo {
		rows = physical_rows(rows);
	}
	let mut watches = runtime.watches().to_vec();
	// Promote canonical assignment/word setters directly through native
	// ancestry.
	for watch in &mut watches {
		if let Some(key) = watch.node {
			if watch.range.is_none()
				&& let Some(span) = analysis.spans.get(&key)
				&& let Some(unit) = source.unit(key.unit as usize)
			{
				watch.range = source_map(source, &unit).range(*span);
			}
			watch.node = Some(analysis.owners.get(&key).copied().unwrap_or(key));
		}
	}
	attach_annotations(&mut rows, &watches, source, &analysis);
	Presentation {
		preferences: options.clone(),
		rows,
		original,
		output: runtime.output.clone(),
		running: runtime.running,
		executing: runtime.executing,
		watches,
		timeline: runtime.timeline.clone(),
		message: runtime.message.clone(),
	}
}

/// Literal arguments can retain shell newlines with Unwrap off; transport rows
/// remain physical lines without copying statement metadata onto continuations.
fn physical_rows(rows: Vec<Row>) -> Vec<Row> {
	let mut result = Vec::with_capacity(rows.len());
	for mut row in rows {
		if row
			.segments
			.iter()
			.all(|segment| !segment.text.contains('\n'))
		{
			result.push(row);
			continue;
		}
		let segments = std::mem::take(&mut row.segments);
		let mut continuation = row.clone();
		// The head row keeps the statement's full source; copying it onto every
		// continuation would cost lines × command bytes.
		continuation.detail = None;
		continuation.meta = None;
		continuation.executed_at_ns = None;
		continuation.execution_seq = None;
		continuation.effects.clear();
		continuation.role = Some("document");
		let mut line = 0u32;
		for mut segment in segments {
			let text = std::mem::take(&mut segment.text);
			let direct = segment
				.range
				.filter(|range| range[1] - range[0] == text.encode_utf16().count() as u32);
			let mut offset = 0u32;
			for (index, part) in text.split('\n').enumerate() {
				if index > 0 {
					result.push(row);
					line += 1;
					row = continuation.clone();
					row.id = format!("{}-line{line}", continuation.id);
					offset += 1;
				}
				let mut fragment = segment.clone();
				part.clone_into(&mut fragment.text);
				if index > 0 {
					fragment.tip = None;
					fragment.expanded = None;
				}
				if let Some(range) = direct {
					fragment.range =
						Some([range[0] + offset, range[0] + offset + part.encode_utf16().count() as u32]);
				}
				row.segments.push(fragment);
				offset += part.encode_utf16().count() as u32;
			}
		}
		result.push(row);
	}
	result
}

fn attach_annotations(
	rows: &mut Vec<Row>,
	watches: &[Watch],
	source: &impl VizSource,
	analysis: &Analysis,
) {
	let mut unlocated = Vec::new();
	for watch in watches {
		let Some(key) = watch.node else {
			unlocated.push(watch.clone());
			continue;
		};
		let direct = rows
			.iter()
			.position(|r| r.node == Some(key) && r.role != Some("tail"));
		let inline = rows.iter().position(|r| {
			r.role != Some("tail")
				&& r.segments.iter().any(|s| {
					s.node
						.is_some_and(|node| analysis.owners.get(&node).copied().unwrap_or(node) == key)
				})
		});
		let target = direct.or(inline);
		if let Some(index) = target {
			let row = &mut rows[index];
			row.annotations
				.get_or_insert_with(Vec::new)
				.push(watch.clone());
			if watch.scope.as_deref() == Some("local")
				&& watch
					.scope_id
					.as_deref()
					.is_none_or(|s| s.contains("unknown"))
			{
				row.detail
					.get_or_insert_with(String::new)
					.push_str("\nLocal binding identity unavailable; no function frame inferred.");
			}
		} else if let Some(unit) = source.unit(key.unit as usize) {
			let span = analysis.spans.get(&key).copied();
			let detail = span.map(|s| {
				String::from_utf8_lossy(source_map(source, &unit).raw(unit.source.as_ref(), s))
					.into_owned()
			});
			let at = watch
				.range
				.and_then(|r| {
					rows
						.iter()
						.position(|row| row.range.is_some_and(|other| other[0] > r[0]))
				})
				.unwrap_or(rows.len());
			rows.insert(at, Row {
				id: format!("setter-{key}"),
				node: Some(key),
				range: watch.range,
				role: Some("stmt"),
				segments: vec![Segment {
					text: format!("{} = {}", watch.name, watch.value),
					node: Some(key),
					range: watch.range,
					style: Some("chip".into()),
					..Segment::default()
				}],
				annotations: Some(vec![watch.clone()]),
				detail,
				..Row::default()
			});
		} else {
			unlocated.push(watch.clone());
		}
	}
	if !unlocated.is_empty() {
		rows.push(Row {
			id: "variable-setters-unlocated".into(),
			role: Some("document"),
			segments: vec![Segment {
				text: "Observed setters · source location unavailable".into(),
				style: Some("frame".into()),
				..Segment::default()
			}],
			detail: Some(
				"These values came from actual runtime assignments; no source location or binding \
				 frame is inferred."
					.into(),
			),
			annotations: Some(unlocated),
			..Row::default()
		});
	}
}

struct Context<'a> {
	unit:     u32,
	source:   u32,
	bytes:    &'a [u8],
	map:      SourceMap,
	untraced: Option<&'static str>,
	/// The traced command running this untraced script: its rows run while
	/// that command does.
	runner:   Option<NodeKey>,
	origin:   Option<ByteOrigins>,
	analysis: &'a Analysis,
}
impl Context<'_> {
	const fn key(&self, id: NodeId) -> NodeKey {
		NodeKey::nested(self.unit, self.source, id)
	}

	/// The traced command whose run rows of `id` follow: the command `id`
	/// belongs to, or in an untraced script, [`Self::runner`].
	fn runner_of(&self, id: NodeId) -> Option<NodeKey> {
		if self.untraced.is_some() {
			return self.runner;
		}
		let key = self.key(id);
		Some(self.analysis.owners.get(&key).copied().unwrap_or(key))
	}

	fn text(&self, span: Span) -> String {
		String::from_utf8_lossy(self.map.raw(self.bytes, span)).into_owned()
	}
}
struct Printer<'a, S> {
	source:   &'a S,
	runtime:  &'a Runtime<'a>,
	options:  &'a Options,
	analysis: &'a Analysis,
	rows:     Vec<Row>,
	serial:   u64,
	children: HashSet<u32>,
}
impl<S: VizSource> Printer<'_, S> {
	fn root_units(&mut self) {
		let source = self.source;
		let analysis = self.analysis;
		let roots = &analysis.roots;
		let mut position = 0usize;
		let mut cursor = 0usize;
		while position < roots.len() {
			let Some(unit) = source.unit(roots[position] as usize) else {
				position += 1;
				continue;
			};
			let Some(at) = unit.at else {
				position += 1;
				continue;
			};
			let start = at as usize;
			// The minimizer runs each `&&` operand as its own unit; a gap that
			// holds only the operator continues the chain into the next unit.
			let mut lead = None;
			if start > cursor {
				let end = start.min(source.script().len());
				let gap = &source.script()[cursor..end];
				match leading_operator(gap) {
					Some((Some(op), len)) if len == gap.len() => lead = Some(op),
					_ => self.ahead(cursor, end),
				}
			}
			if self.options.layers.idioms
				&& let Some(end) = self.setup_units(roots, position)
			{
				cursor = cursor.max(end);
				position += 3;
				continue;
			}
			if let Some(syntax) = unit.syntax {
				let context = Context {
					unit:     unit.index,
					source:   0,
					bytes:    unit.source.as_ref(),
					map:      source_map(source, &unit),
					untraced: None,
					runner:   None,
					origin:   None,
					analysis: self.analysis,
				};
				if let Root::List(list) = syntax.tree.view() {
					self.chain_list(list, &context, 0, lead);
				} else {
					self.tree(&syntax.tree, &context, 0);
				}
			} else {
				let end = (start + unit.source.len()).min(source.script().len());
				self.pending(&source.script()[start.min(end)..end], at, 0);
			}
			cursor = cursor.max(start.saturating_add(unit.source.len()));
			position += 1;
		}
		self.ahead(cursor, source.script().len());
	}

	/// Draws script bytes `lo..hi` the engine has not compiled (still
	/// streaming in, or not reached yet) from a static parse with default
	/// features, so Pseudo shows a command before it runs. Nothing there
	/// has an outcome until the engine announces it; the first command that
	/// does not parse and everything after it stay literal, as does a unit
	/// the engine announced without syntax (its parse may have used aliases
	/// or features this one lacks) and everything after that. A leading
	/// `&&`/`||` continues the chain of the unit before it; a leading `;` is
	/// the separator of the unit before and draws no row of its own.
	fn ahead(&mut self, lo: usize, hi: usize) {
		if lo >= hi {
			return;
		}
		let source = self.source;
		let script: &[u8] = source.script().as_ref();
		let (mut lead, from) = match leading_operator(&script[lo..hi]) {
			// A `;` with nothing after it separates nothing to draw.
			Some((None, len)) if lo + len >= hi => return,
			Some((op, len)) => (op, lo + len),
			None => (None, lo),
		};
		let stop = (0..source.unit_count())
			.filter_map(|index| source.unit(index)?.at)
			.map(|at| at as usize)
			.filter(|at| (from..hi).contains(at))
			.min()
			.unwrap_or(hi);
		let Some(ahead) = self.parsed_ahead(from, stop) else {
			self.pending(&script[lo..hi], lo as u32, 0);
			return;
		};
		let lo = from;
		let bytes = match &ahead.repaired {
			Some(repaired) => repaired,
			None => &script[lo..stop],
		};
		let first_row = self.rows.len();
		let mut cursor = 0;
		for (((tree, root), span), id) in ahead.commands.iter().zip(&ahead.spans).zip(&ahead.ids) {
			let start = span.lo as usize;
			if start > cursor {
				self.pending(&bytes[cursor..start], (lo + cursor) as u32, 0);
			}
			let context = Context {
				unit: AHEAD,
				source: *id,
				bytes,
				map: ahead.map.clone(),
				untraced: None,
				runner: None,
				origin: None,
				analysis: &ahead.analysis,
			};
			self.chain_list(List::at(tree, *root), &context, 0, lead.take());
			cursor = span.hi as usize;
		}
		if ahead.repaired.is_some() {
			// A row drawn only from appended bytes, as the `:` an empty body
			// is closed with, has no source of its own: it is not drawn.
			let mut index = 0;
			self.rows.retain(|row| {
				index += 1;
				index <= first_row || row.range.is_none_or(|[lo, hi]| lo != hi)
			});
		}
		// Bytes past `kept` are not the script's; only a repair at the
		// script's end hides bytes, so `stop == hi`.
		let shown = hi - ahead.hidden;
		let cursor = (lo + cursor.min(ahead.kept)).min(shown);
		self.pending(&script[cursor..shown], cursor as u32, 0);
	}

	fn parsed_ahead(&self, lo: usize, hi: usize) -> Option<Arc<Ahead>> {
		// Only a command its caller says is still streaming in can end
		// mid-construct, and only as a live draft: a stored snapshot is final,
		// and once a run starts the script is whole, so an error past what it
		// has compiled is its own and stays literal.
		let streaming =
			self.options.streaming && self.source.streaming() && self.runtime.timeline.length == 0;
		if let Some(cached) = self
			.source
			.cache()
			.inner
			.lock()
			.ahead
			.get(&(lo, hi, streaming))
		{
			return cached.clone();
		}
		let script: &[u8] = self.source.script().as_ref();
		// Streaming cuts off only the script's end; anywhere else the text
		// is the script's own.
		let streamed = streaming && hi == script.len();
		let end = if streamed {
			hi - unfinished_end(&script[lo..hi])
		} else {
			hi
		};
		let text = &script[lo..end];
		let Parsed { mut commands, mut spans, rest, error } = parse_commands(text, Pos::START);
		let mut repaired = None;
		let mut kept = text.len();
		let mut hidden = hi - end;
		if let Some(error) = error
			&& streamed
		{
			let budget = Budget::new();
			let repair = match repair_tail(text, rest, &error, true, &budget) {
				Some(repair) => {
					hidden += text.len() - repair.kept;
					Some(repair)
				},
				// What follows the head stays literal.
				None => parsed_head(text, rest, true, &budget),
			};
			if let Some(repair) = repair {
				commands.extend(repair.commands);
				spans.extend(repair.spans);
				kept = repair.kept;
				repaired = Some(repair.text);
			}
		}
		let parsed = (!commands.is_empty()).then(|| {
			let ids: Vec<u32> = spans.iter().map(|span| lo as u32 + span.lo + 1).collect();
			let mut analysis = analysis::program(&commands, AHEAD, &ids);
			analysis.arithmetic = Arc::clone(&self.analysis.arithmetic);
			let appended = repaired.as_deref().map_or(kept, <[u8]>::len) - kept;
			Arc::new(Ahead {
				map: source::script_map(self.source, lo, kept, appended),
				commands,
				spans,
				ids,
				analysis,
				repaired,
				kept,
				hidden,
			})
		});
		self
			.source
			.cache()
			.inner
			.lock()
			.ahead
			.insert((lo, hi, streaming), parsed.clone());
		parsed
	}

	fn setup_units(&mut self, roots: &[u32], position: usize) -> Option<usize> {
		let source = self.source;
		let first = source.unit(*roots.get(position)? as usize)?;
		let middle = source.unit(*roots.get(position + 1)? as usize)?;
		let last = source.unit(*roots.get(position + 2)? as usize)?;
		let a = root_command(&first)?;
		let b = root_command(&middle)?;
		let d = root_command(&last)?;
		if !is_simple(a, "set", Some("-a"))
			|| !(is_simple(b, ".", None) || is_simple(b, "source", None))
			|| !is_simple(d, "set", Some("+a"))
		{
			return None;
		}
		if !self.builtin(NodeKey::engine(first.index, a.id()))
			|| !self.builtin(NodeKey::engine(middle.index, b.id()))
			|| !self.builtin(NodeKey::engine(last.index, d.id()))
		{
			return None;
		}
		if [(first.index, a.id()), (middle.index, b.id()), (last.index, d.id())]
			.iter()
			.any(|(unit, node)| {
				self
					.options
					.expanded_nodes
					.contains(&NodeKey::engine(*unit, *node))
			}) {
			return None;
		}
		let start = first.at? as usize;
		let mid = middle.at? as usize;
		let stop = last.at? as usize;
		let first_end = start.checked_add(first.source.len())?;
		let middle_end = mid.checked_add(middle.source.len())?;
		let end = stop.checked_add(last.source.len())?;
		let separator = |range: std::ops::Range<usize>| {
			source.script().get(range).is_some_and(|bytes| {
				bytes
					.iter()
					.all(|byte| byte.is_ascii_whitespace() || *byte == b';')
			})
		};
		if first_end > mid
			|| middle_end > stop
			|| !separator(first_end..mid)
			|| !separator(middle_end..stop)
		{
			return None;
		}
		let ca = Context {
			unit:     first.index,
			source:   0,
			bytes:    first.source.as_ref(),
			map:      source_map(source, &first),
			untraced: None,
			runner:   None,
			origin:   None,
			analysis: self.analysis,
		};
		let cb = Context {
			unit:     middle.index,
			source:   0,
			bytes:    middle.source.as_ref(),
			map:      source_map(source, &middle),
			untraced: None,
			runner:   None,
			origin:   None,
			analysis: self.analysis,
		};
		let cd = Context {
			unit:     last.index,
			source:   0,
			bytes:    last.source.as_ref(),
			map:      source_map(source, &last),
			untraced: None,
			runner:   None,
			origin:   None,
			analysis: self.analysis,
		};
		let CommandKind::Simple(simple) = b.kind() else {
			return None;
		};
		let mut segments = vec![self.segment(&cb, b.id(), b.span(), "load_env(", "fn", true)];
		for (index, word) in simple.words().iter().skip(1).enumerate() {
			if index > 0 {
				segments.push(self.segment(&cb, b.id(), b.span(), ", ", "op", true));
			}
			segments.extend(self.word_segments(word, &cb, "str"));
		}
		segments.push(self.segment(&cb, b.id(), b.span(), ") ", "op", true));
		let first_key = ca.key(a.id());
		let last_key = cd.key(d.id());
		let use_first = self.runtime.active(first_key)
			|| !self.runtime.active(last_key)
				&& self
					.runtime
					.observation(first_key)
					.is_some_and(|observation| observation.status.is_some_and(|status| status != 0));
		let mut badge = if use_first {
			self.segment(&ca, a.id(), a.span(), "exports all", "badge", true)
		} else {
			self.segment(&cd, d.id(), d.span(), "exports all", "badge", true)
		};
		badge.expanded = source
			.script()
			.get(start..end)
			.map(|bytes| String::from_utf8_lossy(bytes).into_owned());
		segments.push(badge);
		self.emit(&cb, b, 0, "stmt", segments, None);
		self.command_documents(b, Some(simple), &cb, 0);
		Some(end)
	}

	const fn words<'a>(&'a self, c: &'a Context<'_>) -> WordPrinter<'a> {
		WordPrinter {
			layers:   &self.options.layers,
			analysis: c.analysis,
			unit:     c.unit,
			source:   c.source,
		}
	}

	fn segment(
		&self,
		c: &Context<'_>,
		id: NodeId,
		span: Span,
		text: impl Into<String>,
		style: &str,
		leaf: bool,
	) -> Segment {
		let key = c.key(id);
		let mut s = Segment {
			text: text.into(),
			node: Some(key),
			range: c.map.range(span),
			style: style_for(style, self.options.layers.color),
			..Segment::default()
		};
		let execution = c.analysis.owners.get(&key).copied().unwrap_or(key);
		if c.untraced.is_none()
			&& leaf
			&& c.analysis.leaves.contains(&execution)
			&& let Some(o) = self.runtime.observation(execution)
		{
			let safe = self.safe_false(execution);
			s.execution_node = Some(execution);
			s.active = Some(self.runtime.active(execution));
			s.state = Some(if safe { State::Ok } else { o.state });
			s.executed_at_ns = o.executed_at_ns;
			s.execution_seq = o.execution_seq;
		}
		s
	}

	fn builtin(&self, key: NodeKey) -> bool {
		!matches!(
			self.runtime.observation(key).and_then(|o| o.resolved),
			Some(ResolvedKind::External | ResolvedKind::Function | ResolvedKind::NotFound)
		)
	}

	fn safe_false(&self, key: NodeKey) -> bool {
		self.analysis.guards.contains(&key)
			&& self.runtime.observation(key).is_some_and(|o| {
				o.status == Some(1) && matches!(o.resolved, None | Some(ResolvedKind::Intrinsic))
			})
	}

	fn emit(
		&mut self,
		c: &Context<'_>,
		cmd: Command<'_>,
		depth: u32,
		role: &'static str,
		segments: Vec<Segment>,
		governor: Option<NodeKey>,
	) {
		let key = c.key(cmd.id());
		let mut row = Row {
			id: format!("row-{key}-{}", self.serial),
			depth,
			node: Some(key),
			range: c.map.range(cmd.span()),
			role: Some(role),
			segments,
			detail: Some(c.text(cmd.span())),
			..Row::default()
		};
		self.serial += 1;
		if let Some(untraced) = c.untraced {
			row.detail.as_mut().unwrap().push_str(untraced);
			row.active = self.running(c, cmd.id());
		} else {
			row.active = Some(row.segments.iter().any(|s| s.active == Some(true)));
			if role == "stmt" {
				let observed = governor
					.or_else(|| {
						row.segments
							.iter()
							.filter_map(|s| s.node)
							.filter(|k| c.analysis.leaves.contains(k))
							.filter_map(|k| self.runtime.observation(k).map(|o| (k, o)))
							.max_by_key(|(k, o)| {
								(
									!self.safe_false(*k) && o.status.is_some_and(|st| st != 0),
									o.execution_seq.unwrap_or(0),
								)
							})
							.map(|(k, _)| k)
					})
					.or(Some(key));
				if let Some(o) = observed.and_then(|k| self.runtime.observation(k)) {
					row.state = Some(if observed.is_some_and(|k| self.safe_false(k)) {
						State::Ok
					} else {
						o.state
					});
					row.executed_at_ns = o.executed_at_ns;
					row.execution_seq = o.execution_seq;
					row.meta = metadata(o, observed.is_some_and(|k| self.safe_false(k)), true);
					append_observation(&mut row.detail, o);
				}
			} else if role == "head" {
				if let Some(g) = governor
					&& let Some(o) = self.runtime.observation(g)
				{
					row.state = Some(if self.safe_false(g) {
						State::Ok
					} else {
						o.state
					});
					row.meta = o
						.status
						.map(|st| if st == 0 { "↳".into() } else { "↷".into() });
					append_observation(&mut row.detail, o);
				}
				if let Some(o) = self.runtime.observation(key) {
					if let Some(n) = o.iteration.or(o.iterations) {
						row.meta = Some(format!("↻ {n}"));
					} else if row.meta.is_none() {
						row.meta = o
							.taken
							.map(|taken| if taken { "↳".into() } else { "↷".into() });
					}
				}
			}
		}
		if self.options.layers.effects {
			let mut seen = HashSet::new();
			for effect in std::iter::once(key)
				.chain(row.segments.iter().filter_map(|s| s.node))
				.filter_map(|k| c.analysis.effects.get(&k))
				.flatten()
			{
				if seen.insert((effect.kind, effect.why.as_str())) {
					row.effects.push(effect.clone());
				}
			}
		}
		self.rows.push(row);
	}

	fn tree(&mut self, tree: &SyntaxTree, c: &Context<'_>, depth: u32) {
		match tree.view() {
			Root::List(l) => self.list(l, c, depth),
			Root::Command(cmd) => self.command(cmd, c, depth, false),
			Root::Word(w) => {
				let s = self.segment(c, w.id(), w.span(), self.words(c).word(w), "str", false);
				self.rows.push(Row {
					id: format!("word-{}", c.key(w.id())),
					depth,
					node: Some(c.key(w.id())),
					range: c.map.range(w.span()),
					role: Some("document"),
					segments: vec![s],
					..Row::default()
				});
			},
		}
	}

	fn list(&mut self, list: List<'_>, c: &Context<'_>, depth: u32) {
		self.chain_list(list, c, depth, None);
	}

	/// Draws `list`; its first chain continues the one `after` cut off before
	/// it (see [`Self::and_or`]).
	fn chain_list(
		&mut self,
		list: List<'_>,
		c: &Context<'_>,
		depth: u32,
		mut after: Option<AndOrOp>,
	) {
		let items = list.items();
		let mut i = 0;
		while let Some(item) = items.get(i) {
			if after.is_none()
				&& self.options.layers.idioms
				&& let (Some(start), Some(loader), Some(end)) = (
					single(item.and_or()),
					items.get(i + 1).and_then(|it| single(it.and_or())),
					items.get(i + 2).and_then(|it| single(it.and_or())),
				)
				&& is_simple(start, "set", Some("-a"))
				&& (is_simple(loader, ".", None) || is_simple(loader, "source", None))
				&& is_simple(end, "set", Some("+a"))
				&& self.builtin(c.key(start.id()))
				&& self.builtin(c.key(loader.id()))
				&& self.builtin(c.key(end.id()))
				&& let CommandKind::Simple(simple) = loader.kind()
			{
				let path = simple
					.words()
					.iter()
					.skip(1)
					.map(|w| self.words(c).word(w))
					.collect::<Vec<_>>()
					.join(", ");
				let text = format!("load_env({path}) exports all");
				let mut seg = self.segment(c, loader.id(), loader.span(), text, "fn badge", true);
				seg.expanded = Some(format!(
					"{}\n{}\n{}",
					c.text(start.span()),
					c.text(loader.span()),
					c.text(end.span())
				));
				self.emit(c, loader, depth, "stmt", vec![seg], Some(c.key(loader.id())));
				i += 3;
				continue;
			}
			let background = matches!(item.sep(), Sep::Amp | Sep::Disown);
			self.and_or(item.and_or(), c, depth, background, after.take());
			i += 1;
		}
	}

	/// Draws one chain. `after` is the operator of an earlier chain this one
	/// continues (a minimizer segment, or script not reached yet): the first
	/// pipeline then reads as a continuation row too.
	fn and_or(
		&mut self,
		a: AndOr<'_>,
		c: &Context<'_>,
		depth: u32,
		background: bool,
		after: Option<AndOrOp>,
	) {
		let first = a.first();
		let rest: Vec<(AndOrOp, Pipeline<'_>)> = a.rest().collect();
		if after.is_none()
			&& rest.is_empty()
			&& let Some(cmd) = first.stages().one()
			&& !first.bang()
			&& first.time().is_none()
		{
			self.command(cmd, c, depth, background);
			return;
		}
		let all_simple = a.pipelines().iter().all(|p| {
			p.stages().iter().all(|s| {
				matches!(
					s.kind(),
					CommandKind::Simple(_) | CommandKind::Cond(_) | CommandKind::Arith(_)
				)
			})
		});
		if all_simple {
			// One row per pipeline: `and`/`or` lead each continuation row, so a
			// chain reads down the page and every command keeps its own status.
			let mut lead = Vec::new();
			if let Some(op) = after {
				lead.push(self.segment(c, a.id(), a.span(), connector(op), "op", false));
			}
			if background {
				lead.push(self.segment(c, a.id(), a.span(), "spawn ", "kw", false));
			}
			lead.extend(self.pipeline(first, c));
			let mut rows = vec![(first, depth + u32::from(after.is_some()), lead)];
			for (index, &(op, p)) in rest.iter().enumerate() {
				let lone = p.stages().one();
				if self.options.layers.idioms
					&& index + 1 == rest.len()
					&& op == AndOrOp::Or
					&& !p.bang()
					&& p.time().is_none()
					&& let Some(cmd) = lone
					&& self.builtin(c.key(cmd.id()))
					&& cmd.redirs().is_empty()
					&& !self.options.expanded_nodes.contains(&c.key(cmd.id()))
					&& matches!(cmd.kind(), CommandKind::Simple(s) if s.assigns().is_empty()
						&& s.words().len() == 1
						&& matches!(command_name(s).as_deref(), Some("true" | ":")))
				{
					let mut s = self.segment(c, cmd.id(), cmd.span(), " may fail", "badge", true);
					s.expanded = Some(format!("|| {}", c.text(cmd.span())));
					if let Some((_, _, segments)) = rows.last_mut() {
						segments.push(s);
					}
				} else {
					let mut segments =
						vec![self.segment(c, a.id(), a.span(), connector(op), "op", false)];
					segments.extend(self.pipeline(p, c));
					rows.push((p, depth + 1, segments));
				}
			}
			for (p, depth, segments) in rows {
				let head = p.stages().first().expect("pipeline stage");
				self.emit(c, head, depth, "stmt", segments, None);
				self.documents(p, c, depth);
			}
		} else {
			for (pi, p) in a.pipelines().iter().enumerate() {
				// The operator this pipeline follows, within the chain or before
				// it.
				let op = if pi > 0 { Some(rest[pi - 1].0) } else { after };
				let mut prev_stderr = false;
				for (si, stage) in p.stages().iter().enumerate() {
					let start = self.rows.len();
					self.command(stage, c, depth + u32::from(op.is_some() || si > 0), background);
					let link = if si > 0 {
						if prev_stderr { "→& " } else { "→ " }
					} else {
						op.map_or("", connector)
					};
					prev_stderr = stage.pipe_stderr();
					let mut prefix = link.to_owned();
					if si == 0 && p.bang() {
						prefix.push_str("not ");
					}
					if si == 0 && p.time().is_some() {
						prefix.push_str("timed ");
					}
					if !prefix.is_empty() {
						let segment = self.segment(c, p.id(), p.span(), prefix, "op", false);
						if let Some(row) = self.rows.get_mut(start) {
							row.segments.insert(0, segment);
						}
					}
				}
			}
		}
	}

	fn pipeline(&self, p: Pipeline<'_>, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		if p.bang() {
			out.push(self.segment(c, p.id(), p.span(), "not ", "kw", false));
		}
		if p.time().is_some() {
			out.push(self.segment(c, p.id(), p.span(), "timed ", "badge", false));
		}
		let stages = p.stages();
		let mut prev_stderr = false;
		for (i, cmd) in stages.iter().enumerate() {
			let pipe_stderr = std::mem::replace(&mut prev_stderr, cmd.pipe_stderr());
			let fold = self.options.layers.idioms
				&& self
					.runtime
					.observation(c.key(cmd.id()))
					.is_none_or(|observation| observation.resolved != Some(ResolvedKind::Function))
				&& !self.options.expanded_nodes.contains(&c.key(cmd.id()))
				&& i > 0
				&& i + 1 == stages.len()
				&& cmd.redirs().is_empty()
				&& matches!(cmd.kind(), CommandKind::Simple(s) if tail_count(s).is_some());
			if fold {
				if let CommandKind::Simple(s) = cmd.kind() {
					let count = tail_count(s).unwrap_or(10);
					let mut seg = self.segment(
						c,
						cmd.id(),
						cmd.span(),
						format!(
							" {} {count}",
							if command_name(s).as_deref() == Some("head") {
								"⇡ first"
							} else {
								"⇣ last"
							}
						),
						"badge",
						true,
					);
					seg.expanded = Some(format!("| {}", c.text(cmd.span())));
					out.push(seg);
				}
				continue;
			}
			if i > 0 {
				out.push(self.segment(
					c,
					p.id(),
					p.span(),
					if pipe_stderr { " →& " } else { " → " },
					"op",
					false,
				));
			}
			out.extend(self.inline_command(cmd, c));
		}
		out
	}

	fn inline_command(&self, cmd: Command<'_>, c: &Context<'_>) -> Vec<Segment> {
		if self.outside_projection(cmd, c) {
			return Vec::new();
		}
		let (id, span) = (cmd.id(), cmd.span());
		match cmd.kind() {
			CommandKind::Simple(s) => self.simple(cmd, s, c),
			CommandKind::Cond(cond) => {
				vec![self.segment(c, id, span, self.words(c).condition(cond), "var", true)]
			},
			CommandKind::Arith(a) => {
				vec![self.segment(c, id, span, self.arithmetic(a.src(), false), "var", true)]
			},
			_ => vec![self.segment(c, id, span, c.text(span), "kw", false)],
		}
	}

	fn simple(&self, cmd: Command<'_>, s: Simple<'_>, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		let (id, span) = (cmd.id(), cmd.span());
		let name = command_name(s).unwrap_or_default();
		let words = s.words();
		let values = words
			.iter()
			.map(|w| literal(w).unwrap_or_else(|| self.words(c).word(w)))
			.collect::<Vec<_>>();
		let expanded = self.options.expanded_nodes.contains(&c.key(id));
		let idioms = self.options.layers.idioms && !expanded;
		if words.is_empty() {
			for (i, a) in s.assigns().iter().enumerate() {
				if i > 0 {
					out.push(self.segment(c, id, span, ", ", "op", true));
				}
				let mut segment =
					self.segment(c, id, a.span(), self.words(c).assignment(a), "var def", true);
				segment.node = Some(c.key(a.id()));
				out.push(segment);
			}
			out.extend(self.redirections(cmd, Some(s), c));
			return out;
		}
		if !s.assigns().is_empty() {
			out.push(self.segment(
				c,
				id,
				span,
				format!(
						"env({}) ",
						s.assigns()
							.iter()
							.map(|a| self.words(c).assignment(a))
							.collect::<Vec<_>>()
							.join(", ")
					),
				"chip env",
				true,
			));
		}
		if idioms && self.builtin(c.key(id)) && name == "cd" && words.len() == 2 {
			let mut seg = self.segment(c, id, span, format!("cwd {}", values[1]), "badge", true);
			seg.expanded = Some(c.text(span));
			out.push(seg);
			return out;
		}
		if idioms && self.builtin(c.key(id)) && name == "set" && words.len() == 2 {
			let meaning = match values[1].as_str() {
				"-e" => Some("stop on first error"),
				"+e" => Some("keep going on errors"),
				"-u" => Some("error on unset vars"),
				"-a" => Some("auto-export assignments"),
				"+a" => Some("stop auto-export"),
				"-m" => Some("job control on"),
				"+m" => Some("job control off"),
				"-x" => Some("trace commands"),
				"-euo" => Some("strict mode"),
				_ => None,
			};
			if let Some(meaning) = meaning {
				let mut seg = self.segment(c, id, span, format!("# {meaning}"), "comment badge", true);
				seg.expanded = Some(c.text(span));
				out.push(seg);
				return out;
			}
		}
		if idioms
			&& self
				.runtime
				.observation(c.key(id))
				.is_none_or(|observation| observation.resolved != Some(ResolvedKind::Function))
			&& name == "curl"
			&& values.iter().any(|v| v == "%{http_code}")
			&& values.iter().any(|v| v == "/dev/null")
			&& let Some(w) = words.iter().find(|&w| {
				literal(w).is_some_and(|v| {
					v.starts_with("http:") || v.starts_with("https:") || v.starts_with("localhost")
				})
			}) {
			out.push(self.segment(c, id, span, "http_status(", "fn badge", true));
			out.extend(self.word_segments(w, c, "str"));
			out.push(self.segment(c, id, span, ")", "op", true));
			return out;
		}
		let resolved = self.runtime.observation(c.key(id)).and_then(|o| o.resolved);
		let builtin = !matches!(
			resolved,
			Some(ResolvedKind::External | ResolvedKind::Function | ResolvedKind::NotFound)
		);
		if builtin && matches!(name.as_str(), "echo" | "printf") {
			out.push(self.segment(c, id, span, "print(", "fn", true));
			let mut first = true;
			for (i, w) in words.iter().enumerate().skip(1) {
				if i == 1
					&& literal(w).is_some_and(|v| {
						v.len() > 1
							&& v.starts_with('-')
							&& v[1..].chars().all(|ch| matches!(ch, 'n' | 'e' | 'E'))
					}) {
					continue;
				}
				if !first {
					out.push(self.segment(c, id, span, ", ", "op", true));
				}
				first = false;
				out.extend(self.word_segments(w, c, "str"));
			}
			out.push(self.segment(c, id, span, ")", "op", true));
		} else if builtin && matches!(name.as_str(), "[" | "test") {
			// A bare `[` (one word) yields the empty range 1..0; `take`/`skip`
			// keep it empty.
			let end = if name == "[" {
				words.len().saturating_sub(1)
			} else {
				words.len()
			};
			out.push(self.segment(
				c,
				id,
				span,
				test_words(words.take(end).skip(1), &self.words(c)),
				"var",
				true,
			));
		} else if resolved == Some(ResolvedKind::Function)
			|| (resolved.is_none() && c.analysis.functions.contains_key(&name))
			|| builtin
				&& matches!(name.as_str(), "source" | "." | "exit" | "return" | "break" | "continue")
		{
			out.push(self.segment(
				c,
				id,
				span,
				format!("{}(", if name == "." { "source" } else { &name }),
				"fn",
				true,
			));
			for (i, w) in words.iter().enumerate().skip(1) {
				if i > 1 {
					out.push(self.segment(c, id, span, ", ", "op", true));
				}
				out.extend(self.word_segments(w, c, "str"));
			}
			out.push(self.segment(c, id, span, ")", "op", true));
		} else {
			let start = if idioms
				&& resolved != Some(ResolvedKind::Function)
				&& name == "timeout"
				&& values.len() > 2
				&& timeout_duration(&values[1])
			{
				out.push(self.segment(
					c,
					id,
					span,
					format!(
						"⏱ {}{} ",
						values[1],
						if values[1].ends_with(|c: char| c.is_ascii_digit()) {
							"s"
						} else {
							""
						}
					),
					"badge",
					true,
				));
				2
			} else {
				0
			};
			for (i, w) in words.iter().enumerate().skip(start) {
				if i > start {
					out.push(self.segment(c, id, span, " ", "", true));
				}
				let language = embedded::argument_language(&values, i);
				let nested = self.nested(cmd, s, w, i, c);
				if self.options.layers.unwrap && nested {
					let mut seg = self.segment(c, w.id(), w.span(), "⟦script ↓⟧", "chip emb", true);
					seg.expanded = Some(c.text(w.span()));
					out.push(seg);
				} else if self.options.layers.unwrap {
					if let (Some(language), Some(value)) = (language, literal(w)) {
						if value.contains('\n') || value.len() > 64 {
							let mut seg = self.segment(
								c,
								w.id(),
								w.span(),
								format!("⟦{language} ↓⟧"),
								"chip emb",
								true,
							);
							seg.expanded = Some(c.text(w.span()));
							out.push(seg);
						} else {
							out.push(self.segment(c, w.id(), w.span(), "‹", "emb", true));
							out.extend(embedded::highlight(
								&value,
								language,
								c.key(w.id()),
								c.map.range(w.span()),
								self.options.layers,
							));
							out.push(self.segment(c, w.id(), w.span(), "›", "emb", true));
						}
					} else {
						out.extend(self.word_segments(w, c, if i == start { "cmd" } else { "arg" }));
					}
				} else {
					out.extend(self.literal_segments(w, c, if i == start { "cmd" } else { "str" }));
				}
			}
		}
		out.extend(self.redirections(cmd, Some(s), c));
		out
	}

	fn word_segments(&self, w: Word<'_>, c: &Context<'_>, style: &str) -> Vec<Segment> {
		let key = c.key(w.id());
		let owner = c.analysis.owners.get(&key).copied().unwrap_or(key);
		let expanded =
			self.options.expanded_nodes.contains(&key) || self.options.expanded_nodes.contains(&owner);
		let mut layers = self.options.layers;
		layers.inline &= !expanded;
		let printer = WordPrinter {
			layers:   &layers,
			analysis: c.analysis,
			unit:     c.unit,
			source:   c.source,
		};
		let text = if matches!(style, "cmd" | "arg") {
			literal(w).unwrap_or_else(|| printer.word(w))
		} else {
			printer.word(w)
		};
		let inline = text.contains('‹');
		let mut seg =
			self.segment(c, w.id(), w.span(), text, if inline { "chip" } else { style }, false);
		if c.untraced.is_none()
			&& let Some(o) = self.runtime.observation(owner)
		{
			seg.execution_node = Some(owner);
			seg.active = Some(self.runtime.active(owner));
			seg.state = Some(if self.safe_false(owner) {
				State::Ok
			} else {
				o.state
			});
			seg.executed_at_ns = o.executed_at_ns;
			seg.execution_seq = o.execution_seq;
		}
		if inline {
			seg.expanded = Some(
				c.analysis
					.variables
					.values()
					.filter(|v| v.inline)
					.filter_map(|v| v.setter)
					.filter_map(|key| {
						let span = c.analysis.spans.get(&key)?;
						if c.source > 0 {
							return Some(c.text(*span));
						}
						let unit = self.source.unit(key.unit as usize)?;
						Some(
							String::from_utf8_lossy(
								source_map(self.source, &unit).raw(unit.source.as_ref(), *span),
							)
							.into_owned(),
						)
					})
					.chain(std::iter::once(c.text(w.span())))
					.collect::<Vec<_>>()
					.join("\n"),
			);
			seg.tip = Some(
				c.analysis
					.variables
					.iter()
					.filter(|(_, v)| v.inline && v.value.is_some())
					.map(|(name, v)| format!("{name} = {}", v.value.as_deref().unwrap_or_default()))
					.collect::<Vec<_>>()
					.join("\n"),
			);
		}
		vec![seg]
	}

	fn literal_segments(&self, word: Word<'_>, c: &Context<'_>, style: &str) -> Vec<Segment> {
		if c.source == 0
			&& self.source.unit(c.unit as usize).is_some_and(|unit| {
				unit.at.is_some() && unit.syntax.is_some_and(|syntax| syntax.parent.is_none())
			})
			&& let Some(range) = c.map.range(word.span())
			&& let Some(segments) =
				raw::literal(self.source, self.runtime, self.options, self.analysis, range)
		{
			return segments;
		}
		let key = c.key(word.id());
		let owner = c.analysis.owners.get(&key).copied().unwrap_or(key);
		let mut segment = self.segment(c, owner.node, word.span(), c.text(word.span()), style, true);
		segment.node = Some(key);
		vec![segment]
	}

	fn redirections(
		&self,
		cmd: Command<'_>,
		s: Option<Simple<'_>>,
		c: &Context<'_>,
	) -> Vec<Segment> {
		let mut out = Vec::new();
		for redir in cmd.redirs() {
			let (op, fd) = (redir.op(), redir.fd());
			let mut style = if self.options.layers.idioms {
				"redir badge"
			} else {
				"redir"
			};
			let text = match redir.target() {
				RedirTarget::HereDoc(doc) => {
					if self.options.layers.unwrap {
						format!(" ⟵ {} ↓", heredoc_language(s, cmd, doc))
					} else {
						format!(
							" {}{}{}",
							fd_text(fd),
							redir_operator(op),
							String::from_utf8_lossy(doc.delim_raw())
						)
					}
				},
				RedirTarget::Word(w) => {
					let raw_target = literal(w);
					if self.options.layers.idioms && raw_target.as_deref() == Some("/dev/null") {
						// `badge-discard-*` names the discarded stream so renderers
						// with an icon font can replace the whole label.
						let (label, discard) = if matches!(op, RedirOp::OutErr | RedirOp::AppendErr) {
							("silent", "redir badge badge-discard-all")
						} else if matches!(fd, Some(RedirFd::Num(2))) {
							("err", "redir badge badge-discard-err")
						} else {
							("out", "redir badge badge-discard-out")
						};
						style = discard;
						format!(" 🔇 {label}")
					} else if self.options.layers.idioms
						&& matches!(fd, Some(RedirFd::Num(2)))
						&& op == RedirOp::DupOut
						&& raw_target.as_deref() == Some("1")
					{
						" +err".into()
					} else {
						format!(
							" {}{}{}",
							fd_text(fd),
							redir_operator(op),
							if self.options.layers.idioms {
								raw_target.unwrap_or_else(|| self.words(c).word(w))
							} else {
								c.text(w.span())
							}
						)
					}
				},
			};
			out.push(self.segment(c, cmd.id(), redir.span(), text, style, true));
		}
		out
	}

	fn command(&mut self, cmd: Command<'_>, c: &Context<'_>, depth: u32, background: bool) {
		if self.outside_projection(cmd, c) {
			self.projected_children(cmd, c, depth);
			return;
		}
		let (id, span, kind) = (cmd.id(), cmd.span(), cmd.kind());
		let key = c.key(id);
		if let CommandKind::Simple(s) = kind {
			if self.options.layers.inline
				&& s.words().is_empty()
				&& cmd.redirs().is_empty()
				&& !self.options.expanded_nodes.contains(&key)
				&& let Some(a) = s.assigns().one()
				&& c
					.analysis
					.variables
					.get(String::from_utf8_lossy(a.name()).as_ref())
					.is_some_and(|v| v.inline)
			{
				return;
			}
			let mut segments = self.simple(cmd, s, c);
			if background {
				segments.insert(0, self.segment(c, id, span, "spawn ", "kw", false));
			}
			self.emit(c, cmd, depth, "stmt", segments, Some(key));
			self.command_documents(cmd, Some(s), c, depth);
			return;
		}
		let row_start = self.rows.len();
		let head =
			|p: &Self, text: String, style: &str| vec![p.segment(c, id, span, text, style, false)];
		match kind {
			CommandKind::If(v) => {
				let arms = v.arms().len();
				for (i, arm) in v.arms().enumerate() {
					let mut seg = head(self, (if i == 0 { "if " } else { "elif " }).into(), "kw");
					seg.extend(self.inline_list(arm.cond, c));
					seg.push(self.segment(c, id, span, ":", "op", false));
					self.emit(c, cmd, depth, "head", seg, guard_key(arm.cond, c));
					self.condition_meta(arm.cond, c, false, (arms == 1).then_some(key));
					self.list(arm.body, c, depth + 1);
				}
				if let Some(body) = v.else_body() {
					let seg = head(self, "else:".into(), "kw");
					self.emit(c, cmd, depth, "mid", seg, None);
					self.list(body, c, depth + 1);
				}
			},
			CommandKind::While(v) => {
				let cond = v.cond();
				let mut seg =
					head(self, (if v.until() { "while not " } else { "while " }).into(), "kw");
				let read = single_list(cond).and_then(|cmd| {
					if let CommandKind::Simple(s) = cmd.kind() {
						(command_name(s).as_deref() == Some("read")).then_some((cmd, s))
					} else {
						None
					}
				});
				if let Some((read_cmd, read)) = read {
					let vars = read
						.words()
						.iter()
						.skip(1)
						.filter_map(literal)
						.filter(|s| !s.starts_with('-'))
						.collect::<Vec<_>>()
						.join(", ");
					seg = vec![self.segment(
						c,
						read_cmd.id(),
						read_cmd.span(),
						format!("for {vars} in lines:"),
						"kw",
						true,
					)];
				} else {
					seg.extend(self.inline_list(cond, c));
					seg.push(self.segment(c, id, span, ":", "op", false));
				}
				self.emit(c, cmd, depth, "head", seg, guard_key(cond, c));
				self.condition_meta(cond, c, v.until(), Some(key));
				self.list(v.body(), c, depth + 1);
			},
			CommandKind::For(v) | CommandKind::Select(v) => {
				let select = matches!(kind, CommandKind::Select(_));
				let mut segments = head(self, (if select { "select " } else { "for " }).into(), "kw");
				let names = std::iter::once(v.var())
					.chain(v.extra_vars())
					.map(String::from_utf8_lossy)
					.collect::<Vec<_>>()
					.join(", ");
				segments.push(self.segment(c, id, v.var_span(), names, "var def", false));
				segments.push(self.segment(c, id, span, " in ", "kw", false));
				segments.extend(self.loop_items(v, cmd, c));
				segments.push(self.segment(c, id, span, ":", "op", false));
				self.emit(c, cmd, depth, "head", segments, None);
				self.list(v.body(), c, depth + 1);
			},
			CommandKind::ArithFor(v) => {
				let part = |p: &Self, text: &[u8], empty: &str| {
					if text.trim_ascii().is_empty() {
						empty.to_owned()
					} else {
						p.arithmetic(text, true)
					}
				};
				let init = part(self, v.init().src(), "None");
				let condition = part(self, v.cond().src(), "True");
				let step = part(self, v.step().src(), "None");
				let text = format!(
					"for _ in arithmetic_loop(init=lambda: {init}, condition=lambda: {condition}, \
					 step=lambda: {step}):"
				);
				let mut head = self.segment(c, id, span, text, "kw", false);
				head.tip = Some(
					"Initialize once; test before each iteration; step after normal completion and \
					 continue, but not break or return."
						.into(),
				);
				head.expanded = Some(c.text(span));
				self.emit(c, cmd, depth, "head", vec![head], None);
				self.list(v.body(), c, depth + 1);
			},
			CommandKind::Case(v) => {
				let seg = head(self, format!("match {}:", self.words(c).word(v.word())), "kw");
				self.emit(c, cmd, depth, "head", seg, None);
				for arm in v.arms() {
					let patterns = arm
						.patterns()
						.iter()
						.map(|w| self.words(c).word(w))
						.collect::<Vec<_>>()
						.join(" | ");
					let seg = head(self, format!("case {patterns}:"), "kw");
					self.emit(c, cmd, depth + 1, "head", seg, None);
					self.list(arm.body(), c, depth + 2);
					let term = arm.term();
					if term != CaseTerm::Break {
						let text = if term == CaseTerm::FallThrough {
							"fallthrough"
						} else {
							"continue matching"
						};
						let seg = head(self, text.into(), "kw");
						self.emit(c, cmd, depth + 2, "tail", seg, None);
					}
				}
			},
			CommandKind::FuncDef(v) => {
				let name = String::from_utf8_lossy(v.name());
				let count = c
					.analysis
					.functions
					.get(name.as_ref())
					.copied()
					.unwrap_or(0);
				let args = (1..=count)
					.map(|i| format!("arg{i}"))
					.collect::<Vec<_>>()
					.join(", ");
				let seg = head(self, format!("def {name}({args}):"), "fn");
				self.emit(c, cmd, depth, "head", seg, None);
				let body = v.body();
				if let CommandKind::Brace(list) = body.kind() {
					self.list(list, c, depth + 1);
				} else {
					self.command(body, c, depth + 1, false);
				}
			},
			CommandKind::Brace(body) => {
				if background || !cmd.redirs().is_empty() {
					let text = if background {
						"spawn:"
					} else {
						"redirected block:"
					};
					let mut seg = head(self, text.into(), "kw");
					seg.extend(self.redirections(cmd, None, c));
					self.emit(c, cmd, depth, "head", seg, None);
					self.list(body, c, depth + 1);
				} else {
					self.list(body, c, depth);
				}
			},
			CommandKind::Subshell(body) => {
				let seg = head(self, "subshell:".into(), "kw");
				self.emit(c, cmd, depth, "head", seg, None);
				self.list(body, c, depth + 1);
			},
			CommandKind::Coproc(v) => {
				let name = v
					.name()
					.map_or_else(|| "COPROC".into(), String::from_utf8_lossy);
				let seg = head(self, format!("coprocess {name}:"), "kw");
				self.emit(c, cmd, depth, "head", seg, None);
				self.command(v.body(), c, depth + 1, false);
			},
			CommandKind::Repeat(v) => {
				let seg = head(self, format!("repeat {}:", self.words(c).word(v.count())), "kw");
				self.emit(c, cmd, depth, "head", seg, None);
				self.list(v.body(), c, depth + 1);
			},
			CommandKind::Try(v) => {
				let seg = head(self, "try:".into(), "kw");
				self.emit(c, cmd, depth, "head", seg, None);
				self.list(v.body(), c, depth + 1);
				let seg = head(self, "finally:".into(), "kw");
				self.emit(c, cmd, depth, "mid", seg, None);
				self.list(v.always(), c, depth + 1);
			},
			CommandKind::AnonFunc(v) => {
				let seg = head(self, "call anonymous:".into(), "fn");
				self.emit(c, cmd, depth, "head", seg, None);
				self.command(v.body(), c, depth + 1, false);
			},
			CommandKind::Cond(_) | CommandKind::Arith(_) => {
				let segments = self.inline_command(cmd, c);
				self.emit(c, cmd, depth, "stmt", segments, Some(key));
			},
			CommandKind::Simple(_) => unreachable!(),
		}
		let brace = matches!(kind, CommandKind::Brace(_));
		if background && !brace {
			let prefix = self.segment(c, id, span, "spawn ", "kw", false);
			if let Some(row) = self.rows.get_mut(row_start) {
				row.segments.insert(0, prefix);
			}
		}
		if !cmd.redirs().is_empty() {
			if !brace {
				let redirs = self.redirections(cmd, None, c);
				if let Some(row) = self.rows.get_mut(row_start) {
					row.segments.extend(redirs);
				}
			}
			self.command_documents(cmd, None, c, depth);
		}
	}

	fn arithmetic(&self, text: &[u8], expression: bool) -> String {
		self.analysis.arithmetic(text).map_or_else(
			|| {
				let raw = String::from_utf8_lossy(text);
				if expression {
					format!("bash_arithmetic({})", super::words::quote(&raw))
				} else {
					format!("(( {raw} ))")
				}
			},
			|value| value.to_string(),
		)
	}

	fn outside_projection(&self, command: Command<'_>, context: &Context<'_>) -> bool {
		context.source == 0
			&& self
				.source
				.unit(context.unit as usize)
				.is_some_and(|unit| unit.projection > 0)
			&& context.map.bytes(command.span()).is_none()
	}

	fn projected_children(&mut self, command: Command<'_>, context: &Context<'_>, depth: u32) {
		match command.kind() {
			CommandKind::Brace(list) | CommandKind::Subshell(list) => self.list(list, context, depth),
			CommandKind::If(branch) => {
				for arm in branch.arms() {
					self.list(arm.cond, context, depth);
					self.list(arm.body, context, depth);
				}
				if let Some(body) = branch.else_body() {
					self.list(body, context, depth);
				}
			},
			CommandKind::While(loop_) => {
				self.list(loop_.cond(), context, depth);
				self.list(loop_.body(), context, depth);
			},
			CommandKind::For(loop_) | CommandKind::Select(loop_) => {
				self.list(loop_.body(), context, depth);
			},
			CommandKind::ArithFor(loop_) => self.list(loop_.body(), context, depth),
			CommandKind::Case(case) => {
				for arm in case.arms() {
					self.list(arm.body(), context, depth);
				}
			},
			CommandKind::FuncDef(function) => self.command(function.body(), context, depth, false),
			CommandKind::Coproc(coproc) => self.command(coproc.body(), context, depth, false),
			CommandKind::Repeat(loop_) => self.list(loop_.body(), context, depth),
			CommandKind::Try(attempt) => {
				self.list(attempt.body(), context, depth);
				self.list(attempt.always(), context, depth);
			},
			CommandKind::AnonFunc(function) => self.command(function.body(), context, depth, false),
			CommandKind::Simple(_) | CommandKind::Arith(_) | CommandKind::Cond(_) => {},
		}
	}

	fn loop_items(&self, loop_: For<'_>, cmd: Command<'_>, c: &Context<'_>) -> Vec<Segment> {
		let (id, span) = (cmd.id(), cmd.span());
		let Some(words) = loop_.words() else {
			return vec![self.segment(c, id, span, "args", "var", false)];
		};
		if let Some(word) = words.one() {
			let lone = word.parts().one().map(WordPart::get);
			if let Some(Part::Lit(bytes)) = lone
				&& bytes.iter().any(|b| matches!(*b, b'*' | b'?' | b'['))
			{
				return vec![self.segment(
					c,
					word.id(),
					word.span(),
					format!(
						"glob({})",
						super::words::quote(&literal(word).unwrap_or_else(|| c.text(word.span())))
					),
					"fn",
					false,
				)];
			}
			if let Some(Part::Comsub(sub)) = lone
				&& let Some(sequence) = single_list(sub.body())
				&& let CommandKind::Simple(simple) = sequence.kind()
				&& command_name(simple).as_deref() == Some("seq")
				&& self.builtin(c.key(sequence.id()))
				&& let Some(args) = simple
					.words()
					.iter()
					.skip(1)
					.map(literal)
					.collect::<Option<Vec<_>>>()
			{
				let range = match args.as_slice() {
					[end] => Some(format!("1..{end}")),
					[start, end] => Some(format!("{start}..{end}")),
					[start, step, end] => Some(format!("range_inclusive({start}, {end}, {step})")),
					_ => None,
				};
				if let Some(range) = range {
					return vec![self.segment(c, word.id(), word.span(), range, "num", false)];
				}
			}
		}
		let count = if self.options.layers.inline && !self.options.expanded_nodes.contains(&c.key(id))
		{
			words.len().min(2)
		} else {
			words.len()
		};
		let mut segments = vec![self.segment(c, id, span, "[", "op", false)];
		for (index, word) in words.iter().take(count).enumerate() {
			if index > 0 {
				segments.push(self.segment(c, id, span, ", ", "op", false));
			}
			segments.extend(self.word_segments(word, c, "str"));
		}
		if count < words.len() {
			segments.push(self.segment(c, id, span, ", ", "op", false));
			let mut more =
				self.segment(c, id, span, format!("+{} more", words.len() - count), "chip", false);
			more.expanded = Some(
				words
					.iter()
					.map(|word| c.text(word.span()))
					.collect::<Vec<_>>()
					.join(" "),
			);
			more.tip = Some(
				words
					.iter()
					.map(|word| c.text(word.span()))
					.collect::<Vec<_>>()
					.join("\n"),
			);
			segments.push(more);
		}
		segments.push(self.segment(c, id, span, "]", "op", false));
		segments
	}

	fn condition_meta(
		&mut self,
		list: List<'_>,
		c: &Context<'_>,
		until: bool,
		parent: Option<NodeKey>,
	) {
		let Some(item) = list.items().last() else {
			return;
		};
		let pipeline_status = |pipeline: Pipeline<'_>| -> Option<i32> {
			if let Some(status) = self
				.runtime
				.observation(c.key(pipeline.id()))
				.and_then(|o| o.status)
			{
				return Some(status);
			}
			let lone = pipeline.stages().one()?;
			let status = self.runtime.observation(c.key(lone.id()))?.status?;
			Some(if pipeline.bang() {
				i32::from(status == 0)
			} else {
				status
			})
		};
		let and_or = item.and_or();
		let mut status = pipeline_status(and_or.first());
		for (op, pipeline) in and_or.rest() {
			status = match status {
				Some(status)
					if (op == AndOrOp::And && status == 0) || (op == AndOrOp::Or && status != 0) =>
				{
					pipeline_status(pipeline)
				},
				other => other,
			};
		}
		let condition = c.key(and_or.id());
		let recorded = self.runtime.branch(condition);
		let condition_status = self.runtime.branch_status(condition);
		let taken = recorded
			.or_else(|| status.map(|status| (status == 0) != until))
			.or_else(|| {
				parent
					.and_then(|key| self.runtime.observation(key))
					.and_then(|o| o.taken)
			});
		let fail = guard_key(list, c)
			.filter(|key| !self.safe_false(*key))
			.and_then(|key| self.runtime.observation(key))
			.and_then(|o| o.status)
			.filter(|status| *status != 0)
			.or_else(|| condition_status.filter(|status| *status > 1));
		let iteration = parent
			.and_then(|key| self.runtime.observation(key))
			.and_then(|o| o.iteration.or(o.iterations));
		if let Some(row) = self.rows.last_mut() {
			if recorded.is_some() {
				row.state = Some(
					if condition_status.is_some_and(|status| status > 1)
						|| row.segments.iter().any(|s| s.state == Some(State::Fail))
					{
						State::Fail
					} else {
						State::Ok
					},
				);
				if let Some(status) = condition_status {
					let detail = row.detail.get_or_insert_default();
					detail.push_str("\ncondition exit status: ");
					detail.push_str(status.format_into(&mut NumBuffer::new()));
				}
			}
			if let Some(taken) = taken {
				let arrow = if taken { "↳" } else { "↷" };
				let mut meta =
					fail.map_or_else(|| arrow.into(), |status| format!("exit {status} · {arrow}"));
				if let Some(iteration) = iteration {
					meta.push_str(" · ↻ ");
					meta.push_str(iteration.format_into(&mut NumBuffer::new()));
				}
				row.meta = Some(meta);
			}
		}
	}

	fn inline_list(&self, list: List<'_>, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		for (i, item) in list.items().iter().enumerate() {
			let and_or = item.and_or();
			if i > 0 {
				out.push(self.segment(c, and_or.id(), and_or.span(), "; ", "op", false));
			}
			out.extend(self.pipeline(and_or.first(), c));
			for (op, p) in and_or.rest() {
				out.push(self.segment(
					c,
					and_or.id(),
					and_or.span(),
					if op == AndOrOp::And { " and " } else { " or " },
					"op",
					false,
				));
				out.extend(self.pipeline(p, c));
			}
		}
		out
	}

	fn pending(&mut self, bytes: &[u8], at: u32, depth: u32) {
		if bytes.iter().all(u8::is_ascii_whitespace) {
			return;
		}
		let mut offset = at;
		let text = String::from_utf8_lossy(bytes);
		let count = text.split('\n').count();
		let map = script_utf16(self.source);
		for (i, line) in text.split('\n').enumerate() {
			if i + 1 == count && line.is_empty() {
				break;
			}
			if i == 0 && at > 0 && line.is_empty() {
				offset += 1;
				continue;
			}
			let lo = *map.get(offset as usize).unwrap_or(&0);
			let hi = lo + line.encode_utf16().count() as u32;
			self.rows.push(Row {
				id: format!("pending-{offset}"),
				depth,
				range: Some([lo, hi]),
				role: Some("raw"),
				segments: vec![Segment {
					text: line.into(),
					style: Some(
						if self.options.layers.color {
							"str uncompiled"
						} else {
							"uncompiled"
						}
						.into(),
					),
					range: Some([lo, hi]),
					..Segment::default()
				}],
				detail: Some("Literal shell source not yet announced as a compiled unit.".into()),
				..Row::default()
			});
			offset += line.len() as u32 + 1;
		}
	}

	/// Whether rows of `id`'s command run now: besides its own words, the
	/// script, heredoc or untraced script it runs ([`Context::runner_of`]).
	fn running(&self, c: &Context<'_>, id: NodeId) -> Option<bool> {
		c.runner_of(id).map(|key| self.runtime.active(key))
	}

	fn close_frame(&mut self, unit: u32, depth: u32, range: Option<[u32; 2]>, active: Option<bool>) {
		self.rows.push(Row {
			id: format!("frame-end-{unit}-{}", self.serial),
			depth,
			range,
			active,
			role: Some("tail"),
			segments: vec![Segment {
				text: "└".into(),
				range,
				style: Some("frame".into()),
				..Segment::default()
			}],
			..Row::default()
		});
		self.serial += 1;
	}

	fn frame(
		&mut self,
		unit: u32,
		depth: u32,
		title: &str,
		range: Option<[u32; 2]>,
		active: Option<bool>,
	) {
		self.rows.push(Row {
			id: format!("frame-{unit}-{}", self.serial),
			depth,
			range,
			active,
			role: Some("document"),
			segments: vec![Segment {
				text: format!("┌ {title}"),
				style: Some("frame".into()),
				range,
				..Segment::default()
			}],
			..Row::default()
		});
		self.serial += 1;
	}

	fn nested(
		&self,
		cmd: Command<'_>,
		s: Simple<'_>,
		w: Word<'_>,
		index: usize,
		c: &Context<'_>,
	) -> bool {
		if !self.options.layers.unwrap {
			return false;
		}
		let key = c.key(w.id());
		if c.source == 0
			&& self.analysis.children.contains_key(&key)
			&& self
				.runtime
				.observation(c.key(cmd.id()))
				.is_none_or(|observation| observation.resolved != Some(ResolvedKind::External))
		{
			return true;
		}
		let Some((body_index, remote)) = embedded::shell_script(&literal_words(s)) else {
			return false;
		};
		if index != body_index {
			return false;
		}
		let external = c.untraced.is_some()
			|| self
				.runtime
				.observation(c.key(cmd.id()))
				.is_some_and(|o| o.resolved == Some(ResolvedKind::External));
		if c.source == 0
			&& remote
			&& self.runtime.observation(c.key(cmd.id())).is_some_and(|o| {
				matches!(o.resolved, Some(ResolvedKind::Function | ResolvedKind::NotFound))
			}) {
			return false;
		}
		if !remote && !external {
			return false;
		}
		let mut cache = self.source.cache().inner.lock();
		if let Entry::Vacant(entry) = cache.nested.entry(key) {
			let parsed = (|| {
				let body = literal(w)?;
				let origin = if let Some(parent) = &c.origin {
					let [start, _] = c.map.bytes(w.span())?;
					let origins = source::literal_map(c.map.raw(c.bytes, w.span()), body.as_bytes())?;
					let mapped = origins
						.into_iter()
						.map(|at| parent.at((start as u32).checked_add(at)?))
						.collect::<Option<Vec<_>>>()?;
					ByteOrigins { base: parent.base, map: Some(mapped.into()) }
				} else {
					ByteOrigins { base: *self.analysis.source_slots.get(&key)?, map: None }
				};
				let program = crate::bash::syntax::parse_all(body.as_bytes(), Features::NONE).ok()?;
				let ids = program
					.commands
					.iter()
					.map(|cc| origin.base.checked_add(origin.at(cc.span.lo)?))
					.collect::<Option<Vec<_>>>()?;
				let commands: Vec<(Tree, u32)> = program
					.commands
					.into_iter()
					.map(|cc| (cc.tree, cc.root.index()))
					.collect();
				let map = c
					.map
					.nested(w.span(), c.bytes, body.as_bytes(), 0)
					.unwrap_or_else(|| SourceMap::unlocated(0, body.len()));
				let mut facts = analysis::program(&commands, c.unit, &ids);
				facts.arithmetic = Arc::clone(&self.analysis.arithmetic);
				Some(Arc::new(Nested {
					body,
					commands,
					ids,
					remote: remote || c.untraced.is_some_and(|s| s.contains("remote/untraced")),
					origin,
					map,
					analysis: facts,
				}))
			})();
			entry.insert(parsed);
		}
		cache.nested.get(&key).is_some_and(Option::is_some)
	}

	fn documents(&mut self, p: Pipeline<'_>, c: &Context<'_>, depth: u32) {
		for stage in p.stages() {
			if let CommandKind::Simple(s) = stage.kind() {
				self.command_documents(stage, Some(s), c, depth);
			}
		}
	}

	fn command_documents(
		&mut self,
		cmd: Command<'_>,
		s: Option<Simple<'_>>,
		c: &Context<'_>,
		depth: u32,
	) {
		if let Some(s) = s {
			let words = literal_words(s);
			for (i, w) in s.words().iter().enumerate() {
				if self.options.layers.unwrap && self.nested(cmd, s, w, i, c) {
					self.nested_document(cmd, w, c, depth);
					continue;
				}
				if self.options.layers.unwrap
					&& let (Some(language), Some(value)) =
						(embedded::argument_language(&words, i), literal(w))
					&& (value.contains('\n') || value.len() > 64)
				{
					self.document(
						&value,
						language,
						c,
						w.id(),
						Some(w.span()),
						depth + 1,
						Some("inline argument"),
					);
				}
			}
		}
		let doc_spans = {
			let mut cache = self.source.cache().inner.lock();
			Arc::clone(
				cache
					.docs
					.entry(c.key(cmd.id()))
					.or_insert_with(|| Arc::new(source::heredoc_spans(&c.map, c.bytes, cmd.redirs()))),
			)
		};
		for (index, redir) in cmd.redirs().iter().enumerate() {
			if let RedirTarget::HereDoc(doc) = redir.target() {
				let body = String::from_utf8_lossy(doc.text());
				let doc_span = doc_spans.get(index).copied().flatten();
				if self.options.layers.unwrap {
					self.document(
						body.strip_suffix('\n').unwrap_or(&body),
						heredoc_language(s, cmd, doc),
						c,
						cmd.id(),
						doc_span,
						depth + 1,
						Some(&format!(
							"heredoc «{}»{}",
							String::from_utf8_lossy(doc.delim()),
							if !doc.quoted() && body.contains('$') {
								" · $vars expand"
							} else {
								""
							}
						)),
					);
				} else {
					let (original, span) = original_heredoc(c, doc_span, doc);
					self.document(&original, "text", c, cmd.id(), span, depth + 1, None);
				}
			}
		}
	}

	fn document(
		&mut self,
		text: &str,
		language: &str,
		c: &Context<'_>,
		id: NodeId,
		span: Option<Span>,
		depth: u32,
		title: Option<&str>,
	) {
		let range = span.and_then(|span| c.map.range(span));
		let active = self.running(c, id);
		if let Some(title) = title {
			self.rows.push(Row {
				id: format!("doc-head-{}-{}", c.key(id), self.serial),
				depth,
				node: Some(c.key(id)),
				range,
				active,
				role: Some("document"),
				segments: vec![Segment {
					text: format!("{language} · {title}"),
					node: Some(c.key(id)),
					range,
					style: style_for("emb", self.options.layers.color),
					..Segment::default()
				}],
				..Row::default()
			});
			self.serial += 1;
		}
		for line in text.split('\n') {
			self.rows.push(Row {
				id: format!("doc-{}-{}", c.key(id), self.serial),
				depth,
				node: Some(c.key(id)),
				range,
				active,
				role: Some("document"),
				segments: embedded::highlight(line, language, c.key(id), range, self.options.layers),
				..Row::default()
			});
			self.serial += 1;
		}
	}

	fn pending_mapped(&mut self, bytes: &[u8], at: u32, map: &SourceMap, depth: u32) {
		if bytes.iter().all(u8::is_ascii_whitespace) {
			return;
		}
		let text = String::from_utf8_lossy(bytes);
		let mut offset = at;
		let count = text.split('\n').count();
		for (i, line) in text.split('\n').enumerate() {
			if i + 1 == count && line.is_empty() {
				break;
			}
			if i == 0 && at > 0 && line.is_empty() {
				offset += 1;
				continue;
			}
			let range = map.range(Span::new(offset, offset + line.len() as u32));
			self.rows.push(Row {
				id: format!("nested-pending-{}-{}", offset, self.serial),
				depth,
				range,
				role: Some("raw"),
				segments: vec![Segment {
					text: line.into(),
					range,
					style: Some(
						if self.options.layers.color {
							"str uncompiled"
						} else {
							"uncompiled"
						}
						.into(),
					),
					..Segment::default()
				}],
				detail: Some("Literal shell source not yet announced as a compiled unit.".into()),
				..Row::default()
			});
			self.serial += 1;
			offset += line.len() as u32 + 1;
		}
	}

	fn nested_document(&mut self, command: Command<'_>, w: Word<'_>, c: &Context<'_>, depth: u32) {
		let range = c.map.range(w.span());
		let native = c.source == 0
			&& self.analysis.children.contains_key(&c.key(w.id()))
			&& self
				.runtime
				.observation(c.key(command.id()))
				.is_none_or(|observation| observation.resolved != Some(ResolvedKind::External));
		let nested = if native {
			None
		} else {
			self
				.source
				.cache()
				.inner
				.lock()
				.nested
				.get(&c.key(w.id()))
				.and_then(Clone::clone)
		};
		if let Some(nested) = nested {
			let title = if nested.remote {
				"remote/untraced: no per-command remote outcomes"
			} else {
				"external/untraced: no per-command inner outcomes"
			};
			let active = self.running(c, command.id());
			self.frame(c.unit, depth + 1, title, range, active);
			let map = nested.map.clone();
			for ((tree, root), id) in nested.commands.iter().zip(&nested.ids) {
				let context = Context {
					unit:     c.unit,
					source:   *id,
					bytes:    nested.body.as_bytes(),
					map:      map.clone(),
					untraced: Some(if nested.remote {
						"\nremote/untraced: no per-command remote outcomes"
					} else {
						"\nexternal/untraced: no per-command inner outcomes"
					}),
					runner:   c.runner_of(command.id()),
					origin:   Some(nested.origin.clone()),
					analysis: &nested.analysis,
				};
				self.list(List::at(tree, *root), &context, depth + 1);
			}
			self.close_frame(c.unit, depth + 1, range, active);
			return;
		}
		// Actual local children use engine-retained syntax only, never a
		// speculative parse.
		let mut children = self
			.analysis
			.children
			.get(&c.key(w.id()))
			.into_iter()
			.flatten()
			.filter_map(|index| self.source.unit(*index as usize))
			.collect::<Vec<_>>();
		children.sort_by_key(|u| (u.line, u.index));
		if children.is_empty() {
			return;
		}
		self.frame(c.unit, depth + 1, "local shell script", range, None);
		let body = literal(w);
		let body_map = body
			.as_ref()
			.and_then(|body| c.map.nested(w.span(), c.bytes, body.as_bytes(), 0));
		let mut cursor = 0usize;
		for unit in children {
			self.children.insert(unit.index);
			if let Some(syntax) = unit.syntax {
				let start = syntax.offset as usize;
				if let (Some(body), Some(map)) = (&body, &body_map)
					&& start > cursor
					&& start <= body.len()
				{
					self.pending_mapped(&body.as_bytes()[cursor..start], cursor as u32, map, depth + 1);
				}
				let context = Context {
					unit:     unit.index,
					source:   0,
					bytes:    unit.source.as_ref(),
					map:      source_map(self.source, &unit),
					untraced: None,
					runner:   None,
					origin:   None,
					analysis: self.analysis,
				};
				self.tree(&syntax.tree, &context, depth + 1);
				cursor = cursor.max(start + unit.source.len());
			}
		}
		if let (Some(body), Some(map)) = (&body, &body_map)
			&& cursor < body.len()
		{
			self.pending_mapped(&body.as_bytes()[cursor..], cursor as u32, map, depth + 1);
		}
		self.close_frame(c.unit, depth + 1, range, None);
	}
}
fn style_for(style: &str, color: bool) -> Option<String> {
	let text = if color {
		style.to_owned()
	} else {
		style
			.split_whitespace()
			.filter(|s| {
				s.starts_with("chip")
					|| s.starts_with("badge")
					|| s.starts_with("emb")
					|| s.starts_with("frame")
					|| s.starts_with("section")
					|| *s == "uncompiled"
			})
			.collect::<Vec<_>>()
			.join(" ")
	};
	(!text.is_empty()).then_some(text)
}
/// Pseudo word drawn for a chain operator.
const fn connector(op: AndOrOp) -> &'static str {
	match op {
		AndOrOp::And => "and ",
		AndOrOp::Or => "or ",
	}
}
/// The operator opening `bytes` after blanks — `&&`/`||` (`Some`), which
/// continues the chain of the unit before, or `;` (`None`), which ends it —
/// with the byte length through it and the whitespace following it.
fn leading_operator(bytes: &[u8]) -> Option<(Option<AndOrOp>, usize)> {
	let at = bytes
		.iter()
		.position(|byte| !matches!(byte, b' ' | b'\t'))?;
	let (op, width) = match &bytes[at..] {
		[b'&', b'&', ..] => (Some(AndOrOp::And), 2),
		[b'|', b'|', ..] => (Some(AndOrOp::Or), 2),
		[b';', ..] => (None, 1),
		_ => return None,
	};
	let end = at + width;
	Some((
		op,
		end + bytes[end..]
			.iter()
			.take_while(|byte| byte.is_ascii_whitespace())
			.count(),
	))
}

/// Complete commands of a text up to the first that does not parse.
struct Parsed {
	commands: Vec<(Tree, u32)>,
	spans:    Vec<Span>,
	/// Where the first command that does not parse starts.
	rest:     Pos,
	/// Why it fails.
	error:    Option<ParseErrorKind>,
}

/// The commands of `text` from `from`: [`Pos::START`], or the
/// [`Parsed::rest`] of a text with the same bytes before it.
fn parse_commands(text: &[u8], from: Pos) -> Parsed {
	let mut parser = Parser::new(text, Features::NONE, NO_ALIASES).with_pos(from);
	let mut commands = Vec::new();
	let mut spans = Vec::new();
	loop {
		let rest = parser.pos();
		let error = match parser.next_command() {
			Some(Ok(command)) => {
				spans.push(command.span);
				commands.push((command.tree, command.root.index()));
				continue;
			},
			Some(Err(error)) => Some(error.kind),
			None => None,
		};
		return Parsed { commands, spans, rest, error };
	}
}

/// A streamed tail parsed as it will most likely continue.
struct Repair {
	text:     Box<[u8]>,
	/// Bytes of the original text `text` starts with; the rest of it was
	/// appended.
	kept:     usize,
	commands: Vec<(Tree, u32)>,
	spans:    Vec<Span>,
}

/// Closers one repair appends at most; each closes one construct.
const MAX_CLOSERS: usize = 16;

/// What one repair may spend. Its candidates and the `$(` it repairs inside
/// recurse: the parses bound the work, so a draft stays cheap to draw at
/// every streamed update, and the nesting bounds the stack.
struct Budget {
	parses:  std::cell::Cell<u32>,
	nesting: std::cell::Cell<u32>,
}
impl Budget {
	const NESTING: u32 = 16;
	const PARSES: u32 = 256;

	const fn new() -> Self {
		Self {
			parses:  std::cell::Cell::new(Self::PARSES),
			nesting: std::cell::Cell::new(Self::NESTING),
		}
	}

	/// One parse more; `None` once the parses are spent.
	fn spend(&self) -> Option<()> {
		self.parses.set(self.parses.get().checked_sub(1)?);
		Some(())
	}

	/// `repair` one `$(` deeper; `None` past the deepest.
	fn nested<T>(&self, repair: impl FnOnce() -> Option<T>) -> Option<T> {
		let left = self.nesting.get().checked_sub(1)?;
		self.nesting.set(left);
		let repaired = repair();
		self.nesting.set(left + 1);
		repaired
	}
}

/// Bytes ending a streamed `text` that parse, but not as they will: a line
/// continuation with the indentation after it, whose `\` would draw as a
/// word, and a lone `&`, so far the first of `&&`, which would background
/// the command.
fn unfinished_end(text: &[u8]) -> usize {
	let mut end = text.len();
	loop {
		let blanks = text[..end]
			.iter()
			.rev()
			.take_while(|byte| matches!(byte, b' ' | b'\t'))
			.count();
		// Blanks are hidden only after a continuation: after a `\` they are
		// the escaped word character.
		let at = match text[..end - blanks].strip_suffix(b"\n") {
			Some(line) => line.len(),
			None if blanks == 0 => end,
			None => break,
		};
		if !escaped(&text[..at]) {
			break;
		}
		end = at - 1;
	}
	if end == text.len()
		&& let [.., before, b'&'] = text
		&& !matches!(before, b'&' | b'>' | b'<' | b'|' | b';')
		&& !escaped(&text[..end - 1])
	{
		end -= 1;
	}
	text.len() - end
}

/// A script still streaming in usually ends mid-construct: inside a quote or
/// `$(`, in a compound command before its closing keyword, after a `|`, `&&`
/// or `>` whose operand has not arrived, or in a command name that is so far
/// a reserved word (`fi` of `find`). Parsed as is, the whole command stays
/// literal until the construct closes, so its rows flip between Pseudo and
/// source as the script streams in. Instead parse it as it most likely
/// continues: drop what cannot be drawn yet, then append the closers the
/// parser awaits. Only the command at `from`, the first that fails with
/// `error`, is reparsed, and only the commands from there are returned.
/// `None` when `error` is not an unfinished end, or no repaired text parses.
fn repair_tail(
	text: &[u8],
	from: Pos,
	error: &ParseErrorKind,
	fill: bool,
	budget: &Budget,
) -> Option<Repair> {
	// Candidate ends, most likely first: the bytes kept, then what is
	// appended before the closers the parser awaits.
	let mut ends: Vec<(usize, &[u8])> = Vec::with_capacity(4);
	// A compound keyword with no header yet (`; for`) reads as the command
	// name it was a byte ago (`fo`); quoted, it is one until its header
	// arrives. In a quote or `$(` still open, which would draw the quotes
	// inline, it is hidden instead.
	if fill
		&& let Some((start, end)) = bare_keyword(text)
		&& start >= from.offset as usize
		&& !matches!(parse_commands(&text[..start], from).error, Some(ParseErrorKind::Unmatched(_)))
	{
		ends.push((end, b"''"));
	}
	// Bash reads `((` as arithmetic only once its `))` is there; closed
	// after an operator, it draws the operator, and before, it reads as
	// nested subshells. Only a quote still open goes first.
	if !matches!(error, ParseErrorKind::Unmatched("\"" | "'" | "`" | "}"))
		&& let Some(end) = open_arithmetic(text)
	{
		ends.push(end);
	}
	match error {
		ParseErrorKind::Unmatched(close) => {
			// A backtick body is parsed only once closed: an operator
			// dangling in it would draw it empty.
			if *close == "`"
				&& let Some(cut) = dangling_operator(text)
			{
				ends.push((cut, b""));
			}
			ends.push((text.len(), b""));
		},
		ParseErrorKind::UnexpectedEof { from: open } => {
			// An operator awaiting its operand draws nothing yet, nor does
			// the start of the keyword the compound awaits.
			if let Some(cut) = dangling_operator(text)
				.or_else(|| open.and_then(|(keyword, _)| awaited_prefix(text, keyword)))
			{
				ends.push((cut, b""));
			}
			ends.push((text.len(), b""));
		},
		ParseErrorKind::UnexpectedToken { token, .. } => {
			// Before a newline: a redirection awaiting its target, or a case
			// pattern awaiting its `)`. Otherwise only a reserved word ending
			// the text (`fi` of `find`) can still grow into something else.
			let newline = **token == *b"newline";
			if newline && let Some(cut) = dangling_redirection(text) {
				ends.push((cut, b""));
				// After a compound, its fd is no argument: it waits too.
				let fd = text[..cut]
					.iter()
					.rev()
					.take_while(|byte| byte.is_ascii_digit())
					.count();
				if fd > 0 {
					ends.push((cut - fd, b""));
				}
			}
			// A function header awaiting its `)` (`gen(`) is the command it
			// read as a byte ago.
			if newline && text.trim_ascii_end().ends_with(b"(") {
				ends.push((text.trim_ascii_end().len() - 1, b""));
			}
			// The start of the header word a compound awaits (`for f i`), or
			// the fd of a redirection still arriving after a compound (`(a)
			// 2`): hidden until whole.
			if text.ends_with(token)
				&& ([&b"in"[..], b"do"]
					.iter()
					.any(|word| word.len() > token.len() && word.starts_with(token))
					|| token.iter().all(u8::is_ascii_digit))
			{
				ends.push((text.len() - token.len(), b""));
			}
			let reserved = token.iter().all(u8::is_ascii_lowercase) && text.ends_with(token);
			if newline || reserved {
				let word = text
					.iter()
					.rposition(|byte| !byte.is_ascii_lowercase())
					.map_or(0, |at| at + 1);
				// A word that starts the keyword its compound awaits (`d` or
				// `do` of `done`, `e` of `esac`) is hidden like any prefix of
				// it; that compound may be open in a `$(` still open.
				let (scope, at) = match open_substitutions(text)
					.pop()
					.filter(|&start| start >= from.offset as usize && start <= word)
				{
					Some(start) => (Pos::START, start),
					None => (from, 0),
				};
				if word < text.len()
					&& word >= from.offset as usize
					&& let Some(ParseErrorKind::UnexpectedEof { from: Some((keyword, _)) }) =
						parse_commands(&text[at..word], scope).error
					&& awaited_prefix(&text[at..], keyword) == Some(word - at)
				{
					ends.push((word, b""));
				}
				// Otherwise a pattern gets its `)` appended; quoted, a reserved
				// word is a plain command name, as it will be once the rest of
				// the name arrives.
				ends.push((text.len(), if newline { b"" } else { b"''" }));
			}
		},
		_ => {},
	}
	// Inside `$(` a dangling operator surfaces as the unclosed `$(`, and
	// closing it leaves `|)`: drop the operator first, then close.
	if let Some(cut) = dangling_operator(text).or_else(|| dangling_redirection(text))
		&& !ends.contains(&(cut, b""))
	{
		ends.push((cut, b""));
	}
	ends
		.into_iter()
		.filter(|&(kept, _)| kept >= from.offset as usize)
		.find_map(|(kept, appended)| {
			let mut repaired = Vec::with_capacity(kept + appended.len());
			repaired.extend_from_slice(&text[..kept]);
			repaired.extend_from_slice(appended);
			close(repaired, kept, from, true, fill, budget)
		})
		// Still inside a `$(`, the error is its body's: repair that.
		.or_else(|| close_substitution(text, text.len(), from, fill, false, budget))
}

/// What a repair appended last.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Appended {
	/// The closer of a quote or `$(`.
	Quote,
	/// Anything else: a compound's completion, a pattern's `)`.
	Other,
}

/// `text`, whose first `kept` bytes are the script's, parsed from `from`
/// with what the parser awaits appended: the completions of compound
/// commands, the closers of quotes and `$(` when `quotes` (after the end of
/// a heredoc still open in them), and a case pattern's `)`. When `fill`, a
/// `:` may fill a body or header still empty; its row, drawn from no
/// source, is dropped, but a `$(` would draw it inline, so the compounds
/// still open in one are completed without.
fn close(
	mut text: Vec<u8>,
	mut kept: usize,
	mut from: Pos,
	quotes: bool,
	fill: bool,
	budget: &Budget,
) -> Option<Repair> {
	let mut commands = Vec::new();
	let mut spans = Vec::new();
	let mut last: Option<(usize, &[u8], Appended)> = None;
	let mut document = false;
	for _ in 0..=MAX_CLOSERS {
		budget.spend()?;
		let tail = parse_commands(&text, from);
		commands.extend(tail.commands);
		spans.extend(tail.spans);
		from = tail.rest;
		let (awaited, appended): (&[u8], Appended) = match tail.error {
			None => return Some(Repair { text: text.into(), kept, commands, spans }),
			Some(ParseErrorKind::Unmatched(close)) if quotes => {
				// Awaited again right after it was appended, the closer may
				// have been read as a line of a heredoc still open: end that
				// first, once. Otherwise another construct awaits it too.
				if let Some((at, previous, Appended::Quote)) = last
					&& previous == close.as_bytes()
					&& !document
					&& let Some((cut, end)) = heredoc_end(&text[..at])
					&& cut >= from.offset as usize
				{
					document = true;
					kept = kept.min(cut);
					text.truncate(cut);
					text.extend_from_slice(&end);
				}
				(close.as_bytes(), Appended::Quote)
			},
			Some(ParseErrorKind::UnexpectedEof { from: open }) => {
				// A function's header reports no opener: its body is awaited.
				let keyword = open
					.map(|(keyword, _)| keyword)
					.or_else(|| function_header(&text).then_some("function"))?;
				// The first completion that closes the compound, leaving at
				// most an outer construct open.
				let at = text.len();
				let completion = completions(keyword)
					.iter()
					.filter(|completion| fill || !completion.contains(&b':'))
					.find(|completion| {
						text.truncate(at);
						text.extend_from_slice(completion);
						budget.spend().is_some()
							&& matches!(
								parse_commands(&text, from).error,
								None
									| Some(
										ParseErrorKind::Unmatched(_) | ParseErrorKind::UnexpectedEof { .. }
									)
							)
					})?;
				text.truncate(at);
				(*completion, Appended::Other)
			},
			Some(ParseErrorKind::UnexpectedToken { token, .. }) if *token == *b"newline" => {
				(b")", Appended::Other)
			},
			// The `)` of a `$(` met a command still open in it: repair the
			// body first.
			Some(ParseErrorKind::UnexpectedToken { token, .. })
				if *token == *b")" && matches!(last, Some((_, b")", Appended::Quote))) =>
			{
				let at = last.map_or(text.len(), |(at, ..)| at);
				let rest = close_substitution(&text[..at], kept, from, fill, true, budget)?;
				commands.extend(rest.commands);
				spans.extend(rest.spans);
				return Some(Repair { text: rest.text, kept: rest.kept, commands, spans });
			},
			Some(_) => return None,
		};
		last = Some((text.len(), awaited, appended));
		text.extend_from_slice(awaited);
	}
	None
}

/// `$(` bodies [`close_substitution`] tries.
const MAX_SUBSTITUTIONS: usize = 4;

/// `text`, whose first `kept` bytes are the script's, with the body of a
/// `$(` still open at its end repaired, then closed and parsed from `from`.
/// The innermost `$(` the balance scan finds goes first, then every `$(`
/// from the last: a `case` pattern's `)` misleads the scan. A `$(` whose
/// body meets a `)` is closed in `text`. The body's commands before its
/// last stay; that one is repaired like a script's tail, else cut back to a
/// head, else hidden. `retry` marks a `text` that already failed with the
/// `)` appended: a body left as it is would fail again.
fn close_substitution(
	text: &[u8],
	kept: usize,
	from: Pos,
	fill: bool,
	retry: bool,
	budget: &Budget,
) -> Option<Repair> {
	let positional = text
		.windows(2)
		.enumerate()
		.filter(|&(at, pair)| pair == b"$(" && text.get(at + 2) != Some(&b'('))
		.map(|(at, _)| at + 2)
		.rev();
	let mut starts: Vec<usize> = Vec::with_capacity(MAX_SUBSTITUTIONS);
	for start in open_substitutions(text).into_iter().rev().chain(positional) {
		if start >= from.offset as usize && !starts.contains(&start) {
			starts.push(start);
		}
		if starts.len() == MAX_SUBSTITUTIONS {
			break;
		}
	}
	budget.nested(|| {
		starts.into_iter().find_map(|start| {
			let body = &text[start..];
			budget.spend()?;
			let parsed = parse_commands(body, Pos::START);
			let repair = match &parsed.error {
				Some(ParseErrorKind::UnexpectedToken { token, .. }) if **token == *b")" => {
					return None;
				},
				Some(error) => repair_tail(body, parsed.rest, error, false, budget)
					.or_else(|| parsed_head(body, parsed.rest, false, budget)),
				None => None,
			};
			let rest = parsed.rest.offset as usize;
			let (repaired, body_kept) = repair
				.as_ref()
				.map_or((&body[..rest], rest), |repair| (&repair.text[..], repair.kept));
			if retry && repaired == body {
				return None;
			}
			let mut closed = Vec::with_capacity(start + repaired.len() + 1);
			closed.extend_from_slice(&text[..start]);
			closed.extend_from_slice(repaired);
			closed.push(b')');
			close(closed, kept.min(start + body_kept), from, true, fill, budget)
		})
	})
}

/// Where the bodies of the `$(` still open at the end of `text` start,
/// outermost first. Quoted text and comments are skipped; quotes restart
/// in each `$(`.
fn open_substitutions(text: &[u8]) -> Vec<usize> {
	// Each `(` still open: the body a `$(` starts, and whether it opened
	// inside double quotes.
	let mut open: Vec<(Option<usize>, bool)> = Vec::new();
	let mut double = false;
	let mut at = 0;
	while at < text.len() {
		match text[at] {
			b'\\' => at += 1,
			b'\'' if !double => match text[at + 1..].iter().position(|&byte| byte == b'\'') {
				Some(len) => at += len + 1,
				None => break,
			},
			b'"' => double = !double,
			b'#'
				if !double
					&& (at == 0 || text[at - 1].is_ascii_whitespace() || text[at - 1] == b';') =>
			{
				match text[at..].iter().position(|&byte| byte == b'\n') {
					Some(len) => at += len,
					None => break,
				}
			},
			b'$' if text.get(at + 1) == Some(&b'(') => {
				let body = (text.get(at + 2) != Some(&b'(')).then_some(at + 2);
				open.push((body, double));
				double = false;
				at += 1;
			},
			b'(' if !double => open.push((None, false)),
			b')' if !double => {
				if let Some((_, outer)) = open.pop() {
					double = outer;
				}
			},
			_ => {},
		}
		at += 1;
	}
	open.into_iter().filter_map(|(body, _)| body).collect()
}

/// What ends the heredoc still open at the end of `text`, the last one
/// opened: where `text` is cut, before a last line that so far is a prefix
/// of its delimiter, and the delimiter on a line of its own. `None` when
/// none is open.
fn heredoc_end(text: &[u8]) -> Option<(usize, Vec<u8>)> {
	let operator = text.windows(2).rposition(|pair| pair == b"<<")?;
	// `<<<` is a here-string.
	if text.get(operator + 2) == Some(&b'<') || (operator > 0 && text[operator - 1] == b'<') {
		return None;
	}
	let mut at = operator + 2;
	let tabs = text.get(at) == Some(&b'-');
	at += usize::from(tabs);
	at += text[at..]
		.iter()
		.take_while(|byte| matches!(byte, b' ' | b'\t'))
		.count();
	let word_end = text[at..]
		.iter()
		.position(|byte| byte.is_ascii_whitespace() || b";|&<>()".contains(byte))
		.map_or(text.len(), |len| at + len);
	let word = &text[at..word_end];
	// A quote still open in the word is closed first; a word that is no name
	// (`1 << 2`) is no delimiter.
	let quotes = |quote| {
		word
			.iter()
			.fold(false, |open, &byte| open ^ (byte == quote))
	};
	let delimiter: Vec<u8> = word
		.iter()
		.copied()
		.filter(|byte| !matches!(byte, b'\'' | b'"' | b'\\'))
		.collect();
	if quotes(b'\'')
		|| quotes(b'"')
		|| !delimiter
			.first()
			.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
	{
		return None;
	}
	// The tabs `<<-` strips from a document line.
	let content = |line: &'_ [u8]| -> usize {
		if tabs {
			line.iter().take_while(|&&byte| byte == b'\t').count()
		} else {
			0
		}
	};
	let terminates = |line: &[u8]| line[content(line)..] == delimiter[..];
	// The delimiter on a line of its own, after a newline when `lead`.
	let end = |lead: bool| {
		let mut end = Vec::with_capacity(delimiter.len() + 2);
		if lead {
			end.push(b'\n');
		}
		end.extend_from_slice(&delimiter);
		end.push(b'\n');
		end
	};
	// The document starts on the line after the operator's.
	let Some(len) = text[word_end..].iter().position(|&byte| byte == b'\n') else {
		return Some((text.len(), end(true)));
	};
	let mut document = text[word_end + len + 1..].split(|&byte| byte == b'\n');
	let partial = document.next_back().unwrap_or_default();
	if document.any(terminates) {
		None
	} else if terminates(partial) {
		Some((text.len(), b"\n".to_vec()))
	} else if delimiter.starts_with(&partial[content(partial)..]) {
		// Empty, or the delimiter so far: it is the line that ends it.
		Some((text.len() - partial.len(), end(false)))
	} else {
		Some((text.len(), end(true)))
	}
}

/// Candidate cuts [`parsed_head`] tries, from the end.
const MAX_HEAD_CUTS: usize = 8;

/// The commands from `from`, the first command of `text` that fails, up to
/// its last list or pipeline operator before which it parses once closed:
/// what precedes a compound command still opening (`&& for f in`, `do\n
/// if`), which nothing appended completes. The rest stays literal, rather
/// than the whole command.
fn parsed_head(text: &[u8], from: Pos, fill: bool, budget: &Budget) -> Option<Repair> {
	let cuts = text
		.iter()
		.enumerate()
		.skip(from.offset as usize)
		.filter(|&(at, byte)| {
			matches!(byte, b';' | b'&' | b'|' | b'\n')
				&& (at == 0 || !matches!(text[at - 1], b';' | b'&' | b'|' | b'<' | b'>'))
		});
	for (at, &byte) in cuts.rev().take(MAX_HEAD_CUTS) {
		// A lone `&` backgrounds the head and a `;` ends it: both stay with it.
		let lone =
			matches!(byte, b';' | b'&') && !matches!(text.get(at + 1), Some(b'&' | b'>' | b';'));
		let end = if lone { at + 1 } else { at };
		// A cut inside quotes or `$(` leaves the head unterminated: it does
		// not parse.
		if let Some(head) = close(text[..end].to_vec(), end, from, false, fill, budget)
			&& !head.commands.is_empty()
		{
			return Some(head);
		}
	}
	None
}

/// The `)` an open arithmetic appends at most.
const PARENS: &[u8; 16] = b"))))))))))))))))";

/// An open arithmetic `((` or `$((` ending `text`: where it is cut, before a
/// trailing operator or `(` awaiting its operand, and the `)` closing what
/// is open in it, then it. Still empty, it is hidden whole.
fn open_arithmetic(text: &[u8]) -> Option<(usize, &'static [u8])> {
	let start = text.windows(2).rposition(|pair| pair == b"((")?;
	let open = start + 2;
	let cut = text
		.iter()
		.rposition(|byte| !b" \t+-*/%<>=&|^!~?:,(".contains(byte))
		.map_or(0, |at| at + 1)
		.max(open);
	if cut == open {
		let start = if start > 0 && text[start - 1] == b'$' {
			start - 1
		} else {
			start
		};
		return Some((start, b""));
	}
	let (mut depth, mut closed) = (0, 0);
	for &byte in &text[open..cut] {
		match byte {
			b'(' => depth += 1,
			b')' if depth > 0 => depth -= 1,
			b')' => closed += 1,
			_ => {},
		}
	}
	if closed >= 2 {
		return None;
	}
	Some((cut, PARENS.get(..depth + 2 - closed)?))
}

/// What closes the compound command opened by `keyword`, in the order
/// tried: its closer; a `:` filling its body still empty; the rest of its
/// header still arriving, with that body. An empty brace group is not
/// filled: drawn from no source, it would have no row of its own left.
fn completions(keyword: &str) -> &'static [&'static [u8]] {
	match keyword {
		"if" => &[b"\nfi", b"\n:\nfi", b"\nthen :\nfi"],
		"for" | "select" | "while" | "until" => &[b"\ndone", b"\n:\ndone", b"\ndo :\ndone"],
		"case" => &[b"\nesac", b"\nin\nesac", b")\nesac"],
		"{" => &[b"\n}"],
		"(" => &[b"\n)", b"\n:\n)"],
		"function" => &[b" {\n:\n}"],
		_ => &[b" ]]"],
	}
}

/// Whether `text` ends in a function header whose body is still to come:
/// `gen()`, `function gen`.
fn function_header(text: &[u8]) -> bool {
	let text = text.trim_ascii_end();
	if text.ends_with(b"()") {
		return true;
	}
	let mut words = text
		.rsplit(u8::is_ascii_whitespace)
		.filter(|word| !word.is_empty());
	words.next().is_some() && words.next() == Some(b"function")
}

/// Start and end of the compound command keyword ending `text` before
/// blanks with no header yet (`; for`, `&& while `), which no completion
/// closes.
fn bare_keyword(text: &[u8]) -> Option<(usize, usize)> {
	let end = text.iter().rposition(|byte| !byte.is_ascii_whitespace())? + 1;
	let at = text[..end]
		.iter()
		.rposition(|&byte| !(byte.is_ascii_lowercase() || byte == b'['))
		.map_or(0, |at| at + 1);
	let keyword =
		matches!(&text[at..end], b"if" | b"for" | b"select" | b"while" | b"until" | b"case" | b"[[");
	(keyword && command_position(text, at)).then_some((at, end))
}

/// Start of the `|`, `|&`, `&&` or `||` ending `text` before blanks: a
/// pipeline or list awaiting its next command.
fn dangling_operator(text: &[u8]) -> Option<usize> {
	let end = text.iter().rposition(|byte| !byte.is_ascii_whitespace())? + 1;
	let width = match &text[..end] {
		[.., b'&', b'&'] | [.., b'|', b'|' | b'&'] => 2,
		[.., b'|'] => 1,
		_ => return None,
	};
	let at = end - width;
	// An escaped `\|` is a word, not an operator.
	(!escaped(&text[..at])).then_some(at)
}

/// Whether the byte after `text` is escaped: `text` ends in an odd number
/// of backslashes (`\\` is an escaped backslash).
fn escaped(text: &[u8]) -> bool {
	text.iter().rev().take_while(|&&byte| byte == b'\\').count() % 2 == 1
}

/// Start of the redirection operator ending `text` before blanks, awaiting
/// its target. A leading fd stays: `2` reads as an argument, as it did
/// before the `>` arrived.
fn dangling_redirection(text: &[u8]) -> Option<usize> {
	let mut end = text.iter().rposition(|byte| !byte.is_ascii_whitespace())? + 1;
	if text[..end].ends_with(b"<<-") {
		end -= 1;
	}
	let at = text[..end]
		.iter()
		.rposition(|byte| !matches!(byte, b'<' | b'>' | b'&' | b'|'))
		.map_or(0, |at| at + 1);
	let operator = text[at..end].iter().any(|byte| matches!(byte, b'<' | b'>'));
	(operator && !escaped(&text[..at])).then_some(at)
}

/// Start of the command name ending `text` when it is so far a prefix of a
/// keyword the compound opened by `keyword` awaits (`d`, `do`, `don` in a
/// loop). Drawn as a command, it would vanish once the keyword completes.
fn awaited_prefix(text: &[u8], keyword: &str) -> Option<usize> {
	let awaited: &[&[u8]] = match keyword {
		"if" => &[b"then", b"fi", b"else", b"elif"],
		"for" | "select" | "while" | "until" => &[b"do", b"done"],
		"case" => &[b"esac"],
		_ => return None,
	};
	let at = text
		.iter()
		.rposition(|byte| !byte.is_ascii_lowercase())
		.map_or(0, |at| at + 1);
	let word = &text[at..];
	if word.is_empty() || !awaited.iter().any(|keyword| keyword.starts_with(word)) {
		return None;
	}
	// A body keyword (`then`, `do`, `else`) cannot be followed by the
	// closing one, but a case's `in` can.
	let before = text[..at].trim_ascii_end();
	let after_in = keyword == "case"
		&& before.len() < at
		&& before.ends_with(b"in")
		&& before[..before.len() - 2]
			.last()
			.is_some_and(u8::is_ascii_whitespace);
	(after_in || command_position(text, at)).then_some(at)
}

/// Whether a word starting at `at` is in command position: after a
/// separator, past blanks.
fn command_position(text: &[u8], at: usize) -> bool {
	let blanks = text[..at]
		.iter()
		.rev()
		.take_while(|byte| matches!(byte, b' ' | b'\t'))
		.count();
	text[..at - blanks]
		.last()
		.is_none_or(|byte| matches!(byte, b';' | b'\n' | b'&' | b'|' | b'(' | b'{'))
}

fn single(a: AndOr<'_>) -> Option<Command<'_>> {
	let first = a.first();
	if a.rest().len() != 0 || first.bang() || first.time().is_some() {
		return None;
	}
	first.stages().one()
}
fn root_command<'a>(unit: &super::runtime::SourceUnit<'a>) -> Option<Command<'a>> {
	match unit.syntax?.tree.view() {
		Root::List(list) => {
			let item = list.items().one()?;
			(!matches!(item.sep(), Sep::Amp | Sep::Disown)).then(|| single(item.and_or()))?
		},
		Root::Command(command) => Some(command),
		Root::Word(_) => None,
	}
}
fn single_list(l: List<'_>) -> Option<Command<'_>> {
	single(l.items().one()?.and_or())
}
fn guard_key(l: List<'_>, c: &Context<'_>) -> Option<NodeKey> {
	let a = l.items().last()?.and_or();
	let p = a.rest().last().map_or_else(|| a.first(), |(_, p)| p);
	p.stages().one().map(|cmd| c.key(cmd.id()))
}
fn is_simple(c: Command<'_>, name: &str, arg: Option<&str>) -> bool {
	let CommandKind::Simple(s) = c.kind() else {
		return false;
	};
	let words = s.words();
	c.redirs().is_empty()
		&& s.assigns().is_empty()
		&& command_name(s).as_deref() == Some(name)
		&& match arg {
			Some(a) => words.len() == 2 && words.get(1).and_then(literal).as_deref() == Some(a),
			None => words.len() > 1,
		}
}
fn timeout_duration(value: &str) -> bool {
	let digits = value.bytes().take_while(u8::is_ascii_digit).count();
	digits > 0
		&& (digits == value.len()
			|| digits + 1 == value.len() && matches!(value.as_bytes()[digits], b's' | b'm' | b'h'))
}
fn tail_count(s: Simple<'_>) -> Option<u32> {
	if !matches!(command_name(s).as_deref(), Some("head" | "tail")) || !s.assigns().is_empty() {
		return None;
	}
	let args = s
		.words()
		.iter()
		.skip(1)
		.map(literal)
		.collect::<Option<Vec<_>>>()?;
	let number = |value: &str| {
		(!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
			.then(|| value.parse::<u32>().ok())
			.flatten()
	};
	match args.as_slice() {
		[] => Some(10),
		[flag, n] if flag == "-n" => number(n),
		[flag] => flag
			.strip_prefix("-n")
			.or_else(|| flag.strip_prefix('-'))
			.and_then(number),
		_ => None,
	}
}
fn original_heredoc(
	context: &Context<'_>,
	span: Option<Span>,
	doc: HereDoc<'_>,
) -> (String, Option<Span>) {
	if let Some(span) = span
		&& let Some([start, end]) = context.map.bytes(span)
	{
		let stop = context
			.bytes
			.get(end..)
			.and_then(|tail| {
				tail
					.iter()
					.position(|byte| *byte == b'\n')
					.map(|count| end + count)
			})
			.unwrap_or(context.bytes.len());
		if let Some(bytes) = context.bytes.get(start..stop) {
			let full = Span::new(span.lo, span.hi.saturating_add((stop - end) as u32));
			return (String::from_utf8_lossy(bytes).into_owned(), Some(full));
		}
	}
	(String::from_utf8_lossy(doc.text()).into_owned(), None)
}
/// Each word's literal value; empty where it expands at run time.
fn literal_words(simple: Simple<'_>) -> Vec<String> {
	simple
		.words()
		.iter()
		.map(|word| literal(word).unwrap_or_default())
		.collect()
}
/// [`embedded::heredoc_language`] of `doc`, a heredoc of `command`.
fn heredoc_language(
	simple: Option<Simple<'_>>,
	command: Command<'_>,
	doc: HereDoc<'_>,
) -> &'static str {
	let targets = command
		.redirs()
		.iter()
		.filter(|redir| {
			matches!(
				redir.op(),
				RedirOp::Out
					| RedirOp::Append
					| RedirOp::Clobber
					| RedirOp::OutErr
					| RedirOp::AppendErr
					| RedirOp::AppendClobber
					| RedirOp::OutErrClobber
					| RedirOp::AppendErrClobber
			)
		})
		.filter_map(|redir| match redir.target() {
			RedirTarget::Word(word) => Some(literal_tail(word)),
			RedirTarget::HereDoc(_) => None,
		})
		.collect::<Vec<_>>();
	embedded::heredoc_language(
		&simple.map_or_default(literal_words),
		&targets,
		&String::from_utf8_lossy(doc.delim()),
		&String::from_utf8_lossy(doc.text()),
	)
}
fn fd_text(fd: Option<RedirFd<'_>>) -> String {
	match fd {
		None => String::new(),
		Some(RedirFd::Num(n)) => n.to_string(),
		Some(RedirFd::Var(v)) => format!("{{{}}}", String::from_utf8_lossy(v)),
	}
}
const fn redir_operator(op: RedirOp) -> &'static str {
	match op {
		RedirOp::In => "<",
		RedirOp::Out => ">",
		RedirOp::Append => ">>",
		RedirOp::Clobber => ">|",
		RedirOp::ReadWrite => "<>",
		RedirOp::DupIn => "<&",
		RedirOp::DupOut => ">&",
		RedirOp::OutErr => "&>",
		RedirOp::AppendErr => "&>>",
		RedirOp::HereDoc { strip_tabs: false } => "<<",
		RedirOp::HereDoc { strip_tabs: true } => "<<-",
		RedirOp::HereString => "<<<",
		RedirOp::AppendClobber => ">>|",
		RedirOp::OutErrClobber => "&>|",
		RedirOp::AppendErrClobber => "&>>|",
	}
}
fn test_words(words: Seq<'_, Word<'_>>, p: &WordPrinter<'_>) -> String {
	let values = words.iter().map(|w| p.word(w)).collect::<Vec<_>>();
	let literal_values = words
		.iter()
		.map(|w| literal(w).unwrap_or_default())
		.collect::<Vec<_>>();
	if words.len() == 2 {
		let op = literal_values[0].as_str();
		let function = match op {
			"-f" => Some("is_file"),
			"-d" => Some("is_dir"),
			"-e" => Some("exists"),
			"-s" => Some("has_content"),
			"-x" => Some("is_executable"),
			"-L" => Some("is_symlink"),
			_ => None,
		};
		if let Some(function) = function {
			return format!("{function}({})", values[1]);
		}
		if matches!(op, "-n" | "-z") {
			return format!("{} {} \"\"", values[1], if op == "-n" { "!=" } else { "==" });
		}
		if op == "!" {
			return format!("not {}", values[1]);
		}
	}
	if words.len() == 3 {
		let op = match literal_values[1].as_str() {
			"=" | "==" | "-eq" => "==",
			"!=" | "-ne" => "!=",
			"-lt" => "<",
			"-le" => "<=",
			"-gt" => ">",
			"-ge" => ">=",
			other => other,
		};
		return format!("{} {op} {}", values[0], values[2]);
	}
	values.join(" ")
}
pub(super) fn metadata(
	o: &super::runtime::Observation<'_>,
	safe_false: bool,
	leaf: bool,
) -> Option<String> {
	let mut parts = Vec::new();
	if !safe_false && o.status.is_some_and(|s| s != 0) {
		parts.push(format!("exit {}", o.status.unwrap()));
	}
	if leaf && o.duration_ns >= 5_000_000 {
		parts.push(if o.duration_ns >= 1_000_000_000 {
			format!("{:.2}s", o.duration_ns as f64 / 1e9)
		} else {
			format!("{}ms", o.duration_ns / 1_000_000)
		});
	}
	if let Some(n) = o.iteration.or(o.iterations) {
		parts.push(format!("↻ {n}"));
	}
	(!parts.is_empty()).then(|| parts.join(" · "))
}
fn append_observation(detail: &mut Option<String>, o: &super::runtime::Observation<'_>) {
	let text = detail.get_or_insert_default();
	let mut number = NumBuffer::new();
	if let Some(status) = o.status {
		text.push_str("\nexit status: ");
		text.push_str(status.format_into(&mut number));
	}
	if !o.argv.is_empty() {
		text.push_str("\nargv: ");
		for (index, argument) in o.argv.iter().enumerate() {
			if index > 0 {
				text.push(' ');
			}
			text.push_str(&String::from_utf8_lossy(argument.as_slice()));
		}
	}
	if !o.env.is_empty() {
		text.push_str("\nenv: ");
		for (index, (name, value)) in o.env.iter().enumerate() {
			if index > 0 {
				text.push(' ');
			}
			text.push_str(&String::from_utf8_lossy(name.as_slice()));
			text.push('=');
			text.push_str(&String::from_utf8_lossy(value.as_slice()));
		}
	}
	if let Some(pid) = o.pid {
		text.push_str("\npid: ");
		text.push_str(pid.format_into(&mut NumBuffer::new()));
	}
	if !o.pipeline.is_empty() {
		write!(text, "\npipeline status: {:?}", o.pipeline).expect("String writes are infallible");
	}
}
