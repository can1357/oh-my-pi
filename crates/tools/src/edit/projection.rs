//! Pure model-facing edit response projection.

use std::{collections::VecDeque, ops::Range, sync::Arc};

use bytes::Bytes;
use omp_core::{Hash32, Str, StrMut, sf};
use omp_edit::diff_string::PinnedMyersWindow;

use super::ResolvedBlock;

const DEFAULT_SOURCE_REVISIONS: usize = 8;
const DEFAULT_PROJECTION_WINDOWS: usize = 16;

/// Edit grammar which produced one streaming projection.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ProjectionDialect {
	/// Native hashline sections.
	Hashline,
	/// Codex `*** Begin Patch` envelopes.
	ApplyPatch,
	/// Sloppy section and inline rewrite syntax.
	Sloppy,
}

/// Complete-operation matcher facts for one argument prefix.
#[derive(Clone, Debug)]
pub struct ProjectionMatcher {
	dialect: ProjectionDialect,
	digest:  Hash32,
	parent:  Option<Hash32>,
	paths:   Arc<[Str]>,
	entries: usize,
}

impl ProjectionMatcher {
	/// Builds matcher facts from the bytes covered by complete parsed entries.
	///
	/// `matcher` must exclude the incomplete trailing entry. Consequently, new
	/// raw argument fragments which do not complete another entry retain the
	/// same digest and entry count.
	pub fn new<I, P>(dialect: ProjectionDialect, matcher: &[u8], paths: I, entries: usize) -> Self
	where
		I: IntoIterator<Item = P>,
		P: Into<Str>,
	{
		Self {
			dialect,
			digest: Hash32::sum(matcher),
			parent: None,
			paths: paths.into_iter().map(Into::into).collect::<Vec<_>>().into(),
			entries,
		}
	}

	/// Builds matcher facts for the next observed argument fragment.
	///
	/// `matcher` still covers only complete entries, so `entries` may be
	/// unchanged when the new fragment extends an incomplete trailing entry.
	/// The parent digest prevents a cache shared by concurrent invocations from
	/// seeding a later projection from an unrelated matcher with the same path
	/// and entry count.
	pub fn fragment<I, P>(previous: &Self, matcher: &[u8], paths: I, entries: usize) -> Self
	where
		I: IntoIterator<Item = P>,
		P: Into<Str>,
	{
		Self {
			dialect: previous.dialect,
			digest: Hash32::sum(matcher),
			parent: Some(previous.digest),
			paths: paths.into_iter().map(Into::into).collect::<Vec<_>>().into(),
			entries,
		}
	}

	/// Edit grammar represented by this matcher.
	pub const fn dialect(&self) -> ProjectionDialect {
		self.dialect
	}

	/// Digest of the complete matcher prefix.
	pub const fn digest(&self) -> Hash32 {
		self.digest
	}

	/// Digest of the immediately preceding complete matcher, when known.
	pub const fn parent_digest(&self) -> Option<Hash32> {
		self.parent
	}

	/// Canonical paths discovered in authored order.
	pub fn paths(&self) -> &[Str] {
		&self.paths
	}

	/// Number of complete parsed entries represented by the digest.
	pub const fn entries(&self) -> usize {
		self.entries
	}
}

fn same_matcher(left: &ProjectionMatcher, right: &ProjectionMatcher) -> bool {
	left.dialect == right.dialect
		&& left.digest == right.digest
		&& left.paths == right.paths
		&& left.entries == right.entries
}

/// Canonical document identity for one cached source revision.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionRevision {
	/// Canonical source path.
	pub path:     Str,
	/// Opaque document revision which names the exact bytes.
	pub revision: Str,
}

impl ProjectionRevision {
	/// Creates a source revision identity.
	pub fn new(path: impl Into<Str>, revision: impl Into<Str>) -> Self {
		Self { path: path.into(), revision: revision.into() }
	}
}

/// Result of looking up a retained streaming projection.
pub enum ProjectionLookup<'a> {
	/// This exact complete matcher was already projected.
	Cached(&'a PinnedMyersWindow),
	/// More argument bytes arrived, but no additional complete entry exists.
	Pending,
	/// A new complete entry may be projected onto this retained predecessor.
	Advance(PinnedMyersWindow),
}

struct SourceRevision {
	key:   ProjectionRevision,
	bytes: Bytes,
}

