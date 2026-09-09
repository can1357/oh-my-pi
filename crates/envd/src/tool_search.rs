//! App-owned workspace adapter for the generic grep and glob executors.

use std::{
	cmp,
	collections::{HashMap, HashSet, VecDeque},
	fmt::Display,
	fs, io,
	path::{Component, Path, PathBuf},
	str,
	sync::{
		self, Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant, UNIX_EPOCH},
};

use bytes::Bytes;
use omp_core::Str;
use omp_edit::store::file_hash;
use omp_tools::{
	glob::{self, WalkMatch, WalkResult},
	grep::{
		self, SearchMatch, SearchResult, SearchRoot, SearchRootKind, SearchSnapshot, WorkspaceSearch,
	},
	read::{
		ReadSources as _, archive,
		resolver::{ResolverTable, Scheme},
		selector::{ParsedSelector, parse_uri},
		web,
	},
};
use omp_walker::{
	CompiledWalkGlob, FileType, FollowLinks, SizeHintPolicy, WalkDecision, WalkDetail, WalkError,
	WalkFilter, WalkOrder, WalkRequest,
};
use tokio::{task, time};
use tokio_util::sync::CancellationToken;

use super::{
	docs::DocumentHost, tool_document::snapshot_text, tool_read_sources::ReadSourceAdapter,
	tool_url::UrlResolver, workspace::WorkspaceHost,
};

const CANCELLED_REASON: &str = "workspace traversal future was dropped";
const SNAPSHOT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const INTERNAL_ROOT_MAX_ENTRIES: usize = 4_096;

/// Cloneable bridge from generic search tools to the app-owned workspace and
/// session document state.
#[derive(Clone)]
pub struct WorkspaceSearchAdapter {
	host:         WorkspaceHost,
	documents:    DocumentHost,
	read_sources: ReadSourceAdapter,
	resolvers:    sync::Arc<ResolverTable<UrlResolver>>,
}

impl WorkspaceSearchAdapter {
	/// Wraps the concrete workspace owner, session document host, and shared
	/// cache-enabled read source used by the environment daemon.
	pub(crate) fn new(
		host: WorkspaceHost,
		documents: DocumentHost,
		read_sources: ReadSourceAdapter,
		resolvers: sync::Arc<ResolverTable<UrlResolver>>,
	) -> Self {
		Self { host, documents, read_sources, resolvers }
	}
}

impl WorkspaceSearch for WorkspaceSearchAdapter {
	fn prepare_roots(
		&self,
		roots: Vec<SearchRoot>,
		unsplit: Option<SearchRoot>,
	) -> impl Future<Output = Result<Vec<SearchRoot>, grep::Fault>> + Send + '_ {
		let host = self.host.clone();
		async move {
			let Some(mut unsplit) = unsplit.filter(|root| root.kind == SearchRootKind::Filesystem)
			else {
				return Ok(roots);
			};
			if resolve_literal_grep_target(&host, unsplit.original.as_str())?.is_some() {
				unsplit.path = unsplit.original.clone();
				unsplit.ranges = Box::default();
				return Ok(vec![unsplit]);
			}
			if resolve_literal_grep_target(&host, unsplit.path.as_str())?.is_some() {
				return Ok(vec![unsplit]);
			}
			Ok(roots)
		}
	}

	fn search(
		&self,
		request: grep::SearchRequest,
	) -> impl Future<Output = Result<SearchResult, grep::Fault>> + Send + '_ {
		let host = self.host.clone();
		let read_sources = self.read_sources.clone();
		let resolvers = sync::Arc::clone(&self.resolvers);
		async move {
			let cancel = CancellationToken::new();
			let blocking_cancel = Arc::new(AtomicBool::new(false));
			let cancel_on_drop = BlockingCancelOnDrop {
				token:    cancel.clone(),
				blocking: Arc::clone(&blocking_cancel),
			};
			let deadline = Instant::now()
				.checked_add(Duration::from_millis(u64::from(request.timeout_ms)))
				.unwrap_or_else(Instant::now);
			let external = materialize_external_roots(
				&host,
				&read_sources,
				&resolvers,
				&request,
				deadline,
				&cancel,
			)
			.await?;
			let operation = task::spawn_blocking(move || {
				search_blocking(&host, request, external, deadline, &cancel, blocking_cancel)
			});
			let result = operation.await.map_err(|error| grep::Fault::Workspace {
				message: Str::from(format!("workspace search task failed: {error}")),
			})?;
			drop(cancel_on_drop);
			result
		}
	}

	fn stage_snapshots(&self, snapshots: Vec<SearchSnapshot>) -> Result<(), grep::Fault> {
		let store = self.documents.snapshot_store();
		for snapshot in snapshots {
			let text = snapshot_text(&snapshot.bytes).ok_or_else(|| grep::Fault::Workspace {
				message: Str::new_static("grep snapshot content is not UTF-8"),
			})?;
			store.record(Path::new(snapshot.source_key.as_str()), &text, None);
		}
		Ok(())
	}

	fn record_snapshots(&self, records: Vec<grep::SnapshotRecord>) -> Result<(), grep::Fault> {
		let store = self.documents.snapshot_store();
		for record in records {
			let tag = str::from_utf8(&record.revision).map_err(|_| grep::Fault::Workspace {
				message: Str::new_static("grep snapshot identity is invalid"),
			})?;
			let path = Path::new(record.source_key.as_str());
			let Some(snapshot) = store.by_hash(path, tag) else {
				return Err(grep::Fault::Workspace {
					message: Str::new_static(
						"grep snapshot revision expired before visibility authorization",
					),
				});
			};
			let seen_lines = record
				.seen_lines
				.into_iter()
				.filter_map(|line| u32::try_from(line).ok())
				.collect::<Vec<_>>();
			store.record_seen_lines(path, &snapshot.hash, &seen_lines);
		}
		Ok(())
	}

	fn glob(
		&self,
		request: glob::WalkRequest,
		cancellation: CancellationToken,
	) -> impl Future<Output = Result<WalkResult, glob::Fault>> + Send + '_ {
		let host = self.host.clone();
		async move {
			let cancel_on_drop = CancelOnDrop(cancellation.clone());
			let operation = task::spawn_blocking(move || glob_blocking(&host, request, &cancellation));
			let result = operation.await.map_err(|error| glob::Fault::Workspace {
				message: Str::from(format!("workspace walk task failed: {error}")),
			})?;
			drop(cancel_on_drop);
			result
		}
	}

	fn glob_resource(
		&self,
		request: glob::WalkRequest,
		cancellation: CancellationToken,
	) -> impl Future<Output = Option<Result<WalkResult, glob::Fault>>> + Send + '_ {
		let resolvers = sync::Arc::clone(&self.resolvers);
		let host = self.host.clone();
		async move {
			if !split_top_level_semicolons(request.path.as_str())
				.into_iter()
				.any(is_resource_glob_target)
			{
				return None;
			}
			Some(resource_glob(&resolvers, &host, request, &cancellation).await)
		}
	}
}

fn is_resource_glob_target(target: &str) -> bool {
	let Some((scheme, _)) = target.trim().split_once("://") else {
		return false;
	};
	matches!(Scheme::parse(scheme), Scheme::Ssh | Scheme::Vault | Scheme::Memory)
}

async fn resource_glob(
	resolvers: &ResolverTable<UrlResolver>,
	host: &WorkspaceHost,
	request: glob::WalkRequest,
	cancellation: &CancellationToken,
) -> Result<WalkResult, glob::Fault> {
	let deadline = time::Instant::now() + Duration::from_millis(request.timeout_ms);
	let mut matches = Vec::new();
	let mut missing_paths = Vec::new();
	let mut found_target = false;
	let mut truncated = false;
	let mut timed_out = false;
	'targets: for target in split_top_level_semicolons(request.path.as_str())
		.into_iter()
		.map(str::trim)
		.filter(|target| !target.is_empty())
	{
		if cancellation.is_cancelled() {
			return Err(cancelled_glob());
		}
		if time::Instant::now() >= deadline {
			timed_out = true;
			break;
		}
		if !target.contains("://") {
			let remaining = deadline.saturating_duration_since(time::Instant::now());
			let local_request = glob::WalkRequest {
				path:       Str::new(target),
				hidden:     request.hidden,
				gitignore:  request.gitignore,
				limit:      request.limit,
				timeout_ms: duration_millis(remaining),
			};
			let local_host = host.clone();
			let local_cancellation = cancellation.clone();
			let local = task::spawn_blocking(move || {
				glob_blocking(&local_host, local_request, &local_cancellation)
			})
			.await
			.map_err(|error| glob::Fault::Workspace {
				message: Str::from(format!("workspace walk task failed: {error}")),
			})?;
			match local {
				Ok(result) => {
					found_target = true;
					matches.extend(result.matches);
					missing_paths.extend(result.missing_paths);
					truncated |= result.truncated;
					if result.timed_out {
						timed_out = true;
						break;
					}
				},
				Err(glob::Fault::PathNotFound { paths }) => missing_paths.extend(paths),
				Err(fault) => return Err(fault),
			}
			continue;
		}
		let parsed = parse_uri(target)
			.map_err(|error| glob::Fault::Workspace { message: Str::new(error.to_string()) })?
			.ok_or_else(|| glob::Fault::UnsupportedScheme { scheme: Str::new_static("file") })?;
		if !matches!(parsed.scheme, Scheme::Ssh | Scheme::Vault | Scheme::Memory) {
			return Err(glob::Fault::UnsupportedScheme {
				scheme: Str::new(parsed.raw_scheme.to_ascii_lowercase()),
			});
		}
		if parsed.selector_text.is_some() || parsed.query.is_some() {
			return Err(glob::Fault::Workspace {
				message: Str::new_static(
					"resource glob targets do not accept read selectors or queries",
				),
			});
		}
		let resource = parsed.resource;
		let wildcard = resource.find(['*', '?', '[']);
		let (base, pattern) = if let Some(index) = wildcard {
			let slash = resource[..index].rfind('/').unwrap_or(resource.len());
			(&resource[..slash], resource)
		} else {
			let slash = resource.rfind('/').unwrap_or(resource.len());
			(&resource[..slash], resource)
		};
		let compiled =
			CompiledWalkGlob::new([pattern]).map_err(|error| glob::Fault::InvalidPattern {
				pattern: Str::new(pattern),
				message: Str::new(error.to_string()),
			})?;
		let mut pending = VecDeque::from([Str::new(base)]);
		let mut listed_any = false;
		while let Some(directory) = pending.pop_front() {
			if cancellation.is_cancelled() {
				return Err(cancelled_glob());
			}
			if time::Instant::now() >= deadline {
				timed_out = true;
				break 'targets;
			}
			if matches.len() >= request.limit as usize || pending.len() > 10_000 {
				truncated = true;
				break;
			}
			let listed = tokio::select! {
				biased;
				() = cancellation.cancelled() => return Err(cancelled_glob()),
				result = time::timeout_at(
					deadline,
					resolvers.list(parsed.scheme, &directory, request.limit as usize + 1, 1024 * 1024),
				) => match result {
					Ok(result) => result,
					Err(_) => {
						timed_out = true;
						break 'targets;
					},
				},
			};
			let Some(listed) = listed else {
				return Err(glob::Fault::UnsupportedScheme {
					scheme: Str::new(parsed.raw_scheme.to_ascii_lowercase()),
				});
			};
			let listed = match listed {
				Ok(value) => {
					found_target = true;
					value
				},
				Err(_) if !listed_any => {
					missing_paths.push(Str::new(target));
					break;
				},
				Err(_) => {
					truncated = true;
					break;
				},
			};
			listed_any = true;
			truncated |= listed.truncated;
			for entry in listed.entries {
				let child = entry
					.uri
					.split_once("://")
					.map_or(entry.uri.as_str(), |(_, value)| value);
				if compiled.is_match(child) && (request.hidden || !entry.name.starts_with('.')) {
					matches.push(WalkMatch {
						path:        entry.uri.clone(),
						modified_ms: 0,
						is_dir:      entry.directory,
					});
				}
				if entry.directory && (request.hidden || !entry.name.starts_with('.')) {
					pending.push_back(Str::new(child));
				}
			}
		}
	}
	if !found_target && !missing_paths.is_empty() {
		return Err(glob::Fault::PathNotFound { paths: missing_paths });
	}
	matches.sort_by(|left, right| {
		right
			.modified_ms
			.cmp(&left.modified_ms)
			.then_with(|| left.path.cmp(&right.path))
	});
	let mut seen = HashSet::with_capacity(matches.len());
	matches.retain(|entry| seen.insert(entry.path.clone()));
	let retain = usize::try_from(request.limit).unwrap_or(usize::MAX);
	if matches.len() > retain {
		truncated = true;
		matches.truncate(retain);
	}
	Ok(WalkResult { matches, missing_paths, timed_out, truncated })
}

