//! Direct GitHub REST resolver for issue:// and pr:// resources.

use std::{
	fmt::{self, Display},
	path::{Path, PathBuf},
	str,
	sync::{Arc, OnceLock},
	time::{SystemTime, UNIX_EPOCH},
};

use bytes::BytesMut;
use futures::StreamExt as _;
use http::{
	HeaderMap, HeaderValue,
	header::{ACCEPT, ETAG, IF_NONE_MATCH, USER_AGENT},
};
use omp_ai::{
	auth::{CredentialError, CredentialFuture, CredentialLease, CredentialNeed, HeaderPlacement},
	id::{AccountId, PrincipalId},
};
use omp_cache::github_cache::{GithubCache, GithubCacheKey, GithubCacheStatus, GithubResourceKind};
use omp_catalog::AuthSpecId;
use omp_core::{CowBytes, Str, sf};
use omp_tool::{Diag, DiagKind};
use omp_tools::read::{
	Fault,
	resolver::{Resolve, ResolvedRead},
	selector::ParsedSelector,
};
use omp_vcs::git::GitRepo;
use serde_json::Value;
use smallvec::smallvec;

use super::tool_url;

const MAX_BODY: usize = 8 * 1024 * 1024;

pub(super) const GITHUB_HOST: &str = "github.com";

#[derive(Clone, Debug)]
pub(super) struct GithubRepo {
	host:     Str,
	slug:     Str,
	identity: Str,
}

impl GithubRepo {
	pub(super) fn parse(value: &str) -> Result<Self, Fault> {
		let mut parts = value.trim().trim_end_matches(".git").split('/');
		let first = parts.next().unwrap_or_default();
		let second = parts.next().unwrap_or_default();
		let third = parts.next();
		if parts.next().is_some() {
			return Err(invalid("GitHub repository must be [host/]owner/repo."));
		}
		match third {
			Some(name) => Self::new(first, second, name),
			None => Self::new(GITHUB_HOST, first, second),
		}
	}

	pub(super) fn new(host: &str, owner: &str, name: &str) -> Result<Self, Fault> {
		if !valid_github_host(host) || !valid_repo_component(owner) || !valid_repo_component(name) {
			return Err(invalid("GitHub repository must be [host/]owner/repo."));
		}
		let host = Str::new(host);
		let slug = Str::new(format!("{owner}/{name}"));
		let identity = if host.eq_ignore_ascii_case(GITHUB_HOST) {
			slug.clone()
		} else {
			Str::new(format!("{host}/{slug}"))
		};
		Ok(Self { host, slug, identity })
	}

	pub(super) fn host(&self) -> &str {
		&self.host
	}

	pub(super) fn slug(&self) -> &str {
		&self.slug
	}

	pub(super) fn identity(&self) -> &str {
		&self.identity
	}

	pub(super) fn api_url(&self, path: &str) -> String {
		api_url_for_host(&self.host, path)
	}
}

pub(super) fn api_url_for_host(host: &str, path: &str) -> String {
	if host.eq_ignore_ascii_case(GITHUB_HOST) {
		format!("https://api.github.com{path}")
	} else {
		format!("https://{host}/api/v3{path}")
	}
}

