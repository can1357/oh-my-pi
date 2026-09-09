//! Model-facing behavioral contracts for `read@2`.

use std::{
	collections::VecDeque,
	env,
	fmt::Write as _,
	fs,
	future::{Future, ready},
	ops::Range,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use bytes::Bytes;
use dashmap::DashMap;
use futures::StreamExt as _;
use omp_ar::zip;
use omp_core::{CowBytes, Str, sf};
use omp_tool::{
	Abort, ArtifactLifetime, BlobRef, CallOutcome, CapsBase, Diag, DiagKind, Ev, IncomingParams,
	Interrupt, ModelClass, Part, PromptCaps, RecordedCall, Rev, Severity, Tool, ToolTerminal, Unit,
};
use omp_tools::read::{
	self, DirectoryEntry, DirectorySource, Fault, ReadBlobs, ReadLease, ReadSources, SnapshotRecord,
	SourceKind, SourceStat, StoredArtifact,
	resolver::{
		ArtifactCatalog, ArtifactRecord, ArtifactResolver, BlobAuthority, BlobStat, LineOffsetCache,
		Resolve, ResolverTable, Scheme, SchemeEntry,
	},
	selector::ParsedSelector,
	web::types::{HttpClient, HttpRequest, HttpResponse, WebError},
};
use parking_lot::Mutex;
use serde_json::json;
use tokio::time;

#[derive(Clone)]
struct FileSource {
	stat:     SourceStat,
	bytes:    Bytes,
	revision: Str,
}

#[derive(Clone, Default)]
struct Sources {
	files:     Arc<DashMap<String, FileSource>>,
	dirs:      Arc<DashMap<String, (SourceStat, DirectorySource)>>,
	suffixes:  Arc<DashMap<String, SourceStat>>,
	snapshots: Arc<Mutex<Vec<SnapshotRecord>>>,
	responses: Arc<Mutex<VecDeque<Result<HttpResponse, WebError>>>>,
}

#[derive(Clone)]
struct Lease {
	canonical_path: Str,
	revision:       Str,
	bytes:          Bytes,
}

impl ReadLease for Lease {
	fn revision(&self) -> &Str {
		&self.revision
	}

	fn canonical_path(&self) -> &Str {
		&self.canonical_path
	}

	fn read_all(&self) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		ready(Ok(self.bytes.clone()))
	}
}

impl ReadSources for Sources {
	type Lease = Lease;

	fn stat(&self, path: Str) -> impl Future<Output = Result<SourceStat, Fault>> + Send + '_ {
		let result = self
			.files
			.get(path.as_str())
			.map(|source| source.stat.clone())
			.or_else(|| self.dirs.get(path.as_str()).map(|entry| entry.0.clone()))
			.ok_or_else(|| Fault::source(format!("Path '{path}' not found")));
		ready(result)
	}

	fn resolve_suffix(
		&self,
		path: Str,
	) -> impl Future<Output = Result<Option<SourceStat>, Fault>> + Send + '_ {
		ready(Ok(self.suffixes.get(path.as_str()).map(|stat| stat.clone())))
	}

	fn open(&self, path: Str) -> impl Future<Output = Result<Self::Lease, Fault>> + Send + '_ {
		let result = self
			.files
			.get(path.as_str())
			.map(|source| Lease {
				canonical_path: path.clone(),
				revision:       source.revision.clone(),
				bytes:          source.bytes.clone(),
			})
			.ok_or_else(|| Fault::source(format!("Path '{path}' not found")));
		ready(result)
	}

	fn read_bytes(&self, path: Str) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		let result = self
			.files
			.get(path.as_str())
			.map(|source| source.bytes.clone())
			.ok_or_else(|| Fault::source(format!("Path '{path}' not found")));
		ready(result)
	}

	fn list_directory(
		&self,
		path: Str,
		_max_depth: usize,
	) -> impl Future<Output = Result<DirectorySource, Fault>> + Send + '_ {
		let result = self
			.dirs
			.get(path.as_str())
			.map(|entry| entry.1.clone())
			.ok_or_else(|| Fault::source(format!("Path '{path}' not found")));
		ready(result)
	}

	fn record_snapshot(&self, record: SnapshotRecord) -> Result<Option<Str>, Fault> {
		self.snapshots.lock().push(record);
		Ok(Some(sf!("A1B2")))
	}
}

impl HttpClient for Sources {
	fn get(
		&self,
		_request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		ready(
			self
				.responses
				.lock()
				.pop_front()
				.unwrap_or_else(|| Err(WebError::request("web fixture not configured"))),
		)
	}
}

#[derive(Clone, Default)]
struct Blobs {
	stored: Arc<Mutex<Vec<(Bytes, Str)>>>,
}

impl ReadBlobs for Blobs {
	fn store(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_ {
		self.stored.lock().push((bytes.clone(), media_type.clone()));
		ready(Ok(BlobRef { hash: sf!("blob-hash"), media_type, byte_len: bytes.len() as u64 }))
	}

	fn store_artifact(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, Fault>> + Send + '_ {
		self.stored.lock().push((bytes.clone(), media_type.clone()));
		ready(Ok(StoredArtifact {
			blob: BlobRef { hash: sf!("blob-hash"), media_type, byte_len: bytes.len() as u64 },
			uri:  sf!("artifact://1"),
		}))
	}
}

#[derive(Clone)]
struct StaticResolver {
	bytes: CowBytes<'static>,
	lines: Arc<LineOffsetCache>,
	calls: Arc<AtomicU64>,
}

impl Resolve for StaticResolver {
	fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a {
		assert_eq!(resource, "7");
		self.calls.fetch_add(1, Ordering::Relaxed);
		let result = match selector {
			ParsedSelector::Lines { ranges, .. } => {
				let [range] = ranges.as_ref() else {
					panic!("fixture expects one merged range")
				};
				self
					.lines
					.slice("artifact-7", &self.bytes, *range)
					.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })
			},
			_ => Ok(self.bytes.clone()),
		};
		ready(result)
	}
}

#[derive(Clone)]
struct ArtifactCatalogFixture {
	record: ArtifactRecord,
}

impl ArtifactCatalog for ArtifactCatalogFixture {
	fn by_ordinal(
		&self,
		ordinal: u64,
	) -> impl Future<Output = Result<Option<ArtifactRecord>, Fault>> + Send + '_ {
		ready(Ok((ordinal == 7).then(|| self.record.clone())))
	}

	fn by_digest<'a>(
		&'a self,
		digest: &'a str,
	) -> impl Future<Output = Result<Option<ArtifactRecord>, Fault>> + Send + 'a {
		ready(Ok((digest == self.record.digest.as_str()).then(|| self.record.clone())))
	}
}

#[derive(Clone)]
struct BlobAuthorityFixture {
	bytes:  CowBytes<'static>,
	stats:  Arc<AtomicU64>,
	ranges: Arc<Mutex<Vec<Range<u64>>>>,
}

impl BlobAuthority for BlobAuthorityFixture {
	fn stat<'a>(
		&'a self,
		_digest: &'a str,
	) -> impl Future<Output = Result<BlobStat, Fault>> + Send + 'a {
		self.stats.fetch_add(1, Ordering::Relaxed);
		ready(Ok(BlobStat { byte_len: self.bytes.len() as u64 }))
	}

	fn read_range<'a>(
		&'a self,
		_digest: &'a str,
		range: Range<u64>,
	) -> impl Future<Output = Result<CowBytes<'static>, Fault>> + Send + 'a {
		self.ranges.lock().push(range.clone());
		let start = usize::try_from(range.start).unwrap();
		let end = usize::try_from(range.end).unwrap();
		ready(Ok(self.bytes.slice(start..end)))
	}
}

#[derive(Clone)]
struct MetadataOnlyAuthority {
	reads: Arc<AtomicU64>,
}

impl BlobAuthority for MetadataOnlyAuthority {
	async fn stat(&self, _digest: &str) -> Result<BlobStat, Fault> {
		Ok(BlobStat { byte_len: 9 * 1024 * 1024 })
	}

	async fn read_range(
		&self,
		_digest: &str,
		_range: Range<u64>,
	) -> Result<CowBytes<'static>, Fault> {
		self.reads.fetch_add(1, Ordering::Relaxed);
		Ok(CowBytes::from_static(b"unexpected"))
	}
}

impl Sources {
	fn file(&self, path: &str, bytes: impl Into<Bytes>) {
		self.file_as(path, path, path, bytes);
	}

	fn file_as(&self, authored: &str, canonical: &str, display: &str, bytes: impl Into<Bytes>) {
		let bytes = bytes.into();
		let source = FileSource {
			stat: SourceStat {
				canonical_path: Str::new(canonical),
				display_path:   Str::new(display),
				kind:           SourceKind::File,
				byte_len:       bytes.len() as u64,
				modified_ms:    Some(u64::MAX),
			},
			bytes,
			revision: sf!("revision-7"),
		};
		self.files.insert(authored.to_owned(), source.clone());
		self.files.insert(canonical.to_owned(), source.clone());
		self.files.insert(display.to_owned(), source);
	}

	fn directory(&self, path: &str, entries: Vec<DirectoryEntry>) {
		let stat = SourceStat {
			canonical_path: Str::new(path),
			display_path:   Str::new(path),
			kind:           SourceKind::Directory,
			byte_len:       0,
			modified_ms:    Some(u64::MAX),
		};
		self.dirs.insert(
			path.to_owned(),
			(stat, DirectorySource { root: Str::new(path), entries, truncated: false }),
		);
	}