#[must_use]
struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.cancel();
	}
}

#[must_use]
struct BlockingCancelOnDrop {
	token:    CancellationToken,
	blocking: Arc<AtomicBool>,
}

impl Drop for BlockingCancelOnDrop {
	fn drop(&mut self) {
		self.blocking.store(true, Ordering::Relaxed);
		self.token.cancel();
	}
}

#[derive(Debug)]
enum GrepTarget {
	Filesystem { root_index: u64, path: PathBuf, glob: Option<Str>, is_file: bool },
	Memory(MemorySearchTarget),
}

#[derive(Debug)]
struct MemorySearchTarget {
	root_index: u64,
	source_key: Str,
	path:       Str,
	content:    Bytes,
}

#[derive(Debug, Default)]
struct ExternalMaterialization {
	by_root:            HashMap<usize, Vec<MemorySearchTarget>>,
	archive_unreadable: Vec<Str>,
}

async fn materialize_external_roots(
	host: &WorkspaceHost,
	sources: &ReadSourceAdapter,
	resolvers: &ResolverTable<UrlResolver>,
	request: &grep::SearchRequest,
	deadline: Instant,
	cancel: &CancellationToken,
) -> Result<ExternalMaterialization, grep::Fault> {
	let mut materialized = ExternalMaterialization::default();
	for (root_index, root) in request.roots.iter().enumerate() {
		check_grep_cancel(cancel)?;
		if root.original != root.path
			&& resolve_literal_grep_target(host, root.original.as_str())?.is_some()
		{
			continue;
		}
		let remaining =
			Duration::from_millis(u64::from(remaining_millis(deadline).ok_or(grep::Fault::TimedOut)?));
		match root.kind {
			SearchRootKind::Filesystem => {},
			SearchRootKind::Archive => {
				let archive =
					time::timeout(remaining, materialize_archive_root(host, sources, root, root_index))
						.await
						.map_err(|_| grep::Fault::TimedOut)?;
				match archive {
					Ok((targets, unreadable)) => {
						if !root.ranges.is_empty() && targets.len().saturating_add(unreadable.len()) != 1
						{
							return Err(grep::Fault::InvalidSelector {
								message: Str::from(format!(
									"Line-range selector requires a single archive member: {}",
									root.original
								)),
							});
						}
						if !targets.is_empty() {
							materialized.by_root.insert(root_index, targets);
						}
						materialized.archive_unreadable.extend(unreadable);
					},
					Err(message) => materialized
						.archive_unreadable
						.push(Str::from(format!("{} ({message})", root.path))),
				}
			},
			SearchRootKind::Url => {
				let target = time::timeout(remaining, materialize_url_root(sources, root, root_index))
					.await
					.map_err(|_| grep::Fault::TimedOut)??;
				materialized.by_root.insert(root_index, vec![target]);
			},
			SearchRootKind::Internal => {
				let targets =
					time::timeout(remaining, materialize_internal_root(resolvers, root, root_index))
						.await
						.map_err(|_| grep::Fault::TimedOut)??;
				if !root.ranges.is_empty() && targets.len() != 1 {
					return Err(grep::Fault::InvalidSelector {
						message: Str::from(format!(
							"Line-range selector requires a single internal resource: {}",
							root.original
						)),
					});
				}
				materialized.by_root.insert(root_index, targets);
			},
		}
	}
	remaining_millis(deadline).ok_or(grep::Fault::TimedOut)?;
	Ok(materialized)
}

async fn materialize_archive_root(
	host: &WorkspaceHost,
	sources: &ReadSourceAdapter,
	root: &SearchRoot,
	root_index: usize,
) -> Result<(Vec<MemorySearchTarget>, Vec<Str>), String> {
	let candidates = archive::parse_archive_path_candidates(root.path.as_str());
	let mut last_error = None;
	for candidate in candidates
		.into_iter()
		.filter(|candidate| !candidate.sub_path.is_empty())
	{
		let archive_path = resolve_input_path(host.root(), &candidate.archive_path);
		let archive_path = tokio::fs::canonicalize(&archive_path)
			.await
			.unwrap_or(archive_path);
		let source_path = Str::from(archive_path.to_string_lossy().into_owned());
		let bytes = match sources.read_bytes(source_path).await {
			Ok(bytes) => bytes,
			Err(error) => {
				last_error = Some(error.message().to_string());
				continue;
			},
		};
		let archive_key = Str::from(archive_path.to_string_lossy().into_owned());
		let root = root.clone();
		return task::spawn_blocking(move || {
			materialize_archive_bytes(&root, root_index, candidate, archive_key, bytes)
		})
		.await
		.map_err(|error| format!("archive materialization task failed: {error}"))?;
	}
	Err(format!(
		"cannot open archive: {}",
		last_error.unwrap_or_else(|| "archive path could not be resolved".to_owned())
	))
}

fn materialize_archive_bytes(
	root: &SearchRoot,
	root_index: usize,
	candidate: archive::ArchivePathCandidate,
	archive_key: Str,
	bytes: Bytes,
) -> Result<(Vec<MemorySearchTarget>, Vec<Str>), String> {
	let format = archive::archive_format_from_path(&candidate.archive_path)
		.or_else(|| archive::sniff_archive_format(&bytes))
		.ok_or_else(|| "cannot determine archive format".to_owned())?;
	let contents = archive::open_archive_bytes(bytes, format)
		.map_err(|error| format!("cannot open archive: {error}"))?
		.materialize_text_members()
		.map_err(|error| format!("cannot read archive: {error}"))?;
	let selected = candidate.sub_path.trim_matches('/');
	let selected_prefix = format!("{selected}/");
	let matches_selected = |path: &str| path == selected || path.starts_with(&selected_prefix);
	let root_index = u64::try_from(root_index).unwrap_or(u64::MAX);
	let mut targets = Vec::new();
	for member in contents
		.members
		.into_iter()
		.filter(|member| matches_selected(&member.path))
	{
		let display = archive_display_path(root.path.as_str(), &candidate, selected, &member.path);
		targets.push(MemorySearchTarget {
			root_index,
			source_key: Str::from(format!("archive:{archive_key}:{}", member.path)),
			path: display,
			content: Bytes::from(member.text),
		});
	}
	let mut unreadable = Vec::new();
	for member in contents
		.binary_members
		.into_iter()
		.filter(|member| matches_selected(&member.node.path))
	{
		let display =
			archive_display_path(root.path.as_str(), &candidate, selected, &member.node.path);
		unreadable.push(Str::from(format!("{display} (binary archive entry)")));
	}
	if targets.is_empty() && unreadable.is_empty() {
		unreadable.push(Str::from(format!("{} (archive entry not found)", root.path)));
	}
	Ok((targets, unreadable))
}

fn archive_display_path(
	authored: &str,
	candidate: &archive::ArchivePathCandidate,
	selected: &str,
	member: &str,
) -> Str {
	if selected == member {
		Str::from(authored)
	} else {
		Str::from(format!("{}:{member}", candidate.archive_path))
	}
}

async fn materialize_url_root<C: web::types::HttpClient + Sync>(
	client: &C,
	root: &SearchRoot,
	root_index: usize,
) -> Result<MemorySearchTarget, grep::Fault> {
	let parsed = web::parse_target(root.path.as_str())
		.map_err(grep_workspace_message)?
		.ok_or_else(|| grep_workspace_message(format!("invalid URL: {}", root.path)))?;
	let rendered = web::read(client, &parsed.url, false)
		.await
		.map_err(grep_workspace_message)?;
	Ok(MemorySearchTarget {
		root_index: u64::try_from(root_index).unwrap_or(u64::MAX),
		source_key: Str::from(format!("url:{}", parsed.url)),
		path:       root.path.clone(),
		content:    Bytes::from(rendered.content),
	})
}