fn valid_github_host(host: &str) -> bool {
	!host.is_empty()
		&& host.len() <= 255
		&& host
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_repo_component(component: &str) -> bool {
	!component.is_empty()
		&& component.len() <= 255
		&& component
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Provider credential authority consumed by environment-owned GitHub
/// resources.
pub trait CredentialAuthority: Send + Sync + 'static {
	/// Issues one sealed provider lease.
	fn provider_lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>>;
}

/// Late-bound projection of the one combined daemon credential authority.
pub struct GithubCredentialBridge {
	authority: OnceLock<Arc<dyn CredentialAuthority>>,
}

impl GithubCredentialBridge {
	/// Creates an unbound credential projection.
	pub const fn new() -> Self {
		Self { authority: OnceLock::new() }
	}

	/// Installs the sole combined credential authority for this environment.
	pub fn bind(
		&self,
		authority: Arc<dyn CredentialAuthority>,
	) -> Result<(), Arc<dyn CredentialAuthority>> {
		self.authority.set(authority)
	}

	/// Leases the default GitHub provider credential when one is available.
	pub async fn lease(&self) -> Result<Option<CredentialLease>, Fault> {
		self.lease_for("github").await
	}

	/// Leases one named provider credential when one is available.
	pub async fn lease_for(&self, spec: &str) -> Result<Option<CredentialLease>, Fault> {
		self.lease_for_account(spec, None).await
	}

	/// Leases one named provider credential, optionally pinned to its durable
	/// account row.
	pub async fn lease_for_account(
		&self,
		spec: &str,
		account: Option<u64>,
	) -> Result<Option<CredentialLease>, Fault> {
		let Some(authority) = self.authority.get() else {
			return Ok(None);
		};
		match authority
			.provider_lease(CredentialNeed {
				spec:        AuthSpecId::from(Str::new(spec)),
				account:     Some(account.map_or_else(
					|| AccountId::from(sf!("{spec}:environment")),
					|account| AccountId::from(account.to_string()),
				)),
				principal:   Some(PrincipalId::from("environment")),
				valid_after: SystemTime::now(),
			})
			.await
		{
			Ok(lease) => Ok(Some(lease)),
			Err(CredentialError::Unavailable) => Ok(None),
			Err(_) => Err(Fault::Source { message: sf!("credential lease failed.") }),
		}
	}
}

impl fmt::Debug for GithubCredentialBridge {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("GithubCredentialBridge")
			.field("bound", &self.authority.get().is_some())
			.finish()
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GithubScheme {
	Issue,
	PullRequest,
}

pub(super) struct GithubResolver {
	scheme:      GithubScheme,
	root:        PathBuf,
	cache:       Arc<GithubCache>,
	credentials: Arc<GithubCredentialBridge>,
	client:      omp_http::Client,
}

impl GithubResolver {
	pub(super) fn new(
		scheme: GithubScheme,
		root: PathBuf,
		cache: Arc<GithubCache>,
		credentials: Arc<GithubCredentialBridge>,
	) -> Self {
		Self { scheme, root, cache, credentials, client: omp_http::no_redirect_client() }
	}

	#[tracing::instrument(
		name = "github_resource_resolve",
		level = "debug",
		skip_all,
		fields(scheme = ?self.scheme, repo = tracing::field::Empty, number = tracing::field::Empty),
	)]
	async fn resolve(&self, resource: &str, query: Option<&str>) -> Result<GithubRead, Fault> {
		let target = Target::parse(self.scheme, resource, query, &self.root)?;
		tracing::Span::current().record("repo", target.repo.identity());
		if let Some(number) = target.number {
			tracing::Span::current().record("number", number);
		}
		let key = target.cache_key()?;
		let now = now_ms();
		let cached = self.cache.get(&key, now).map_err(cache_fault)?;
		if cached
			.as_ref()
			.is_some_and(|entry| entry.status == GithubCacheStatus::Fresh)
		{
			return Ok(GithubRead { data: cached.expect("fresh entry").body.to_vec(), stale: false });
		}
		match self
			.fetch(&target, cached.as_ref().and_then(|entry| entry.etag.as_deref()))
			.await
		{
			Ok(Fetch::NotModified) => {
				self.cache.touch(&key, now).map_err(cache_fault)?;
				Ok(GithubRead {
					data:  cached.expect("304 requires cached entity").body.to_vec(),
					stale: false,
				})
			},
			Ok(Fetch::Body { body, etag }) => {
				let comments = if target.comments_enabled() {
					match self.fetch_comments(&target).await {
						Ok(comments) => Some(comments),
						Err(error) => {
							tracing::warn!(
								error = ?error,
								cached = cached.is_some(),
								"GitHub comments refresh failed",
							);
							if let Some(cached) = &cached {
								return Ok(GithubRead { data: cached.body.to_vec(), stale: true });
							}
							return Err(error);
						},
					}
				} else {
					None
				};
				let rendered = target.render(&body, comments.as_deref())?;
				self
					.cache
					.put(&key, &rendered, etag.as_deref(), now)
					.map_err(cache_fault)?;
				Ok(GithubRead { data: rendered, stale: false })
			},
			Err(error) => {
				tracing::warn!(
					error = ?error,
					cached = cached.is_some(),
					"GitHub resource refresh failed",
				);
				if let Some(cached) = cached {
					Ok(GithubRead { data: cached.body.to_vec(), stale: true })
				} else {
					Err(error)
				}
			},
		}
	}

	#[tracing::instrument(
		name = "github_resource_fetch",
		level = "debug",
		skip_all,
		fields(scheme = ?target.scheme, repo = %target.repo.identity(), number = ?target.number),
	)]
	async fn fetch(&self, target: &Target, etag: Option<&str>) -> Result<Fetch, Fault> {
		let mut headers = HeaderMap::new();
		headers.insert(USER_AGENT, HeaderValue::from_static("omp/issue-pr-resolver"));
		headers.insert("x-github-api-version", HeaderValue::from_static("2022-11-28"));
		headers.insert(ACCEPT, HeaderValue::from_static(target.accept()));
		if let Some(lease) = self.credentials.lease().await? {
			lease
				.apply_header(&HeaderPlacement::bearer(), &mut headers)
				.map_err(|_| Fault::Source { message: sf!("GitHub credential projection failed.") })?;
		}
		if let Some(etag) = etag {
			headers.insert(
				IF_NONE_MATCH,
				HeaderValue::from_str(etag).map_err(|_| invalid("Invalid cached GitHub ETag."))?,
			);
		}
		let response = self
			.client
			.get(target.api_url())
			.headers(headers)
			.send()
			.await
			.map_err(http_fault)?;
		if response.status().as_u16() == 304 {
			return Ok(Fetch::NotModified);
		}
		let status = response.status().as_u16();
		let etag = response
			.headers()
			.get(ETAG)
			.and_then(|value| value.to_str().ok())
			.map(Str::new);
		let mut stream = response.bytes_stream();
		let mut bytes = BytesMut::new();
		while let Some(chunk) = stream.next().await {
			let chunk = chunk.map_err(http_fault)?;
			if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
				return Err(invalid("GitHub response exceeds 8 MiB."));
			}
			bytes.extend_from_slice(&chunk);
		}
		if !(200..300).contains(&status) {
			return Err(Fault::Source {
				message: Str::new(format!("GitHub API returned HTTP {status}.")),
			});
		}
		Ok(Fetch::Body { body: bytes.freeze().to_vec(), etag })
	}

	#[tracing::instrument(
		name = "github_comments_fetch",
		level = "debug",
		skip_all,
		fields(scheme = ?target.scheme, repo = %target.repo.identity(), number = ?target.number),
	)]
	async fn fetch_comments(&self, target: &Target) -> Result<Vec<Value>, Fault> {
		let mut comments = Vec::new();
		let mut retained_bytes = 0usize;
		let lease = self.credentials.lease().await?;
		for page in 1..=100u32 {
			let mut headers = HeaderMap::new();
			headers.insert(USER_AGENT, HeaderValue::from_static("omp/issue-pr-resolver"));
			headers.insert("x-github-api-version", HeaderValue::from_static("2022-11-28"));
			headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
			if let Some(lease) = &lease {
				lease
					.apply_header(&HeaderPlacement::bearer(), &mut headers)
					.map_err(|_| Fault::Source {
						message: sf!("GitHub credential projection failed."),
					})?;
			}
			let response = self
				.client
				.get(target.comments_url(page))
				.headers(headers)
				.send()
				.await
				.map_err(http_fault)?;
			let status = response.status().as_u16();
			if !(200..300).contains(&status) {
				return Err(Fault::Source {
					message: Str::new(format!("GitHub comments API returned HTTP {status}.")),
				});
			}
			let mut stream = response.bytes_stream();
			let mut bytes = BytesMut::new();
			while let Some(chunk) = stream.next().await {
				let chunk = chunk.map_err(http_fault)?;
				retained_bytes = retained_bytes.saturating_add(chunk.len());
				if retained_bytes > MAX_BODY {
					return Err(invalid("GitHub comments exceed 8 MiB."));
				}
				bytes.extend_from_slice(&chunk);
			}
			let page_comments: Vec<Value> = serde_json::from_slice(&bytes).map_err(|error| {
				Fault::Invalid { message: Str::new(format!("Invalid GitHub comments JSON: {error}")) }
			})?;
			let complete = page_comments.len() < 100;
			comments.extend(page_comments);
			if complete {
				return Ok(comments);
			}
		}
		Err(invalid("GitHub comments exceed 100 pages."))
	}
}

