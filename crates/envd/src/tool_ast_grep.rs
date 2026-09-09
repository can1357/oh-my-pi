//! Envd-owned path and resource authority for structural search.

use std::{
	collections::HashSet,
	fs, io,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use omp_core::{Hash32, Str};
use omp_tools::{
	ast_grep::{AstSearchResolver, ResolveFault, ResolveRequest, ResolvedFile},
	read::{
		resolver::{ResolverTable, Scheme},
		selector::{ParsedSelector, parse_uri},
		web,
	},
};
use omp_walker::{
	FileType, FollowLinks, WalkDecision, WalkDetail, WalkError, WalkOrder, WalkRequest,
};
use tokio::{io::AsyncWriteExt as _, task, time};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	tool_read_sources::ReadSourceAdapter, tool_url::UrlResolver, workspace::WorkspaceHost,
};

static MATERIALIZATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Project-scoped filesystem and Read-resource authority for `ast_grep`.
#[derive(Clone)]
pub(crate) struct AstSearchAuthority {
	workspace:            WorkspaceHost,
	read_sources:         ReadSourceAdapter,
	resolvers:            Arc<ResolverTable<UrlResolver>>,
	materialization_root: PathBuf,
}

impl AstSearchAuthority {
	/// Binds structural search to the same workspace and URL authorities as
	/// Read.
	pub(crate) fn new(
		workspace: WorkspaceHost,
		read_sources: ReadSourceAdapter,
		resolvers: Arc<ResolverTable<UrlResolver>>,
		state_dir: &Path,
	) -> Self {
		Self {
			workspace,
			read_sources,
			resolvers,
			materialization_root: state_dir.join("ast-search"),
		}
	}

	async fn resolve_inner(
		&self,
		request: ResolveRequest,
		cancel: CancellationToken,
	) -> Result<Vec<ResolvedFile>, ResolveFault> {
		validate_filter(request.glob.as_deref())?;
		let mut local_roots = Vec::new();
		let mut granted_roots = Vec::new();
		let mut resolved = Vec::new();
		let mut saw_existing_scope = false;

		for root in &request.roots {
			if resolved.len() > request.maximum_files {
				break;
			}
			let authored = root.trim();
			if authored.is_empty() {
				return Err(ResolveFault::InvalidTarget { target: root.clone() });
			}
			let parsed = parse_uri(authored.as_str())
				.map_err(|_| ResolveFault::InvalidTarget { target: root.clone() })?;
			match parsed {
				None => local_roots.push(root.clone()),
				Some(uri) if uri.scheme == Scheme::File => {
					let path = Url::parse(authored.as_str())
						.ok()
						.and_then(|url| url.to_file_path().ok())
						.ok_or_else(|| ResolveFault::InvalidTarget { target: root.clone() })?;
					local_roots.push(Str::from(path.to_string_lossy().into_owned()));
				},
				Some(uri) if uri.scheme == Scheme::Http => {
					if has_glob_syntax(uri.resource)
						|| !matches!(uri.selector, ParsedSelector::None | ParsedSelector::Raw)
					{
						return Err(ResolveFault::InvalidTarget { target: root.clone() });
					}
					let file = self
						.materialize_http(root, request.maximum_file_bytes)
						.await?;
					saw_existing_scope = true;
					if matches_url_filter(request.glob.as_deref(), &file.display_path)? {
						resolved.push(file);
					}
				},
				Some(uri) => {
					if uri.scheme == Scheme::Unknown {
						return Err(ResolveFault::UnsupportedTarget { target: root.clone() });
					}
					if has_glob_syntax(uri.resource) {
						return Err(ResolveFault::InvalidTarget { target: root.clone() });
					}
					if uri.query.is_some()
						|| !matches!(uri.selector, ParsedSelector::None | ParsedSelector::Raw)
					{
						return Err(ResolveFault::InvalidTarget { target: root.clone() });
					}
					let Some(path_result) = self.resolvers.path(uri.scheme, uri.resource).await else {
						return Err(ResolveFault::UnsupportedTarget { target: root.clone() });
					};
					let path_result = path_result.map_err(|_| ResolveFault::AuthorityUnavailable)?;
					let Some(path_uri) = path_result.canonical_path_uri else {
						return Err(ResolveFault::UnsupportedTarget { target: root.clone() });
					};
					let path = Url::parse(path_uri.as_str())
						.ok()
						.and_then(|url| url.to_file_path().ok())
						.ok_or_else(|| ResolveFault::UnsupportedTarget { target: root.clone() })?;
					granted_roots.push(GrantedRoot { path, display: root.clone() });
				},
			}
		}

		if !local_roots.is_empty() {
			let workspace = self.workspace.clone();
			let filter = request.glob.clone();
			let maximum = request.maximum_files.saturating_sub(resolved.len());
			let worker_cancel = cancel.clone();
			let roots = local_roots;
			let outcome = task::spawn_blocking(move || {
				resolve_local_roots(&workspace, &roots, filter.as_deref(), maximum, &worker_cancel)
			})
			.await
			.map_err(|_| ResolveFault::AuthorityUnavailable)??;
			saw_existing_scope |= outcome.saw_existing_scope;
			resolved.extend(outcome.files);
		}

		for granted in granted_roots {
			let filter = request.glob.clone();
			let maximum = request.maximum_files.saturating_sub(resolved.len());
			let worker_cancel = cancel.clone();
			let outcome = task::spawn_blocking(move || {
				resolve_granted_root(granted, filter.as_deref(), maximum, &worker_cancel)
			})
			.await
			.map_err(|_| ResolveFault::AuthorityUnavailable)??;
			saw_existing_scope |= outcome.saw_existing_scope;
			resolved.extend(outcome.files);
			if resolved.len() > request.maximum_files {
				break;
			}
		}

		if cancel.is_cancelled() {
			return Err(ResolveFault::AuthorityUnavailable);
		}
		resolved.sort_unstable_by(|left, right| left.display_path.cmp(&right.display_path));
		let mut seen = HashSet::with_capacity(resolved.len());
		resolved.retain(|file| seen.insert(file.display_path.clone()));
		if resolved.len() > request.maximum_files {
			resolved.truncate(request.maximum_files.saturating_add(1));
		}
		if resolved.is_empty() && !saw_existing_scope {
			return Err(ResolveFault::AllTargetsMissing { targets: request.roots });
		}
		Ok(resolved)
	}