struct ProjectionWindow {
	matcher:   ProjectionMatcher,
	revisions: Arc<[ProjectionRevision]>,
	window:    PinnedMyersWindow,
}

/// Bounded call-site cache for source bytes and monotonic edit projections.
///
/// Source content is keyed by canonical path plus the document owner's opaque
/// revision, never by path alone. Projection windows additionally key on the
/// dialect, matcher digest, discovered paths, complete-entry count, and ordered
/// source revisions. This lets hashline, apply-patch, and sloppy streaming
/// renderers share the same cache without reparsing journal prose or re-reading
/// an unchanged document.
pub struct ProjectionCache {
	source_limit:     usize,
	projection_limit: usize,
	sources:          VecDeque<SourceRevision>,
	projections:      VecDeque<ProjectionWindow>,
}

impl Default for ProjectionCache {
	fn default() -> Self {
		Self::with_limits(DEFAULT_SOURCE_REVISIONS, DEFAULT_PROJECTION_WINDOWS)
	}
}

impl ProjectionCache {
	/// Creates a cache with the default bounded capacities.
	pub fn new() -> Self {
		Self::default()
	}

	/// Creates a cache with explicit capacities, clamped to the built-in bounds.
	pub fn with_limits(source_revisions: usize, projection_windows: usize) -> Self {
		let source_limit = source_revisions.clamp(1, DEFAULT_SOURCE_REVISIONS);
		let projection_limit = projection_windows.clamp(1, DEFAULT_PROJECTION_WINDOWS);
		Self {
			source_limit,
			projection_limit,
			sources: VecDeque::with_capacity(source_limit),
			projections: VecDeque::with_capacity(projection_limit),
		}
	}

	/// Returns exact cached bytes for `revision`.
	pub fn source(&self, revision: &ProjectionRevision) -> Option<&Bytes> {
		self
			.sources
			.iter()
			.find(|source| &source.key == revision)
			.map(|source| &source.bytes)
	}

	/// Returns a zero-copy range of exact cached bytes for `revision`.
	pub fn source_chunk(&self, revision: &ProjectionRevision, range: Range<usize>) -> Option<Bytes> {
		let bytes = self.source(revision)?;
		(range.start <= range.end && range.end <= bytes.len()).then(|| bytes.slice(range))
	}

	/// Retains exact source bytes under their document revision.
	///
	/// Re-inserting the same key replaces its bytes. Evicting a source also
	/// evicts projections which depend on it, preventing a retained window from
	/// being reused without its pinned base.
	pub fn insert_source(&mut self, revision: ProjectionRevision, bytes: Bytes) {
		if let Some(index) = self
			.sources
			.iter()
			.position(|source| source.key == revision)
		{
			self.sources.remove(index);
			self
				.projections
				.retain(|projection| !projection.revisions.contains(&revision));
		}
		while self.sources.len() >= self.source_limit {
			if let Some(evicted) = self.sources.pop_front() {
				self
					.projections
					.retain(|projection| !projection.revisions.contains(&evicted.key));
			}
		}
		self
			.sources
			.push_back(SourceRevision { key: revision, bytes });
	}

	/// Looks up an exact projection or seeds the next complete prefix.
	///
	/// A predecessor is eligible only when its digest is the requested
	/// matcher's immediate parent and its dialect, paths, and source revisions
	/// are prefixes of the requested facts. An exact complete prefix returns
	/// [`ProjectionLookup::Cached`]; a changed matcher with the same entry count
	/// returns [`ProjectionLookup::Pending`]. Neither case lets a partial
	/// trailing operation reach the diff.
	pub fn lookup(
		&self,
		matcher: &ProjectionMatcher,
		revisions: &[ProjectionRevision],
	) -> ProjectionLookup<'_> {
		if revisions
			.iter()
			.any(|revision| self.source(revision).is_none())
		{
			return ProjectionLookup::Advance(PinnedMyersWindow::new());
		}
		if let Some(projection) = self.projections.iter().find(|projection| {
			same_matcher(&projection.matcher, matcher) && projection.revisions.as_ref() == revisions
		}) {
			return ProjectionLookup::Cached(&projection.window);
		}