	fn directory_symlink(&self, authored: &str, target: &str) {
		let target_stat = self
			.dirs
			.get(target)
			.unwrap_or_else(|| panic!("directory symlink target '{target}' exists"))
			.0
			.clone();
		self.files.insert(authored.to_owned(), FileSource {
			stat:     SourceStat {
				display_path: Str::new(authored),
				kind: SourceKind::Symlink,
				..target_stat
			},
			bytes:    Bytes::new(),
			revision: sf!("symlink"),
		});
	}

	fn file_symlink(&self, authored: &str, target: &str) {
		let target_source = self
			.files
			.get(target)
			.unwrap_or_else(|| panic!("file symlink target '{target}' exists"))
			.clone();
		self.files.insert(authored.to_owned(), FileSource {
			stat:     SourceStat {
				display_path: Str::new(authored),
				kind: SourceKind::Symlink,
				..target_source.stat
			},
			bytes:    target_source.bytes,
			revision: target_source.revision,
		});
	}

	fn suffix(&self, authored: &str, resolved: &str) {
		let stat = self
			.files
			.get(resolved)
			.expect("resolved fixture exists")
			.stat
			.clone();
		self.suffixes.insert(authored.to_owned(), stat);
	}
}

async fn project(sources: Sources, blobs: Blobs, raw: &str, media: bool) -> Vec<Part> {
	project_with_policy(sources, blobs, raw, media, read::ReadPolicy::default()).await
}

async fn project_with_policy(
	sources: Sources,
	blobs: Blobs,
	raw: &str,
	media: bool,
	policy: read::ReadPolicy,
) -> Vec<Part> {
	project_with_policy_and_diags(sources, blobs, raw, media, policy)
		.await
		.0
}

async fn project_with_policy_and_diags(
	sources: Sources,
	blobs: Blobs,
	raw: &str,
	media: bool,
	policy: read::ReadPolicy,
) -> (Vec<Part>, Vec<Diag>) {
	let tool = read::tool_with_policy(
		sources,
		blobs,
		Arc::new(ResolverTable::<read::resolver::NoResolver>::default()),
		Arc::new(read::conflicts::ConflictRegistry::default()),
		policy,
	);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(raw))
		.expect("read invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let mut diags = Vec::new();
	let mut terminal = None;
	for event in events {
		match event {
			Ev::Diag(diag) => diags.push(diag),
			Ev::Done(ToolTerminal::Done { result, .. }) => terminal = Some(result),
			other => panic!("unexpected read event: {other:?}"),
		}
	}
	let result = terminal.expect("one terminal read event");
	let parts = tool.prompt(
		result.as_ref(),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts: 16,
				maximum_text_bytes: u32::MAX,
				media,
				model_class: ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	(parts, diags)
}

async fn text(sources: Sources, raw: &str) -> String {
	text_with_diags(sources, raw).await.0
}

async fn text_with_diags(sources: Sources, raw: &str) -> (String, Vec<Diag>) {
	let (parts, diags) = project_with_policy_and_diags(
		sources,
		Blobs::default(),
		raw,
		false,
		read::ReadPolicy::default(),
	)
	.await;
	let [Part::Text { text }] = parts.as_slice() else {
		panic!("expected exactly one model-facing text part: {parts:?}");
	};
	(text.to_string(), diags)
}
async fn payload(sources: Sources, blobs: Blobs, raw: &str) -> read::Payload {
	let tool = read::tool(sources, blobs);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(raw))
		.expect("read invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	events
		.into_iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => Some(payload),
			_ => None,
		})
		.expect("one successful read event")
}

/// Asserts that an oversized read returns its complete text with no
/// read-level truncation notice and no private artifact spill (ADR 0009:
/// bounding happens once, in the dispatcher).
async fn assert_complete_text(sources: Sources, raw: &str, expected: &str) {
	let blobs = Blobs::default();
	let parts = project(sources, blobs.clone(), raw, false).await;
	let [Part::Text { text }] = parts.as_slice() else {
		panic!("expected one complete text projection: {parts:?}");
	};
	assert!(!text.contains("[truncated:"), "read must not append its own truncation notice");
	assert_eq!(text.as_str(), expected, "read must return every projected byte");
	assert!(
		blobs.stored.lock().is_empty(),
		"read must not spill its own artifact; the dispatcher owns the spill gate"
	);
}

fn numbered_lines(count: usize) -> String {
	(1..=count)
		.map(|line| format!("line {line}"))
		.collect::<Vec<_>>()
		.join("\n")
}

const FIXTURE_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/special-sources");

fn fixture_path(relative: &str) -> PathBuf {
	Path::new(FIXTURE_ROOT).join(relative)
}

#[tokio::test]
async fn protocol_intent_is_not_deserialized_as_a_read_parameter() {
	let sources = Sources::default();
	sources.file("intent.txt", "intent survives");
	assert_eq!(
		text(sources, r#"{"i":"Reading intent fixture","path":"intent.txt:raw"}"#,).await,
		"intent survives",
	);
}

#[test]
fn generated_schema_exposes_optional_image_question_without_a_new_tool() {
	let tool = read::tool(Sources::default(), Blobs::default());
	let actual: serde_json::Value =
		serde_json::from_slice(&tool.spec().schema).expect("schema JSON");
	assert_eq!(tool.spec().rev, Rev { family: Default::default(), n: 2 });
	assert_eq!(
		tool.spec().schema.as_ref(),
		omp_tool::schema::<read::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		actual,
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "path"],
			"properties": {
				"path": {
					"type": "string",
					"description": "Local path, internal URI (e.g. skill://), or URL. Inline selectors are supported."
				},
				"question": {
					"type": "string",
					"description": "Optional question about one image. The active model vision route receives the question and materialized image together."
				},
				"notrunc": {
					"type": "boolean",
					"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
				},
				"i": {
					"type": "string",
					"description": "Short present-participle intent for this call."
				}
			}
		})
	);
	let rev1_args = br#"{"path":"src/lib.rs"}"#;
	let rev1_verdict = serde_json::to_vec(&CallOutcome::<read::Payload, Fault>::Ok(read::Payload {
		parts: vec![read::PayloadPart::Text { text: sf!("complete") }],
	}))
	.expect("rev 1 verdict serializes");
	let lifted = tool
		.lift(&Rev { family: Default::default(), n: 1 }, RecordedCall {
			raw_args: rev1_args,
			verdict:  &rev1_verdict,
		})
		.expect("read@1 lifts onto read@2");
	assert_eq!(lifted.raw_args.as_ref(), rev1_args);
	assert_eq!(lifted.verdict.as_ref(), rev1_verdict.as_slice());
	assert!(
		tool
			.lift(&Rev { family: Default::default(), n: 2 }, RecordedCall {
				raw_args: rev1_args,
				verdict:  &rev1_verdict,
			},)
			.is_none()
	);

	for legacy in [
		json!({"path": "src/lib.rs", "ranges": [[1, 2]]}),
		json!({"path": "src/lib.rs", "structural": true}),
	] {
		assert!(
			serde_json::from_value::<read::Params>(legacy).is_err(),
			"read params must reject legacy fields"
		);
	}
}

#[test]
fn canonical_url_vocabulary_matches_dense_rust_dispatch_and_selector_parser() {
	#[derive(serde::Deserialize)]
	struct Vocabulary {
		version:          u32,
		selector_grammar: String,
		schemes:          Vec<SchemeRow>,
	}

	#[derive(serde::Deserialize)]
	struct SchemeRow {
		member:    String,
		wire:      Vec<String>,
		selectors: bool,
	}

	let vocabulary: Vocabulary = serde_json::from_str(read::resolver::URL_VOCABULARY_JSON).unwrap();
	assert_eq!(vocabulary.version, 1);
	assert!(vocabulary.selector_grammar.contains("raw ':' ranges"));
	assert_eq!(vocabulary.schemes.len(), Scheme::ALL.len());
	for (scheme, row) in Scheme::ALL.iter().copied().zip(vocabulary.schemes) {
		let entry = SchemeEntry::new(scheme, false, false, "");
		assert_eq!(entry.member.as_str(), row.member);
		assert_eq!(entry.selectors, row.selectors);
		for wire in row.wire {
			assert_eq!(Scheme::parse(&wire), scheme);
		}
	}
	assert_eq!(Scheme::parse("custom"), Scheme::Unknown);
	for selector in
		["5", "5-16,960-973", "5..16", "5+12", "5-", "raw", "conflicts", "img", "raw:5-16"]
	{
		assert_ne!(read::selector::parse_selector(Some(selector)).unwrap(), ParsedSelector::None);
	}
}

