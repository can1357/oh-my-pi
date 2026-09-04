//! Anonymous GitLab API renderer.

use std::fmt::Write as _;

use omp_core::{Str, sf};
use omp_tool::{Diag, DiagKind, Unit};
use serde::Deserialize;
use url::Url;

use super::utils::{format_iso_date, format_number, html_to_basic_markdown};
use crate::read::web::types::{
	HttpClient, HttpRequest, MAX_BYTES, RenderResult, WebError, finalize_output,
};

const API: &str = "https://gitlab.com/api/v4";

#[derive(Clone, Copy)]
enum Kind {
	Repo,
	Blob,
	Tree,
	Issue(i64),
	MergeRequest(i64),
}

struct Target {
	namespace: String,
	project:   String,
	kind:      Kind,
	reference: Option<String>,
	path:      Option<String>,
}

pub(super) fn matches(url: &Url) -> bool {
	parse(url).is_some()
}

pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse(url) else {
		return Ok(None);
	};
	let (content, content_type, method, provenance) = match target.kind {
		Kind::Repo => {
			let endpoint = format!(
				"{API}/projects/{}",
				encode(&format!("{}/{}", target.namespace, target.project))
			);
			let Some(repo): Option<Project> = get_json(client, endpoint).await else {
				return Ok(None);
			};
			let mut out = format!("# {}\n\n", repo.name);
			if let Some(description) = repo.description.filter(|s| !s.is_empty()) {
				out.push_str(&description);
				out.push_str("\n\n");
			}
			writeln!(
				out,
				"**Stars:** {} · **Forks:** {} · **Issues:** {}",
				format_number(repo.star_count),
				format_number(repo.forks_count),
				format_number(repo.open_issues_count)
			)
			.expect("writing to String cannot fail");
			writeln!(
				out,
				"**Visibility:** {} · **Default Branch:** {}",
				repo.visibility,
				repo.default_branch.as_deref().unwrap_or("null")
			)
			.expect("writing to String cannot fail");
			if let Some(topics) = repo.topics.filter(|topics| !topics.is_empty()) {
				writeln!(out, "**Topics:** {}", topics.join(", "))
					.expect("writing to String cannot fail");
			}
			write!(
				out,
				"**Created:** {} · **Last Activity:** {}\n\n",
				format_iso_date(&repo.created_at),
				format_iso_date(&repo.last_activity_at)
			)
			.expect("writing to String cannot fail");
			if let Some(readme_url) = repo.readme_url.filter(|url| !url.is_empty())
				&& let Some(readme) = get_text(client, readme_url).await
				&& !readme.trim().is_empty()
			{
				out.push_str("---\n\n## README\n\n");
				out.push_str(&readme);
				out.push('\n');
			}
			(out, None, "gitlab-repo", "Fetched repository via GitLab API")
		},
		kind => {
			let project_endpoint = format!(
				"{API}/projects/{}",
				encode(&format!("{}/{}", target.namespace, target.project))
			);
			let Some(project): Option<ProjectId> = get_json(client, project_endpoint)
				.await
				.filter(|project: &ProjectId| project.id != 0)
			else {
				return Ok(None);
			};
			match kind {
				Kind::Blob => {
					let endpoint = format!(
						"{API}/projects/{}/repository/files/{}/raw?ref={}",
						project.id,
						encode(target.path.as_deref().unwrap_or("")),
						target.reference.as_deref().unwrap_or("")
					);
					let Some(out) = get_text(client, endpoint).await else {
						return Ok(None);
					};
					(out, Some(sf!("text/plain")), "gitlab-raw", "Fetched raw file via GitLab API")
				},
				Kind::Tree => {
					let endpoint = format!(
						"{API}/projects/{}/repository/tree?ref={}&path={}&per_page=100",
						project.id,
						target.reference.as_deref().unwrap_or(""),
						target.path.as_deref().unwrap_or("")
					);
					let Some(items): Option<Vec<TreeItem>> = get_json(client, endpoint).await else {
						return Ok(None);
					};
					let shown_path = target
						.path
						.as_deref()
						.filter(|p| !p.is_empty())
						.unwrap_or("/");
					let mut out = format!(
						"# Directory: {shown_path}\n\n**Ref:** {}\n\n",
						target.reference.as_deref().unwrap_or("")
					);
					let dirs: Vec<_> = items.iter().filter(|i| i.kind == "tree").collect();
					let files: Vec<_> = items.iter().filter(|i| i.kind == "blob").collect();
					if !dirs.is_empty() {
						write!(out, "## Directories ({})\n\n", dirs.len())
							.expect("writing to String cannot fail");
						for item in dirs {
							writeln!(out, "- 📁 {}/", item.name).expect("writing to String cannot fail");
						}
						out.push('\n');
					}
					if !files.is_empty() {
						write!(out, "## Files ({})\n\n", files.len())
							.expect("writing to String cannot fail");
						for item in files {
							writeln!(out, "- 📄 {}", item.name).expect("writing to String cannot fail");
						}
					}
					(out, None, "gitlab-tree", "Fetched directory tree via GitLab API")
				},
				Kind::Issue(id) => {
					let endpoint = format!("{API}/projects/{}/issues/{id}", project.id);
					let Some(issue): Option<Issue> = get_json(client, endpoint).await else {
						return Ok(None);
					};
					let mut out = format!("# Issue #{id}: {}\n\n", issue.title);
					writeln!(
						out,
						"**State:** {} · **Author:** {} (@{})",
						issue.state.to_uppercase(),
						issue.author.name,
						issue.author.username
					)
					.expect("writing to String cannot fail");
					writeln!(
						out,
						"**Created:** {} · **Updated:** {}",
						format_iso_date(&issue.created_at),
						format_iso_date(&issue.updated_at)
					)
					.expect("writing to String cannot fail");
					writeln!(
						out,
						"**Upvotes:** {} · **Downvotes:** {} · **Comments:** {}",
						issue.upvotes, issue.downvotes, issue.user_notes_count
					)
					.expect("writing to String cannot fail");
					append_metadata(&mut out, &issue.labels, &issue.assignees);
					out.push_str("\n---\n\n## Description\n\n");
					if let Some(description) = issue
						.description
						.as_deref()
						.filter(|description| !description.is_empty())
					{
						out.push_str(&html_to_basic_markdown(description)?);
					} else {
						out.push_str("*No description*");
					}
					(out, None, "gitlab-issue", "Fetched issue via GitLab API")
				},
				Kind::MergeRequest(id) => {
					let endpoint = format!("{API}/projects/{}/merge_requests/{id}", project.id);
					let Some(mr): Option<MergeRequest> = get_json(client, endpoint).await else {
						return Ok(None);
					};
					let mut out = format!("# MR !{id}: {}\n\n", mr.title);
					if mr.draft {
						out.push_str("**[DRAFT]** ");
					}
					writeln!(
						out,
						"**State:** {} · **Author:** {} (@{})",
						mr.state.to_uppercase(),
						mr.author.name,
						mr.author.username
					)
					.expect("writing to String cannot fail");
					writeln!(out, "**Branch:** {} → {}", mr.source_branch, mr.target_branch)
						.expect("writing to String cannot fail");
					writeln!(
						out,
						"**Created:** {} · **Updated:** {}",
						format_iso_date(&mr.created_at),
						format_iso_date(&mr.updated_at)
					)
					.expect("writing to String cannot fail");
					writeln!(
						out,
						"**Merge Status:** {} · **Upvotes:** {} · **Downvotes:** {} · **Comments:** {}",
						mr.merge_status, mr.upvotes, mr.downvotes, mr.user_notes_count
					)
					.expect("writing to String cannot fail");
					append_metadata(&mut out, &mr.labels, &mr.assignees);
					out.push_str("\n---\n\n## Description\n\n");
					if let Some(description) = mr
						.description
						.as_deref()
						.filter(|description| !description.is_empty())
					{
						out.push_str(&html_to_basic_markdown(description)?);
					} else {
						out.push_str("*No description*");
					}
					(out, None, "gitlab-mr", "Fetched merge request via GitLab API")
				},
				Kind::Repo => unreachable!(),
			}
		},
	};
	let mut rendered = if content_type.is_none() {
		RenderResult::markdown(&content, method)
	} else {
		let (content, omitted) = finalize_output(&content);
		let mut diags = Vec::new();
		if omitted != 0 {
			diags.push(
				Diag::warn(DiagKind::OutputBounded, "scraper output truncated")
					.omitted(omitted as u64, Unit::Chars),
			);
		}
		RenderResult { content, content_type, method: Str::new(method), diags }
	};
	rendered
		.diags
		.insert(0, Diag::info(DiagKind::Provenance, provenance));
	Ok(Some(rendered))
}