	async fn materialize_http(
		&self,
		target: &Str,
		maximum_bytes: u64,
	) -> Result<ResolvedFile, ResolveFault> {
		let parsed = web::parse_target(target.as_str())
			.map_err(|_| ResolveFault::InvalidTarget { target: target.clone() })?
			.ok_or_else(|| ResolveFault::InvalidTarget { target: target.clone() })?;
		let raw = matches!(parsed.selector, ParsedSelector::Raw);
		let rendered = web::read(&self.read_sources, &parsed.url, raw)
			.await
			.map_err(|error| match error {
				web::types::WebError::ResponseTooLarge { .. } => {
					ResolveFault::MaterializationTooLarge { target: target.clone(), maximum_bytes }
				},
				_ => ResolveFault::AuthorityUnavailable,
			})?;
		let bytes = rendered.content.as_bytes();
		if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum_bytes {
			return Err(ResolveFault::MaterializationTooLarge {
				target: target.clone(),
				maximum_bytes,
			});
		}
		let extension = source_extension(&parsed.url);
		let hash = Hash32::sum(bytes).to_hex();
		let file_name = format!("{hash}.{extension}");
		let root = prepare_materialization_root(&self.materialization_root).await?;
		let destination = root.join(file_name);
		if !destination.exists() {
			write_immutable(&root, &destination, bytes).await?;
		}
		let absolute_path = tokio::fs::canonicalize(&destination)
			.await
			.map_err(|_| ResolveFault::AuthorityUnavailable)?;
		if !absolute_path.starts_with(&root) {
			return Err(ResolveFault::AuthorityUnavailable);
		}
		Ok(ResolvedFile { absolute_path, display_path: target.clone() })
	}
}

impl AstSearchResolver for AstSearchAuthority {
	fn resolve(
		&self,
		request: ResolveRequest,
	) -> impl Future<Output = Result<Vec<ResolvedFile>, ResolveFault>> + Send + '_ {
		async move {
			let cancel = CancellationToken::new();
			let cancel_on_drop = CancelOnDrop(cancel.clone());
			let timeout = request.timeout;
			let result = time::timeout(timeout, self.resolve_inner(request, cancel)).await;
			drop(cancel_on_drop);
			result.map_err(|_| ResolveFault::TimedOut)?
		}
	}
}

#[must_use]
struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		self.0.cancel();
	}
}

struct GrantedRoot {
	path:    PathBuf,
	display: Str,
}

struct ResolveOutcome {
	files:              Vec<ResolvedFile>,
	saw_existing_scope: bool,
}