		let predecessor = matcher.parent.and_then(|parent| {
			self.projections.iter().find(|projection| {
				projection.matcher.dialect == matcher.dialect
					&& projection.matcher.digest == parent
					&& matcher.paths.starts_with(&projection.matcher.paths)
					&& revisions.starts_with(&projection.revisions)
			})
		});
		match predecessor {
			Some(projection) if projection.matcher.entries >= matcher.entries => {
				ProjectionLookup::Pending
			},
			Some(projection) => ProjectionLookup::Advance(projection.window.clone()),
			None => ProjectionLookup::Advance(PinnedMyersWindow::new()),
		}
	}

	/// Commits a successfully computed projection for exact future reuse.
	///
	/// Returns `false` without retaining the window when any named source
	/// revision is absent.
	pub fn insert_projection(
		&mut self,
		matcher: ProjectionMatcher,
		revisions: Arc<[ProjectionRevision]>,
		window: PinnedMyersWindow,
	) -> bool {
		if revisions
			.iter()
			.any(|revision| self.source(revision).is_none())
		{
			return false;
		}
		if let Some(index) = self.projections.iter().position(|projection| {
			same_matcher(&projection.matcher, &matcher) && projection.revisions == revisions
		}) {
			self.projections.remove(index);
		}
		while self.projections.len() >= self.projection_limit {
			self.projections.pop_front();
		}
		self
			.projections
			.push_back(ProjectionWindow { matcher, revisions, window });
		true
	}
}

/// File-level outcome rendered for one hashline section.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SectionOp {
	/// The file was removed by `REM`.
	Delete,
	/// The patch applied cleanly without changing bytes.
	Noop,
	/// Content was updated and/or moved.
	Update,
}

/// Borrowed facts needed to render one section.
#[derive(Clone, Copy, Debug)]
pub struct SectionView<'a> {
	/// Durable section outcome.
	pub op:                SectionOp,
	/// Authored/resolved source path.
	pub path:              &'a str,
	/// Post-edit hashline header for updates.
	pub header:            &'a str,
	/// Escalation-aware diagnostic for a no-op.
	pub noop_diagnostic:   &'a str,
	/// Destination path for `MV`.
	pub move_dest:         Option<&'a str>,
	/// Compact numbered current-file preview.
	pub preview:           &'a str,
	/// Concrete spans selected by block locators.
	pub block_resolutions: &'a [ResolvedBlock],
}

/// Renders one section's exact model-facing success/diagnostic text.
pub fn render_section(view: SectionView<'_>) -> Str {
	match view.op {
		SectionOp::Delete => return sf!("Deleted {}", view.path),
		SectionOp::Noop => return Str::new(view.noop_diagnostic),
		SectionOp::Update => {},
	}

	let estimated = view.header.len() + view.preview.len() + view.block_resolutions.len() * 80;
	let mut output = StrMut::with_capacity(estimated);
	output.push_str(view.header);
	for resolution in view.block_resolutions {
		output.push('\n');
		output.push_str(&format_block_resolution(resolution));
	}
	if let Some(destination) = view.move_dest {
		output.push_str("\nMoved to ");
		output.push_str(destination);
	}
	if !view.preview.is_empty() {
		output.push('\n');
		output.push_str(view.preview);
	}
	output.freeze()
}

/// Joins independently rendered section responses with a single blank row.
pub fn render_sections(sections: &[Str]) -> Str {
	let capacity =
		sections.iter().map(Str::len).sum::<usize>() + sections.len().saturating_sub(1) * 2;
	let mut output = StrMut::with_capacity(capacity);
	for (index, section) in sections.iter().enumerate() {
		if index > 0 {
			output.push_str("\n\n");
		}
		output.push_str(section);
	}
	output.freeze()
}