async fn get_text<C: HttpClient + Sync>(client: &C, endpoint: String) -> Option<String> {
	let response = client
		.get(HttpRequest::new(endpoint).with_max_bytes(MAX_BYTES))
		.await
		.ok()?;
	response.is_success().then(|| response.text().to_string())
}

async fn get_json<C, T>(client: &C, endpoint: String) -> Option<T>
where
	C: HttpClient + Sync,
	T: for<'de> Deserialize<'de>,
{
	let text = get_text(client, endpoint).await?;
	serde_json::from_str(&text).ok()
}

fn parse(url: &Url) -> Option<Target> {
	if url.host_str()? != "gitlab.com" {
		return None;
	}
	let segments: Vec<String> = url
		.path_segments()?
		.filter(|segment| !segment.is_empty())
		.map(str::to_owned)
		.collect();
	if segments.len() < 2 {
		return None;
	}
	let namespace = segments[0].clone();
	let project = segments[1].clone();
	if segments.len() == 2 {
		return Some(Target { namespace, project, kind: Kind::Repo, reference: None, path: None });
	}
	if segments.get(2).map(String::as_str) != Some("-") {
		return None;
	}
	let kind = segments.get(3)?.as_str();
	let rest = &segments[4..];
	let (kind, reference, path) = match kind {
		"blob" if rest.len() >= 2 => (Kind::Blob, Some(rest[0].clone()), Some(rest[1..].join("/"))),
		"tree" if !rest.is_empty() => {
			(Kind::Tree, Some(rest[0].clone()), (!rest[1..].is_empty()).then(|| rest[1..].join("/")))
		},
		"issues" if rest.len() == 1 => (Kind::Issue(parse_js_id(&rest[0])?), None, None),
		"merge_requests" if rest.len() == 1 => {
			(Kind::MergeRequest(parse_js_id(&rest[0])?), None, None)
		},
		_ => return None,
	};
	Some(Target { namespace, project, kind, reference, path })
}