fn resolve_local_roots(
	workspace: &WorkspaceHost,
	roots: &[Str],
	filter: Option<&str>,
	maximum: usize,
	cancel: &CancellationToken,
) -> Result<ResolveOutcome, ResolveFault> {
	let mut outcome = ResolveOutcome { files: Vec::new(), saw_existing_scope: false };
	for root in roots {
		if outcome.files.len() > maximum {
			break;
		}
		let authored = root.trim();
		let literal = if Path::new(authored.as_str()).is_absolute() {
			PathBuf::from(authored.as_str())
		} else {
			workspace.root().join(authored.as_str())
		};
		match fs::canonicalize(&literal) {
			Ok(path) => {
				if !path.starts_with(workspace.root()) {
					return Err(ResolveFault::InvalidTarget { target: root.clone() });
				}
				outcome.saw_existing_scope = true;
				collect_scope(
					&path,
					workspace.root(),
					None,
					filter,
					maximum,
					cancel,
					&mut outcome.files,
				)?;
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				let Some((base, pattern)) = split_glob(authored.as_str())
					.map_err(|_| ResolveFault::InvalidTarget { target: root.clone() })?
				else {
					continue;
				};
				let base = workspace.root().join(base);
				let Ok(base) = fs::canonicalize(base) else {
					continue;
				};
				if !base.starts_with(workspace.root()) {
					return Err(ResolveFault::InvalidTarget { target: root.clone() });
				}
				outcome.saw_existing_scope = true;
				collect_scope(
					&base,
					workspace.root(),
					Some(&pattern),
					filter,
					maximum,
					cancel,
					&mut outcome.files,
				)?;
			},
			Err(_) => return Err(ResolveFault::AuthorityUnavailable),
		}
	}
	Ok(outcome)
}

fn resolve_granted_root(
	root: GrantedRoot,
	filter: Option<&str>,
	maximum: usize,
	cancel: &CancellationToken,
) -> Result<ResolveOutcome, ResolveFault> {
	let canonical = match fs::canonicalize(root.path) {
		Ok(path) => path,
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return Ok(ResolveOutcome { files: Vec::new(), saw_existing_scope: false });
		},
		Err(_) => return Err(ResolveFault::AuthorityUnavailable),
	};
	let metadata = fs::metadata(&canonical).map_err(|_| ResolveFault::AuthorityUnavailable)?;
	let single_file = metadata.is_file();
	let display_root = if single_file {
		canonical.parent().unwrap_or(&canonical)
	} else {
		&canonical
	};
	let mut files = Vec::new();
	collect_scope(&canonical, display_root, None, filter, maximum, cancel, &mut files)?;
	let base = root.display.trim_end_matches('/');
	for file in &mut files {
		if single_file {
			file.display_path = root.display.clone();
		} else {
			let suffix = file.display_path.as_str();
			file.display_path = if suffix.is_empty() {
				root.display.clone()
			} else {
				Str::from(format!("{base}/{suffix}"))
			};
		}
	}
	Ok(ResolveOutcome { files, saw_existing_scope: true })
}

#[allow(
	clippy::too_many_arguments,
	reason = "walker policy inputs remain explicit at the authority boundary"
)]
fn collect_scope(
	scope: &Path,
	display_root: &Path,
	target_glob: Option<&str>,
	filter: Option<&str>,
	maximum: usize,
	cancel: &CancellationToken,
	files: &mut Vec<ResolvedFile>,
) -> Result<(), ResolveFault> {
	if cancel.is_cancelled() {
		return Err(ResolveFault::AuthorityUnavailable);
	}
	let metadata = fs::metadata(scope).map_err(|_| ResolveFault::AuthorityUnavailable)?;
	if metadata.is_file() {
		let relative = scope.strip_prefix(display_root).unwrap_or(scope);
		if matches_glob(filter, relative)? {
			files.push(ResolvedFile {
				absolute_path: scope.to_path_buf(),
				display_path:  slash_path(relative),
			});
		}
		return Ok(());
	}
	if !metadata.is_dir() {
		return Ok(());
	}
	let target = compile_glob(target_glob)?;
	let filter = compile_glob(filter)?;
	let request = WalkRequest::new(scope)
		.hidden(false)
		.gitignore(true)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(FollowLinks::Never)
		.detail(WalkDetail::Minimal)
		.order(WalkOrder::Unordered)
		.emit_root(false)
		.cache(false);
	let result = request.for_each_entry_with_heartbeat(
		|| {
			if cancel.is_cancelled() {
				Err(())
			} else {
				Ok(())
			}
		},
		|entry| {
			if entry.file_type != FileType::File {
				return Ok(WalkDecision::Include);
			}
			let walk_relative = entry
				.absolute_path
				.strip_prefix(scope)
				.unwrap_or(&entry.absolute_path);
			if target
				.as_ref()
				.is_some_and(|matcher| !matcher.is_match(walk_relative))
				|| filter.as_ref().is_some_and(|matcher| {
					!matcher.is_match(walk_relative)
						&& !walk_relative
							.file_name()
							.is_some_and(|name| matcher.is_match(Path::new(name)))
				}) {
				return Ok(WalkDecision::Include);
			}
			let display = entry
				.absolute_path
				.strip_prefix(display_root)
				.unwrap_or(&entry.absolute_path);
			files.push(ResolvedFile {
				absolute_path: entry.absolute_path.to_path_buf(),
				display_path:  slash_path(display),
			});
			Ok(if files.len() > maximum {
				WalkDecision::Stop
			} else {
				WalkDecision::Include
			})
		},
		|_| Ok(WalkDecision::Include),
	);
	match result {
		Ok(_) => Ok(()),
		Err(WalkError::Interrupted(())) if cancel.is_cancelled() => {
			Err(ResolveFault::AuthorityUnavailable)
		},
		Err(_) => Err(ResolveFault::AuthorityUnavailable),
	}
}