impl Resolve for GithubResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		self
			.read_with_diags(resource, selector)
			.await
			.map(|resolved| resolved.data)
	}

	async fn read_with_diags<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		let resolved = self.resolve(resource, None).await?;
		selected_read(resolved, resource, selector)
	}

	async fn read_query<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		self
			.read_query_with_diags(resource, query, selector)
			.await
			.map(|resolved| resolved.data)
	}

	async fn read_query_with_diags<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		let resolved = self.resolve(resource, query).await?;
		selected_read(resolved, resource, selector)
	}
}

fn selected_read(
	resolved: GithubRead,
	resource: &str,
	selector: &ParsedSelector,
) -> Result<ResolvedRead, Fault> {
	let data = tool_url::select_bytes(
		&Default::default(),
		resource,
		CowBytes::from(resolved.data),
		selector,
	)?;
	let diags = if resolved.stale {
		smallvec![Diag::warn(
			DiagKind::StaleCache,
			"Live GitHub refresh failed; cached content may be stale.",
		)]
	} else {
		smallvec![]
	};
	Ok(ResolvedRead { data, diags })
}

impl fmt::Debug for GithubResolver {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("GithubResolver(..)")
	}
}

struct GithubRead {
	data:  Vec<u8>,
	stale: bool,
}