#[test]
fn special_source_fixture_workspace_is_complete_and_self_contained() {
	let manifest: serde_json::Value = serde_json::from_slice(
		&fs::read(fixture_path("manifest.json")).expect("special-source manifest"),
	)
	.expect("valid special-source manifest");
	let expected_groups = [
		"plain",
		"directory",
		"archives",
		"database",
		"images",
		"documents",
		"notebooks",
		"profiles",
		"conflicts",
		"web",
	];
	for group in expected_groups {
		let paths = manifest[group]
			.as_array()
			.unwrap_or_else(|| panic!("fixture manifest group '{group}'"));
		assert!(!paths.is_empty(), "fixture manifest group '{group}' is empty");
		for path in paths {
			let relative = path.as_str().expect("fixture path string");
			assert!(fixture_path(relative).is_file(), "missing fixture '{relative}'");
		}
	}
	let large = fs::read(fixture_path("plain/large-utf8.txt")).expect("large UTF-8 fixture");
	assert!(large.len() > 50 * 1024);
	assert!(std::str::from_utf8(&large).is_ok());
	assert_eq!(
		&std::fs::read(fixture_path("database/catalog.sqlite")).expect("SQLite fixture")[..16],
		b"SQLite format 3\0"
	);
	assert_eq!(
		&std::fs::read(fixture_path("images/pixel.png")).expect("PNG fixture")[..8],
		b"\x89PNG\r\n\x1a\n"
	);
}