async fn materialize_internal_root(
	resolvers: &ResolverTable<UrlResolver>,
	root: &SearchRoot,
	root_index: usize,
) -> Result<Vec<MemorySearchTarget>, grep::Fault> {
	let parsed = parse_uri(root.path.as_str())
		.map_err(grep_workspace_message)?
		.ok_or_else(|| grep_workspace_message(format!("invalid internal URI: {}", root.path)))?;
	let root_index = u64::try_from(root_index).unwrap_or(u64::MAX);
	if parsed.scheme == Scheme::Omp
		&& (parsed.resource.is_empty() || parsed.resource.trim_matches('/') == "docs")
	{
		let (completions, truncated) = resolvers
			.complete(Scheme::Omp, "", INTERNAL_ROOT_MAX_ENTRIES)
			.await
			.ok_or_else(|| grep_workspace_message("omp:// documentation resolver is unavailable"))?
			.map_err(|error| grep_workspace_message(error.message()))?;
		if truncated {
			return Err(grep_workspace_message(
				"omp:// documentation catalog exceeded the bounded search inventory",
			));
		}
		let mut targets = Vec::with_capacity(completions.len());
		for completion in completions {
			let uri = completion.value;
			let doc = parse_uri(uri.as_str())
				.map_err(grep_workspace_message)?
				.ok_or_else(|| grep_workspace_message(format!("invalid documentation URI: {uri}")))?;
			let content = resolvers
				.read_query(doc.scheme, &doc.resource, doc.query, &ParsedSelector::None)
				.await
				.ok_or_else(|| grep_workspace_message("omp:// documentation resolver disappeared"))?
				.map_err(|error| grep_workspace_message(error.message()))?;
			targets.push(MemorySearchTarget {
				root_index,
				source_key: uri.clone(),
				path: uri,
				content: content.into_bytes(),
			});
		}
		return Ok(targets);
	}
	let content = resolvers
		.read_query(parsed.scheme, &parsed.resource, parsed.query, &ParsedSelector::None)
		.await
		.ok_or_else(|| {
			grep_workspace_message(format!("unsupported internal URI scheme: {}", parsed.raw_scheme))
		})?
		.map_err(|error| grep_workspace_message(error.message()))?;
	Ok(vec![MemorySearchTarget {
		root_index,
		source_key: root.path.clone(),
		path: root.path.clone(),
		content: content.into_bytes(),
	}])
}

#[derive(Debug)]
struct PendingSnapshot {
	path: PathBuf,
}

fn search_blocking(
	host: &WorkspaceHost,
	request: grep::SearchRequest,
	mut external: ExternalMaterialization,
	deadline: Instant,
	cancel: &CancellationToken,
	blocking_cancel: Arc<AtomicBool>,
) -> Result<SearchResult, grep::Fault> {
	check_grep_cancel(cancel)?;
	let mut targets = Vec::new();
	let mut missing_paths = Vec::new();
	for (root_index, root) in request.roots.iter().enumerate() {
		let literal_original = if root.original == root.path {
			None
		} else {
			resolve_literal_grep_target(host, root.original.as_str())?
		};
		if let Some(GrepTarget::Filesystem { path, glob, is_file, .. }) = literal_original {
			targets.push(GrepTarget::Filesystem { root_index: u64::MAX, path, glob, is_file });
			continue;
		}
		match root.kind {
			SearchRootKind::Archive | SearchRootKind::Url | SearchRootKind::Internal => {
				targets.extend(
					external
						.by_root
						.remove(&root_index)
						.unwrap_or_default()
						.into_iter()
						.map(GrepTarget::Memory),
				);
			},
			SearchRootKind::Filesystem => match resolve_grep_target(host, root.path.as_str())? {
				Some(GrepTarget::Filesystem { path, glob, is_file, .. }) => {
					if !root.ranges.is_empty() && !is_file {
						return Err(grep::Fault::InvalidSelector {
							message: Str::from(format!(
								"Line-range selector requires a single file: {} is a directory",
								root.original
							)),
						});
					}
					targets.push(GrepTarget::Filesystem {
						root_index: u64::try_from(root_index).unwrap_or(u64::MAX),
						path,
						glob,
						is_file,
					});
				},
				Some(GrepTarget::Memory(_)) => unreachable!("filesystem resolver returned memory"),
				None => missing_paths.push(root.original.clone()),
			},
		}
	}
	if targets.is_empty() && external.archive_unreadable.is_empty() {
		return Err(grep::Fault::AllPathsMissing { paths: missing_paths });
	}

	let memory_targets = targets
		.iter()
		.filter(|target| matches!(target, GrepTarget::Memory(_)))
		.count();
	let multi_scope = request.roots.len() > 1
		|| memory_targets > 1
		|| targets.iter().any(|target| {
			matches!(
				target,
				GrepTarget::Filesystem { is_file: false, .. }
					| GrepTarget::Filesystem { glob: Some(_), .. }
			)
		});
	let per_file_cap = if multi_scope {
		request.multi_file_max_count
	} else {
		request.single_file_max_count
	};
	let mut remaining = request.max_count;
	let mut matches = Vec::new();
	let mut seen_matches = HashSet::new();
	let mut limit_reached = false;
	let mut skipped_oversized = 0_u32;
	let mut oversized_files = Vec::new();
	let mut pending_snapshots: HashMap<Str, PendingSnapshot> = HashMap::new();

	for target in &targets {
		check_grep_cancel(cancel)?;
		if remaining == 0 {
			limit_reached = true;
			break;
		}
		let timeout_ms = remaining_millis(deadline).ok_or(grep::Fault::TimedOut)?;
		let (display_path, glob) = match target {
			GrepTarget::Filesystem { path, glob, is_file, .. } => {
				if *is_file
					&& fs::metadata(path)
						.is_ok_and(|metadata| metadata.len() > crate::grep::MAX_FILE_BYTES)
				{
					oversized_files.push(workspace_relative(host.root(), path)?);
				}
				(Str::from(path.to_string_lossy().into_owned()), glob.clone())
			},
			GrepTarget::Memory(memory) => (memory.path.clone(), None),
		};
		let options = crate::grep::GrepOptions {
			pattern: request.pattern.clone(),
			path: display_path,
			glob,
			ignore_case: request.ignore_case,
			multiline: request.multiline,
			hidden: request.hidden,
			gitignore: request.gitignore,
			max_count: Some(remaining),
			max_count_per_file: Some(per_file_cap),
			context_before: request.context_before,
			context_after: request.context_after,
			max_columns: Some(request.max_columns),
			mode: crate::grep::GrepOutputMode::Content,
			timeout_ms: Some(timeout_ms),
		};
		let native = match target {
			GrepTarget::Filesystem { .. } => {
				crate::grep::grep_with_cancellation(&options, blocking_cancel.as_ref())
					.map_err(map_native_grep_fault)?
			},
			GrepTarget::Memory(memory) => crate::grep::search_with_cancellation(
				&memory.content,
				&options,
				blocking_cancel.as_ref(),
			)
			.map_err(map_native_grep_fault)?,
		};
		skipped_oversized = skipped_oversized.saturating_add(native.skipped_oversized);
		limit_reached |= native.limit_reached;

		for matched in native.matches {
			check_grep_cancel(cancel)?;
			let context_before: Vec<_> = matched
				.context_before
				.into_iter()
				.map(|line| grep::ContextLine { line_number: line.line_number, line: line.line })
				.collect();
			let context_after: Vec<_> = matched
				.context_after
				.into_iter()
				.map(|line| grep::ContextLine { line_number: line.line_number, line: line.line })
				.collect();
			let (source_key, path, root_index) = match target {
				GrepTarget::Filesystem { root_index, path, is_file, .. } => {
					let source_path = if *is_file {
						path.clone()
					} else {
						path.join(matched.path.as_str())
					};
					let canonical = fs::canonicalize(&source_path).unwrap_or(source_path);
					let source_key = Str::from(canonical.to_string_lossy().into_owned());
					pending_snapshots
						.entry(source_key.clone())
						.or_insert_with(|| PendingSnapshot { path: canonical.clone() });
					(source_key, workspace_relative(host.root(), &canonical)?, *root_index)
				},
				GrepTarget::Memory(memory) => {
					(memory.source_key.clone(), memory.path.clone(), memory.root_index)
				},
			};
			if !seen_matches.insert((source_key.clone(), matched.line_number)) {
				continue;
			}
			matches.push(SearchMatch {
				source_key,
				path,
				root_index,
				line_number: matched.line_number,
				line: matched.line,
				truncated: matched.truncated,
				context_before,
				context_after,
				snapshot_tag: None,
			});
			remaining = remaining.saturating_sub(1);
			if remaining == 0 {
				limit_reached = true;
				break;
			}
		}
	}
	let mut pending_snapshots: Vec<_> = pending_snapshots.into_iter().collect();
	pending_snapshots.sort_unstable_by(|left, right| left.0.cmp(&right.0));
	let mut snapshots = Vec::with_capacity(pending_snapshots.len());
	let mut snapshot_tags = HashMap::with_capacity(pending_snapshots.len());
	for (source_key, pending) in pending_snapshots {
		if let Some(snapshot) = prepare_grep_snapshot(source_key.clone(), &pending.path) {
			snapshot_tags.insert(
				source_key,
				Str::from(str::from_utf8(&snapshot.revision).expect("prepared tag is UTF-8")),
			);
			snapshots.push(snapshot);
		}
	}
	for matched in &mut matches {
		matched.snapshot_tag = snapshot_tags.get(&matched.source_key).cloned();
	}
	check_grep_cancel(cancel)?;
	oversized_files.sort_unstable();
	oversized_files.dedup();
	Ok(SearchResult {
		matches,
		snapshots,
		multi_scope,
		limit_reached,
		skipped_oversized,
		missing_paths,
		archive_unreadable: external.archive_unreadable,
		oversized_files,
	})
}

fn resolve_literal_grep_target(
	host: &WorkspaceHost,
	input: &str,
) -> Result<Option<GrepTarget>, grep::Fault> {
	let input = normalize_input(input);
	let literal = resolve_input_path(host.root(), &input);
	let metadata = match fs::metadata(&literal) {
		Ok(metadata) => metadata,
		Err(error) if is_missing(&error) => return Ok(None),
		Err(error) => return Err(grep_workspace_message(error)),
	};
	let canonical = fs::canonicalize(&literal).map_err(grep_workspace_message)?;
	Ok(Some(GrepTarget::Filesystem {
		root_index: 0,
		path:       canonical,
		glob:       None,
		is_file:    metadata.is_file(),
	}))
}