fn split_glob(target: &str) -> Result<Option<(PathBuf, Str)>, ResolveFault> {
	let normalized = target.replace('\\', "/");
	let segments = normalized.split('/').collect::<Vec<_>>();
	let Some(first) = segments.iter().position(|segment| has_glob_syntax(segment)) else {
		return Ok(None);
	};
	let base = if first == 0 {
		PathBuf::from(".")
	} else {
		PathBuf::from(segments[..first].join("/"))
	};
	let pattern = segments[first..].join("/");
	compile_glob(Some(&pattern))?;
	Ok(Some((base, Str::from(pattern))))
}

fn validate_filter(filter: Option<&str>) -> Result<(), ResolveFault> {
	if let Some(glob) = filter.map(str::trim).filter(|glob| !glob.is_empty()) {
		globset::Glob::new(glob).map_err(|_| ResolveFault::InvalidGlob { glob: Str::new(glob) })?;
	}
	Ok(())
}

fn compile_glob(glob: Option<&str>) -> Result<Option<globset::GlobMatcher>, ResolveFault> {
	glob
		.map(|glob| {
			globset::Glob::new(glob)
				.map(|glob| glob.compile_matcher())
				.map_err(|_| ResolveFault::InvalidGlob { glob: Str::new(glob) })
		})
		.transpose()
}

fn matches_glob(glob: Option<&str>, path: &Path) -> Result<bool, ResolveFault> {
	Ok(compile_glob(glob)?.is_none_or(|matcher| {
		matcher.is_match(path)
			|| path
				.file_name()
				.is_some_and(|name| matcher.is_match(Path::new(name)))
	}))
}

fn matches_url_filter(glob: Option<&str>, target: &str) -> Result<bool, ResolveFault> {
	let path = web::parse_target(target)
		.ok()
		.flatten()
		.map_or_else(|| PathBuf::from(target), |target| PathBuf::from(target.url.path()));
	matches_glob(glob, &path)
}

fn has_glob_syntax(value: &str) -> bool {
	value
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'[' | b']' | b'{' | b'}'))
}

fn slash_path(path: &Path) -> Str {
	let value = path.to_string_lossy();
	if value.contains('\\') {
		Str::from(value.replace('\\', "/"))
	} else {
		Str::new(value.as_ref())
	}
}

fn source_extension(url: &Url) -> &str {
	url.path_segments()
		.and_then(Iterator::last)
		.and_then(|name| name.rsplit_once('.').map(|(_, extension)| extension))
		.filter(|extension| {
			!extension.is_empty()
				&& extension.len() <= 16
				&& extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
		})
		.unwrap_or("txt")
}

async fn prepare_materialization_root(root: &Path) -> Result<PathBuf, ResolveFault> {
	tokio::fs::create_dir_all(root)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?;
	tokio::fs::canonicalize(root)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)
}

async fn write_immutable(
	root: &Path,
	destination: &Path,
	bytes: &[u8],
) -> Result<(), ResolveFault> {
	let sequence = MATERIALIZATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	let temporary = root.join(format!(".materializing-{}-{sequence}", std::process::id()));
	let guard = TemporaryFile(temporary.clone());
	let mut file = tokio::fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&temporary)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?;
	file
		.write_all(bytes)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?;
	file
		.sync_all()
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?;
	drop(file);
	let mut permissions = tokio::fs::metadata(&temporary)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?
		.permissions();
	permissions.set_readonly(true);
	tokio::fs::set_permissions(&temporary, permissions)
		.await
		.map_err(|_| ResolveFault::AuthorityUnavailable)?;
	match tokio::fs::rename(&temporary, destination).await {
		Ok(()) => {},
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
		Err(_) => return Err(ResolveFault::AuthorityUnavailable),
	}
	drop(guard);
	Ok(())
}

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.0);
	}
}