#[tokio::test]
async fn directory_listing_is_depth_two_and_elides_nested_children() {
	let sources = Sources::default();
	let mut entries = vec![DirectoryEntry {
		path:        sf!("dir"),
		kind:        SourceKind::Directory,
		byte_len:    0,
		modified_ms: Some(u64::MAX),
	}];
	entries.extend((0..14).map(|index| DirectoryEntry {
		path:        sf!("dir/child-{index:02}.txt"),
		kind:        SourceKind::File,
		byte_len:    index,
		modified_ms: Some(u64::MAX),
	}));
	entries.push(DirectoryEntry {
		path:        sf!("dir/nested/too-deep.txt"),
		kind:        SourceKind::File,
		byte_len:    1,
		modified_ms: Some(u64::MAX),
	});
	sources.directory("tree", entries);
	let (output, diags) = text_with_diags(sources, r#"{"path":"tree"}"#).await;
	assert_eq!(
		output,
		concat!(
			".\n",
			"  - dir/\n",
			"    - child-00.txt\n",
			"    - child-01.txt\n",
			"    - child-02.txt\n",
			"    - child-03.txt\n",
			"    - child-04.txt\n",
			"    - child-05.txt\n",
			"    - child-06.txt\n",
			"    - child-07.txt\n",
			"    - child-08.txt\n",
			"    - child-09.txt\n",
			"    - child-10.txt\n",
			"    - child-11.txt",
		)
	);
	let [diag] = diags.as_slice() else {
		panic!("child cap emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::LimitReached));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 2, unit: Unit::Entries }));
}

#[tokio::test]
async fn oversized_directory_listing_returns_the_complete_rendered_tree() {
	let sources = Sources::default();
	let mut entries = Vec::with_capacity(4_000);
	let mut expected = String::from(".");
	for index in 0..4_000 {
		let name = format!("entry-{index:04}-abcdefghijklmnop.txt");
		entries.push(DirectoryEntry {
			path:        Str::new(name.clone()),
			kind:        SourceKind::File,
			byte_len:    1,
			modified_ms: Some(u64::MAX),
		});
		write!(expected, "\n  - {name}").expect("writing expected directory listing");
	}
	sources.directory("large-tree", entries);

	assert_complete_text(sources, r#"{"path":"large-tree"}"#, &expected).await;
}

#[tokio::test]
async fn directory_symlink_is_reclassified_before_special_dispatch() {
	let sources = Sources::default();
	sources.directory("tree", vec![DirectoryEntry {
		path:        sf!("leaf.txt"),
		kind:        SourceKind::File,
		byte_len:    4,
		modified_ms: Some(u64::MAX),
	}]);
	sources.directory_symlink("tree-link", "tree");

	assert_eq!(text(sources, r#"{"path":"tree-link"}"#).await, ".\n  - leaf.txt");
}

#[tokio::test]
async fn file_symlink_keeps_the_authored_alias_in_headers_and_snapshot_keys() {
	let sources = Sources::default();
	sources.file("target.txt", "alpha\nbeta\n");
	sources.file_symlink("alias.txt", "target.txt");
	assert_eq!(
		text(sources.clone(), r#"{"path":"alias.txt:1-1"}"#).await,
		"[alias.txt#A1B2]\n1:alpha\n2:beta"
	);
	let snapshots = sources.snapshots.lock();
	let [snapshot] = snapshots.as_slice() else {
		panic!("one snapshot must be recorded")
	};
	assert_eq!(snapshot.path, "alias.txt");
}

#[tokio::test]
async fn line_range_adds_context_header_and_records_the_exposed_snapshot() {
	let sources = Sources::default();
	sources.file("file.txt", numbered_lines(12));
	let (output, diags) = text_with_diags(sources.clone(), r#"{"path":"file.txt:5-8"}"#).await;
	assert_eq!(
		output,
		concat!(
			"[file.txt#A1B2]\n",
			"4:line 4\n5:line 5\n6:line 6\n7:line 7\n8:line 8\n9:line 9\n10:line 10\n11:line 11",
		)
	);
	let [diag] = diags.as_slice() else {
		panic!("bounded line range emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some(":12"));
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 1, unit: Unit::Lines }));
	let snapshots = sources.snapshots.lock();
	let [snapshot] = snapshots.as_slice() else {
		panic!("one snapshot must be recorded")
	};
	assert_eq!(snapshot.path, "file.txt");
	assert_eq!(snapshot.revision, "revision-7");
	assert_eq!(
		snapshot
			.seen
			.iter()
			.map(|span| (span.start_line, span.end_line))
			.collect::<Vec<_>>(),
		vec![(4, 11)]
	);
}

#[tokio::test]
async fn raw_is_verbatim_and_multi_range_uses_one_hashline_header_and_ellipsis() {
	let sources = Sources::default();
	sources.file("file.txt", numbered_lines(10));
	assert_eq!(
		text(sources.clone(), r#"{"path":"file.txt:raw:5-8"}"#).await,
		"line 5\nline 6\nline 7\nline 8"
	);
	assert_eq!(
		text(sources, r#"{"path":"file.txt:2-3,8-9"}"#).await,
		"[file.txt#A1B2]\n2:line 2\n3:line 3\n…\n8:line 8\n9:line 9"
	);
}

#[test]
fn binary_header_classifier_covers_the_sniff_boundary_cases() {
	assert!(!read::is_probably_binary_header(b""));
	assert!(!read::is_probably_binary_header(b"plain ascii text\n"));
	assert!(!read::is_probably_binary_header("caf\u{e9} \u{20ac}".as_bytes()));
	// NUL bytes mark true binary plus NUL-padded UTF-16/UTF-32 text.
	assert!(read::is_probably_binary_header(b"v\0a\0l\0i\0d\0"));
	// A genuinely invalid byte fails wherever it sits.
	assert!(read::is_probably_binary_header(b"ok\xFFnope"));
	assert!(read::is_probably_binary_header(b"\xC3\x28"));
	// A multibyte sequence truncated at the sniff window is tolerated.
	assert!(!read::is_probably_binary_header(b"tail\xE2\x82"));
	assert!(!read::is_probably_binary_header(b"tail\xF0\x9F\x98"));
}

#[tokio::test]
async fn binary_content_is_refused_before_decoding_and_raw_stays_the_escape_hatch() {
	// Valid UTF-8 with NUL padding is refused as binary rather than rendered.
	let sources = Sources::default();
	sources.file("padded.txt", Bytes::from_static(b"v\0a\0l\0i\0d\0"));
	assert_eq!(
		text(sources.clone(), r#"{"path":"padded.txt"}"#).await,
		"[Cannot read binary file 'padded.txt' (10B); not valid UTF-8 text. Use ':raw' to read \
		 bytes verbatim.]"
	);
	// `:raw` bypasses the sniff; NUL bytes are valid UTF-8 and stay verbatim.
	assert_eq!(text(sources, r#"{"path":"padded.txt:raw"}"#).await, "v\0a\0l\0i\0d\0");

	// An invalid byte inside the sniff window is refused without decoding.
	let sources = Sources::default();
	sources.file("garbage.txt", Bytes::from_static(b"ok\xFF\xFEnot text"));
	assert_eq!(
		text(sources.clone(), r#"{"path":"garbage.txt"}"#).await,
		"[Cannot read binary file 'garbage.txt' (12B); not valid UTF-8 text. Use ':raw' to read \
		 bytes verbatim.]"
	);
	// `:raw` decodes losses: invalid bytes surface as U+FFFD replacements.
	assert_eq!(text(sources, r#"{"path":"garbage.txt:raw"}"#).await, "ok\u{fffd}\u{fffd}not text");
}
#[tokio::test]
async fn oversized_payload_is_one_complete_text_part_without_artifact_spill() {
	let sources = Sources::default();
	sources.file("large.txt", numbered_lines(4000));
	let blobs = Blobs::default();
	let payload = payload(sources, blobs.clone(), r#"{"path":"large.txt"}"#).await;
	let [read::PayloadPart::Text { text }] = payload.parts.as_slice() else {
		panic!("expected one complete text part: {:?}", payload.parts);
	};
	assert!(text.ends_with("\n4000:line 4000"), "{text}");
	assert!(blobs.stored.lock().is_empty(), "read must not store its own spill artifact");
}

#[tokio::test]
async fn invalid_bytes_past_the_sniff_window_still_refuse_non_raw_reads() {
	// 8 KiB of clean text keeps the sniff quiet; the strict whole-file decode
	// still refuses the invalid tail.
	let mut bytes = "a".repeat(read::BINARY_SNIFF_BYTES).into_bytes();
	bytes.extend_from_slice(b"\xFFtail");
	let sources = Sources::default();
	sources.file("late-garbage.txt", bytes);
	assert_eq!(
		text(sources, r#"{"path":"late-garbage.txt"}"#).await,
		"[Cannot read binary file 'late-garbage.txt' (8.0KB); not valid UTF-8 text. Use ':raw' to \
		 read bytes verbatim.]"
	);
}

#[tokio::test]
async fn multibyte_sequence_split_at_the_sniff_boundary_reads_as_text() {
	// "€" (3 bytes) straddles the 8192-byte sniff window; the truncated tail
	// must not classify the file as binary.
	let mut body = "aaaaaaa\n".repeat(1023);
	body.push_str("aaaaaa\u{20ac}ok");
	assert_eq!(body.as_bytes()[read::BINARY_SNIFF_BYTES - 2], 0xe2);
	let sources = Sources::default();
	sources.file("boundary.txt", body);
	let projected = text(sources, r#"{"path":"boundary.txt"}"#).await;
	assert!(projected.starts_with("[boundary.txt#A1B2]\n1:aaaaaaa\n"), "{projected}");
	assert!(projected.ends_with("1024:aaaaaa\u{20ac}ok"), "{projected}");
}

#[tokio::test]
async fn oversized_numbered_projection_is_complete_without_a_notice() {
	// 4,000 lines exceeds the former 3,000-line read cap.
	let sources = Sources::default();
	sources.file("large.txt", numbered_lines(4000));
	let mut full = String::from("[large.txt#A1B2]\n");
	for line in 1..=4000 {
		if line > 1 {
			full.push('\n');
		}
		write!(full, "{line}:line {line}").expect("writing to string");
	}
	assert_complete_text(sources, r#"{"path":"large.txt"}"#, &full).await;
}

/// Lines wide enough that 3,500 of them exceed the former 50 KiB byte cap.
fn wide_numbered_lines(count: usize) -> String {
	(1..=count)
		.map(|line| format!("line {line} {}", "x".repeat(40)))
		.collect::<Vec<_>>()
		.join("\n")
}

#[tokio::test]
async fn raw_selector_on_oversized_file_yields_every_byte_without_a_notice() {
	let body = wide_numbered_lines(4000);
	assert!(body.len() > 50 * 1024 && body.lines().count() > 3000);
	let sources = Sources::default();
	sources.file("wide.txt", body.clone());
	assert_complete_text(sources, r#"{"path":"wide.txt:raw"}"#, &body).await;
}

#[tokio::test]
async fn range_selector_on_oversized_file_yields_every_selected_byte_without_a_notice() {
	let body = wide_numbered_lines(4000);
	let sources = Sources::default();
	sources.file("wide.txt", body.clone());
	let expected = body.lines().take(3500).collect::<Vec<_>>().join("\n");
	assert!(expected.len() > 50 * 1024 && expected.lines().count() > 3000);
	assert_complete_text(sources, r#"{"path":"wide.txt:raw:1-3500"}"#, &expected).await;
}

#[tokio::test]
async fn final_projection_authorizes_every_source_line() {
	let sources = Sources::default();
	sources.file("large.txt", numbered_lines(4000));
	let _ = project(sources.clone(), Blobs::default(), r#"{"path":"large.txt"}"#, false).await;
	let snapshots = sources.snapshots.lock();
	let [snapshot] = snapshots.as_slice() else {
		panic!("one snapshot must be recorded")
	};
	assert_eq!(
		snapshot
			.seen
			.iter()
			.map(|span| (span.start_line, span.end_line))
			.collect::<Vec<_>>(),
		vec![(1, 4000)],
		"every projected line is editable because read no longer caps the projection"
	);
}

#[tokio::test]
async fn structural_summary_has_a_concrete_recovery_diag() {
	let sources = Sources::default();
	let mut body = String::from("pub fn giant() {\n");
	for line in 0..120 {
		writeln!(body, "    let value_{line} = {line};").expect("writing to string");
	}
	body.push_str("}\n");
	sources.file("big.rs", body);
	let (output, diags) = text_with_diags(sources, r#"{"path":"big.rs"}"#).await;
	assert_eq!(output, "[big.rs#A1B2]\n1-122:pub fn giant() { … }");
	let [diag] = diags.as_slice() else {
		panic!("structural summary emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::SummaryElided));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some("big.rs:2-121"));
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 120, unit: Unit::Lines }));
}

#[tokio::test]
async fn read_policy_controls_structural_summaries_and_plain_line_numbers() {
	let sources = Sources::default();
	let mut body = String::from("pub fn giant() {\n");
	for line in 0..120 {
		writeln!(body, "    let value_{line} = {line};").expect("writing to string");
	}
	body.push_str("}\n");
	sources.file("big.rs", body);

	let without_summary = project_with_policy(
		sources.clone(),
		Blobs::default(),
		r#"{"path":"big.rs"}"#,
		false,
		read::ReadPolicy {
			summarize: false,
			line_numbers: false,
			hashline_headers: false,
			..read::ReadPolicy::default()
		},
	)
	.await;
	let [Part::Text { text: plain }] = without_summary.as_slice() else {
		panic!("plain read must produce text: {without_summary:?}");
	};
	assert!(plain.starts_with("pub fn giant() {\n    let value_0 = 0;"), "{plain}");
	assert!(plain.contains("let value_119 = 119;"), "{plain}");
	assert!(!plain.contains("ln elided"), "{plain}");
	assert!(!plain.starts_with("1:"), "{plain}");

	let numbered = project_with_policy(
		sources,
		Blobs::default(),
		r#"{"path":"big.rs:1-2"}"#,
		false,
		read::ReadPolicy {
			summarize: false,
			line_numbers: true,
			hashline_headers: false,
			..read::ReadPolicy::default()
		},
	)
	.await;
	let [Part::Text { text: numbered }] = numbered.as_slice() else {
		panic!("numbered read must produce text: {numbered:?}");
	};
	assert!(numbered.starts_with("1:pub fn giant() {\n2:    let value_0 = 0;"), "{numbered}");
}

#[tokio::test]
async fn files_over_twenty_thousand_lines_skip_structural_summary() {
	let sources = Sources::default();
	let mut body = String::from("pub fn too_many_lines() {\n");
	for line in 0..20_001 {
		writeln!(body, "\tlet value_{line} = {line}").expect("writing to string");
	}
	body.push_str("}\n");
	sources.file("too-many.rs", body);
	let output = text(sources, r#"{"path":"too-many.rs"}"#).await;
	assert!(output.starts_with("[too-many.rs#A1B2]\n1:pub fn too_many_lines() {\n"), "{output}");
	assert!(!output.contains("structural summary"), "{output}");
}

struct TempDb(PathBuf);
impl Drop for TempDb {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.0);
	}
}

fn sqlite_fixture() -> TempDb {
	static NEXT: AtomicU64 = AtomicU64::new(0);
	let path = env::temp_dir().join(format!(
		"omp-read-golden-{}-{}.sqlite",
		std::process::id(),
		NEXT.fetch_add(1, Ordering::Relaxed),
	));
	fs::write(&path, include_bytes!("../fixtures/special-sources/database/catalog.sqlite"))
		.expect("copy checked-in SQLite fixture");
	TempDb(path)
}

#[tokio::test]
async fn sqlite_root_table_key_where_and_forbidden_where_are_model_text() {
	let db = sqlite_fixture();
	let sources = Sources::default();
	sources.file_as(
		"data.sqlite",
		db.0.to_str().unwrap(),
		"data.sqlite",
		fs::read(&db.0).expect("read SQLite fixture bytes"),
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"data.sqlite"}"#).await,
		"packages (2 rows)\npeople (3 rows)"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"data.sqlite:people:2"}"#).await,
		"id: 2\nname: Grace\nscore: 20"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"data.sqlite:people?where=score%3E10&limit=2"}"#).await,
		concat!(
			"| id  | name  | score |\n",
			"| --- | ----- | ----- |\n",
			"| 2   | Grace | 20    |\n",
			"| 3   | Linus | 30    |",
		)
	);
	let (page, diags) =
		text_with_diags(sources.clone(), r#"{"path":"data.sqlite:people?limit=2"}"#).await;
	assert!(page.contains("| 1   | Ada"), "{page}");
	let [diag] = diags.as_slice() else {
		panic!("SQLite pagination emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some(":people?limit=2&offset=2"));
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 1, unit: Unit::Rows }));
	let schema = text(sources.clone(), r#"{"path":"data.sqlite:people"}"#).await;
	assert_eq!(
		schema,
		concat!(
			"CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score INTEGER)\n\n",
			"Sample rows:\n",
			"| id  | name  | score |\n",
			"| --- | ----- | ----- |\n",
			"| 1   | Ada   | 10    |\n",
			"| 2   | Grace | 20    |\n",
			"| 3   | Linus | 30    |",
		)
	);
	assert_eq!(
		text(sources, r#"{"path":"data.sqlite:people?where=score%3E0%20LIMIT%201"}"#).await,
		"SQLite 'where' clause must not contain \
		 LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL"
	);
}

#[tokio::test]
async fn oversized_sqlite_output_returns_the_complete_rendered_table() {
	let db = sqlite_fixture();
	{
		let mut connection = rusqlite::Connection::open(&db.0).expect("open SQLite spill fixture");
		connection
			.execute_batch("CREATE TABLE wide(id INTEGER PRIMARY KEY, alpha TEXT, beta TEXT);")
			.expect("create wide SQLite table");
		let transaction = connection
			.transaction()
			.expect("start SQLite spill fixture transaction");
		let cell = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		for id in 1..=1_000_i64 {
			transaction
				.execute("INSERT INTO wide(id, alpha, beta) VALUES (?1, ?2, ?3)", (id, cell, cell))
				.expect("insert wide SQLite row");
		}
		transaction.commit().expect("commit SQLite spill fixture");
	}
	let authored = "wide.sqlite?q=SELECT%20id,alpha,beta%20FROM%20wide%20ORDER%20BY%20id";
	let expected =
		read::sqlite::read(&db.0, authored).expect("render complete oversized SQLite output");
	assert!(expected.text.len() > 50 * 1024, "SQLite fixture must exceed the shared byte limit");

	let sources = Sources::default();
	sources.file_as(
		"wide.sqlite",
		db.0.to_str().unwrap(),
		"wide.sqlite",
		fs::read(&db.0).expect("read oversized SQLite fixture bytes"),
	);
	assert_complete_text(
		sources,
		r#"{"path":"wide.sqlite?q=SELECT%20id,alpha,beta%20FROM%20wide%20ORDER%20BY%20id"}"#,
		&expected.text,
	)
	.await;
}

#[tokio::test]
async fn suffix_resolved_sqlite_container_emits_path_recovered_diag() {
	let db = sqlite_fixture();
	let sources = Sources::default();
	sources.file_as(
		"resolved/data.sqlite",
		db.0.to_str().unwrap(),
		"resolved/data.sqlite",
		fs::read(&db.0).expect("read SQLite fixture bytes"),
	);
	sources.suffix("missing/data.sqlite", "resolved/data.sqlite");

	let (output, diags) = text_with_diags(sources, r#"{"path":"missing/data.sqlite"}"#).await;
	assert_eq!(output, "packages (2 rows)\npeople (3 rows)");
	let [diag] = diags.as_slice() else {
		panic!("suffix recovery emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::PathRecovered));
	assert_eq!(diag.severity, Severity::Info);
}

#[tokio::test]
async fn sqlite_extensions_without_magic_are_read_as_ordinary_text() {
	let sources = Sources::default();
	sources.file("notes.db", "not a database");
	sources.file("notes.sqlite", "also plain text");

	assert_eq!(
		text(sources.clone(), r#"{"path":"notes.db"}"#).await,
		"[notes.db#A1B2]\n1:not a database"
	);
	assert_eq!(
		text(sources, r#"{"path":"notes.sqlite"}"#).await,
		"[notes.sqlite#A1B2]\n1:also plain text"
	);
}

#[tokio::test(flavor = "current_thread")]
async fn long_sqlite_query_is_interrupted_without_blocking_the_runtime() {
	let db = sqlite_fixture();
	let sources = Sources::default();
	sources.file_as(
		"data.sqlite",
		db.0.to_str().unwrap(),
		"data.sqlite",
		fs::read(&db.0).expect("read SQLite fixture bytes"),
	);
	let tool = read::tool(sources, Blobs::default());
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(
			r#"{{"path":"data.sqlite?q=WITH%20RECURSIVE%20count(x)%20AS%20(VALUES(0)%20UNION%20ALL%20SELECT%20x%2B1%20FROM%20count)%20SELECT%20sum(x)%20FROM%20count"}}"#,
		))
		.expect("read invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>();
	tokio::pin!(events);

	tokio::select! {
		result = &mut events => panic!("unbounded SQLite query completed unexpectedly: {result:?}"),
		() = tokio::time::sleep(Duration::from_millis(50)) => {},
	}
	feed
		.interrupt(Interrupt { class: sf!("deadline"), reason: sf!("test deadline exceeded") })
		.expect("read invocation accepts its deadline interrupt");
	let events = time::timeout(Duration::from_secs(1), &mut events)
		.await
		.expect("SQLite query stops within the cancellation bound");
	assert!(
		matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })] if reason == "test deadline exceeded"
		),
		"deadline remains structured abort truth: {events:?}"
	);
}

const fn zip_fixture() -> Bytes {
	Bytes::from_static(include_bytes!("../fixtures/special-sources/archives/bundle.zip"))
}

const fn tar_fixture() -> Bytes {
	Bytes::from_static(include_bytes!("../fixtures/special-sources/archives/bundle.tar.gz"))
}

fn encoded_zip(entries: &[(&str, &str)]) -> Bytes {
	Bytes::from(
		omp_ar::zip::encode(
			entries
				.iter()
				.map(|&(path, contents)| (path, contents.as_bytes())),
		)
		.expect("encode ZIP fixture"),
	)
}

fn encoded_binary_zip(path: &str, contents: &[u8]) -> Bytes {
	let mut writer = zip::Writer::new(Vec::new());
	writer
		.add_file(path, contents)
		.expect("add binary ZIP fixture member");
	Bytes::from(writer.finish().expect("finish binary ZIP fixture"))
}

fn asar_fixture() -> Bytes {
	let json = br#"{"files":{"dir":{"files":{"member.txt":{"size":7,"offset":"0"}}},"root.txt":{"size":4,"offset":"7"}}}"#;
	let payload_size = 4 + json.len() + 1;
	let padded_payload_size = (payload_size + 3) & !3;
	let inner_size = 4 + padded_payload_size;
	let mut bytes = Vec::with_capacity(8 + inner_size + 11);
	for value in [
		4,
		u32::try_from(inner_size).unwrap(),
		u32::try_from(padded_payload_size).unwrap(),
		u32::try_from(json.len()).unwrap(),
	] {
		bytes.extend_from_slice(&value.to_le_bytes());
	}
	bytes.extend_from_slice(json);
	bytes.resize(8 + inner_size, 0);
	bytes.extend_from_slice(b"one\ntworoot");
	Bytes::from(bytes)
}

#[tokio::test]
async fn zip_and_tar_root_member_and_member_range_use_standard_text_formatting() {
	let sources = Sources::default();
	sources.file("bundle.zip", zip_fixture());
	sources.file("bundle.tar.gz", tar_fixture());
	assert_eq!(
		text(sources.clone(), r#"{"path":"bundle.zip"}"#).await,
		"binary.bin (4B)\ndir/\nroot.txt (18B)"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"bundle.zip:dir/member.txt"}"#).await,
		"1:one\n2:two\n3:three\n4:four\n5:five"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"bundle.zip:dir/member.txt:2-3"}"#).await,
		"1:one\n2:two\n3:three\n4:four\n5:five"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"bundle.tar.gz"}"#).await,
		"binary.bin (4B)\ndir/\nroot.txt (18B)"
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"bundle.tar.gz:dir/member.txt"}"#).await,
		"1:one\n2:two\n3:three\n4:four\n5:five"
	);
	assert_eq!(
		text(sources, r#"{"path":"bundle.tar.gz:dir/member.txt:raw:2-3"}"#).await,
		"two\nthree"
	);
}

#[tokio::test]
async fn asar_root_subdirectory_and_packed_member_use_archive_routing() {
	let sources = Sources::default();
	sources.file("bundle.asar", asar_fixture());
	assert_eq!(text(sources.clone(), r#"{"path":"bundle.asar"}"#).await, "dir/\nroot.txt (4B)");
	assert_eq!(text(sources.clone(), r#"{"path":"bundle.asar:dir"}"#).await, "member.txt (7B)");
	assert_eq!(text(sources, r#"{"path":"bundle.asar:dir/member.txt"}"#).await, "1:one\n2:two");
}

#[tokio::test]
async fn oversized_archive_listing_returns_every_entry_line() {
	let mut writer = zip::Writer::new(Vec::new());
	let mut expected_lines = Vec::with_capacity(read::archive::DEFAULT_ARCHIVE_LIST_LIMIT);
	for index in 0..read::archive::DEFAULT_ARCHIVE_LIST_LIMIT {
		let name = format!("entry-{index:03}-{}.txt", "x".repeat(120));
		writer
			.add_file(&name, b"x")
			.expect("add oversized archive listing entry");
		expected_lines.push(format!("{name} (1B)"));
	}
	let archive = Bytes::from(writer.finish().expect("finish oversized archive fixture"));
	let expected = expected_lines.join("\n");
	assert!(expected.len() > 50 * 1024, "archive fixture must exceed the shared byte limit");

	let sources = Sources::default();
	sources.file("large-listing.zip", archive);
	assert_complete_text(sources, r#"{"path":"large-listing.zip"}"#, &expected).await;
}

#[tokio::test]
async fn selector_shaped_archive_members_win_over_selector_interpretation() {
	let sources = Sources::default();
	sources.file(
		"selectors.zip",
		encoded_zip(&[
			("50", "literal numeric member\nsecond line"),
			("raw", "literal raw member\nsecond line"),
		]),
	);

	assert_eq!(
		text(sources.clone(), r#"{"path":"selectors.zip:50"}"#).await,
		"1:literal numeric member\n2:second line"
	);
	assert_eq!(
		text(sources, r#"{"path":"selectors.zip:raw"}"#).await,
		"1:literal raw member\n2:second line"
	);
}

#[tokio::test]
async fn absent_selector_shaped_members_fall_back_to_text_selectors() {
	let sources = Sources::default();
	let member = numbered_lines(60);
	let root_sources = Sources::default();
	root_sources
		.file("root-fallback.zip", encoded_zip(&[("a.txt", "a"), ("b.txt", "b"), ("c.txt", "c")]));
	assert_eq!(
		text(root_sources.clone(), r#"{"path":"root-fallback.zip:raw"}"#).await,
		"a.txt (1B)\nb.txt (1B)\nc.txt (1B)"
	);
	assert_eq!(
		text(root_sources.clone(), r#"{"path":"root-fallback.zip:50"}"#).await,
		"(empty archive directory)"
	);
	assert_eq!(
		text(root_sources, r#"{"path":"root-fallback.zip:2-3"}"#).await,
		"b.txt (1B)\nc.txt (1B)"
	);
	sources.file("fallback.zip", encoded_zip(&[("member.txt", member.as_str())]));

	assert_eq!(text(sources.clone(), r#"{"path":"fallback.zip:member.txt:raw"}"#).await, member);
	assert_eq!(
		text(sources.clone(), r#"{"path":"fallback.zip:member.txt:50"}"#).await,
		concat!(
			"49:line 49\n50:line 50\n51:line 51\n52:line 52\n53:line 53\n54:line 54\n",
			"55:line 55\n56:line 56\n57:line 57\n58:line 58\n59:line 59\n60:line 60",
		)
	);
	let (output, diags) =
		text_with_diags(sources, r#"{"path":"fallback.zip:member.txt:10-12"}"#).await;
	assert_eq!(
		output,
		concat!(
			"9:line 9\n10:line 10\n11:line 11\n12:line 12\n13:line 13\n14:line 14\n",
			"15:line 15",
		)
	);
	let [diag] = diags.as_slice() else {
		panic!("archive member pagination emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some(":16"));
	assert_eq!(diag.omitted, Some(omp_tool::Omitted { count: 45, unit: Unit::Lines }));
}

#[tokio::test]
async fn suffix_resolved_archive_container_emits_path_recovered_diag() {
	let sources = Sources::default();
	sources.file_as(
		"resolved/bundle.zip",
		"resolved/bundle.zip",
		"resolved/bundle.zip",
		zip_fixture(),
	);
	sources.suffix("missing/bundle.zip", "resolved/bundle.zip");

	let (output, diags) =
		text_with_diags(sources, r#"{"path":"missing/bundle.zip:dir/member.txt"}"#).await;
	assert_eq!(output, "1:one\n2:two\n3:three\n4:four\n5:five");
	let [diag] = diags.as_slice() else {
		panic!("archive suffix recovery emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::PathRecovered));
	assert_eq!(diag.severity, Severity::Info);
}

#[tokio::test]
async fn notebook_cells_are_projected_with_editable_markers() {
	let sources = Sources::default();
	let notebook = include_str!("../fixtures/special-sources/notebooks/book.ipynb");
	sources.file("book.ipynb", notebook);
	assert_eq!(
		text(sources.clone(), r#"{"path":"book.ipynb"}"#).await,
		concat!(
			"[book.ipynb#A1B2]\n",
			"1:# %% [markdown] cell:0\n2:# Fixture notebook\n3:Unicode: café 東京\n4:\n",
			"5:# %% [code] cell:1\n6:value = 42\n7:print(value)",
		)
	);
	let snapshots = sources.snapshots.lock();
	let [snapshot] = snapshots.as_slice() else {
		panic!("one notebook snapshot must be recorded")
	};
	assert_eq!(
		snapshot.bytes.as_ref(),
		read::notebook::render(notebook.as_bytes(), "book.ipynb")
			.unwrap()
			.text
			.as_bytes()
	);
	assert_eq!(
		snapshot
			.seen
			.iter()
			.map(|span| (span.start_line, span.end_line))
			.collect::<Vec<_>>(),
		vec![(1, 7)]
	);
}

#[tokio::test]
async fn conflicted_notebook_selector_runs_before_notebook_json_conversion() {
	let sources = Sources::default();
	sources.file("merge.ipynb", include_str!("../fixtures/special-sources/conflicts/merge.ipynb"));
	let output = text(sources, r#"{"path":"merge.ipynb:conflicts"}"#).await;
	assert!(
		output.starts_with(
			"⚠ 1 unresolved conflict in merge.ipynb\n- ours = HEAD\n- theirs = feature/notebook\n- \
			 base = base\n"
		),
		"{output}"
	);
	assert!(output.ends_with("(3-way)"), "{output}");
}

#[tokio::test]
async fn document_raw_selector_returns_converted_markdown_without_line_projection() {
	let sources = Sources::default();
	sources.file(
		"report.docx",
		Bytes::from_static(include_bytes!("../fixtures/special-sources/documents/report.docx")),
	);
	assert_eq!(
		text(sources.clone(), r#"{"path":"report.docx:raw"}"#).await,
		"Content-Type: text/markdown\nFixture document\n\nConverted café."
	);
	assert!(sources.snapshots.lock().is_empty());
}

const CONFLICTED: &str = include_str!("../fixtures/special-sources/conflicts/merge.txt");

#[tokio::test]
async fn conflict_selector_is_data_and_normal_read_emits_diag() {
	let sources = Sources::default();
	sources.file("conflicted.txt", CONFLICTED);
	let summary = text(sources.clone(), r#"{"path":"conflicted.txt:conflicts"}"#).await;
	assert_eq!(
		summary,
		concat!(
			"⚠ 1 unresolved conflict in conflicted.txt\n",
			"- ours = HEAD\n",
			"- theirs = feature/source\n",
			"- base = base\n",
			"NOTICE: Read `conflicted.txt:conflicts` for the conflict index and ",
			"`conflict://<id>` (or `/ours`, `/base`, `/theirs`, `/both`) for exact sides. Resolve ",
			"with `write` targeting `conflict://<id>` and content `@ours`, `@base`, `@theirs`, ",
			"`@both`, or custom text; re-read `conflicted.txt:conflicts` to verify.\n\n",
			"#1  L2-8  (3-way)",
		)
	);
	assert!(summary.contains("conflict://"));
	let warning = read::conflicts::render_conflict_warning(CONFLICTED);
	assert!(warning.text.is_empty());
	let [warning_diag] = warning.diags.as_slice() else {
		panic!("ordinary conflict render emits one diagnostic");
	};
	assert_eq!(warning_diag.native_kind(), Some(DiagKind::Conflicts));
	assert_eq!(warning_diag.severity, Severity::Warn);
	assert_eq!(warning_diag.continuation.as_deref(), Some("path:conflicts"));

	let (ordinary, diags) = text_with_diags(sources, r#"{"path":"conflicted.txt"}"#).await;
	assert!(ordinary.starts_with("[conflicted.txt#A1B2]\n1:before\n2:<<<<<<< HEAD"), "{ordinary}");
	let final_line = CONFLICTED
		.lines()
		.last()
		.expect("conflict fixture has source text");
	assert!(
		ordinary.ends_with(&format!("{}:{final_line}", CONFLICTED.lines().count())),
		"{ordinary}"
	);
	let [diag] = diags.as_slice() else {
		panic!("ordinary read emits one conflict diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Conflicts));
	assert_eq!(diag.severity, Severity::Warn);
	assert_eq!(diag.continuation.as_deref(), Some("conflicted.txt:conflicts"));
}

#[tokio::test]
async fn oversized_conflict_index_returns_every_complete_summary_line() {
	let mut source = String::new();
	for index in 1..=3_100 {
		writeln!(source, "<<<<<<< HEAD\nours {index}\n=======\ntheirs {index}\n>>>>>>> feature")
			.expect("writing conflict fixture");
	}
	let expected =
		read::conflicts::render_conflicts_for_path(&source, "many-conflicts.txt", false).text;
	assert!(expected.lines().count() > 3_000, "conflict fixture must exceed the shared line limit");

	let sources = Sources::default();
	sources.file("many-conflicts.txt", source);
	assert_complete_text(sources, r#"{"path":"many-conflicts.txt:conflicts"}"#, &expected).await;
}

#[tokio::test]
async fn ordinary_conflict_warning_requires_a_complete_emitted_marker_block() {
	const SOURCE: &str = concat!(
		"before\n",
		"<<<<<<< HEAD\n",
		"ours\n",
		"||||||| base\n",
		"ancestor\n",
		"=======\n",
		"theirs\n",
		">>>>>>> feature\n",
		"after\n",
		"far away\n",
	);
	let sources = Sources::default();
	sources.file("window.txt", SOURCE);

	let hidden = text(sources.clone(), r#"{"path":"window.txt:10"}"#).await;
	assert!(!hidden.contains("unresolved conflict"), "{hidden}");

	let visible = text(sources, r#"{"path":"window.txt:3-7"}"#).await;
	assert!(visible.contains("\n⚠ 1 unresolved conflict detected"), "{visible}");
}

const fn png_fixture() -> Bytes {
	Bytes::from_static(include_bytes!("../fixtures/special-sources/images/pixel.png"))
}

#[tokio::test]
async fn image_read_emits_description_and_blob_and_rejects_over_twenty_mibibytes() {
	let sources = Sources::default();
	sources.file("pixel.png", png_fixture());
	let blobs = Blobs::default();
	let parts = project(sources.clone(), blobs.clone(), r#"{"path":"pixel.png"}"#, true).await;
	let [Part::Text { text: description }, Part::Blob { blob, alt }] = parts.as_slice() else {
		panic!("image read must emit text plus blob: {parts:?}");
	};
	let expected = concat!(
		"Read image file [image/jpeg]\n",
		"[Inspection: MIME image/jpeg; dimensions 8x6; channels 3; alpha no]\n",
		"[Image: original 8x6, displayed at 267x200. Multiply coordinates by 0.03 to map to \
		 original image.]",
	);
	assert_eq!(description, expected);
	assert_eq!(blob.hash, "blob-hash");
	assert_eq!(blob.media_type, "image/jpeg");
	assert_eq!(alt.as_deref(), Some(expected));
	assert_eq!(blobs.stored.lock().len(), 1);

	sources.file("huge.png", Bytes::from(vec![0; 20 * 1024 * 1024 + 1]));
	assert_eq!(
		text(sources, r#"{"path":"huge.png"}"#).await,
		"Image file too large: 20.0MB exceeds 20.0MB limit."
	);
}

#[tokio::test]
async fn image_question_routes_question_and_blob_to_vision_or_reports_unavailable() {
	let sources = Sources::default();
	sources.file("pixel.png", png_fixture());
	let blobs = Blobs::default();

	let result = payload(
		sources.clone(),
		blobs.clone(),
		r#"{"path":"pixel.png","question":"What color is the pixel?"}"#,
	)
	.await;
	let [
		read::PayloadPart::Text { text: payload_text },
		read::PayloadPart::Blob { vision: Some(read::VisionRequest { question }), .. },
	] = result.parts.as_slice()
	else {
		panic!("image question must remain a typed vision request: {:?}", result.parts);
	};
	assert!(payload_text.contains("Image question: What color is the pixel?"), "{payload_text}");
	assert_eq!(question, "What color is the pixel?");

	let vision_parts = project(
		sources.clone(),
		blobs.clone(),
		r#"{"path":"pixel.png","question":"What color is the pixel?"}"#,
		true,
	)
	.await;
	let [Part::Text { text: vision_text }, Part::Blob { .. }] = vision_parts.as_slice() else {
		panic!("vision route must receive question text and the image: {vision_parts:?}");
	};
	assert!(vision_text.contains("Image question: What color is the pixel?"), "{vision_text}");

	let unavailable_parts = project(
		sources.clone(),
		blobs,
		r#"{"path":"pixel.png","question":"What color is the pixel?"}"#,
		false,
	)
	.await;
	let [Part::Text { text: unavailable_question }, Part::Text { text: unavailable }] =
		unavailable_parts.as_slice()
	else {
		panic!(
			"text-only route must receive a typed unavailability projection: {unavailable_parts:?}"
		);
	};
	assert!(
		unavailable_question.contains("Image question: What color is the pixel?"),
		"{unavailable_question}"
	);
	assert_eq!(
		unavailable,
		"Image question unavailable: the active model route does not accept image input."
	);

	sources.file("notes.txt", "plain text");
	assert_eq!(
		text(sources, r#"{"path":"notes.txt","question":"What is pictured?"}"#,).await,
		"Image questions require a supported PNG, JPEG, GIF, WebP, or rasterized SVG/PDF image."
	);
}

#[tokio::test]
async fn image_question_materializes_archive_internal_and_url_images() {
	let question = "What color is the pixel?";

	let archive_sources = Sources::default();
	archive_sources.file("images.zip", encoded_binary_zip("nested/pixel.png", &png_fixture()));
	let archive = payload(
		archive_sources,
		Blobs::default(),
		r#"{"path":"images.zip:nested/pixel.png","question":"What color is the pixel?"}"#,
	)
	.await;
	let [
		read::PayloadPart::Text { text: archive_text },
		read::PayloadPart::Blob {
			vision: Some(read::VisionRequest { question: archive_question }),
			..
		},
	] = archive.parts.as_slice()
	else {
		panic!("archive image remains a typed vision request: {:?}", archive.parts);
	};
	assert!(archive_text.contains("Archive image images.zip:nested/pixel.png"), "{archive_text}");
	assert_eq!(archive_question, question);

	let calls = Arc::new(AtomicU64::new(0));
	let resolver = StaticResolver {
		bytes: CowBytes::from_static(include_bytes!("../fixtures/special-sources/images/pixel.png")),
		lines: Arc::new(LineOffsetCache::default()),
		calls,
	};
	let mut builder = ResolverTable::builder();
	builder
		.register(
			SchemeEntry::new(Scheme::Artifact, true, true, "Session and durable artifacts"),
			resolver,
		)
		.expect("register artifact fixture");
	let internal_tool =
		read::tool_with_resolvers(Sources::default(), Blobs::default(), Arc::new(builder.build()));
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"path":"artifact://7","question":"{question}"}}"#))
		.expect("internal image question remains live");
	let events = internal_tool.call(params).collect::<Vec<_>>().await;
	let internal = events
		.iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => Some(payload),
			_ => None,
		})
		.unwrap_or_else(|| panic!("internal image question succeeds: {events:?}"));
	assert!(matches!(
		internal.parts.as_slice(),
		[
			read::PayloadPart::Text { .. },
			read::PayloadPart::Blob {
				vision: Some(read::VisionRequest { question: internal_question }),
				..
			}
		] if internal_question == question
	));

	let url_sources = Sources::default();
	url_sources.responses.lock().push_back(Ok(HttpResponse {
		final_url:    sf!("https://fixture.invalid/pixel"),
		status:       200,
		content_type: Some(sf!("image/jpeg")),
		headers:      vec![(sf!("content-type"), sf!("image/jpeg"))].into(),
		body:         png_fixture(),
	}));
	let url = payload(
		url_sources,
		Blobs::default(),
		r#"{"path":"https://fixture.invalid/pixel","question":"What color is the pixel?"}"#,
	)
	.await;
	assert!(matches!(
		url.parts.as_slice(),
		[
			read::PayloadPart::Text { .. },
			read::PayloadPart::Blob {
				vision: Some(read::VisionRequest { question: url_question }),
				..
			}
		] if url_question == question
	));
}

#[tokio::test]
async fn svg_image_selector_rasterizes_to_png_blob() {
	let sources = Sources::default();
	sources.file(
		"diagram.svg",
		r#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7">
			<rect width="12" height="7" fill="red"/>
		</svg>"#,
	);
	let blobs = Blobs::default();
	let parts = project(sources, blobs.clone(), r#"{"path":"diagram.svg:img"}"#, true).await;
	let [Part::Text { .. }, Part::Blob { blob, .. }] = parts.as_slice() else {
		panic!("selected SVG must emit text plus image blob: {parts:?}");
	};

	assert_eq!(blob.media_type, "image/png");
	let stored = blobs.stored.lock();
	assert_eq!(stored.len(), 1);
	assert_eq!(&stored[0].0[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn cpu_profile_is_summarized_instead_of_dumping_json() {
	let sources = Sources::default();
	let profile = include_str!("../fixtures/special-sources/profiles/run.cpuprofile");
	sources.file("run.cpuprofile", profile);
	assert_eq!(
		text(sources.clone(), r#"{"path":"run.cpuprofile"}"#).await,
		concat!(
			"1:V8 CPU profile: 1.00 s wall clock, 4 samples (avg interval 250000 µs)\n",
			"2:On-CPU total: 1.00 s (100.0% of wall clock). Values below are on-CPU milliseconds \
			 (idle time excluded).\n",
			"3:\n4:## Hot paths\n5:  1000.0 100.0%  work (/src/work.js:5)\n",
			"6:\n7:## Top functions by self time (idle time excluded)\n8:  1000.0 100.0%  work \
			 (/src/work.js:5)\n",
			"9:\n10:[Summarized view of a V8 .cpuprofile. Use ':raw' to read the original JSON.]",
		)
	);
	assert!(sources.snapshots.lock().is_empty());
}

#[tokio::test]
async fn macos_sample_profile_uses_the_checked_in_call_tree_fixture() {
	let sources = Sources::default();
	sources.file(
		"trace.sample.txt",
		include_str!("../fixtures/special-sources/profiles/trace.sample.txt"),
	);
	let output = text(sources.clone(), r#"{"path":"trace.sample.txt"}"#).await;
	assert!(
		output.starts_with("1:macOS sample profile: fixture (pid 123), sampled every 1 ms\n"),
		"{output}"
	);
	assert!(output.contains("800  80.0%    work"), "{output}");
	assert!(
		output.ends_with(
			"[Summarized view of a macOS `sample` call-tree report. Use ':raw' to read the original \
			 file.]"
		),
		"{output}"
	);
	assert!(sources.snapshots.lock().is_empty());
}

#[tokio::test]
async fn checked_in_url_mock_drives_the_network_free_html_pipeline() {
	let sources = Sources::default();
	sources.responses.lock().push_back(Ok(HttpResponse {
		final_url:    sf!("https://fixture.invalid/final"),
		status:       200,
		content_type: Some(sf!("text/html")),
		headers:      vec![(sf!("content-type"), sf!("text/html; charset=utf-8"))].into(),
		body:         Bytes::from_static(include_bytes!("../fixtures/special-sources/web/page.html")),
	}));
	let output = text(sources, r#"{"path":"https://fixture.invalid/page"}"#).await;
	assert!(
		output.starts_with(
			"URL: https://fixture.invalid/final\nContent-Type: text/html\nMethod: native\n\n---\n\n"
		),
		"{output}"
	);
	assert!(output.contains("# Fixture page"), "{output}");
	assert!(output.contains("Network-free café content."), "{output}");
	assert!(!output.contains("Skip navigation"), "{output}");
}

#[tokio::test]
async fn scheme_faults_suffix_recovery_and_semicolon_sections_are_exact() {
	let sources = Sources::default();
	assert_eq!(
		text(sources.clone(), r#"{"path":"skill://react"}"#).await,
		"skill:// is not readable in this deployment"
	);
	sources.file("uri-note.txt", "uri body");
	assert_eq!(text(sources.clone(), r#"{"path":"file://uri-note.txt:raw"}"#).await, "uri body");

	sources.file("nested/lost.txt", "found");
	sources.suffix("lost.txt", "nested/lost.txt");
	let (output, diags) = text_with_diags(sources.clone(), r#"{"path":"lost.txt:raw"}"#).await;
	assert_eq!(output, "found");
	let [diag] = diags.as_slice() else {
		panic!("suffix recovery emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::PathRecovered));
	assert_eq!(diag.severity, Severity::Info);

	sources.file("one.txt", "alpha");
	sources.file("two.txt", "beta");
	let (output, diags) = text_with_diags(sources, r#"{"path":"one.txt:raw;two.txt:raw"}"#).await;
	assert_eq!(output, "alpha\n\nbeta");
	let [diag] = diags.as_slice() else {
		panic!("batch path interpretation emits one diagnostic: {diags:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::Advisory));
	assert_eq!(diag.severity, Severity::Info);
}

#[tokio::test]
async fn dense_resolver_dispatch_applies_the_shared_selector_without_copying_the_slice() {
	let calls = Arc::new(AtomicU64::new(0));
	let source = CowBytes::from_static(b"one\ntwo\nthree\nfour\n");
	let resolver = StaticResolver {
		bytes: source,
		lines: Arc::new(LineOffsetCache::default()),

		calls: calls.clone(),
	};
	let mut builder = ResolverTable::builder();
	builder
		.register(
			SchemeEntry::new(Scheme::Artifact, true, true, "Session and durable artifacts"),
			resolver,
		)
		.unwrap();
	let table = Arc::new(builder.build());
	assert_eq!(table.routes().get(Scheme::Artifact).unwrap().index(), 0);
	assert!(table.routes().get(Scheme::History).is_none());
	let snapshot = table.snapshot();
	assert_ne!(snapshot.device_hash, [0; 32]);
	assert_eq!(snapshot.device_hash, table.snapshot().device_hash);
	assert_eq!(snapshot.entries.as_ref(), table.entries());

	let tool = read::tool_with_resolvers(Sources::default(), Blobs::default(), table);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"path":"artifact://7:2-3"}}"#))
		.expect("resolver invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let payload = events
		.iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => Some(payload),
			_ => None,
		})
		.unwrap_or_else(|| panic!("expected resolved payload: {events:?}"));
	let [read::PayloadPart::Text { text }] = payload.parts.as_slice() else {
		panic!("expected one resolved text part: {:?}", payload.parts);
	};
	assert_eq!(text.as_str(), "two\nthree\n");
	assert_eq!(calls.load(Ordering::Relaxed), 1);

	let cache = LineOffsetCache::default();
	let bytes = CowBytes::from_static(b"one\ntwo\nthree\n");
	let bytes_ptr = bytes.as_ptr();
	let sliced = cache
		.slice("same-blob", &bytes, read::selector::LineRange { start_line: 2, end_line: Some(2) })
		.unwrap();
	assert_eq!(sliced.as_ptr(), bytes_ptr.wrapping_add(4));
}
#[tokio::test]
async fn artifact_resolver_stats_authority_caches_offsets_and_gates_digest_form_to_durable() {
	let digest = Str::new("a".repeat(64));
	let bytes = CowBytes::from_static(b"one\ntwo\nthree\n");
	let stats = Arc::new(AtomicU64::new(0));
	let ranges = Arc::new(Mutex::new(Vec::new()));
	let authority =
		BlobAuthorityFixture { bytes: bytes.clone(), stats: stats.clone(), ranges: ranges.clone() };
	let session_record =
		ArtifactRecord { digest: digest.clone(), lifetime: ArtifactLifetime::Session };
	let resolver =
		ArtifactResolver::new(ArtifactCatalogFixture { record: session_record }, authority.clone());

	let selected = read::selector::parse_selector(Some("2-3")).unwrap();
	let first = resolver.read("7", &selected).await.unwrap();
	assert_eq!(&*first, b"1:one\n2:two\n3:three");
	assert_eq!(stats.load(Ordering::Relaxed), 1);
	assert_eq!(
		ranges.lock().as_slice(),
		&[0..1, 1..bytes.len() as u64, 0..bytes.len() as u64],
		"the first artifact range indexes through bounded reads before loading its selected window"
	);

	let first_line = read::selector::parse_selector(Some("raw:1-1")).unwrap();
	assert_eq!(&*resolver.read("7", &first_line).await.unwrap(), b"one");
	assert_eq!(stats.load(Ordering::Relaxed), 2);
	assert_eq!(ranges.lock().as_slice(), &[
		0..1,
		1..bytes.len() as u64,
		0..bytes.len() as u64,
		0..4
	]);

	let error = resolver
		.read(digest.as_str(), &ParsedSelector::None)
		.await
		.unwrap_err();
	assert!(matches!(error, Fault::Source { .. }));
	assert_eq!(stats.load(Ordering::Relaxed), 2);

	let durable = ArtifactResolver::new(
		ArtifactCatalogFixture {
			record: ArtifactRecord { digest: digest.clone(), lifetime: ArtifactLifetime::Durable },
		},
		authority,
	);
	assert_eq!(
		&*durable
			.read(digest.as_str(), &ParsedSelector::None)
			.await
			.unwrap(),
		bytes.as_ref()
	);
	assert_eq!(stats.load(Ordering::Relaxed), 3);
}

#[tokio::test]
async fn artifact_raw_size_guard_uses_metadata_before_loading_blob_bytes() {
	let reads = Arc::new(AtomicU64::new(0));
	let resolver = ArtifactResolver::new(
		ArtifactCatalogFixture {
			record: ArtifactRecord {
				digest:   Str::new("c".repeat(64)),
				lifetime: ArtifactLifetime::Session,
			},
		},
		MetadataOnlyAuthority { reads: reads.clone() },
	);
	let error = resolver.read("7", &ParsedSelector::Raw).await.unwrap_err();
	assert!(matches!(error, Fault::Invalid { .. }));
	assert_eq!(reads.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn artifact_ranges_format_disjoint_spans_and_do_not_address_terminal_newlines() {
	let digest = Str::new("b".repeat(64));
	let bytes = CowBytes::from_static(b"one\ntwo\nthree\nfour\n");
	let ranges = Arc::new(Mutex::new(Vec::new()));
	let resolver = ArtifactResolver::new(
		ArtifactCatalogFixture {
			record: ArtifactRecord { digest, lifetime: ArtifactLifetime::Session },
		},
		BlobAuthorityFixture { bytes, stats: Arc::new(AtomicU64::new(0)), ranges },
	);

	let numbered = read::selector::parse_selector(Some("1-1,3-3")).unwrap();
	assert_eq!(&*resolver.read("7", &numbered).await.unwrap(), b"1:one\n\xe2\x80\xa6\n3:three");
	let raw = read::selector::parse_selector(Some("raw:2-2,4-4")).unwrap();
	assert_eq!(&*resolver.read("7", &raw).await.unwrap(), b"two\n\n\xe2\x80\xa6\n\nfour");
	let mut builder = ResolverTable::builder();
	builder
		.register(
			SchemeEntry::new(Scheme::Artifact, true, true, "Session and durable artifacts"),
			resolver,
		)
		.expect("register artifact resolver");
	let tool =
		read::tool_with_resolvers(Sources::default(), Blobs::default(), Arc::new(builder.build()));
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"path":"artifact://7:5-5"}}"#))
		.expect("artifact range invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let [Ev::Diag(diag), Ev::Done(ToolTerminal::Done { result: Ok(payload), .. })] =
		events.as_slice()
	else {
		panic!("out-of-range artifact selector emits a diagnostic then completes: {events:?}");
	};
	assert_eq!(diag.native_kind(), Some(DiagKind::RangeOutOfBounds));
	assert_eq!(diag.severity, Severity::Warn);
	let [read::PayloadPart::Text { text }] = payload.parts.as_slice() else {
		panic!("out-of-range artifact read returns one empty text part");
	};
	assert!(text.is_empty());
}

#[tokio::test]
async fn unknown_scheme_is_a_typed_fault() {
	let tool = read::tool(Sources::default(), Blobs::default());
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"path":"custom://pending"}}"#))
		.expect("unknown-scheme invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let scheme = events
		.iter()
		.find_map(|event| match event {
			Ev::Done(ToolTerminal::Done {
				result: Err(Fault::UnknownScheme { scheme, .. }), ..
			}) => Some(scheme),
			_ => None,
		})
		.unwrap_or_else(|| panic!("expected typed unknown-scheme fault: {events:?}"));
	assert_eq!(scheme.as_str(), "custom");
}