fn resolve_grep_target(
	host: &WorkspaceHost,
	input: &str,
) -> Result<Option<GrepTarget>, grep::Fault> {
	let input = normalize_input(input);
	let literal = resolve_input_path(host.root(), &input);
	match fs::metadata(&literal) {
		Ok(metadata) => {
			let canonical = fs::canonicalize(&literal).map_err(grep_workspace_message)?;
			return Ok(Some(GrepTarget::Filesystem {
				root_index: 0,
				path:       canonical,
				glob:       None,
				is_file:    metadata.is_file(),
			}));
		},
		Err(error) if is_missing(&error) => {},
		Err(error) => return Err(grep_workspace_message(error)),
	}
	let Some(parsed) = parse_glob_path(&input) else {
		return Ok(None);
	};
	let base = resolve_input_path(host.root(), &parsed.base);
	let metadata = match fs::metadata(&base) {
		Ok(metadata) => metadata,
		Err(error) if is_missing(&error) => return Ok(None),
		Err(error) => return Err(grep_workspace_message(error)),
	};
	let canonical = fs::canonicalize(&base).map_err(grep_workspace_message)?;
	if !metadata.is_dir() {
		return Ok(None);
	}
	Ok(Some(GrepTarget::Filesystem {
		root_index: 0,
		path:       canonical,
		glob:       Some(parsed.pattern.into()),
		is_file:    false,
	}))
}

fn prepare_grep_snapshot(source_key: Str, path: &Path) -> Option<SearchSnapshot> {
	let metadata = fs::metadata(path).ok()?;
	if metadata.len() > SNAPSHOT_MAX_BYTES {
		return None;
	}
	let bytes = Bytes::from(fs::read(path).ok()?);
	let text = snapshot_text(&bytes)?;
	let revision = Bytes::from(file_hash(&text));
	Some(SearchSnapshot { source_key, revision, bytes })
}

fn map_native_grep_fault(error: crate::grep::GrepError) -> grep::Fault {
	match error {
		crate::grep::GrepError::InvalidRegex { regex, pcre2 } => {
			let message = format!("{regex}; PCRE2 fallback: {pcre2}");
			grep::Fault::InvalidRegex { message: Str::from(strip_regex_error_prefix(&message)) }
		},
		crate::grep::GrepError::Timeout { .. } => grep::Fault::TimedOut,
		crate::grep::GrepError::Cancelled => {
			grep::Fault::Cancelled { reason: Str::from(CANCELLED_REASON) }
		},
		crate::grep::GrepError::PathNotFound { path } => {
			grep::Fault::AllPathsMissing { paths: vec![path] }
		},
		crate::grep::GrepError::InvalidGlob { message }
		| crate::grep::GrepError::Walk { message }
		| crate::grep::GrepError::Search { message } => grep::Fault::Workspace { message },
	}
}
fn strip_regex_error_prefix(message: &str) -> &str {
	for prefix in ["regex parse error:", "regex error:"] {
		if message
			.get(..prefix.len())
			.is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
		{
			return message[prefix.len()..].trim_start();
		}
	}
	message
}

fn remaining_millis(deadline: Instant) -> Option<u32> {
	let remaining = deadline.checked_duration_since(Instant::now())?;
	let millis = remaining.as_millis().clamp(1, u128::from(u32::MAX));
	Some(u32::try_from(millis).unwrap_or(u32::MAX))
}

fn check_grep_cancel(cancel: &CancellationToken) -> Result<(), grep::Fault> {
	if cancel.is_cancelled() {
		Err(grep::Fault::Cancelled { reason: Str::from(CANCELLED_REASON) })
	} else {
		Ok(())
	}
}

#[derive(Debug)]
struct ParsedGlob {
	base:    String,
	pattern: String,
}

fn parse_glob_path(input: &str) -> Option<ParsedGlob> {
	let normalized = input.replace('\\', "/");
	let segments: Vec<&str> = normalized.split('/').collect();
	let first_glob = segments
		.iter()
		.position(|segment| has_glob_chars(segment))?;
	let base = if first_glob == 0 {
		".".to_owned()
	} else {
		segments[..first_glob].join("/")
	};
	Some(ParsedGlob { base, pattern: segments[first_glob..].join("/") })
}

#[derive(Debug)]
struct FindPattern {
	base:     String,
	pattern:  String,
	has_glob: bool,
}

fn parse_find_pattern(input: &str) -> FindPattern {
	let normalized = input.replace('\\', "/");
	let segments: Vec<&str> = normalized.split('/').collect();
	let Some(first_glob) = segments.iter().position(|segment| has_glob_chars(segment)) else {
		return FindPattern { base: normalized, pattern: "**/*".to_owned(), has_glob: false };
	};
	if first_glob == 0 {
		let pattern = if normalized.starts_with("**/") {
			normalized
		} else {
			format!("**/{normalized}")
		};
		return FindPattern { base: ".".to_owned(), pattern, has_glob: true };
	}
	FindPattern {
		base:     segments[..first_glob].join("/"),
		pattern:  segments[first_glob..].join("/"),
		has_glob: true,
	}
}

fn glob_blocking(
	host: &WorkspaceHost,
	request: glob::WalkRequest,
	cancel: &CancellationToken,
) -> Result<WalkResult, glob::Fault> {
	let inputs = split_glob_inputs(host, request.path.as_str())?;
	let multi_target = inputs.len() > 1;
	let mut missing_paths = Vec::new();
	let mut targets = Vec::new();
	let mut found_paths = 0_usize;

	for input in inputs {
		check_glob_cancel(cancel)?;
		if input.bytes().all(|byte| byte == b'/') {
			return Err(glob::Fault::RootSearch);
		}
		let literal_path = resolve_input_path(host.root(), &input);
		let (parsed, metadata, target_path) = match fs::metadata(&literal_path) {
			Ok(metadata) => (
				FindPattern { base: input.clone(), pattern: "**/*".to_owned(), has_glob: false },
				metadata,
				literal_path,
			),
			Err(error) if is_missing(&error) => {
				let parsed = parse_find_pattern(&input);
				if parsed.base.bytes().all(|byte| byte == b'/') {
					return Err(glob::Fault::RootSearch);
				}
				let target_path = resolve_input_path(host.root(), &parsed.base);
				match fs::metadata(&target_path) {
					Ok(metadata) => (parsed, metadata, target_path),
					Err(error) if is_missing(&error) => {
						missing_paths.push(Str::from(input));
						continue;
					},
					Err(error) => return Err(glob_workspace_message(error)),
				}
			},
			Err(error) => return Err(glob_workspace_message(error)),
		};
		let canonical = fs::canonicalize(&target_path).map_err(glob_workspace_message)?;
		// Walk the canonical root, but retain an external absolute root's
		// caller-visible spelling (notably `/var` versus `/private/var` on macOS) for
		// result projection. Normalize only lexical `.`/`..` components so equivalent
		// authored targets project and deduplicate identically without resolving
		// symlinks.
		let visible_root = (Path::new(&parsed.base).is_absolute()
			&& canonical.strip_prefix(host.root()).is_err())
		.then(|| lexical_normalize_absolute(&target_path));
		found_paths = found_paths.saturating_add(1);
		if (!metadata.is_file() && !metadata.is_dir()) || (parsed.has_glob && !metadata.is_dir()) {
			if multi_target {
				continue;
			}
			return Err(glob::Fault::PathNotDirectory { path: Str::from(input) });
		}
		targets.push(GlobTarget { parsed, metadata, canonical, visible_root });
	}
	if targets.is_empty() && found_paths == 0 {
		return Err(glob::Fault::PathNotFound { paths: missing_paths });
	}

	let deadline = Instant::now()
		.checked_add(Duration::from_millis(request.timeout_ms))
		.unwrap_or_else(Instant::now);
	let mut matches = Vec::new();
	let mut truncated = false;
	let mut timed_out = false;
	for target in targets {
		check_glob_cancel(cancel)?;
		if Instant::now() >= deadline {
			timed_out = true;
			break;
		}
		if !target.parsed.has_glob && target.metadata.is_file() {
			matches.push(WalkMatch {
				path:        glob_display_path(
					host.root(),
					&target.canonical,
					target.visible_root.as_deref(),
					&target.canonical,
				)
				.map(Str::from)
				.map_err(glob_workspace_message)?,
				modified_ms: modified_millis(&target.metadata),
				is_dir:      false,
			});
			continue;
		}
		let compiled = CompiledWalkGlob::new([target.parsed.pattern.as_str()]).map_err(|error| {
			glob::Fault::InvalidPattern {
				pattern: Str::from(target.parsed.pattern.clone()),
				message: Str::from(error.to_string()),
			}
		})?;
		let mentions_node_modules = target.parsed.pattern.contains("node_modules");
		let max_depth = glob_max_depth(&target.parsed.pattern);
		let walk = WalkRequest::new(&target.canonical)
			.hidden(request.hidden)
			.gitignore(request.gitignore)
			.skip_git(true)
			.skip_node_modules(!mentions_node_modules)
			.follow_links(FollowLinks::Never)
			.detail(WalkDetail::Full)
			.size_hints(SizeHintPolicy::Always)
			.order(WalkOrder::Unordered)
			.emit_root(false)
			.depth(1, max_depth)
			.filter(WalkFilter::all().glob(compiled))
			.cache(false);
		let outcome = walk_glob_target(
			host.root(),
			&target.canonical,
			target.visible_root.as_deref(),
			&walk,
			request.limit,
			deadline,
			cancel,
		)?;
		matches.extend(outcome.matches);
		truncated |= outcome.truncated;
		if outcome.timed_out {
			timed_out = true;
			break;
		}
	}

	matches.sort_by(|left, right| {
		right
			.modified_ms
			.cmp(&left.modified_ms)
			.then_with(|| left.path.cmp(&right.path))
	});
	let mut seen = HashSet::with_capacity(matches.len());
	matches.retain(|entry| seen.insert(entry.path.clone()));
	let retain = usize::try_from(request.limit).unwrap_or(usize::MAX);
	if matches.len() > retain {
		truncated = true;
		matches.truncate(retain);
	}
	Ok(WalkResult { matches, missing_paths, timed_out, truncated })
}

#[derive(Debug)]
struct GlobTarget {
	parsed:       FindPattern,
	metadata:     fs::Metadata,
	canonical:    PathBuf,
	visible_root: Option<PathBuf>,
}

#[derive(Debug)]
struct GlobTargetOutcome {
	matches:   Vec<WalkMatch>,
	truncated: bool,
	timed_out: bool,
}

#[derive(Clone, Debug, thiserror::Error)]
enum WalkStop {
	#[error("cancelled")]
	Cancelled,
	#[error("timed out")]
	TimedOut,
	#[error("{0}")]
	Workspace(Str),
}