/// Formats one syntax-aware block resolution using authored locator
/// coordinates.
pub fn format_block_resolution(resolution: &ResolvedBlock) -> Str {
	let label = match resolution.operation.as_str() {
		"replace" => format!("PUT {}*:", resolution.anchor_line),
		"insert_after" => format!("PUT >{}*:", resolution.anchor_line),
		"cut" => format!("CUT {}*", resolution.anchor_line),
		"paste_after" => format!("PUT >{}*", resolution.anchor_line),
		operation => format!("{operation} {}", resolution.anchor_line),
	};
	let lines = resolution.end - resolution.start + 1;
	let span = if resolution.start == resolution.end {
		format!("line {}", resolution.start)
	} else {
		format!("lines {}-{}", resolution.start, resolution.end)
	};
	let suffix = match resolution.operation.as_str() {
		"insert_after" => format!("; body lands after line {}", resolution.end),
		"paste_after" => format!("; clipboard lands after line {}", resolution.end),
		_ => String::new(),
	};
	format!("{label} → resolved {span} ({lines} line{}){suffix}", if lines == 1 { "" } else { "s" })
		.into()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn matcher(input: &str, entries: usize) -> ProjectionMatcher {
		ProjectionMatcher::new(ProjectionDialect::Hashline, input.as_bytes(), ["src/lib.rs"], entries)
	}

	#[test]
	fn cache_reuses_revision_bytes_and_returns_zero_copy_chunks() {
		let mut cache = ProjectionCache::new();
		let revision = ProjectionRevision::new("src/lib.rs", "rev-1");
		cache.insert_source(revision.clone(), Bytes::from_static(b"alpha\nbeta\n"));
		assert_eq!(cache.source(&revision).unwrap().as_ref(), b"alpha\nbeta\n");
		assert_eq!(cache.source_chunk(&revision, 6..10).unwrap().as_ref(), b"beta");
		assert!(cache.source_chunk(&revision, 10..20).is_none());
	}

	#[test]
	fn matcher_exposes_digest_paths_and_complete_entries() {
		let matcher = ProjectionMatcher::new(
			ProjectionDialect::Sloppy,
			b"complete matcher",
			["src/a.rs", "src/b.rs"],
			3,
		);
		assert_eq!(matcher.dialect(), ProjectionDialect::Sloppy);
		assert_eq!(matcher.digest(), Hash32::sum(b"complete matcher"));
		assert_eq!(matcher.parent_digest(), None);
		assert_eq!(matcher.paths().iter().map(Str::as_str).collect::<Vec<_>>(), vec![
			"src/a.rs", "src/b.rs"
		]);
		assert_eq!(matcher.entries(), 3);
	}

	#[test]
	fn projection_cache_retains_monotonic_predecessor_and_drops_partial_tail() {
		let mut cache = ProjectionCache::new();
		let revision = ProjectionRevision::new("src/lib.rs", "rev-1");
		cache.insert_source(revision.clone(), Bytes::from_static(b"a\nb\nc\n"));
		let revisions: Arc<[ProjectionRevision]> = vec![revision].into();

		let first_matcher = matcher("one complete op", 1);
		let ProjectionLookup::Advance(mut first) = cache.lookup(&first_matcher, &revisions) else {
			panic!("first complete entry must start a projection");
		};
		first.advance("rev-1", "a\nb\nc\n", "a\nB\nc\n", None);
		let first_text = first.text().to_owned();
		assert!(cache.insert_projection(first_matcher.clone(), Arc::clone(&revisions), first,));

		let ProjectionLookup::Cached(cached) = cache.lookup(&first_matcher, &revisions) else {
			panic!("exact matcher must hit");
		};
		assert_eq!(cached.text(), first_text);

		assert!(matches!(
			cache.lookup(&matcher("one complete op", 1), &revisions),
			ProjectionLookup::Cached(_)
		));
		let partial_fragment =
			ProjectionMatcher::fragment(&first_matcher, b"one complete op", ["src/lib.rs"], 1);
		assert!(matches!(cache.lookup(&partial_fragment, &revisions), ProjectionLookup::Cached(_)));
		let rewritten_same_generation =
			ProjectionMatcher::fragment(&first_matcher, b"rewritten complete op", ["src/lib.rs"], 1);
		assert!(matches!(
			cache.lookup(&rewritten_same_generation, &revisions),
			ProjectionLookup::Pending
		));

		let second_matcher =
			ProjectionMatcher::fragment(&first_matcher, b"two complete ops", ["src/lib.rs"], 2);
		let ProjectionLookup::Advance(mut second) = cache.lookup(&second_matcher, &revisions) else {
			panic!("a new complete entry must advance its predecessor");
		};
		second.advance("rev-1", "a\nb\nc\n", "prefix\na\nB\nc\n", None);
		assert!(second.text().starts_with(&first_text));
	}

	#[test]
	fn dialects_do_not_share_projection_windows() {
		let mut cache = ProjectionCache::new();
		let revision = ProjectionRevision::new("src/lib.rs", "rev-1");
		cache.insert_source(revision.clone(), Bytes::from_static(b"a\n"));
		let revisions: Arc<[ProjectionRevision]> = vec![revision].into();
		let hashline =
			ProjectionMatcher::new(ProjectionDialect::Hashline, b"complete", ["src/lib.rs"], 1);
		let ProjectionLookup::Advance(mut window) = cache.lookup(&hashline, &revisions) else {
			panic!("first projection must advance");
		};
		window.advance("rev-1", "a\n", "A\n", None);
		assert!(cache.insert_projection(hashline, Arc::clone(&revisions), window));

		for dialect in [ProjectionDialect::ApplyPatch, ProjectionDialect::Sloppy] {
			let matcher = ProjectionMatcher::new(dialect, b"complete", ["src/lib.rs"], 1);
			let ProjectionLookup::Advance(fresh) = cache.lookup(&matcher, &revisions) else {
				panic!("dialects must not reuse another dialect's projection");
			};
			assert!(fresh.text().is_empty());
		}
	}

	#[test]
	fn source_revision_change_cannot_reuse_an_old_projection() {
		let mut cache = ProjectionCache::with_limits(1, 4);
		let old = ProjectionRevision::new("src/lib.rs", "rev-1");
		let new = ProjectionRevision::new("src/lib.rs", "rev-2");
		cache.insert_source(old.clone(), Bytes::from_static(b"a\n"));
		let old_revisions: Arc<[ProjectionRevision]> = vec![old.clone()].into();
		let old_matcher = matcher("one complete op", 1);
		let ProjectionLookup::Advance(mut window) = cache.lookup(&old_matcher, &old_revisions) else {
			panic!("first projection must advance");
		};
		window.advance("rev-1", "a\n", "A\n", None);
		assert!(cache.insert_projection(old_matcher, old_revisions, window));

		cache.insert_source(new.clone(), Bytes::from_static(b"x\n"));
		assert!(cache.source(&old).is_none());
		let new_revisions = [new];
		let ProjectionLookup::Advance(fresh) =
			cache.lookup(&matcher("two complete ops", 2), &new_revisions)
		else {
			panic!("new source revision must start a fresh projection");
		};
		assert!(fresh.text().is_empty());
	}

	#[test]
	fn renders_update_delete_move_and_blocks_exactly() {
		let resolution = ResolvedBlock {
			anchor_line: 4,
			start:       4,
			end:         7,
			operation:   "insert_after".into(),
		};
		assert_eq!(
			render_section(SectionView {
				op:                SectionOp::Update,
				path:              "src/old.rs",
				header:            "[src/new.rs#1A2B]",
				noop_diagnostic:   "",
				move_dest:         Some("src/new.rs"),
				preview:           "4:fn f() {\n8:after();",
				block_resolutions: &[resolution],
			}),
			"[src/new.rs#1A2B]\nPUT >4*: → resolved lines 4-7 (4 lines); body lands after line \
			 7\nMoved to src/new.rs\n4:fn f() {\n8:after();"
		);
		assert_eq!(
			render_section(SectionView {
				op:                SectionOp::Delete,
				path:              "src/old.rs",
				header:            "",
				noop_diagnostic:   "",
				move_dest:         None,
				preview:           "",
				block_resolutions: &[],
			}),
			"Deleted src/old.rs"
		);
	}

	#[test]
	fn formats_every_block_operation_label_exactly() {
		for (operation, expected) in [
			("replace", "PUT 9*: → resolved line 9 (1 line)"),
			("insert_after", "PUT >9*: → resolved line 9 (1 line); body lands after line 9"),
			("cut", "CUT 9* → resolved line 9 (1 line)"),
			("paste_after", "PUT >9* → resolved line 9 (1 line); clipboard lands after line 9"),
		] {
			assert_eq!(
				format_block_resolution(&ResolvedBlock {
					anchor_line: 9,
					start:       9,
					end:         9,
					operation:   operation.into(),
				}),
				expected
			);
		}
	}

	#[test]
	fn joins_section_results_with_one_blank_row() {
		assert_eq!(
			render_sections(&["[a.rs#1A2B]\n1:A".into(), "Deleted b.rs".into()]),
			"[a.rs#1A2B]\n1:A\n\nDeleted b.rs"
		);
	}
}