fn encode(value: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut encoded = String::with_capacity(value.len());
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric()
			|| matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
		{
			encoded.push(char::from(byte));
		} else {
			encoded.push('%');
			encoded.push(char::from(HEX[usize::from(byte >> 4)]));
			encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
	encoded
}

fn parse_js_id(value: &str) -> Option<i64> {
	let (sign, unsigned) = match value.as_bytes().first() {
		Some(b'+') => (1_i64, &value[1..]),
		Some(b'-') => (-1_i64, &value[1..]),
		_ => (1_i64, value),
	};
	let digits = unsigned.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 {
		return None;
	}
	unsigned[..digits].parse::<i64>().ok()?.checked_mul(sign)
}

fn append_metadata(out: &mut String, labels: &[String], assignees: &[Person]) {
	if !labels.is_empty() {
		writeln!(out, "**Labels:** {}", labels.join(", ")).expect("writing to String cannot fail");
	}
	if !assignees.is_empty() {
		writeln!(
			out,
			"**Assignees:** {}",
			assignees
				.iter()
				.map(|assignee| assignee.name.as_str())
				.collect::<Vec<_>>()
				.join(", ")
		)
		.expect("writing to String cannot fail");
	}
}

#[derive(Deserialize)]
struct ProjectId {
	id: u64,
}
#[derive(Deserialize)]
struct Project {
	name:              String,
	description:       Option<String>,
	star_count:        u64,
	forks_count:       u64,
	open_issues_count: u64,
	default_branch:    Option<String>,
	visibility:        String,
	created_at:        String,
	last_activity_at:  String,
	#[serde(default)]
	topics:            Option<Vec<String>>,
	readme_url:        Option<String>,
}
#[derive(Deserialize)]
struct TreeItem {
	name: String,
	#[serde(rename = "type")]
	kind: String,
}

#[derive(Deserialize)]
struct Person {
	name:     String,
	#[serde(default)]
	username: String,
}
#[derive(Deserialize)]
struct Issue {
	title:            String,
	description:      Option<String>,
	state:            String,
	author:           Person,
	created_at:       String,
	updated_at:       String,
	#[serde(default)]
	labels:           Vec<String>,
	upvotes:          u64,
	downvotes:        u64,
	user_notes_count: u64,
	#[serde(default)]
	assignees:        Vec<Person>,
}
#[derive(Deserialize)]
struct MergeRequest {
	title:            String,
	description:      Option<String>,
	state:            String,
	author:           Person,
	created_at:       String,
	updated_at:       String,
	source_branch:    String,
	target_branch:    String,
	#[serde(default)]
	labels:           Vec<String>,
	upvotes:          u64,
	downvotes:        u64,
	user_notes_count: u64,
	#[serde(default)]
	assignees:        Vec<Person>,
	draft:            bool,
	merge_status:     String,
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		future::{Future, ready},
		iter::empty,
	};

	use bytes::Bytes;
	use omp_core::sf;
	use parking_lot::Mutex;
	use smallvec::SmallVec;
	use url::Url;

	use super::{Kind, matches, parse, render};
	use crate::read::web::types::{HttpClient, HttpRequest, HttpResponse, MAX_BYTES, WebError};

	struct FakeClient {
		requests:  Mutex<Vec<HttpRequest>>,
		responses: Mutex<VecDeque<Result<HttpResponse, WebError>>>,
	}

	impl FakeClient {
		fn new(responses: impl IntoIterator<Item = Result<HttpResponse, WebError>>) -> Self {
			Self {
				requests:  Mutex::new(Vec::new()),
				responses: Mutex::new(responses.into_iter().collect()),
			}
		}
	}

	impl HttpClient for FakeClient {
		fn get(
			&self,
			request: HttpRequest,
		) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
			self.requests.lock().push(request);
			let response = self
				.responses
				.lock()
				.pop_front()
				.unwrap_or_else(|| Err(WebError::request("unexpected request")));
			ready(response)
		}
	}

	fn response(status: u16, body: &'static str) -> HttpResponse {
		HttpResponse {
			final_url: sf!("https://gitlab.com/fixture"),
			status,
			content_type: Some(sf!("application/json")),
			headers: SmallVec::new(),
			body: Bytes::from_static(body.as_bytes()),
		}
	}

	#[test]
	fn matches_only_supported_gitlab_routes() {
		for route in [
			"https://gitlab.com/group/project",
			"https://gitlab.com/group/project/",
			"https://gitlab.com/group/project/-/blob/main/file.rs",
			"https://gitlab.com/group/project/-/tree/main",
			"https://gitlab.com/group/project/-/tree/main/src",
			"https://gitlab.com/group/project/-/issues/12",
			"https://gitlab.com/group/project/-/issues/12-and-more",
			"https://gitlab.com/group/project/-/merge_requests/34",
		] {
			assert!(matches(&Url::parse(route).unwrap()), "{route}");
		}
		for route in [
			"https://example.com/group/project",
			"https://gitlab.com/group",
			"https://gitlab.com/group/project/commits/main",
			"https://gitlab.com/group/project/-/blob/main",
			"https://gitlab.com/group/project/-/tree",
			"https://gitlab.com/group/project/-/issues/nope",
			"https://gitlab.com/group/project/-/issues/1/extra",
			"https://gitlab.com/group/project/-/commits/main",
		] {
			assert!(!matches(&Url::parse(route).unwrap()), "{route}");
		}
	}

	#[test]
	fn preserves_encoded_path_components_like_pi() {
		let url = Url::parse(
			"https://gitlab.com/group%2Fsub/project%20name/-/blob/feature%2Fdocs/dir/guide%20one.md",
		)
		.unwrap();
		let target = parse(&url).unwrap();
		assert_eq!(target.namespace, "group%2Fsub");
		assert_eq!(target.project, "project%20name");
		assert!(matches!(target.kind, Kind::Blob));
		assert_eq!(target.reference.as_deref(), Some("feature%2Fdocs"));
		assert_eq!(target.path.as_deref(), Some("dir/guide%20one.md"));
	}

	#[tokio::test]
	async fn repository_renders_metadata_and_optional_readme() {
		let project = r#"{
			"name":"OMP","description":"Fast tools.","star_count":12345,"forks_count":67,
			"open_issues_count":8,"default_branch":"main","visibility":"public",
			"created_at":"2024-01-02T03:04:05Z","last_activity_at":"2025-06-07T08:09:10Z",
			"topics":["rust","agents"],"readme_url":"https://gitlab.com/group/project/-/raw/main/README.md"
		}"#;
		let client =
			FakeClient::new([Ok(response(200, project)), Ok(response(200, "# Welcome\n\nHello"))]);
		let url = Url::parse("https://gitlab.com/group/project").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# OMP\n\nFast tools.\n\n**Stars:** 12,345 · **Forks:** 67 · **Issues:** \
			 8\n**Visibility:** public · **Default Branch:** main\n**Topics:** rust, \
			 agents\n**Created:** 2024-01-02 · **Last Activity:** 2025-06-07\n\n---\n\n## \
			 README\n\n# Welcome\n\nHello"
		);
		assert_eq!(result.content_type.as_deref(), Some("text/markdown"));
		assert_eq!(result.method.as_str(), "gitlab-repo");
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		let requests = client.requests.lock();
		assert_eq!(requests.len(), 2);
		assert_eq!(requests[0].url.as_str(), "https://gitlab.com/api/v4/projects/group%2Fproject");
		assert_eq!(requests[1].url.as_str(), "https://gitlab.com/group/project/-/raw/main/README.md");
		assert!(
			requests
				.iter()
				.all(|request| request.max_bytes == MAX_BYTES)
		);
	}

	#[tokio::test]
	async fn optional_readme_failure_keeps_repository_metadata() {
		let project = r#"{
			"name":"Bare","star_count":0,"forks_count":0,"open_issues_count":0,
			"default_branch":null,"visibility":"private","created_at":"2024-01-02",
			"last_activity_at":"2024-01-03","readme_url":"https://gitlab.com/readme"
		}"#;
		let client = FakeClient::new([
			Ok(response(200, project)),
			Err(WebError::request("README transport failure")),
		]);
		let result = render(&client, &Url::parse("https://gitlab.com/g/p").unwrap())
			.await
			.unwrap()
			.unwrap();
		assert_eq!(
			result.content.as_str(),
			"# Bare\n\n**Stars:** 0 · **Forks:** 0 · **Issues:** 0\n**Visibility:** private · \
			 **Default Branch:** null\n**Created:** 2024-01-02 · **Last Activity:** 2024-01-03"
		);
	}

	#[tokio::test]
	async fn file_route_encodes_project_ref_and_path_and_returns_raw_text() {
		let client = FakeClient::new([
			Ok(response(200, r#"{"id":42}"#)),
			Ok(response(200, "fn main() {}\n\n\n")),
		]);
		let url = Url::parse(
			"https://gitlab.com/group%2Fsub/project%20name/-/blob/feature%2Fdocs/src/a%20b.rs",
		)
		.unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(result.content.as_str(), "fn main() {}");
		assert_eq!(result.content_type.as_deref(), Some("text/plain"));
		assert_eq!(result.method.as_str(), "gitlab-raw");
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		let requests = client.requests.lock();
		assert_eq!(
			requests[0].url.as_str(),
			"https://gitlab.com/api/v4/projects/group%252Fsub%2Fproject%2520name"
		);
		assert_eq!(
			requests[1].url.as_str(),
			"https://gitlab.com/api/v4/projects/42/repository/files/src%2Fa%2520b.rs/raw?ref=feature%2Fdocs"
		);
	}

	#[tokio::test]
	async fn tree_route_renders_directories_then_files_with_api_cap() {
		let tree = r#"[
			{"name":"src","type":"tree","path":"src","mode":"040000"},
			{"name":"Cargo.toml","type":"blob","path":"Cargo.toml","mode":"100644"},
			{"name":"tests","type":"tree","path":"tests","mode":"040000"},
			{"name":"README.md","type":"blob","path":"README.md","mode":"100644"}
		]"#;
		let client = FakeClient::new([Ok(response(200, r#"{"id":7}"#)), Ok(response(200, tree))]);
		let url =
			Url::parse("https://gitlab.com/g/p/-/tree/release%2Fnext/docs%20and%20guides").unwrap();
		let result = render(&client, &url).await.unwrap().unwrap();

		assert_eq!(
			result.content.as_str(),
			"# Directory: docs%20and%20guides\n\n**Ref:** release%2Fnext\n\n## Directories (2)\n\n- \
			 📁 src/\n- 📁 tests/\n\n## Files (2)\n\n- 📄 Cargo.toml\n- 📄 README.md"
		);
		assert_eq!(result.method.as_str(), "gitlab-tree");
		assert_eq!(result.diags.len(), 1);
		assert_eq!(result.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(result.diags[0].severity, Severity::Info);
		let requests = client.requests.lock();
		assert_eq!(
			requests[1].url.as_str(),
			"https://gitlab.com/api/v4/projects/7/repository/tree?ref=release%2Fnext&path=docs%20and%20guides&per_page=100"
		);
	}

	#[tokio::test]
	async fn root_tree_uses_empty_path_and_renders_root_heading() {
		let client = FakeClient::new([Ok(response(200, r#"{"id":9}"#)), Ok(response(200, "[]"))]);
		let result =
			render(&client, &Url::parse("https://gitlab.com/group/project/-/tree/main").unwrap())
				.await
				.unwrap()
				.unwrap();
		assert_eq!(result.content.as_str(), "# Directory: /\n\n**Ref:** main");
		assert_eq!(
			client.requests.lock()[1].url.as_str(),
			"https://gitlab.com/api/v4/projects/9/repository/tree?ref=main&path=&per_page=100"
		);
	}

	#[tokio::test]
	async fn unsupported_route_falls_back_without_http_requests() {
		let client = FakeClient::new(empty::<Result<HttpResponse, WebError>>());
		let result =
			render(&client, &Url::parse("https://gitlab.com/group/project/-/commits/main").unwrap())
				.await
				.unwrap();
		assert!(result.is_none());
		assert!(client.requests.lock().is_empty());
	}

	#[tokio::test]
	async fn malformed_api_responses_fall_back_without_rendering() {
		for response in [
			Ok(response(404, "not found")),
			Ok(response(200, "not json")),
			Err(WebError::request("offline")),
		] {
			let client = FakeClient::new([response]);
			let result = render(&client, &Url::parse("https://gitlab.com/group/project").unwrap())
				.await
				.unwrap();
			assert!(result.is_none());
		}
	}

	#[tokio::test]
	async fn missing_project_id_falls_back_before_content_api_call() {
		let client = FakeClient::new([Ok(response(200, r#"{"id":0}"#))]);
		let result = render(
			&client,
			&Url::parse("https://gitlab.com/group/project/-/blob/main/file.rs").unwrap(),
		)
		.await
		.unwrap();
		assert!(result.is_none());
		assert_eq!(client.requests.lock().len(), 1);
	}
}