fn walk_glob_target(
	workspace_root: &Path,
	canonical_root: &Path,
	visible_root: Option<&Path>,
	request: &WalkRequest,
	limit: u64,
	deadline: Instant,
	cancel: &CancellationToken,
) -> Result<GlobTargetOutcome, glob::Fault> {
	let keep = usize::try_from(limit).unwrap_or(usize::MAX);
	let mut matches = Vec::with_capacity(keep.saturating_add(1).min(201));
	let result = request.for_each_entry_with_heartbeat(
		|| {
			if cancel.is_cancelled() {
				Err(WalkStop::Cancelled)
			} else if Instant::now() >= deadline {
				Err(WalkStop::TimedOut)
			} else {
				Ok(())
			}
		},
		|entry| {
			let mut path =
				glob_display_path(workspace_root, canonical_root, visible_root, &entry.absolute_path)
					.map_err(|error| WalkStop::Workspace(Str::from(error.to_string())))?;
			let is_dir = entry.file_type == FileType::Dir;
			if is_dir {
				path.push('/');
			}
			retain_ranked(
				&mut matches,
				WalkMatch {
					path: Str::from(path),
					modified_ms: entry.mtime.map_or(0, float_millis),
					is_dir,
				},
				keep,
			);
			Ok(WalkDecision::Include)
		},
		|_| Ok(WalkDecision::Include),
	);
	let timed_out = match result {
		Ok(_) => Instant::now() >= deadline,
		Err(WalkError::Interrupted(WalkStop::TimedOut)) => true,
		Err(WalkError::Interrupted(WalkStop::Cancelled)) => return Err(cancelled_glob()),
		Err(WalkError::Interrupted(WalkStop::Workspace(message))) => {
			return Err(glob::Fault::Workspace { message });
		},
		Err(error) => {
			return Err(glob::Fault::Workspace { message: Str::from(error.to_string()) });
		},
	};
	matches.sort_by(|left, right| {
		right
			.modified_ms
			.cmp(&left.modified_ms)
			.then_with(|| left.path.cmp(&right.path))
	});
	let truncated = matches.len() > keep;
	matches.truncate(keep);
	Ok(GlobTargetOutcome { matches, truncated, timed_out })
}

fn retain_ranked(matches: &mut Vec<WalkMatch>, candidate: WalkMatch, limit: usize) {
	let capacity = limit.saturating_add(1);
	if matches.len() < capacity {
		matches.push(candidate);
		return;
	}
	let Some((worst, _)) = matches
		.iter()
		.enumerate()
		.min_by(|(_, left), (_, right)| compare_glob_rank(left, right))
	else {
		return;
	};
	if compare_glob_rank(&candidate, &matches[worst]).is_gt() {
		matches[worst] = candidate;
	}
}

fn compare_glob_rank(left: &WalkMatch, right: &WalkMatch) -> cmp::Ordering {
	left
		.modified_ms
		.cmp(&right.modified_ms)
		.then_with(|| right.path.cmp(&left.path))
}

fn split_glob_inputs(host: &WorkspaceHost, raw: &str) -> Result<Vec<String>, glob::Fault> {
	let normalized = normalize_input(raw);
	if normalized.is_empty() {
		return Err(glob::Fault::EmptyPath);
	}
	if fs::metadata(resolve_input_path(host.root(), &normalized)).is_ok() {
		return Ok(vec![normalized]);
	}
	let raw_inputs = split_top_level_semicolons(&normalized);
	if raw_inputs.len() == 1 {
		return Ok(vec![normalized]);
	}
	let inputs: Vec<String> = raw_inputs
		.into_iter()
		.map(normalize_input)
		.filter(|entry| !entry.is_empty())
		.collect();
	if inputs.is_empty() {
		Err(glob::Fault::EmptyPath)
	} else {
		Ok(inputs)
	}
}

fn split_top_level_semicolons(input: &str) -> Vec<&str> {
	let mut parts = Vec::new();
	let mut brace_depth = 0_u32;
	let mut start = 0;
	let mut escaped = false;
	for (index, character) in input.char_indices() {
		if escaped {
			escaped = false;
			continue;
		}
		match character {
			'\\' => escaped = true,
			'{' => brace_depth = brace_depth.saturating_add(1),
			'}' => brace_depth = brace_depth.saturating_sub(1),
			';' if brace_depth == 0 => {
				parts.push(&input[start..index]);
				start = index + character.len_utf8();
			},
			_ => {},
		}
	}
	parts.push(&input[start..]);
	parts
}

fn glob_max_depth(pattern: &str) -> usize {
	if pattern.split('/').any(|segment| segment == "**") {
		usize::MAX
	} else {
		pattern
			.split('/')
			.filter(|segment| !segment.is_empty())
			.count()
			.max(1)
	}
}

fn has_glob_chars(segment: &str) -> bool {
	segment
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{'))
}

fn normalize_input(input: &str) -> String {
	let trimmed = input.trim();
	trimmed
		.strip_prefix('"')
		.and_then(|value| value.strip_suffix('"'))
		.unwrap_or(trimmed)
		.to_owned()
}

fn resolve_input_path(root: &Path, input: &str) -> PathBuf {
	let path = Path::new(input);
	if path.is_absolute() {
		path.to_path_buf()
	} else {
		root.join(path)
	}
}

fn lexical_normalize_absolute(path: &Path) -> PathBuf {
	debug_assert!(path.is_absolute());
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
				normalized.push(component.as_os_str());
			},
			Component::CurDir => {},
			Component::ParentDir => {
				if matches!(normalized.components().next_back(), Some(Component::Normal(_))) {
					normalized.pop();
				}
			},
		}
	}
	normalized
}

fn is_missing(error: &io::Error) -> bool {
	matches!(
		error.kind(),
		std::io::ErrorKind::NotFound
			| std::io::ErrorKind::NotADirectory
			| std::io::ErrorKind::InvalidInput
	)
}

fn workspace_relative(root: &Path, path: &Path) -> Result<Str, grep::Fault> {
	workspace_relative_raw(root, path)
		.map(Str::from)
		.map_err(grep_workspace_message)
}

fn glob_display_path(
	workspace_root: &Path,
	canonical_root: &Path,
	visible_root: Option<&Path>,
	path: &Path,
) -> Result<String, io::Error> {
	if path.strip_prefix(workspace_root).is_ok() {
		return workspace_relative_raw(workspace_root, path);
	}
	let Some(visible_root) = visible_root else {
		return workspace_relative_raw(workspace_root, path);
	};
	let relative = path.strip_prefix(canonical_root).map_err(|_| {
		io::Error::new(
			io::ErrorKind::PermissionDenied,
			"glob result escaped the canonical traversal root",
		)
	})?;
	Ok(visible_root
		.join(relative)
		.to_string_lossy()
		.replace('\\', "/"))
}

fn workspace_relative_raw(root: &Path, path: &Path) -> Result<String, io::Error> {
	let Ok(relative) = path.strip_prefix(root) else {
		return Ok(path.to_string_lossy().replace('\\', "/"));
	};
	let mut normalized = String::new();
	for component in relative.components() {
		match component {
			Component::CurDir => {},
			Component::Normal(component) => {
				if !normalized.is_empty() {
					normalized.push('/');
				}
				normalized.push_str(&component.to_string_lossy());
			},
			Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err(io::Error::new(
					io::ErrorKind::PermissionDenied,
					"path is outside the workspace",
				));
			},
		}
	}
	Ok(normalized)
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
	metadata
		.modified()
		.ok()
		.and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
		.map_or(0, duration_millis)
}

