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
	analysis::{self, Analysis, command_name, literal},
	embedded,
	model::*,
	raw,
	runtime::{Runtime, VizSource},
	source::{self, SourceMap},
	words::WordPrinter,
};
use crate::bash::{
	event::ResolvedKind,
	syntax::*,
	trace::{State, syntax::SyntaxTree},
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
	ahead:        HashMap<(usize, usize), Option<Arc<Ahead>>>,
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
		(Some(SyntaxTree::List(a)), Some(SyntaxTree::List(b))) => Arc::ptr_eq(a, b),
		(Some(SyntaxTree::Command(a)), Some(SyntaxTree::Command(b))) => Arc::ptr_eq(a, b),
		(Some(SyntaxTree::Word(a)), Some(SyntaxTree::Word(b))) => Arc::ptr_eq(a, b),
		_ => false,
	}
}
#[derive(Debug)]
struct Nested {
	body:     String,
	program:  Program,
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
	program:  Program,
	/// Source identity per command: one past its script byte offset.
	ids:      Vec<u32>,
	map:      SourceMap,
	analysis: Analysis,
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
					origin:   None,
					analysis: &analysis,
				};
				p.frame(unit.index, 0, "built at runtime · not in the command text", None);
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
	origin:   Option<ByteOrigins>,
	analysis: &'a Analysis,
}
impl Context<'_> {
	const fn key(&self, id: NodeId) -> NodeKey {
		NodeKey::nested(self.unit, self.source, id)
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
			if start > cursor {
				self.ahead(cursor, start.min(source.script().len()));
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
					origin:   None,
					analysis: self.analysis,
				};
				self.tree(&syntax.tree, &context, 0);
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
	/// or features this one lacks) and everything after that.
	fn ahead(&mut self, lo: usize, hi: usize) {
		if lo >= hi {
			return;
		}
		let source = self.source;
		let script: &[u8] = source.script().as_ref();
		let stop = (0..source.unit_count())
			.filter_map(|index| source.unit(index)?.at)
			.map(|at| at as usize)
			.filter(|at| (lo..hi).contains(at))
			.min()
			.unwrap_or(hi);
		let Some(ahead) = self.parsed_ahead(lo, stop) else {
			self.pending(&script[lo..hi], lo as u32, 0);
			return;
		};
		let bytes = &script[lo..stop];
		let mut cursor = 0;
		for (command, id) in ahead.program.commands.iter().zip(&ahead.ids) {
			let start = command.span.lo as usize;
			if start > cursor {
				self.pending(&bytes[cursor..start], (lo + cursor) as u32, 0);
			}
			let context = Context {
				unit: AHEAD,
				source: *id,
				bytes,
				map: ahead.map.clone(),
				untraced: None,
				origin: None,
				analysis: &ahead.analysis,
			};
			self.list(&command.list, &context, 0);
			cursor = command.span.hi as usize;
		}
		self.pending(&script[lo + cursor..hi], (lo + cursor) as u32, 0);
	}

	fn parsed_ahead(&self, lo: usize, hi: usize) -> Option<Arc<Ahead>> {
		if let Some(cached) = self.source.cache().inner.lock().ahead.get(&(lo, hi)) {
			return cached.clone();
		}
		let script: &[u8] = self.source.script().as_ref();
		let mut parser = Parser::new(&script[lo..hi], Features::NONE, NO_ALIASES);
		let mut commands = Vec::new();
		while let Some(Ok(command)) = parser.next_command() {
			commands.push(command);
		}
		let parsed = (!commands.is_empty()).then(|| {
			let program = Program { commands };
			let ids: Vec<u32> = program
				.commands
				.iter()
				.map(|command| lo as u32 + command.span.lo + 1)
				.collect();
			let mut analysis = analysis::program(&program, AHEAD, &ids);
			analysis.arithmetic = Arc::clone(&self.analysis.arithmetic);
			Arc::new(Ahead {
				map: source::script_map(self.source, lo, hi - lo),
				program,
				ids,
				analysis,
			})
		});
		self
			.source
			.cache()
			.inner
			.lock()
			.ahead
			.insert((lo, hi), parsed.clone());
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
		if !self.builtin(NodeKey::engine(first.index, a.id))
			|| !self.builtin(NodeKey::engine(middle.index, b.id))
			|| !self.builtin(NodeKey::engine(last.index, d.id))
		{
			return None;
		}
		if [(first.index, a.id), (middle.index, b.id), (last.index, d.id)]
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
			origin:   None,
			analysis: self.analysis,
		};
		let cb = Context {
			unit:     middle.index,
			source:   0,
			bytes:    middle.source.as_ref(),
			map:      source_map(source, &middle),
			untraced: None,
			origin:   None,
			analysis: self.analysis,
		};
		let cd = Context {
			unit:     last.index,
			source:   0,
			bytes:    last.source.as_ref(),
			map:      source_map(source, &last),
			untraced: None,
			origin:   None,
			analysis: self.analysis,
		};
		let CommandKind::Simple(simple) = &b.kind else {
			return None;
		};
		let mut segments = vec![self.segment(&cb, b.id, b.span, "load_env(", "fn", true)];
		for (index, word) in simple.words.iter().skip(1).enumerate() {
			if index > 0 {
				segments.push(self.segment(&cb, b.id, b.span, ", ", "op", true));
			}
			segments.extend(self.word_segments(word, &cb, "str"));
		}
		segments.push(self.segment(&cb, b.id, b.span, ") ", "op", true));
		let first_key = ca.key(a.id);
		let last_key = cd.key(d.id);
		let use_first = self.runtime.active(first_key)
			|| !self.runtime.active(last_key)
				&& self
					.runtime
					.observation(first_key)
					.is_some_and(|observation| observation.status.is_some_and(|status| status != 0));
		let mut badge = if use_first {
			self.segment(&ca, a.id, a.span, "exports all", "badge", true)
		} else {
			self.segment(&cd, d.id, d.span, "exports all", "badge", true)
		};
		badge.expanded = source
			.script()
			.get(start..end)
			.map(|bytes| String::from_utf8_lossy(bytes).into_owned());
		segments.push(badge);
		self.emit(&cb, b, 0, "stmt", segments, None);
		self.command_documents(b, simple, &cb, 0);
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
		cmd: &Command,
		depth: u32,
		role: &'static str,
		segments: Vec<Segment>,
		governor: Option<NodeKey>,
	) {
		let key = c.key(cmd.id);
		let mut row = Row {
			id: format!("row-{key}-{}", self.serial),
			depth,
			node: Some(key),
			range: c.map.range(cmd.span),
			role: Some(role),
			segments,
			detail: Some(c.text(cmd.span)),
			..Row::default()
		};
		self.serial += 1;
		if let Some(untraced) = c.untraced {
			row.detail.as_mut().unwrap().push_str(untraced);
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
		match tree {
			SyntaxTree::List(l) => self.list(l, c, depth),
			SyntaxTree::Command(cmd) => self.command(cmd, c, depth, false),
			SyntaxTree::Word(w) => {
				let s = self.segment(c, w.id, w.span, self.words(c).word(w), "str", false);
				self.rows.push(Row {
					id: format!("word-{}", c.key(w.id)),
					depth,
					node: Some(c.key(w.id)),
					range: c.map.range(w.span),
					role: Some("document"),
					segments: vec![s],
					..Row::default()
				});
			},
		}
	}

	fn list(&mut self, list: &List, c: &Context<'_>, depth: u32) {
		let mut i = 0;
		while i < list.items.len() {
			let item = &list.items[i];
			if self.options.layers.idioms && i + 2 < list.items.len() {
				let start = single(&item.and_or);
				let loader = single(&list.items[i + 1].and_or);
				let end = single(&list.items[i + 2].and_or);
				if let (Some(start), Some(loader), Some(end)) = (start, loader, end)
					&& is_simple(start, "set", Some("-a"))
					&& (is_simple(loader, ".", None) || is_simple(loader, "source", None))
					&& is_simple(end, "set", Some("+a"))
					&& self.builtin(c.key(start.id))
					&& self.builtin(c.key(loader.id))
					&& self.builtin(c.key(end.id))
					&& let CommandKind::Simple(simple) = &loader.kind
				{
					let path = simple
						.words
						.iter()
						.skip(1)
						.map(|w| self.words(c).word(w))
						.collect::<Vec<_>>()
						.join(", ");
					let text = format!("load_env({path}) exports all");
					let mut seg = self.segment(c, loader.id, loader.span, text, "fn badge", true);
					seg.expanded = Some(format!(
						"{}\n{}\n{}",
						c.text(start.span),
						c.text(loader.span),
						c.text(end.span)
					));
					self.emit(c, loader, depth, "stmt", vec![seg], Some(c.key(loader.id)));
					i += 3;
					continue;
				}
			}
			self.and_or(&item.and_or, c, depth, matches!(item.sep, Sep::Amp | Sep::Disown));
			i += 1;
		}
	}

	fn and_or(&mut self, a: &AndOr, c: &Context<'_>, depth: u32, background: bool) {
		if a.rest.is_empty() && a.first.stages.len() == 1 {
			let cmd = &a.first.stages[0].cmd;
			if !a.first.bang && a.first.time.is_none() {
				self.command(cmd, c, depth, background);
				return;
			}
		}
		let all_simple = std::iter::once(&a.first)
			.chain(a.rest.iter().map(|(_, p)| p))
			.all(|p| {
				p.stages.iter().all(|s| {
					matches!(
						s.cmd.kind,
						CommandKind::Simple(_) | CommandKind::Cond(_) | CommandKind::Arith(_)
					)
				})
			});
		if all_simple {
			// One row per pipeline: `and`/`or` lead each continuation row, so a
			// chain reads down the page and every command keeps its own status.
			let mut lead = Vec::new();
			if background {
				lead.push(self.segment(c, a.id, a.span, "spawn ", "kw", false));
			}
			lead.extend(self.pipeline(&a.first, c));
			let mut rows = vec![(&a.first, depth, lead)];
			for (index, (op, p)) in a.rest.iter().enumerate() {
				if self.options.layers.idioms
					&& index + 1 == a.rest.len()
					&& *op == AndOrOp::Or
					&& !p.bang
					&& p.time.is_none()
					&& p.stages.len() == 1
					&& self.builtin(c.key(p.stages[0].cmd.id))
					&& p.stages[0].cmd.redirs.is_empty()
					&& !self
						.options
						.expanded_nodes
						.contains(&c.key(p.stages[0].cmd.id))
					&& matches!(&p.stages[0].cmd.kind,CommandKind::Simple(s) if s.assigns.is_empty()&&s.words.len()==1&&matches!(command_name(s).as_deref(),Some("true"|":")))
				{
					let cmd = &p.stages[0].cmd;
					let mut s = self.segment(c, cmd.id, cmd.span, " may fail", "badge", true);
					s.expanded = Some(format!("|| {}", c.text(cmd.span)));
					if let Some((_, _, segments)) = rows.last_mut() {
						segments.push(s);
					}
				} else {
					let connector = if *op == AndOrOp::And { "and " } else { "or " };
					let mut segments = vec![self.segment(c, a.id, a.span, connector, "op", false)];
					segments.extend(self.pipeline(p, c));
					rows.push((p, depth + 1, segments));
				}
			}
			for (p, depth, segments) in rows {
				self.emit(c, &p.stages[0].cmd, depth, "stmt", segments, None);
				self.documents(p, c, depth);
			}
		} else {
			for (pi, p) in std::iter::once(&a.first)
				.chain(a.rest.iter().map(|(_, p)| p))
				.enumerate()
			{
				for (si, stage) in p.stages.iter().enumerate() {
					let start = self.rows.len();
					self.command(&stage.cmd, c, depth + u32::from(pi > 0 || si > 0), background);
					let connector = if si > 0 {
						if p.stages[si - 1].pipe_stderr {
							"→& "
						} else {
							"→ "
						}
					} else if pi > 0 {
						if a.rest[pi - 1].0 == AndOrOp::And {
							"and "
						} else {
							"or "
						}
					} else {
						""
					};
					let mut prefix = connector.to_owned();
					if si == 0 && p.bang {
						prefix.push_str("not ");
					}
					if si == 0 && p.time.is_some() {
						prefix.push_str("timed ");
					}
					if !prefix.is_empty() {
						let segment = self.segment(c, p.id, p.span, prefix, "op", false);
						if let Some(row) = self.rows.get_mut(start) {
							row.segments.insert(0, segment);
						}
					}
				}
			}
		}
	}

	fn pipeline(&self, p: &Pipeline, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		if p.bang {
			out.push(self.segment(c, p.id, p.span, "not ", "kw", false));
		}
		if p.time.is_some() {
			out.push(self.segment(c, p.id, p.span, "timed ", "badge", false));
		}
		for (i, stage) in p.stages.iter().enumerate() {
			let cmd = &stage.cmd;
			let fold = self.options.layers.idioms
				&& self
					.runtime
					.observation(c.key(cmd.id))
					.is_none_or(|observation| observation.resolved != Some(ResolvedKind::Function))
				&& !self.options.expanded_nodes.contains(&c.key(cmd.id))
				&& i > 0
				&& i + 1 == p.stages.len()
				&& cmd.redirs.is_empty()
				&& matches!(&cmd.kind,CommandKind::Simple(s) if tail_count(s).is_some());
			if fold {
				if let CommandKind::Simple(s) = &cmd.kind {
					let count = tail_count(s).unwrap_or(10);
					let mut seg = self.segment(
						c,
						cmd.id,
						cmd.span,
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
					seg.expanded = Some(format!("| {}", c.text(cmd.span)));
					out.push(seg);
				}
				continue;
			}
			if i > 0 {
				out.push(self.segment(
					c,
					p.id,
					p.span,
					if p.stages[i - 1].pipe_stderr {
						" →& "
					} else {
						" → "
					},
					"op",
					false,
				));
			}
			out.extend(self.inline_command(cmd, c));
		}
		out
	}

	fn inline_command(&self, cmd: &Command, c: &Context<'_>) -> Vec<Segment> {
		if self.outside_projection(cmd, c) {
			return Vec::new();
		}
		match &cmd.kind {
			CommandKind::Simple(s) => self.simple(cmd, s, c),
			CommandKind::Cond(cond) => {
				vec![self.segment(c, cmd.id, cmd.span, self.words(c).condition(cond), "var", true)]
			},
			CommandKind::Arith(a) => {
				vec![self.segment(c, cmd.id, cmd.span, self.arithmetic(&a.src, false), "var", true)]
			},
			_ => vec![self.segment(c, cmd.id, cmd.span, c.text(cmd.span), "kw", false)],
		}
	}

	fn simple(&self, cmd: &Command, s: &Simple, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		let name = command_name(s).unwrap_or_default();
		let values = s
			.words
			.iter()
			.map(|w| literal(w).unwrap_or_else(|| self.words(c).word(w)))
			.collect::<Vec<_>>();
		let expanded = self.options.expanded_nodes.contains(&c.key(cmd.id));
		let idioms = self.options.layers.idioms && !expanded;
		if s.words.is_empty() {
			for (i, a) in s.assigns.iter().enumerate() {
				if i > 0 {
					out.push(self.segment(c, cmd.id, cmd.span, ", ", "op", true));
				}
				let mut segment =
					self.segment(c, cmd.id, a.span, self.words(c).assignment(a), "var def", true);
				segment.node = Some(c.key(a.id));
				out.push(segment);
			}
			out.extend(self.redirections(cmd, s, c));
			return out;
		}
		if !s.assigns.is_empty() {
			out.push(self.segment(
				c,
				cmd.id,
				cmd.span,
				format!(
						"env({}) ",
						s.assigns
							.iter()
							.map(|a| self.words(c).assignment(a))
							.collect::<Vec<_>>()
							.join(", ")
					),
				"chip env",
				true,
			));
		}
		if idioms && self.builtin(c.key(cmd.id)) && name == "cd" && s.words.len() == 2 {
			let mut seg =
				self.segment(c, cmd.id, cmd.span, format!("cwd {}", values[1]), "badge", true);
			seg.expanded = Some(c.text(cmd.span));
			out.push(seg);
			return out;
		}
		if idioms && self.builtin(c.key(cmd.id)) && name == "set" && s.words.len() == 2 {
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
				let mut seg =
					self.segment(c, cmd.id, cmd.span, format!("# {meaning}"), "comment badge", true);
				seg.expanded = Some(c.text(cmd.span));
				out.push(seg);
				return out;
			}
		}
		if idioms
			&& self
				.runtime
				.observation(c.key(cmd.id))
				.is_none_or(|observation| observation.resolved != Some(ResolvedKind::Function))
			&& name == "curl"
			&& values.iter().any(|v| v == "%{http_code}")
			&& values.iter().any(|v| v == "/dev/null")
			&& let Some(w) = s.words.iter().find(|w| {
				literal(w).is_some_and(|v| {
					v.starts_with("http:") || v.starts_with("https:") || v.starts_with("localhost")
				})
			}) {
			out.push(self.segment(c, cmd.id, cmd.span, "http_status(", "fn badge", true));
			out.extend(self.word_segments(w, c, "str"));
			out.push(self.segment(c, cmd.id, cmd.span, ")", "op", true));
			return out;
		}
		let resolved = self
			.runtime
			.observation(c.key(cmd.id))
			.and_then(|o| o.resolved);
		let builtin = !matches!(
			resolved,
			Some(ResolvedKind::External | ResolvedKind::Function | ResolvedKind::NotFound)
		);
		if builtin && matches!(name.as_str(), "echo" | "printf") {
			out.push(self.segment(c, cmd.id, cmd.span, "print(", "fn", true));
			let mut first = true;
			for (i, w) in s.words.iter().enumerate().skip(1) {
				if i == 1
					&& literal(w).is_some_and(|v| {
						v.len() > 1
							&& v.starts_with('-')
							&& v[1..].chars().all(|ch| matches!(ch, 'n' | 'e' | 'E'))
					}) {
					continue;
				}
				if !first {
					out.push(self.segment(c, cmd.id, cmd.span, ", ", "op", true));
				}
				first = false;
				out.extend(self.word_segments(w, c, "str"));
			}
			out.push(self.segment(c, cmd.id, cmd.span, ")", "op", true));
		} else if builtin && matches!(name.as_str(), "[" | "test") {
			out.push(self.segment(
				c,
				cmd.id,
				cmd.span,
				test_words(
					&s.words[1..if name == "[" {
						s.words.len().saturating_sub(1)
					} else {
						s.words.len()
					}],
					&self.words(c),
				),
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
				cmd.id,
				cmd.span,
				format!("{}(", if name == "." { "source" } else { &name }),
				"fn",
				true,
			));
			for (i, w) in s.words.iter().enumerate().skip(1) {
				if i > 1 {
					out.push(self.segment(c, cmd.id, cmd.span, ", ", "op", true));
				}
				out.extend(self.word_segments(w, c, "str"));
			}
			out.push(self.segment(c, cmd.id, cmd.span, ")", "op", true));
		} else {
			let start = if idioms
				&& resolved != Some(ResolvedKind::Function)
				&& name == "timeout"
				&& values.len() > 2
				&& timeout_duration(&values[1])
			{
				out.push(self.segment(
					c,
					cmd.id,
					cmd.span,
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
			for (i, w) in s.words.iter().enumerate().skip(start) {
				if i > start {
					out.push(self.segment(c, cmd.id, cmd.span, " ", "", true));
				}
				let language = embedded::argument_language(&name, &values, i);
				let nested = self.nested(cmd, s, w, i, c);
				if self.options.layers.unwrap && nested {
					let mut seg = self.segment(c, w.id, w.span, "⟦script ↓⟧", "chip emb", true);
					seg.expanded = Some(c.text(w.span));
					out.push(seg);
				} else if self.options.layers.unwrap {
					if let (Some(language), Some(value)) = (language, literal(w)) {
						if value.contains('\n') || value.len() > 64 {
							let mut seg =
								self.segment(c, w.id, w.span, format!("⟦{language} ↓⟧"), "chip emb", true);
							seg.expanded = Some(c.text(w.span));
							out.push(seg);
						} else {
							out.push(self.segment(c, w.id, w.span, "‹", "emb", true));
							out.extend(embedded::highlight(
								&value,
								language,
								c.key(w.id),
								c.map.range(w.span),
								self.options.layers,
							));
							out.push(self.segment(c, w.id, w.span, "›", "emb", true));
						}
					} else {
						out.extend(self.word_segments(w, c, if i == start { "cmd" } else { "arg" }));
					}
				} else {
					out.extend(self.literal_segments(w, c, if i == start { "cmd" } else { "str" }));
				}
			}
		}
		out.extend(self.redirections(cmd, s, c));
		out
	}

	fn word_segments(&self, w: &Word, c: &Context<'_>, style: &str) -> Vec<Segment> {
		let key = c.key(w.id);
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
		let mut seg = self.segment(c, w.id, w.span, text, if inline { "chip" } else { style }, false);
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
					.chain(std::iter::once(c.text(w.span)))
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

	fn literal_segments(&self, word: &Word, c: &Context<'_>, style: &str) -> Vec<Segment> {
		if c.source == 0
			&& self.source.unit(c.unit as usize).is_some_and(|unit| {
				unit.at.is_some() && unit.syntax.is_some_and(|syntax| syntax.parent.is_none())
			})
			&& let Some(range) = c.map.range(word.span)
			&& let Some(segments) =
				raw::literal(self.source, self.runtime, self.options, self.analysis, range)
		{
			return segments;
		}
		let key = c.key(word.id);
		let owner = c.analysis.owners.get(&key).copied().unwrap_or(key);
		let mut segment = self.segment(c, owner.node, word.span, c.text(word.span), style, true);
		segment.node = Some(key);
		vec![segment]
	}

	fn redirections(&self, cmd: &Command, s: &Simple, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		let args = arguments_with_redirs(s, cmd);
		let name = command_name(s).unwrap_or_default();
		for redir in &cmd.redirs {
			let text = match &redir.target {
				RedirTarget::HereDoc(doc) => {
					if self.options.layers.unwrap {
						format!(
							" ⟵ {} ↓",
							embedded::heredoc_language(&name, &args, &String::from_utf8_lossy(&doc.delim))
						)
					} else {
						let fd = fd_text(redir.fd.as_ref());
						format!(
							" {fd}{}{}",
							redir_operator(redir.op),
							String::from_utf8_lossy(&doc.delim_raw)
						)
					}
				},
				RedirTarget::Word(w) => {
					let raw_target = literal(w);
					if self.options.layers.idioms && raw_target.as_deref() == Some("/dev/null") {
						format!(
							" 🔇 {}",
							if matches!(redir.op, RedirOp::OutErr | RedirOp::AppendErr) {
								"silent"
							} else if matches!(redir.fd, Some(RedirFd::Num(2))) {
								"err"
							} else {
								"out"
							}
						)
					} else if self.options.layers.idioms
						&& matches!(redir.fd, Some(RedirFd::Num(2)))
						&& redir.op == RedirOp::DupOut
						&& raw_target.as_deref() == Some("1")
					{
						" +err".into()
					} else {
						format!(
							" {}{}{}",
							fd_text(redir.fd.as_ref()),
							redir_operator(redir.op),
							if self.options.layers.idioms {
								literal(w).unwrap_or_else(|| self.words(c).word(w))
							} else {
								c.text(w.span)
							}
						)
					}
				},
			};
			out.push(self.segment(
				c,
				cmd.id,
				redir.span,
				text,
				if self.options.layers.idioms {
					"redir badge"
				} else {
					"redir"
				},
				true,
			));
		}
		out
	}

	fn command(&mut self, cmd: &Command, c: &Context<'_>, depth: u32, background: bool) {
		if self.outside_projection(cmd, c) {
			self.projected_children(cmd, c, depth);
			return;
		}
		let key = c.key(cmd.id);
		if let CommandKind::Simple(s) = &cmd.kind {
			if self.options.layers.inline
				&& s.words.is_empty()
				&& s.assigns.len() == 1
				&& cmd.redirs.is_empty()
				&& !self.options.expanded_nodes.contains(&key)
				&& c
					.analysis
					.variables
					.get(String::from_utf8_lossy(&s.assigns[0].name).as_ref())
					.is_some_and(|v| v.inline)
			{
				return;
			}
			let mut segments = self.simple(cmd, s, c);
			if background {
				segments.insert(0, self.segment(c, cmd.id, cmd.span, "spawn ", "kw", false));
			}
			self.emit(c, cmd, depth, "stmt", segments, Some(key));
			self.command_documents(cmd, s, c, depth);
			return;
		}
		let row_start = self.rows.len();
		match &cmd.kind {
			CommandKind::If(v) => {
				for (i, arm) in v.arms.iter().enumerate() {
					let mut seg = vec![self.segment(
						c,
						cmd.id,
						cmd.span,
						if i == 0 { "if " } else { "elif " },
						"kw",
						false,
					)];
					seg.extend(self.inline_list(&arm.cond, c));
					seg.push(self.segment(c, cmd.id, cmd.span, ":", "op", false));
					self.emit(c, cmd, depth, "head", seg, guard_key(&arm.cond, c));
					self.condition_meta(
						&arm.cond,
						c,
						false,
						(v.arms.len() == 1).then_some(c.key(cmd.id)),
					);
					self.list(&arm.body, c, depth + 1);
				}
				if let Some(body) = &v.else_body {
					self.emit(
						c,
						cmd,
						depth,
						"mid",
						vec![self.segment(c, cmd.id, cmd.span, "else:", "kw", false)],
						None,
					);
					self.list(body, c, depth + 1);
				}
			},
			CommandKind::While(v) => {
				let mut seg = vec![self.segment(
					c,
					cmd.id,
					cmd.span,
					if v.until { "while not " } else { "while " },
					"kw",
					false,
				)];
				let read = single_list(&v.cond).and_then(|cmd| {
					if let CommandKind::Simple(s) = &cmd.kind {
						(command_name(s).as_deref() == Some("read")).then_some((cmd, s))
					} else {
						None
					}
				});
				if let Some((read_cmd, read)) = read {
					let vars = read
						.words
						.iter()
						.skip(1)
						.filter_map(literal)
						.filter(|s| !s.starts_with('-'))
						.collect::<Vec<_>>()
						.join(", ");
					seg = vec![self.segment(
						c,
						read_cmd.id,
						read_cmd.span,
						format!("for {vars} in lines:"),
						"kw",
						true,
					)];
				} else {
					seg.extend(self.inline_list(&v.cond, c));
					seg.push(self.segment(c, cmd.id, cmd.span, ":", "op", false));
				}
				self.emit(c, cmd, depth, "head", seg, guard_key(&v.cond, c));
				self.condition_meta(&v.cond, c, v.until, Some(c.key(cmd.id)));
				self.list(&v.body, c, depth + 1);
			},
			CommandKind::For(v) | CommandKind::Select(v) => {
				let mut segments = vec![self.segment(
					c,
					cmd.id,
					cmd.span,
					if matches!(cmd.kind, CommandKind::Select(_)) {
						"select "
					} else {
						"for "
					},
					"kw",
					false,
				)];
				let names = std::iter::once(v.var.as_slice())
					.chain(v.extra_vars.iter().map(Vec::as_slice))
					.map(String::from_utf8_lossy)
					.collect::<Vec<_>>()
					.join(", ");
				segments.push(self.segment(c, cmd.id, v.var_span, names, "var def", false));
				segments.push(self.segment(c, cmd.id, cmd.span, " in ", "kw", false));
				segments.extend(self.loop_items(v, cmd, c));
				segments.push(self.segment(c, cmd.id, cmd.span, ":", "op", false));
				self.emit(c, cmd, depth, "head", segments, None);
				self.list(&v.body, c, depth + 1);
			},
			CommandKind::ArithFor(v) => {
				let init = if v.init.src.trim_ascii().is_empty() {
					"None".into()
				} else {
					self.arithmetic(&v.init.src, true)
				};
				let condition = if v.cond.src.trim_ascii().is_empty() {
					"True".into()
				} else {
					self.arithmetic(&v.cond.src, true)
				};
				let step = if v.step.src.trim_ascii().is_empty() {
					"None".into()
				} else {
					self.arithmetic(&v.step.src, true)
				};
				let text = format!(
					"for _ in arithmetic_loop(init=lambda: {init}, condition=lambda: {condition}, \
					 step=lambda: {step}):"
				);
				let mut head = self.segment(c, cmd.id, cmd.span, text, "kw", false);
				head.tip = Some(
					"Initialize once; test before each iteration; step after normal completion and \
					 continue, but not break or return."
						.into(),
				);
				head.expanded = Some(c.text(cmd.span));
				self.emit(c, cmd, depth, "head", vec![head], None);
				self.list(&v.body, c, depth + 1);
			},
			CommandKind::Case(v) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(
						c,
						cmd.id,
						cmd.span,
						format!("match {}:", self.words(c).word(&v.word)),
						"kw",
						false,
					)],
					None,
				);
				for arm in &v.arms {
					let patterns = arm
						.patterns
						.iter()
						.map(|w| self.words(c).word(w))
						.collect::<Vec<_>>()
						.join(" | ");
					self.emit(
						c,
						cmd,
						depth + 1,
						"head",
						vec![self.segment(c, cmd.id, cmd.span, format!("case {patterns}:"), "kw", false)],
						None,
					);
					self.list(&arm.body, c, depth + 2);
					if arm.term != CaseTerm::Break {
						self.emit(
							c,
							cmd,
							depth + 2,
							"tail",
							vec![self.segment(
								c,
								cmd.id,
								cmd.span,
								if arm.term == CaseTerm::FallThrough {
									"fallthrough"
								} else {
									"continue matching"
								},
								"kw",
								false,
							)],
							None,
						);
					}
				}
			},
			CommandKind::FuncDef(v) => {
				let name = String::from_utf8_lossy(&v.name);
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
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(c, cmd.id, cmd.span, format!("def {name}({args}):"), "fn", false)],
					None,
				);
				if let CommandKind::Brace(body) = &v.body.kind {
					self.list(body, c, depth + 1);
				} else {
					self.command(&v.body, c, depth + 1, false);
				}
			},
			CommandKind::Brace(body) => {
				if background || !cmd.redirs.is_empty() {
					let mut head = vec![self.segment(
						c,
						cmd.id,
						cmd.span,
						if background {
							"spawn:"
						} else {
							"redirected block:"
						},
						"kw",
						false,
					)];
					head.extend(self.redirections(cmd, &Simple::default(), c));
					self.emit(c, cmd, depth, "head", head, None);
					self.list(body, c, depth + 1);
				} else {
					self.list(body, c, depth);
				}
			},
			CommandKind::Subshell(body) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(c, cmd.id, cmd.span, "subshell:", "kw", false)],
					None,
				);
				self.list(body, c, depth + 1);
			},
			CommandKind::Coproc(v) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(
						c,
						cmd.id,
						cmd.span,
						format!(
								"coprocess {}:",
								v.name
									.as_deref().map_or_else(|| "COPROC".into(), String::from_utf8_lossy)
							),
						"kw",
						false,
					)],
					None,
				);
				self.command(&v.body, c, depth + 1, false);
			},
			CommandKind::Repeat(v) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(
						c,
						cmd.id,
						cmd.span,
						format!("repeat {}:", self.words(c).word(&v.count)),
						"kw",
						false,
					)],
					None,
				);
				self.list(&v.body, c, depth + 1);
			},
			CommandKind::Try(v) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(c, cmd.id, cmd.span, "try:", "kw", false)],
					None,
				);
				self.list(&v.body, c, depth + 1);
				self.emit(
					c,
					cmd,
					depth,
					"mid",
					vec![self.segment(c, cmd.id, cmd.span, "finally:", "kw", false)],
					None,
				);
				self.list(&v.always, c, depth + 1);
			},
			CommandKind::AnonFunc(v) => {
				self.emit(
					c,
					cmd,
					depth,
					"head",
					vec![self.segment(c, cmd.id, cmd.span, "call anonymous:", "fn", false)],
					None,
				);
				self.command(&v.body, c, depth + 1, false);
			},
			CommandKind::Cond(_) | CommandKind::Arith(_) => {
				let segments = self.inline_command(cmd, c);
				self.emit(c, cmd, depth, "stmt", segments, Some(key));
			},
			CommandKind::Simple(_) => unreachable!(),
		}
		if background && !matches!(cmd.kind, CommandKind::Brace(_)) {
			let prefix = self.segment(c, cmd.id, cmd.span, "spawn ", "kw", false);
			if let Some(row) = self.rows.get_mut(row_start) {
				row.segments.insert(0, prefix);
			}
		}
		if !cmd.redirs.is_empty() {
			let simple = Simple::default();
			if !matches!(cmd.kind, CommandKind::Brace(_)) {
				let redirs = self.redirections(cmd, &simple, c);
				if let Some(row) = self.rows.get_mut(row_start) {
					row.segments.extend(redirs);
				}
			}
			self.command_documents(cmd, &simple, c, depth);
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

	fn outside_projection(&self, command: &Command, context: &Context<'_>) -> bool {
		context.source == 0
			&& self
				.source
				.unit(context.unit as usize)
				.is_some_and(|unit| unit.projection > 0)
			&& context.map.bytes(command.span).is_none()
	}

	fn projected_children(&mut self, command: &Command, context: &Context<'_>, depth: u32) {
		match &command.kind {
			CommandKind::Brace(list) | CommandKind::Subshell(list) => self.list(list, context, depth),
			CommandKind::If(branch) => {
				for arm in &branch.arms {
					self.list(&arm.cond, context, depth);
					self.list(&arm.body, context, depth);
				}
				if let Some(body) = &branch.else_body {
					self.list(body, context, depth);
				}
			},
			CommandKind::While(loop_) => {
				self.list(&loop_.cond, context, depth);
				self.list(&loop_.body, context, depth);
			},
			CommandKind::For(loop_) | CommandKind::Select(loop_) => {
				self.list(&loop_.body, context, depth);
			},
			CommandKind::ArithFor(loop_) => self.list(&loop_.body, context, depth),
			CommandKind::Case(case) => {
				for arm in &case.arms {
					self.list(&arm.body, context, depth);
				}
			},
			CommandKind::FuncDef(function) => self.command(&function.body, context, depth, false),
			CommandKind::Coproc(coproc) => self.command(&coproc.body, context, depth, false),
			CommandKind::Repeat(loop_) => self.list(&loop_.body, context, depth),
			CommandKind::Try(attempt) => {
				self.list(&attempt.body, context, depth);
				self.list(&attempt.always, context, depth);
			},
			CommandKind::AnonFunc(function) => self.command(&function.body, context, depth, false),
			CommandKind::Simple(_) | CommandKind::Arith(_) | CommandKind::Cond(_) => {},
		}
	}

	fn loop_items(&self, loop_: &For, cmd: &Command, c: &Context<'_>) -> Vec<Segment> {
		let Some(words) = &loop_.words else {
			return vec![self.segment(c, cmd.id, cmd.span, "args", "var", false)];
		};
		if let [word] = words.as_slice() {
			if matches!(word.parts.as_slice(),[WordPart::Lit(bytes)]if bytes.iter().any(|b|matches!(*b,b'*'|b'?'|b'[')))
			{
				return vec![self.segment(
					c,
					word.id,
					word.span,
					format!(
						"glob({})",
						super::words::quote(&literal(word).unwrap_or_else(|| c.text(word.span)))
					),
					"fn",
					false,
				)];
			}
			if let [WordPart::Comsub(sub)] = word.parts.as_slice()
				&& let Some(sequence) = single_list(&sub.body)
				&& let CommandKind::Simple(simple) = &sequence.kind
				&& command_name(simple).as_deref() == Some("seq")
				&& self.builtin(c.key(sequence.id))
				&& let Some(args) = simple
					.words
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
					return vec![self.segment(c, word.id, word.span, range, "num", false)];
				}
			}
		}
		let count =
			if self.options.layers.inline && !self.options.expanded_nodes.contains(&c.key(cmd.id)) {
				words.len().min(2)
			} else {
				words.len()
			};
		let mut segments = vec![self.segment(c, cmd.id, cmd.span, "[", "op", false)];
		for (index, word) in words.iter().take(count).enumerate() {
			if index > 0 {
				segments.push(self.segment(c, cmd.id, cmd.span, ", ", "op", false));
			}
			segments.extend(self.word_segments(word, c, "str"));
		}
		if count < words.len() {
			segments.push(self.segment(c, cmd.id, cmd.span, ", ", "op", false));
			let mut more = self.segment(
				c,
				cmd.id,
				cmd.span,
				format!("+{} more", words.len() - count),
				"chip",
				false,
			);
			more.expanded = Some(
				words
					.iter()
					.map(|word| c.text(word.span))
					.collect::<Vec<_>>()
					.join(" "),
			);
			more.tip = Some(
				words
					.iter()
					.map(|word| c.text(word.span))
					.collect::<Vec<_>>()
					.join("\n"),
			);
			segments.push(more);
		}
		segments.push(self.segment(c, cmd.id, cmd.span, "]", "op", false));
		segments
	}

	fn condition_meta(
		&mut self,
		list: &List,
		c: &Context<'_>,
		until: bool,
		parent: Option<NodeKey>,
	) {
		let Some(item) = list.items.last() else {
			return;
		};
		let pipeline_status = |pipeline: &Pipeline| -> Option<i32> {
			if let Some(status) = self
				.runtime
				.observation(c.key(pipeline.id))
				.and_then(|o| o.status)
			{
				return Some(status);
			}
			if pipeline.stages.len() != 1 {
				return None;
			}
			let status = self
				.runtime
				.observation(c.key(pipeline.stages[0].cmd.id))?
				.status?;
			Some(if pipeline.bang {
				i32::from(status == 0)
			} else {
				status
			})
		};
		let mut status = pipeline_status(&item.and_or.first);
		for (op, pipeline) in &item.and_or.rest {
			status = match status {
				Some(status)
					if (*op == AndOrOp::And && status == 0) || (*op == AndOrOp::Or && status != 0) =>
				{
					pipeline_status(pipeline)
				},
				other => other,
			};
		}
		let condition = c.key(item.and_or.id);
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

	fn inline_list(&self, list: &List, c: &Context<'_>) -> Vec<Segment> {
		let mut out = Vec::new();
		for (i, item) in list.items.iter().enumerate() {
			if i > 0 {
				out.push(self.segment(c, item.and_or.id, item.and_or.span, "; ", "op", false));
			}
			out.extend(self.pipeline(&item.and_or.first, c));
			for (op, p) in &item.and_or.rest {
				out.push(self.segment(
					c,
					item.and_or.id,
					item.and_or.span,
					if *op == AndOrOp::And { " and " } else { " or " },
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

	fn close_frame(&mut self, unit: u32, depth: u32, range: Option<[u32; 2]>) {
		self.rows.push(Row {
			id: format!("frame-end-{unit}-{}", self.serial),
			depth,
			range,
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

	fn frame(&mut self, unit: u32, depth: u32, title: &str, range: Option<[u32; 2]>) {
		self.rows.push(Row {
			id: format!("frame-{unit}-{}", self.serial),
			depth,
			range,
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

	fn nested(&self, cmd: &Command, s: &Simple, w: &Word, index: usize, c: &Context<'_>) -> bool {
		if !self.options.layers.unwrap {
			return false;
		}
		let key = c.key(w.id);
		if c.source == 0
			&& self.analysis.children.contains_key(&key)
			&& self
				.runtime
				.observation(c.key(cmd.id))
				.is_none_or(|observation| observation.resolved != Some(ResolvedKind::External))
		{
			return true;
		}
		let Some((body_index, remote)) = shell_body(s) else {
			return false;
		};
		if index != body_index {
			return false;
		}
		let external = c.untraced.is_some()
			|| self
				.runtime
				.observation(c.key(cmd.id))
				.is_some_and(|o| o.resolved == Some(ResolvedKind::External));
		if c.source == 0
			&& remote
			&& self.runtime.observation(c.key(cmd.id)).is_some_and(|o| {
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
					let [start, _] = c.map.bytes(w.span)?;
					let origins = source::literal_map(c.map.raw(c.bytes, w.span), body.as_bytes())?;
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
				let map = c
					.map
					.nested(w.span, c.bytes, body.as_bytes(), 0)
					.unwrap_or_else(|| SourceMap::unlocated(0, body.len()));
				let mut facts = analysis::program(&program, c.unit, &ids);
				facts.arithmetic = Arc::clone(&self.analysis.arithmetic);
				Some(Arc::new(Nested {
					body,
					program,
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

	fn documents(&mut self, p: &Pipeline, c: &Context<'_>, depth: u32) {
		for stage in &p.stages {
			if let CommandKind::Simple(s) = &stage.cmd.kind {
				self.command_documents(&stage.cmd, s, c, depth);
			}
		}
	}

	fn command_documents(&mut self, cmd: &Command, s: &Simple, c: &Context<'_>, depth: u32) {
		let name = command_name(s).unwrap_or_default();
		let args = arguments_with_redirs(s, cmd);
		for (i, w) in s.words.iter().enumerate() {
			if self.options.layers.unwrap && self.nested(cmd, s, w, i, c) {
				self.nested_document(cmd, w, c, depth);
				continue;
			}
			if self.options.layers.unwrap
				&& let (Some(language), Some(value)) =
					(embedded::argument_language(&name, &args, i), literal(w))
				&& (value.contains('\n') || value.len() > 64)
			{
				self.document(
					&value,
					language,
					c,
					w.id,
					Some(w.span),
					depth + 1,
					Some("inline argument"),
				);
			}
		}
		let doc_spans = {
			let mut cache = self.source.cache().inner.lock();
			Arc::clone(
				cache
					.docs
					.entry(c.key(cmd.id))
					.or_insert_with(|| Arc::new(source::heredoc_spans(&c.map, c.bytes, &cmd.redirs))),
			)
		};
		for (index, redir) in cmd.redirs.iter().enumerate() {
			if let RedirTarget::HereDoc(doc) = &redir.target {
				let body = String::from_utf8_lossy(&doc.text);
				let doc_span = doc_spans.get(index).copied().flatten();
				if self.options.layers.unwrap {
					let language =
						embedded::heredoc_language(&name, &args, &String::from_utf8_lossy(&doc.delim));
					self.document(
						body.strip_suffix('\n').unwrap_or(&body),
						language,
						c,
						cmd.id,
						doc_span,
						depth + 1,
						Some(&format!(
							"heredoc «{}»{}",
							String::from_utf8_lossy(&doc.delim),
							if !doc.quoted && body.contains('$') {
								" · $vars expand"
							} else {
								""
							}
						)),
					);
				} else {
					let (original, span) = original_heredoc(c, doc_span, doc);
					self.document(&original, "text", c, cmd.id, span, depth + 1, None);
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
		if let Some(title) = title {
			self.rows.push(Row {
				id: format!("doc-head-{}-{}", c.key(id), self.serial),
				depth,
				node: Some(c.key(id)),
				range,
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

	fn nested_document(&mut self, command: &Command, w: &Word, c: &Context<'_>, depth: u32) {
		let range = c.map.range(w.span);
		let native = c.source == 0
			&& self.analysis.children.contains_key(&c.key(w.id))
			&& self
				.runtime
				.observation(c.key(command.id))
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
				.get(&c.key(w.id))
				.and_then(Clone::clone)
		};
		if let Some(nested) = nested {
			let title = if nested.remote {
				"remote/untraced: no per-command remote outcomes"
			} else {
				"external/untraced: no per-command inner outcomes"
			};
			self.frame(c.unit, depth + 1, title, range);
			let map = nested.map.clone();
			for (cc, id) in nested.program.commands.iter().zip(&nested.ids) {
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
					origin:   Some(nested.origin.clone()),
					analysis: &nested.analysis,
				};
				self.list(&cc.list, &context, depth + 1);
			}
			self.close_frame(c.unit, depth + 1, range);
			return;
		}
		// Actual local children use engine-retained syntax only, never a
		// speculative parse.
		let mut children = self
			.analysis
			.children
			.get(&c.key(w.id))
			.into_iter()
			.flatten()
			.filter_map(|index| self.source.unit(*index as usize))
			.collect::<Vec<_>>();
		children.sort_by_key(|u| (u.line, u.index));
		if children.is_empty() {
			return;
		}
		self.frame(c.unit, depth + 1, "local shell script", range);
		let body = literal(w);
		let body_map = body
			.as_ref()
			.and_then(|body| c.map.nested(w.span, c.bytes, body.as_bytes(), 0));
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
		self.close_frame(c.unit, depth + 1, range);
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
fn single(a: &AndOr) -> Option<&Command> {
	(a.rest.is_empty() && a.first.stages.len() == 1 && !a.first.bang && a.first.time.is_none())
		.then(|| &a.first.stages[0].cmd)
}
fn root_command<'a>(unit: &super::runtime::SourceUnit<'a>) -> Option<&'a Command> {
	match &unit.syntax?.tree {
		SyntaxTree::List(list)
			if list.items.len() == 1 && !matches!(list.items[0].sep, Sep::Amp | Sep::Disown) =>
		{
			single(&list.items[0].and_or)
		},
		SyntaxTree::Command(command) => Some(command),
		_ => None,
	}
}
fn single_list(l: &List) -> Option<&Command> {
	(l.items.len() == 1)
		.then(|| single(&l.items[0].and_or))
		.flatten()
}
fn guard_key(l: &List, c: &Context<'_>) -> Option<NodeKey> {
	let a = &l.items.last()?.and_or;
	let p = a.rest.last().map_or(&a.first, |(_, p)| p);
	(p.stages.len() == 1).then(|| c.key(p.stages[0].cmd.id))
}
fn is_simple(c: &Command, name: &str, arg: Option<&str>) -> bool {
	matches!(&c.kind,CommandKind::Simple(s) if c.redirs.is_empty()&&s.assigns.is_empty()&&command_name(s).as_deref()==Some(name)&&match arg{Some(a)=>s.words.len()==2&&s.words.get(1).and_then(literal).as_deref()==Some(a),None=>s.words.len()>1})
}
fn timeout_duration(value: &str) -> bool {
	let digits = value.bytes().take_while(u8::is_ascii_digit).count();
	digits > 0
		&& (digits == value.len()
			|| digits + 1 == value.len() && matches!(value.as_bytes()[digits], b's' | b'm' | b'h'))
}
fn tail_count(s: &Simple) -> Option<u32> {
	if !matches!(command_name(s).as_deref(), Some("head" | "tail")) || !s.assigns.is_empty() {
		return None;
	}
	let args = s
		.words
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
	doc: &HereDoc,
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
	(String::from_utf8_lossy(&doc.text).into_owned(), None)
}
fn arguments_with_redirs(simple: &Simple, command: &Command) -> Vec<String> {
	let mut args = simple
		.words
		.iter()
		.map(|word| literal(word).unwrap_or_default())
		.collect::<Vec<_>>();
	args.extend(
		command
			.redirs
			.iter()
			.filter(|redir| {
				matches!(
					redir.op,
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
			.filter_map(|redir| match &redir.target {
				RedirTarget::Word(word) => literal(word),
				RedirTarget::HereDoc(_) => None,
			}),
	);
	args
}
fn fd_text(fd: Option<&RedirFd>) -> String {
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
fn test_words(words: &[Word], p: &WordPrinter<'_>) -> String {
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
fn shell_body(s: &Simple) -> Option<(usize, bool)> {
	let args = s
		.words
		.iter()
		.map(|word| literal(word).unwrap_or_default())
		.collect::<Vec<_>>();
	let name = args.first()?.rsplit('/').next()?;
	if name == "ssh" {
		let mut i = 1;
		while i < args.len() {
			if args[i] == "--" {
				i += 1;
				break;
			}
			if !args[i].starts_with('-') {
				break;
			}
			let flag = args[i].as_bytes().get(1).copied();
			if matches!(
				flag,
				Some(
					b'p'
						| b'i'
						| b'l'
						| b'o'
						| b'J'
						| b'F'
						| b'S'
						| b'L'
						| b'R'
						| b'D'
						| b'W'
						| b'b'
						| b'c'
						| b'E'
						| b'e'
						| b'm'
						| b'O'
						| b'Q'
						| b'w'
				)
			) && args[i].len() == 2
			{
				i += 1;
			}
			i += 1;
		}
		return (i + 2 == args.len()).then_some((i + 1, true));
	}
	for (i, arg) in args.iter().enumerate() {
		if matches!(arg.rsplit('/').next(), Some("bash" | "sh" | "zsh" | "dash" | "ksh")) {
			for (j, flag) in args.iter().enumerate().skip(i + 1) {
				if flag.starts_with('-') && flag[1..].contains('c') {
					return (j + 1 < args.len()).then_some((j + 1, false));
				}
				if !flag.starts_with('-') {
					break;
				}
			}
		}
	}
	None
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