enum Fetch {
	NotModified,
	Body { body: Vec<u8>, etag: Option<Str> },
}

#[derive(Clone, Debug)]
enum View {
	List { state: Str, limit: u32, author: Option<Str>, label: Option<Str> },
	Detail { comments: bool },
	Diff { mode: DiffMode },
}
#[derive(Clone, Debug)]
enum DiffMode {
	Index,
	All,
	Slice(usize),
}
#[derive(Clone, Debug)]
struct Target {
	scheme: GithubScheme,
	repo:   GithubRepo,
	number: Option<u64>,
	view:   View,
}

impl Target {
	fn parse(
		scheme: GithubScheme,
		resource: &str,
		query: Option<&str>,
		root: &Path,
	) -> Result<Self, Fault> {
		let parts = resource
			.split('/')
			.filter(|part| !part.is_empty())
			.collect::<Vec<_>>();
		if parts.iter().any(|part| matches!(*part, "." | "..")) {
			return Err(invalid("Unsafe GitHub resource path."));
		}
		let (repo, number, trailing) = match parts.as_slice() {
			[] => (infer_repo(root)?, None, &[][..]),
			[number] if number.bytes().all(|b| b.is_ascii_digit()) => {
				(infer_repo(root)?, Some(parse_number(number)?), &[][..])
			},
			[host, owner, repo] if host.contains('.') => {
				(GithubRepo::new(host, owner, repo)?, None, &[][..])
			},
			[host, owner, repo, number, tail @ ..]
				if number.bytes().all(|byte| byte.is_ascii_digit()) =>
			{
				(GithubRepo::new(host, owner, repo)?, Some(parse_number(number)?), tail)
			},
			[owner, repo] => (GithubRepo::new(GITHUB_HOST, owner, repo)?, None, &[][..]),
			[owner, repo, number, tail @ ..] => {
				(GithubRepo::new(GITHUB_HOST, owner, repo)?, Some(parse_number(number)?), tail)
			},
			_ => {
				return Err(invalid(
					"Expected issue://<n>, issue://[host/]owner/repo/<n>, or a repo list.",
				));
			},
		};
		let params = query
			.map(|query| {
				url::form_urlencoded::parse(query.as_bytes())
					.into_owned()
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();
		let get = |name: &str| {
			params
				.iter()
				.find(|(key, _)| key == name)
				.map(|(_, value)| value.as_str())
		};
		let view = if !trailing.is_empty() {
			if scheme != GithubScheme::PullRequest
				|| trailing.first() != Some(&"diff")
				|| trailing.len() > 2
			{
				return Err(invalid("Only pr:// resources support /diff[/all|<index>]."));
			}
			let mode = match trailing.get(1).copied() {
				None => DiffMode::Index,
				Some("all") => DiffMode::All,
				Some(value) => DiffMode::Slice(
					value
						.parse()
						.map_err(|_| invalid("Diff index must be positive."))?,
				),
			};
			View::Diff { mode }
		} else if number.is_some() {
			View::Detail { comments: !matches!(get("comments"), Some("0" | "false")) }
		} else {
			let state = Str::new(get("state").unwrap_or("open"));
			if !matches!(state.as_str(), "open" | "closed" | "merged" | "all") {
				return Err(invalid("Invalid GitHub list state."));
			}
			let limit = get("limit")
				.map_or(Ok(30), str::parse::<u32>)
				.map_err(|_| invalid("Invalid GitHub list limit."))?
				.clamp(1, 100);
			View::List {
				state,
				limit,
				author: get("author").map(Str::new),
				label: get("label").map(Str::new),
			}
		};
		Ok(Self { scheme, repo, number, view })
	}

	fn cache_key(&self) -> Result<GithubCacheKey, Fault> {
		GithubCacheKey::new(
			match &self.view {
				View::Diff { .. } => GithubResourceKind::Diff,
				_ if self.scheme == GithubScheme::Issue => GithubResourceKind::Issue,
				_ => GithubResourceKind::PullRequest,
			},
			self.repo.identity(),
			self.number,
			self.view_key(),
		)
		.map_err(cache_fault)
	}

	fn view_key(&self) -> Str {
		Str::new(format!("{:?}", self.view))
	}

	fn accept(&self) -> &'static str {
		if matches!(self.view, View::Diff { .. }) {
			"application/vnd.github.v3.diff"
		} else {
			"application/vnd.github+json"
		}
	}

	fn api_url(&self) -> String {
		let base = self.repo.api_url(&format!("/repos/{}", self.repo.slug()));
		match &self.view {
			View::List { state, limit, author, label } => {
				let family = if self.scheme == GithubScheme::Issue {
					"issues"
				} else {
					"pulls"
				};
				let mut url = format!(
					"{base}/{family}?state={}&per_page={limit}",
					if state == "merged" {
						"closed"
					} else {
						state.as_str()
					}
				);
				if let Some(author) = author {
					url.push_str("&creator=");
					url.push_str(author);
				}
				if let Some(label) = label {
					url.push_str("&labels=");
					url.push_str(label);
				}
				url
			},
			View::Detail { .. } => format!(
				"{base}/{}/{}",
				if self.scheme == GithubScheme::Issue {
					"issues"
				} else {
					"pulls"
				},
				self.number.expect("detail number")
			),
			View::Diff { .. } => format!("{base}/pulls/{}", self.number.expect("diff number")),
		}
	}

	fn comments_enabled(&self) -> bool {
		matches!(self.view, View::Detail { comments: true })
	}

	fn comments_url(&self, page: u32) -> String {
		self.repo.api_url(&format!(
			"/repos/{}/issues/{}/comments?per_page=100&page={page}",
			self.repo.slug(),
			self.number.expect("comments require a detail number"),
		))
	}

	fn render(&self, body: &[u8], comments: Option<&[Value]>) -> Result<Vec<u8>, Fault> {
		if let View::Diff { mode } = &self.view {
			let text = str::from_utf8(body).map_err(|_| invalid("GitHub diff is not UTF-8."))?;
			return render_diff(text, mode, self.repo.identity(), self.number.expect("diff number"));
		}
		let value: Value = serde_json::from_slice(body).map_err(|error| Fault::Invalid {
			message: Str::new(format!("Invalid GitHub JSON: {error}")),
		})?;
		let mut out = String::new();
		match (&self.view, value) {
			(View::List { .. }, Value::Array(items)) => {
				out.push_str(if self.scheme == GithubScheme::Issue {
					"# Issues\n\n"
				} else {
					"# Pull Requests\n\n"
				});
				for item in items {
					if self.scheme == GithubScheme::Issue && item.get("pull_request").is_some() {
						continue;
					}
					render_item(&mut out, &item, self.repo.identity(), self.scheme);
				}
			},
			(View::Detail { comments: include_comments }, item) => {
				out.push_str("# ");
				out.push_str(
					item
						.get("title")
						.and_then(Value::as_str)
						.unwrap_or("(no title)"),
				);
				out.push_str("\n\n");
				out.push_str(item.get("body").and_then(Value::as_str).unwrap_or(""));
				if !include_comments {
					out.push_str("\n\n_Comments disabled._");
				} else if let Some(comments) = comments {
					render_comments(&mut out, comments);
				}
			},
			_ => return Err(invalid("Unexpected GitHub response shape.")),
		}
		Ok(out.into_bytes())
	}
}

fn render_comments(out: &mut String, comments: &[Value]) {
	out.push_str("\n\n## Comments\n");
	if comments.is_empty() {
		out.push_str("\n_No comments._\n");
		return;
	}
	for comment in comments {
		let author = comment
			.get("user")
			.and_then(|user| user.get("login"))
			.and_then(Value::as_str)
			.unwrap_or("unknown");
		let created = comment
			.get("created_at")
			.and_then(Value::as_str)
			.unwrap_or("unknown time");
		out.push_str("\n### @");
		out.push_str(author);
		out.push_str(" — ");
		out.push_str(created);
		out.push_str("\n\n");
		out.push_str(comment.get("body").and_then(Value::as_str).unwrap_or(""));
		out.push('\n');
	}
}

fn render_item(out: &mut String, item: &Value, repo: &str, scheme: GithubScheme) {
	let number = item
		.get("number")
		.and_then(Value::as_u64)
		.unwrap_or_default();
	let state = item.get("state").and_then(Value::as_str).unwrap_or("?");
	let title = item
		.get("title")
		.and_then(Value::as_str)
		.unwrap_or("(no title)");
	out.push_str(&format!(
		"- [{state}] #{number} {title}\n  {}://{repo}/{number}\n",
		if scheme == GithubScheme::Issue {
			"issue"
		} else {
			"pr"
		}
	));
}
fn render_diff(text: &str, mode: &DiffMode, repo: &str, number: u64) -> Result<Vec<u8>, Fault> {
	if matches!(mode, DiffMode::All) {
		return Ok(text.as_bytes().to_vec());
	}
	let starts = text
		.match_indices("diff --git ")
		.map(|(index, _)| index)
		.collect::<Vec<_>>();
	if let DiffMode::Slice(index) = mode {
		if *index == 0 || *index > starts.len() {
			return Err(invalid("Diff file index is out of range."));
		}
		let start = starts[index - 1];
		let end = starts.get(*index).copied().unwrap_or(text.len());
		return Ok(text.as_bytes()[start..end].to_vec());
	}
	let mut out = format!("# Pull Request Diff: {repo}#{number}\n\n");
	for (index, start) in starts.iter().enumerate() {
		let line = text[*start..].lines().next().unwrap_or("diff --git");
		out.push_str(&format!(
			"{}. {}\n   pr://{repo}/{number}/diff/{}\n",
			index + 1,
			line.trim_start_matches("diff --git "),
			index + 1
		));
	}
	Ok(out.into_bytes())
}
pub(super) fn infer_repo(root: &Path) -> Result<GithubRepo, Fault> {
	let repo = GitRepo::require(root)
		.map_err(|_| invalid("Cannot infer GitHub repo; use [host/]owner/repo explicitly."))?;
	let config = std::fs::read_to_string(repo.info().common_dir.join("config"))
		.map_err(|_| invalid("Git repository config is unavailable."))?;
	let mut in_origin = false;
	let mut first_remote = None;
	let mut origin = None;
	for line in config.lines().map(str::trim) {
		if line.starts_with('[') {
			in_origin = line.eq_ignore_ascii_case("[remote \"origin\"]");
		} else if let Some(url) = line.strip_prefix("url = ") {
			if first_remote.is_none() {
				first_remote = Some(url);
			}
			if in_origin {
				origin = Some(url);
				break;
			}
		}
	}
	let remote = origin
		.or(first_remote)
		.ok_or_else(|| invalid("Git origin URL is missing."))?;
	repo_from_remote(remote)
}

fn repo_from_remote(remote: &str) -> Result<GithubRepo, Fault> {
	let remote = remote.trim();
	if remote.contains("://") {
		let parsed =
			url::Url::parse(remote).map_err(|_| invalid("Git origin is not a GitHub remote."))?;
		let host = parsed
			.host_str()
			.ok_or_else(|| invalid("Git origin is not a GitHub remote."))?;
		let host = parsed
			.port()
			.map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"));
		repo_from_host_path(&host, parsed.path().trim_start_matches('/'))
	} else {
		let (authority, path) = remote
			.split_once(':')
			.ok_or_else(|| invalid("Git origin is not a GitHub remote."))?;
		let host = authority
			.rsplit_once('@')
			.map_or(authority, |(_, host)| host);
		repo_from_host_path(host, path)
	}
}

/// Builds the repo identity from a remote's host and path segments.
fn repo_from_host_path(host: &str, path: &str) -> Result<GithubRepo, Fault> {
	let path = path.trim_end_matches('/').trim_end_matches(".git");
	let mut parts = path.split('/');
	let owner = parts.next().unwrap_or_default();
	let name = parts.next().unwrap_or_default();
	if parts.next().is_some() {
		return Err(invalid("GitHub origin is not owner/repo."));
	}
	GithubRepo::new(host, owner, name)
}
fn parse_number(value: &str) -> Result<u64, Fault> {
	value
		.parse::<u64>()
		.ok()
		.filter(|n| *n > 0)
		.ok_or_else(|| invalid("GitHub number must be positive."))
}
fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
fn invalid(message: &'static str) -> Fault {
	Fault::Invalid { message: Str::new_static(message) }
}
fn cache_fault(error: impl Display) -> Fault {
	Fault::Source { message: Str::new(error.to_string()) }
}
fn http_fault(error: impl Display) -> Fault {
	Fault::Source { message: Str::new(format!("GitHub API request failed: {error}")) }
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stale_cache_is_reported_out_of_band_without_changing_document_bytes() {
		let cached = b"# Cached issue\n\nBody".to_vec();
		let resolved = selected_read(
			GithubRead { data: cached.clone(), stale: true },
			"owner/repo/1",
			&ParsedSelector::None,
		)
		.expect("cached resource");
		assert_eq!(resolved.data.as_ref(), cached.as_slice());
		assert_eq!(resolved.diags.len(), 1);
		assert_eq!(resolved.diags[0].native_kind(), Some(DiagKind::StaleCache));
		assert_eq!(resolved.diags[0].severity, omp_tool::Severity::Warn);
	}

	#[test]
	fn target_parses_dotted_and_single_label_enterprise_hosts() {
		let root = Path::new("/unused");
		let dotted =
			Target::parse(GithubScheme::PullRequest, "ghe.example.com/owner/repo/7", None, root)
				.expect("dotted enterprise target");
		assert_eq!(dotted.repo.identity(), "ghe.example.com/owner/repo");
		assert_eq!(dotted.api_url(), "https://ghe.example.com/api/v3/repos/owner/repo/pulls/7",);

		let single = Target::parse(GithubScheme::PullRequest, "ghe/owner/repo/7", None, root)
			.expect("single-label enterprise target");
		assert_eq!(single.repo.identity(), "ghe/owner/repo");
		assert_eq!(single.api_url(), "https://ghe/api/v3/repos/owner/repo/pulls/7");
		let issue = Target::parse(GithubScheme::Issue, "ghe.example.com/owner/repo/8", None, root)
			.expect("enterprise issue target");
		assert_eq!(issue.api_url(), "https://ghe.example.com/api/v3/repos/owner/repo/issues/8",);
	}

	#[test]
	fn numeric_tail_disambiguates_host_from_diff_suffix() {
		let root = Path::new("/unused");
		let slice = Target::parse(GithubScheme::PullRequest, "owner/repo/77/diff/1", None, root)
			.expect("default-host diff slice");
		assert_eq!(slice.repo.identity(), "owner/repo");
		assert!(matches!(slice.view, View::Diff { mode: DiffMode::Slice(1) }));

		assert!(
			Target::parse(GithubScheme::PullRequest, "ghe/owner/repo", None, root).is_err(),
			"an unnumbered single-label host is ambiguous and must not be guessed",
		);
	}

	#[test]
	fn remote_urls_preserve_enterprise_hosts_and_normalize_github_dot_com() {
		let enterprise =
			repo_from_remote("git@ghe.example.com:Owner/Repo.git").expect("enterprise SSH remote");
		assert_eq!(enterprise.identity(), "ghe.example.com/Owner/Repo");
		assert_eq!(
			enterprise.api_url("/repos/Owner/Repo"),
			"https://ghe.example.com/api/v3/repos/Owner/Repo",
		);

		let default =
			repo_from_remote("https://github.com/Owner/Repo.git").expect("github.com remote");
		assert_eq!(default.identity(), "Owner/Repo");
		assert_eq!(default.api_url("/repos/Owner/Repo"), "https://api.github.com/repos/Owner/Repo");
		let workspace = tempfile::tempdir().expect("workspace");
		std::fs::create_dir(workspace.path().join(".git")).expect("git directory");
		std::fs::write(
			workspace.path().join(".git/config"),
			"[remote \"upstream\"]\n\turl = https://github.com/other/upstream.git\n[remote \
			 \"origin\"]\n\turl = ssh://git@ghe/Owner/Repo.git\n",
		)
		.expect("git config");
		let inferred = infer_repo(workspace.path()).expect("origin repo");
		assert_eq!(inferred.identity(), "ghe/Owner/Repo");
	}
}