fn duration_millis(duration: Duration) -> u64 {
	u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn float_millis(value: f64) -> u64 {
	if value.is_finite() && value > 0.0 {
		value.min(u64::MAX as f64) as u64
	} else {
		0
	}
}

fn grep_workspace_message(error: impl Display) -> grep::Fault {
	grep::Fault::Workspace { message: Str::from(error.to_string()) }
}

fn glob_workspace_message(error: impl Display) -> glob::Fault {
	glob::Fault::Workspace { message: Str::from(error.to_string()) }
}

fn check_glob_cancel(cancel: &CancellationToken) -> Result<(), glob::Fault> {
	if cancel.is_cancelled() {
		Err(cancelled_glob())
	} else {
		Ok(())
	}
}

fn cancelled_glob() -> glob::Fault {
	glob::Fault::Cancelled { reason: Str::from(CANCELLED_REASON) }
}

#[cfg(test)]
mod tests {
	use std::future;

	use omp_core::sf;
	use omp_tools::read::{resolver::SchemeEntry, web::types::WebError};
	use tokio::{
		io::{AsyncReadExt as _, AsyncWriteExt as _, duplex},
		net::TcpListener,
	};

	use super::*;
	use crate::{
		docserver::{
			Environment, ServerConfig,
			connection::{ConnectionConfig, serve_connection},
		},
		document_cache::project_document_cache,
		tool_url::{UrlResolver, docs::DocsResolver, vault::VaultResolver},
		vault::{VaultPaths, VaultService},
	};

	async fn connected_search_adapter(root: &Path) -> WorkspaceSearchAdapter {
		let config = ServerConfig::new(root).expect("docserver config");
		let environment = Environment::new(config).expect("document authority");
		let (client_stream, server_stream) = duplex(256 * 1024);
		tokio::spawn(serve_connection(environment, server_stream, ConnectionConfig::default()));
		let documents = DocumentHost::connect(client_stream)
			.await
			.expect("document hello");
		let workspace = WorkspaceHost::open(root).expect("workspace host");
		let read_sources =
			ReadSourceAdapter::new(documents.clone(), workspace.clone(), project_document_cache(root));
		WorkspaceSearchAdapter::new(
			workspace,
			documents,
			read_sources,
			sync::Arc::new(ResolverTable::default()),
		)
	}

	#[tokio::test]
	async fn grep_expands_omp_root_into_individually_searchable_documents() {
		let mut builder = ResolverTable::builder();
		builder
			.register(
				SchemeEntry::new(Scheme::Omp, true, false, "packaged OMP documentation")
					.with_capabilities(true, false, true),
				UrlResolver::Docs(DocsResolver::default()),
			)
			.expect("unique docs resolver");
		let table = builder.build();
		let root = SearchRoot {
			original: sf!("omp://"),
			path:     sf!("omp://"),
			kind:     SearchRootKind::Internal,
			ranges:   Box::default(),
		};
		let targets = materialize_internal_root(&table, &root, 3)
			.await
			.expect("materialize docs");
		assert!(targets.len() > 1);
		assert!(
			targets
				.iter()
				.all(|target| target.path.starts_with("omp://"))
		);
		assert!(targets.iter().all(|target| target.root_index == 3));
		assert!(targets.windows(2).all(|pair| pair[0].path < pair[1].path));
	}

	#[tokio::test]
	async fn grep_prefers_an_existing_literal_semicolon_path_before_root_splitting() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::write(directory.path().join("semi;colon.txt"), "needle\n").expect("fixture");
		let adapter = connected_search_adapter(directory.path()).await;
		let roots = vec![
			SearchRoot {
				original: sf!("semi"),
				path:     sf!("semi"),
				kind:     SearchRootKind::Filesystem,
				ranges:   Box::default(),
			},
			SearchRoot {
				original: sf!("colon.txt"),
				path:     sf!("colon.txt"),
				kind:     SearchRootKind::Filesystem,
				ranges:   Box::default(),
			},
		];
		let unsplit = SearchRoot {
			original: sf!("semi;colon.txt"),
			path:     sf!("semi;colon.txt"),
			kind:     SearchRootKind::Filesystem,
			ranges:   Box::default(),
		};
		let prepared = adapter
			.prepare_roots(roots, Some(unsplit))
			.await
			.expect("prepare roots");
		assert_eq!(prepared.len(), 1);
		assert_eq!(prepared[0].path, "semi;colon.txt");

		let mut request = search_request("semi;colon.txt", SearchRootKind::Filesystem, 5_000);
		request.roots = prepared;
		let result = adapter
			.search(request)
			.await
			.expect("literal semicolon search");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "semi;colon.txt");
	}

	#[tokio::test]
	async fn grep_missing_targets_fail_only_when_no_searchable_root_survives() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::write(directory.path().join("live.txt"), "needle\n").expect("fixture");
		let adapter = connected_search_adapter(directory.path()).await;

		let missing = adapter
			.search(search_request("gone.txt", SearchRootKind::Filesystem, 5_000))
			.await;
		assert!(matches!(
			missing,
			Err(grep::Fault::AllPathsMissing { paths }) if paths == [sf!("gone.txt")]
		));

		let mut mixed = search_request("gone.txt", SearchRootKind::Filesystem, 5_000);
		mixed.roots.push(SearchRoot {
			original: sf!("live.txt"),
			path:     sf!("live.txt"),
			kind:     SearchRootKind::Filesystem,
			ranges:   Box::default(),
		});
		let result = adapter.search(mixed).await.expect("surviving root");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.missing_paths, [sf!("gone.txt")]);
	}

	#[tokio::test]
	async fn grep_global_budget_counts_unique_rows_across_overlapping_roots() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::write(directory.path().join("a.txt"), "needle a\n").expect("fixture a");
		fs::write(directory.path().join("b.txt"), "needle b\n").expect("fixture b");
		let adapter = connected_search_adapter(directory.path()).await;
		let mut request = search_request("a.txt", SearchRootKind::Filesystem, 5_000);
		request.max_count = 2;
		request.roots = ["a.txt", "a.txt", "b.txt"]
			.into_iter()
			.map(|path| SearchRoot {
				original: Str::new(path),
				path:     Str::new(path),
				kind:     SearchRootKind::Filesystem,
				ranges:   Box::default(),
			})
			.collect();
		let result = adapter.search(request).await.expect("overlap search");
		assert_eq!(result.matches.len(), 2);
		assert_eq!(result.matches[0].path, "a.txt");
		assert_eq!(result.matches[1].path, "b.txt");
	}

	#[tokio::test]
	async fn grep_rejects_line_selectors_on_directories() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::create_dir(directory.path().join("src")).expect("fixture directory");
		fs::write(directory.path().join("src/lib.rs"), "needle\n").expect("fixture");
		let adapter = connected_search_adapter(directory.path()).await;
		let mut request = search_request("src", SearchRootKind::Filesystem, 5_000);
		request.roots[0].original = sf!("src:1-2");
		request.roots[0].ranges =
			vec![omp_tools::read::selector::LineRange { start_line: 1, end_line: Some(2) }]
				.into_boxed_slice();
		assert!(matches!(adapter.search(request).await, Err(grep::Fault::InvalidSelector { .. })));
	}

	fn search_request(
		path: impl Into<Str>,
		kind: SearchRootKind,
		timeout_ms: u32,
	) -> grep::SearchRequest {
		let path = path.into();
		grep::SearchRequest {
			pattern: sf!("needle"),
			roots: vec![SearchRoot { original: path.clone(), path, kind, ranges: Box::default() }],
			ignore_case: false,
			multiline: false,
			gitignore: false,
			hidden: true,
			max_count: 2_000,
			single_file_max_count: 200,
			multi_file_max_count: 20,
			context_before: 0,
			context_after: 0,
			max_columns: 512,
			timeout_ms,
		}
	}

	#[test]
	fn resource_glob_target_routing_keeps_vault_uris() {
		assert!(is_resource_glob_target("vault://reports/**/*.json"));
		assert!(is_resource_glob_target(" VAULT://reports/**/*.json "));
		assert!(is_resource_glob_target("ssh://host/**/*.rs"));
		assert!(is_resource_glob_target("memory://notes/*"));
		assert!(!is_resource_glob_target("artifact://sha256/*"));
	}

	#[tokio::test]
	async fn resource_glob_walks_configured_vault_paths() {
		let fixture = tempfile::tempdir().expect("fixture");
		let vault_root = fixture.path().join("vault");
		fs::create_dir_all(vault_root.join("reports")).expect("vault directories");
		fs::write(vault_root.join("reports/a.json"), "{}").expect("vault file");
		fs::write(vault_root.join("reports/b.txt"), "skip").expect("nonmatching vault file");
		let user_config = fixture.path().join("config");
		fs::create_dir_all(&user_config).expect("config directory");
		fs::write(user_config.join("vaults.toml"), format!("[vaults]\nreports = {:?}\n", vault_root))
			.expect("vault config");
		let service = VaultService::load_layered(&VaultPaths::new(&user_config, fixture.path()))
			.expect("vault service");
		let mut builder = ResolverTable::builder();
		builder
			.register(
				omp_tools::read::resolver::SchemeEntry::new(Scheme::Vault, true, false, "test vault")
					.with_capabilities(true, false, true),
				UrlResolver::Vault(VaultResolver::new(service)),
			)
			.expect("vault resolver");
		let resolvers = builder.build();
		let host = WorkspaceHost::open(fixture.path()).expect("workspace host");
		let result = resource_glob(
			&resolvers,
			&host,
			glob::WalkRequest {
				path:       Str::new_static("vault://reports/**/*.json"),
				hidden:     true,
				gitignore:  true,
				limit:      20,
				timeout_ms: 30_000,
			},
			&CancellationToken::new(),
		)
		.await
		.expect("vault glob");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "vault://reports/reports/a.json");

		fs::create_dir(fixture.path().join("local")).expect("local directory");
		fs::write(fixture.path().join("local/a.json"), "{}").expect("local file");
		let mixed = resource_glob(
			&resolvers,
			&host,
			glob::WalkRequest {
				path:       Str::new_static("local/**/*.json; vault://reports/**/*.json"),
				hidden:     true,
				gitignore:  true,
				limit:      20,
				timeout_ms: 30_000,
			},
			&CancellationToken::new(),
		)
		.await
		.expect("mixed local and resource glob");
		assert_eq!(
			mixed
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>(),
			["local/a.json", "vault://reports/reports/a.json"]
		);
	}

	#[test]
	fn glob_semicolon_recovery_preserves_literals_and_top_level_roots() {
		let fixture = tempfile::tempdir().expect("fixture");
		fs::write(fixture.path().join("literal;name.rs"), "").expect("semicolon literal");
		fs::write(fixture.path().join("route[id].rs"), "").expect("literal glob characters");
		let host = WorkspaceHost::open(fixture.path()).expect("workspace host");

		assert_eq!(split_glob_inputs(&host, "literal;name.rs").expect("literal path"), [
			"literal;name.rs"
		]);
		assert_eq!(
			split_glob_inputs(&host, "src/{one;two}.rs; tests/**/*.rs").expect("top-level roots"),
			["src/{one;two}.rs", "tests/**/*.rs"]
		);
		assert_eq!(
			split_glob_inputs(&host, "one.rs; two.rs;").expect("missing roots still split"),
			["one.rs", "two.rs"]
		);
		assert_eq!(
			split_glob_inputs(&host, r"src/a\;b.rs").expect("escaped delimiter stays literal"),
			[r"src/a\;b.rs"]
		);

		let literal_match = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("route[id].rs"),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			&CancellationToken::new(),
		)
		.expect("existing glob-shaped path stays literal");
		assert_eq!(literal_match.matches.len(), 1);
		assert_eq!(literal_match.matches[0].path, "route[id].rs");
	}

	#[test]
	fn glob_hidden_and_gitignore_toggles_are_independent() {
		let fixture = tempfile::tempdir().expect("fixture");
		fs::write(fixture.path().join(".gitignore"), "ignored.rs\n").expect("ignore file");
		fs::write(fixture.path().join(".hidden.rs"), "").expect("hidden file");
		fs::write(fixture.path().join("ignored.rs"), "").expect("ignored file");
		fs::write(fixture.path().join("visible.rs"), "").expect("visible file");
		let host = WorkspaceHost::open(fixture.path()).expect("workspace host");

		let respected = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("**/*.rs"),
				hidden:     true,
				gitignore:  true,
				limit:      200,
				timeout_ms: 5_000,
			},
			&CancellationToken::new(),
		)
		.expect("gitignore-respecting glob");
		let respected_paths = respected
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();
		assert!(respected_paths.contains(&".hidden.rs"));
		assert!(respected_paths.contains(&"visible.rs"));
		assert!(!respected_paths.contains(&"ignored.rs"));

		let ignored_disabled = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("**/*.rs"),
				hidden:     false,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			&CancellationToken::new(),
		)
		.expect("unignored visible glob");
		let visible_paths = ignored_disabled
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();
		assert!(!visible_paths.contains(&".hidden.rs"));
		assert!(visible_paths.contains(&"ignored.rs"));
		assert!(visible_paths.contains(&"visible.rs"));
	}

	#[test]
	fn glob_multi_root_missing_timeout_and_cancellation_are_explicit() {
		let fixture = tempfile::tempdir().expect("fixture");
		fs::create_dir(fixture.path().join("one")).expect("first root");
		fs::create_dir(fixture.path().join("two")).expect("second root");
		fs::write(fixture.path().join("one/a.rs"), "").expect("first match");
		fs::write(fixture.path().join("two/b.rs"), "").expect("second match");
		let host = WorkspaceHost::open(fixture.path()).expect("workspace host");

		let result = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("one/**/*.rs; missing/**/*.rs; two/**/*.rs"),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			&CancellationToken::new(),
		)
		.expect("surviving roots");
		assert_eq!(
			result
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>(),
			["one/a.rs", "two/b.rs"]
		);
		assert_eq!(result.missing_paths, [sf!("missing/**/*.rs")]);

		let timed_out = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("one/**/*.rs"),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 0,
			},
			&CancellationToken::new(),
		)
		.expect("timeout is partial success");
		assert!(timed_out.timed_out);
		assert!(timed_out.matches.is_empty());

		let cancellation = CancellationToken::new();
		cancellation.cancel();
		assert!(matches!(
			glob_blocking(
				&host,
				glob::WalkRequest {
					path:       sf!("one/**/*.rs"),
					hidden:     true,
					gitignore:  false,
					limit:      200,
					timeout_ms: 5_000,
				},
				&cancellation,
			),
			Err(glob::Fault::Cancelled { .. })
		));
	}

	#[test]
	fn find_patterns_preserve_non_recursive_scopes() {
		let parsed = parse_find_pattern("src/*");
		assert_eq!(parsed.base, "src");
		assert_eq!(parsed.pattern, "*");
		assert!(parsed.has_glob);
	}

	#[test]
	fn leading_glob_patterns_become_recursive() {
		let parsed = parse_find_pattern("*.rs");
		assert_eq!(parsed.base, ".");
		assert_eq!(parsed.pattern, "**/*.rs");
	}

	#[test]
	fn ranked_retention_keeps_newest_then_lexical() {
		let mut matches = Vec::new();
		for (path, modified_ms) in [("b", 1), ("c", 2), ("a", 2)] {
			retain_ranked(
				&mut matches,
				WalkMatch { path: Str::from(path), modified_ms, is_dir: false },
				1,
			);
		}
		matches.sort_by(|left, right| compare_glob_rank(right, left));
		assert_eq!(matches.len(), 2);
		assert_eq!(matches[0].path, "a");
	}

	#[test]
	fn grep_accepts_an_external_file_and_uses_its_absolute_display_path() {
		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		let external = parent.path().join("external.txt");
		fs::create_dir(&workspace).expect("workspace directory");
		fs::write(&external, "alpha\nneedle\nomega\n").expect("external file");
		let host = WorkspaceHost::open(&workspace).expect("workspace host");
		let target = resolve_grep_target(&host, external.to_str().expect("UTF-8 external path"))
			.expect("resolve target")
			.expect("external target");
		let GrepTarget::Filesystem { path, .. } = target else {
			panic!("external file resolved to memory");
		};
		let result = crate::grep::grep(&crate::grep::GrepOptions {
			pattern: sf!("needle"),
			path: Str::from(path.to_string_lossy().into_owned()),
			..crate::grep::GrepOptions::default()
		})
		.expect("grep external file");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(
			workspace_relative(host.root(), &path).expect("display path"),
			Str::from(path.to_string_lossy().replace('\\', "/")),
		);
	}

	#[test]
	fn glob_accepts_an_external_directory_and_returns_absolute_paths() {
		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		let external = parent.path().join("external");
		fs::create_dir(&workspace).expect("workspace directory");
		fs::create_dir(&external).expect("external directory");
		let source = external.join("lib.rs");
		fs::write(&source, "fn external() {}\n").expect("external source");
		let host = WorkspaceHost::open(&workspace).expect("workspace host");
		let result = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       Str::from(format!("{}/**/*.rs", external.to_string_lossy())),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			&CancellationToken::new(),
		)
		.expect("glob external directory");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, Str::from(source.to_string_lossy().replace('\\', "/")),);
	}

	#[tokio::test]
	async fn literal_selector_shaped_filename_wins_before_internal_materialization() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::write(directory.path().join("test:1-2"), "needle\n").expect("write literal source");
		let adapter = connected_search_adapter(directory.path()).await;
		let mut request = search_request("test", SearchRootKind::Internal, 5_000);
		request.roots[0].original = sf!("test:1-2");

		let result =
			time::timeout(Duration::from_secs(2), WorkspaceSearch::search(&adapter, request))
				.await
				.expect("literal search stayed bounded")
				.expect("literal search succeeded");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path.as_str(), "test:1-2");
	}

	#[tokio::test]
	async fn grep_defers_line_authorization_until_final_visibility_is_supplied() {
		let directory = tempfile::tempdir().expect("temp directory");
		let source = directory.path().join("file.rs");
		fs::write(&source, "before\nneedle\nafter\n").expect("write grep source");
		let adapter = connected_search_adapter(directory.path()).await;
		let result = WorkspaceSearch::search(
			&adapter,
			search_request("file.rs", SearchRootKind::Filesystem, 5_000),
		)
		.await
		.expect("search file");
		let canonical = fs::canonicalize(source).expect("canonical grep source");
		let source_key = Str::from(canonical.to_string_lossy().into_owned());
		assert!(
			adapter
				.documents
				.snapshot_store()
				.head(Path::new(source_key.as_str()))
				.is_none(),
			"native overfetch must not authorize lines before final projection"
		);
		let [snapshot] = result.snapshots.as_slice() else {
			panic!("one editable snapshot candidate expected: {:?}", result.snapshots);
		};
		WorkspaceSearch::stage_snapshots(&adapter, vec![snapshot.clone()])
			.expect("stage exact snapshot without visibility");
		assert!(
			adapter
				.documents
				.snapshot_store()
				.head(Path::new(source_key.as_str()))
				.is_some_and(|snapshot| snapshot.seen_lines.is_none()),
			"staging bytes must not authorize any source line"
		);
		WorkspaceSearch::record_snapshots(&adapter, vec![grep::SnapshotRecord {
			source_key: snapshot.source_key.clone(),
			revision:   snapshot.revision.clone(),
			seen_lines: vec![2],
		}])
		.expect("record final visible line");
		let retained = adapter
			.documents
			.snapshot_store()
			.head(Path::new(source_key.as_str()))
			.expect("visible snapshot retained");

		assert_eq!(
			retained
				.seen_lines
				.expect("visible lines recorded")
				.into_iter()
				.collect::<Vec<_>>(),
			vec![2]
		);
	}

	#[test]
	fn cancellation_guard_trips_the_walker_and_blocking_search_tokens() {
		let token = CancellationToken::new();
		{
			let _guard = CancelOnDrop(token.clone());
			assert!(!token.is_cancelled());
		}
		assert!(token.is_cancelled());

		let token = CancellationToken::new();
		let blocking = Arc::new(AtomicBool::new(false));
		{
			let _guard =
				BlockingCancelOnDrop { token: token.clone(), blocking: Arc::clone(&blocking) };
			assert!(!token.is_cancelled());
			assert!(!blocking.load(Ordering::Relaxed));
		}
		assert!(token.is_cancelled());
		assert!(blocking.load(Ordering::Relaxed));
	}

	#[test]
	fn archive_root_round_trips_real_zip_members_into_memory_search() {
		let directory = tempfile::tempdir().expect("temp directory");
		let archive_path = directory.path().join("fixture.zip");
		fs::write(
			&archive_path,
			stored_zip(&[
				("docs/readme.txt", b"first\nneedle\nthird\n"),
				("docs/blob.bin", b"\0binary"),
			]),
		)
		.expect("write ZIP");
		let bytes = Bytes::from(fs::read(&archive_path).expect("read ZIP"));
		let root = SearchRoot {
			original: sf!("fixture.zip:docs"),
			path:     sf!("fixture.zip:docs"),
			kind:     SearchRootKind::Archive,
			ranges:   Box::default(),
		};
		let candidate = archive::parse_archive_path_candidates(root.path.as_str())
			.into_iter()
			.next()
			.expect("archive candidate");
		let archive_key = Str::from(
			fs::canonicalize(&archive_path)
				.expect("canonical ZIP")
				.to_string_lossy()
				.into_owned(),
		);
		let (targets, unreadable) =
			materialize_archive_bytes(&root, 0, candidate, archive_key, bytes)
				.expect("materialize ZIP");

		assert_eq!(targets.len(), 1);
		assert_eq!(targets[0].path, "fixture.zip:docs/readme.txt");
		assert_eq!(unreadable, vec![sf!("fixture.zip:docs/blob.bin (binary archive entry)")]);
		let result = crate::grep::search(&targets[0].content, &crate::grep::GrepOptions {
			pattern: sf!("needle"),
			path: targets[0].path.clone(),
			..crate::grep::GrepOptions::default()
		})
		.expect("search materialized member");
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "fixture.zip:docs/readme.txt");
		assert_eq!(result.matches[0].line_number, 2);
	}

	#[derive(Clone)]
	struct CannedHttpClient;

	impl web::types::HttpClient for CannedHttpClient {
		fn get(
			&self,
			request: web::types::HttpRequest,
		) -> impl Future<Output = Result<web::types::HttpResponse, WebError>> + Send + '_ {
			assert_eq!(request.url, "https://example.test/data.txt");
			future::ready(Ok(web::types::HttpResponse {
				final_url:    request.url,
				status:       200,
				content_type: Some(sf!("text/plain")),
				headers:      Default::default(),
				body:         Bytes::from_static(b"alpha\nneedle\nomega\n"),
			}))
		}
	}

	#[tokio::test]
	async fn url_root_round_trips_canned_http_into_memory_search() {
		let root = SearchRoot {
			original: sf!("https://example.test/data.txt"),
			path:     sf!("https://example.test/data.txt"),
			kind:     SearchRootKind::Url,
			ranges:   Box::default(),
		};
		let target = materialize_url_root(&CannedHttpClient, &root, 3)
			.await
			.expect("materialize URL");
		let result = crate::grep::search(&target.content, &crate::grep::GrepOptions {
			pattern: sf!("needle"),
			path: target.path.clone(),
			..crate::grep::GrepOptions::default()
		})
		.expect("search URL");

		assert_eq!(target.root_index, 3);
		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "https://example.test/data.txt");
		assert_eq!(result.matches[0].line_number, 2);
	}

	#[tokio::test]
	async fn archive_root_round_trips_through_the_real_search_adapter() {
		let directory = tempfile::tempdir().expect("temp directory");
		fs::write(
			directory.path().join("fixture.zip"),
			stored_zip(&[
				("docs/readme.txt", b"first\nneedle\nthird\n"),
				("docs/blob.bin", b"\0binary"),
			]),
		)
		.expect("write ZIP");
		let adapter = connected_search_adapter(directory.path()).await;
		let result = WorkspaceSearch::search(
			&adapter,
			search_request("fixture.zip:docs", SearchRootKind::Archive, 5_000),
		)
		.await
		.expect("search archive through adapter");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, "fixture.zip:docs/readme.txt");
		assert_eq!(result.matches[0].root_index, 0);
		assert_eq!(result.matches[0].line_number, 2);
		assert_eq!(result.matches[0].line, "needle");
		assert!(result.matches[0].source_key.starts_with("archive:"));
		assert!(result.matches[0].source_key.ends_with(":docs/readme.txt"));
		assert_eq!(result.archive_unreadable, vec![sf!(
			"fixture.zip:docs/blob.bin (binary archive entry)"
		)]);
	}

	#[tokio::test]
	async fn external_archive_members_accept_absolute_and_parent_relative_roots() {
		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		fs::create_dir(&workspace).expect("workspace directory");
		let archive_path = parent.path().join("fixture.zip");
		fs::write(&archive_path, stored_zip(&[("docs/readme.txt", b"first\nneedle\nthird\n")]))
			.expect("write external ZIP");
		let canonical_archive = fs::canonicalize(&archive_path).expect("canonical external ZIP");
		let expected_source_key =
			format!("archive:{}:docs/readme.txt", canonical_archive.to_string_lossy());
		let adapter = connected_search_adapter(&workspace).await;
		let absolute = format!("{}:docs/readme.txt", archive_path.to_string_lossy());

		for authored in [absolute.as_str(), "../fixture.zip:docs/readme.txt"] {
			let result = WorkspaceSearch::search(
				&adapter,
				search_request(authored, SearchRootKind::Archive, 5_000),
			)
			.await
			.unwrap_or_else(|error| panic!("search external archive root {authored}: {error:?}"));

			assert_eq!(result.matches.len(), 1, "{authored}");
			assert_eq!(result.matches[0].path, authored);
			assert_eq!(result.matches[0].source_key, expected_source_key);
			assert_eq!(result.matches[0].root_index, 0);
			assert_eq!(result.matches[0].line_number, 2);
			assert_eq!(result.matches[0].line, "needle");
			assert_eq!(result.matches[0].snapshot_tag, None);
			assert!(result.archive_unreadable.is_empty());
		}
	}

	#[tokio::test]
	async fn external_absolute_globs_normalize_projection_and_deduplicate() {
		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		let external = parent.path().join("external");
		fs::create_dir(&workspace).expect("workspace directory");
		fs::create_dir_all(external.join("a")).expect("lexical parent directory");
		fs::create_dir_all(external.join("b")).expect("external target directory");
		fs::write(external.join("b/x.rs"), "fn external() {}\n").expect("external source");
		let external = external.to_string_lossy().replace('\\', "/");
		let authored = format!("{external}/a/../b/**/*.rs;{external}/b/**/*.rs");
		let adapter = connected_search_adapter(&workspace).await;

		let result = WorkspaceSearch::glob(
			&adapter,
			glob::WalkRequest {
				path:       Str::from(authored),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			tokio_util::sync::CancellationToken::new(),
		)
		.await
		.expect("glob equivalent external absolute targets");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, format!("{external}/b/x.rs"));
		assert!(!result.matches[0].is_dir);
		assert!(!result.timed_out);
		assert!(!result.truncated);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn external_absolute_glob_preserves_authored_symlink_alias() {
		use std::os::unix::fs::symlink;

		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		let real = parent.path().join("real");
		let alias = parent.path().join("alias");
		fs::create_dir(&workspace).expect("workspace directory");
		fs::create_dir(&real).expect("external real directory");
		fs::write(real.join("x.rs"), "fn external() {}\n").expect("external source");
		symlink(&real, &alias).expect("external directory symlink");
		let alias = alias.to_string_lossy().replace('\\', "/");
		let adapter = connected_search_adapter(&workspace).await;

		let result = WorkspaceSearch::glob(
			&adapter,
			glob::WalkRequest {
				path:       Str::from(format!("{alias}/**/*.rs")),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			tokio_util::sync::CancellationToken::new(),
		)
		.await
		.expect("glob authored external symlink alias");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, format!("{alias}/x.rs"));
	}

	#[tokio::test]
	async fn external_parent_relative_glob_round_trips_through_the_real_adapter() {
		let parent = tempfile::tempdir().expect("parent directory");
		let workspace = parent.path().join("workspace");
		let external = parent.path().join("external");
		fs::create_dir(&workspace).expect("workspace directory");
		fs::create_dir(&external).expect("external directory");
		let source = external.join("lib.rs");
		fs::write(&source, "fn external() {}\n").expect("external source");
		let adapter = connected_search_adapter(&workspace).await;
		let result = WorkspaceSearch::glob(
			&adapter,
			glob::WalkRequest {
				path:       sf!("../external/**/*.rs"),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 5_000,
			},
			tokio_util::sync::CancellationToken::new(),
		)
		.await
		.expect("glob external parent-relative directory through adapter");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(
			result.matches[0].path,
			fs::canonicalize(source)
				.expect("canonical external source")
				.to_string_lossy()
				.replace('\\', "/")
		);
		assert!(!result.matches[0].is_dir);
		assert!(!result.timed_out);
		assert!(!result.truncated);
	}

	#[tokio::test]
	async fn url_root_round_trips_local_http_through_the_real_search_adapter() {
		let listener = TcpListener::bind("127.0.0.1:0")
			.await
			.expect("bind local HTTP fixture");
		let address = listener.local_addr().expect("fixture address");
		let url = format!("http://{address}/data.txt");
		let server = tokio::spawn(async move {
			let (mut socket, _) = listener.accept().await.expect("accept local request");
			let mut request = [0_u8; 4_096];
			let read = socket.read(&mut request).await.expect("read local request");
			let request = String::from_utf8_lossy(&request[..read]);
			assert!(request.starts_with("GET /data.txt "), "{request}");
			let body = b"alpha\nneedle\nomega\n";
			let response = format!(
				"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: \
				 close\r\n\r\n",
				body.len()
			);
			socket
				.write_all(response.as_bytes())
				.await
				.expect("write response headers");
			socket.write_all(body).await.expect("write response body");
			socket.shutdown().await.expect("close local response");
		});
		let directory = tempfile::tempdir().expect("temp directory");
		let adapter = connected_search_adapter(directory.path()).await;
		let result =
			WorkspaceSearch::search(&adapter, search_request(url.clone(), SearchRootKind::Url, 5_000))
				.await
				.expect("search local URL through adapter");
		time::timeout(Duration::from_secs(2), server)
			.await
			.expect("local HTTP fixture completed before its deadline")
			.expect("local HTTP fixture task succeeded");

		assert_eq!(result.matches.len(), 1);
		assert_eq!(result.matches[0].path, url);
		assert_eq!(result.matches[0].source_key, format!("url:{url}"));
		assert_eq!(result.matches[0].root_index, 0);
		assert_eq!(result.matches[0].line_number, 2);
		assert_eq!(result.matches[0].line, "needle");
		assert_eq!(result.matches[0].snapshot_tag, None);
	}

	#[tokio::test]
	async fn real_search_adapter_enforces_the_shared_external_materialization_deadline() {
		let directory = tempfile::tempdir().expect("temp directory");
		let adapter = connected_search_adapter(directory.path()).await;
		let error = WorkspaceSearch::search(
			&adapter,
			search_request("http://127.0.0.1:9/deadline", SearchRootKind::Url, 0),
		)
		.await
		.expect_err("zero-duration URL materialization deadline must expire before any request");
		assert_eq!(error, grep::Fault::TimedOut);
	}

	#[test]
	fn cancellation_and_glob_deadlines_are_observed_before_walking() {
		let directory = tempfile::tempdir().expect("temp directory");
		let host = WorkspaceHost::open(directory.path()).expect("workspace host");
		let cancelled = CancellationToken::new();
		cancelled.cancel();
		assert_eq!(
			check_grep_cancel(&cancelled),
			Err(grep::Fault::Cancelled { reason: Str::from(CANCELLED_REASON) })
		);
		assert_eq!(
			glob_blocking(
				&host,
				glob::WalkRequest {
					path:       sf!("."),
					hidden:     true,
					gitignore:  false,
					limit:      200,
					timeout_ms: 5_000,
				},
				&cancelled,
			),
			Err(glob::Fault::Cancelled { reason: Str::from(CANCELLED_REASON) })
		);

		let timed_out = glob_blocking(
			&host,
			glob::WalkRequest {
				path:       sf!("."),
				hidden:     true,
				gitignore:  false,
				limit:      200,
				timeout_ms: 0,
			},
			&CancellationToken::new(),
		)
		.expect("glob returns partial timeout metadata");
		assert!(timed_out.timed_out);
		assert!(timed_out.matches.is_empty());
	}

	fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
		let mut output = Vec::new();
		let mut central = Vec::new();
		for (name, content) in entries {
			let offset = u32::try_from(output.len()).expect("small ZIP");
			let name = name.as_bytes();
			let size = u32::try_from(content.len()).expect("small member");
			let crc = crc32(content);
			push_u32(&mut output, 0x0403_4b50);
			push_u16(&mut output, 20);
			push_u16(&mut output, 0);
			push_u16(&mut output, 0);
			push_u16(&mut output, 0);
			push_u16(&mut output, 0);
			push_u32(&mut output, crc);
			push_u32(&mut output, size);
			push_u32(&mut output, size);
			push_u16(&mut output, u16::try_from(name.len()).expect("short name"));
			push_u16(&mut output, 0);
			output.extend_from_slice(name);
			output.extend_from_slice(content);

			push_u32(&mut central, 0x0201_4b50);
			push_u16(&mut central, 20);
			push_u16(&mut central, 20);
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u32(&mut central, crc);
			push_u32(&mut central, size);
			push_u32(&mut central, size);
			push_u16(&mut central, u16::try_from(name.len()).expect("short name"));
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u16(&mut central, 0);
			push_u32(&mut central, 0);
			push_u32(&mut central, offset);
			central.extend_from_slice(name);
		}
		let central_offset = u32::try_from(output.len()).expect("small ZIP");
		let central_size = u32::try_from(central.len()).expect("small ZIP");
		output.extend_from_slice(&central);
		push_u32(&mut output, 0x0605_4b50);
		push_u16(&mut output, 0);
		push_u16(&mut output, 0);
		let count = u16::try_from(entries.len()).expect("few entries");
		push_u16(&mut output, count);
		push_u16(&mut output, count);
		push_u32(&mut output, central_size);
		push_u32(&mut output, central_offset);
		push_u16(&mut output, 0);
		output
	}

	fn crc32(bytes: &[u8]) -> u32 {
		let mut crc = u32::MAX;
		for byte in bytes {
			crc ^= u32::from(*byte);
			for _ in 0..8 {
				crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
			}
		}
		!crc
	}

	fn push_u16(output: &mut Vec<u8>, value: u16) {
		output.extend_from_slice(&value.to_le_bytes());
	}

	fn push_u32(output: &mut Vec<u8>, value: u32) {
		output.extend_from_slice(&value.to_le_bytes());
	}
}
