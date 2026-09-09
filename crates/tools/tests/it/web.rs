//! Network-free web pipeline and scraper contracts for `read`.
use std::{
	collections::VecDeque,
	fmt::Write as _,
	future::{Future, ready},
	io,
	sync::Arc,
};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_ar::zip::Writer;
use omp_core::{Str, sf};
use omp_tool::{
	BlobRef, CapsBase, DiagKind, Ev, IncomingParams, ModelClass, Part, PromptCaps, Severity, Tool,
	ToolTerminal, Unit,
};
use omp_tools::read::{
	self, DirectorySource, Fault, ReadBlobs, ReadLease, ReadSources, SnapshotRecord, SourceStat,
	StoredArtifact,
	web::{
		self,
		scrapers::{self, Scraper},
		types::{
			HttpClient, HttpRequest, HttpResponse, MAX_BYTES, MAX_OUTPUT_CHARS, RenderResult, WebError,
		},
	},
};
use parking_lot::Mutex;
use serde_json::json;
use smallvec::SmallVec;
use url::Url;

#[derive(Clone, Default)]
struct CannedHttp {
	responses: Arc<Mutex<VecDeque<Result<HttpResponse, WebError>>>>,
	requests:  Arc<Mutex<Vec<HttpRequest>>>,
}

impl CannedHttp {
	fn from_responses(responses: impl IntoIterator<Item = HttpResponse>) -> Self {
		Self {
			responses: Arc::new(Mutex::new(responses.into_iter().map(Ok).collect())),
			requests:  Arc::default(),
		}
	}

	fn from_results(responses: impl IntoIterator<Item = Result<HttpResponse, WebError>>) -> Self {
		Self {
			responses: Arc::new(Mutex::new(responses.into_iter().collect())),
			requests:  Arc::default(),
		}
	}

	fn requests(&self) -> Vec<HttpRequest> {
		self.requests.lock().clone()
	}
}

impl HttpClient for CannedHttp {
	fn get(
		&self,
		request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		self.requests.lock().push(request.clone());
		let result = self.responses.lock().pop_front().unwrap_or_else(|| {
			Err(WebError::request(format!("no canned response remains for {}", request.url)))
		});
		ready(result)
	}
}

#[derive(Clone)]
struct WebSources(CannedHttp);

#[derive(Clone)]
struct UnusedLease;

impl ReadLease for UnusedLease {
	fn revision(&self) -> &Str {
		panic!("web reads never open a local lease")
	}

	fn canonical_path(&self) -> &Str {
		panic!("web reads never open a local lease")
	}

	fn read_all(&self) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		ready(Err(Fault::source("web reads never open a local lease")))
	}
}

impl HttpClient for WebSources {
	fn get(
		&self,
		request: HttpRequest,
	) -> impl Future<Output = Result<HttpResponse, WebError>> + Send + '_ {
		self.0.get(request)
	}
}

impl ReadSources for WebSources {
	type Lease = UnusedLease;

	fn stat(&self, _path: Str) -> impl Future<Output = Result<SourceStat, Fault>> + Send + '_ {
		ready(Err(Fault::source("web fixture has no local paths")))
	}

	fn resolve_suffix(
		&self,
		_path: Str,
	) -> impl Future<Output = Result<Option<SourceStat>, Fault>> + Send + '_ {
		ready(Ok(None))
	}

	fn open(&self, _path: Str) -> impl Future<Output = Result<Self::Lease, Fault>> + Send + '_ {
		ready(Err(Fault::source("web fixture has no local paths")))
	}

	fn read_bytes(&self, _path: Str) -> impl Future<Output = Result<Bytes, Fault>> + Send + '_ {
		ready(Err(Fault::source("web fixture has no local paths")))
	}

	fn list_directory(
		&self,
		_path: Str,
		_max_depth: usize,
	) -> impl Future<Output = Result<DirectorySource, Fault>> + Send + '_ {
		ready(Err(Fault::source("web fixture has no local paths")))
	}

	fn record_snapshot(&self, _record: SnapshotRecord) -> Result<Option<Str>, Fault> {
		Ok(None)
	}
}

#[derive(Clone)]
struct NoBlobs;

impl ReadBlobs for NoBlobs {
	fn store(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_ {
		ready(Ok(BlobRef { hash: sf!("unused-web-blob"), media_type, byte_len: bytes.len() as u64 }))
	}

	fn store_artifact(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, Fault>> + Send + '_ {
		ready(Ok(StoredArtifact {
			blob: BlobRef { hash: sf!("unused-web-blob"), media_type, byte_len: bytes.len() as u64 },
			uri:  sf!("artifact://1"),
		}))
	}
}

async fn read_tool_text(path: &str, responses: impl IntoIterator<Item = HttpResponse>) -> String {
	let tool = read::tool(WebSources(CannedHttp::from_responses(responses)), NoBlobs);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(json!({ "path": path }).to_string()))
		.expect("read invocation remains live");
	let events = tool.call(params).collect::<Vec<_>>().await;
	let Some(Ev::Done(ToolTerminal::Done { result, .. })) = events.last() else {
		panic!("expected a terminal read event: {events:?}");
	};
	let parts = tool.prompt(
		result.as_ref(),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      16,
				maximum_text_bytes: u32::MAX,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	let [Part::Text { text }] = parts.as_slice() else {
		panic!("expected one model-facing web text part: {parts:?}");
	};
	text.to_string()
}

fn response(status: u16, content_type: &str, body: impl Into<Bytes>) -> HttpResponse {
	HttpResponse {
		final_url: sf!("https://fixture.invalid/final"),
		status,
		content_type: Some(Str::new(content_type)),
		headers: SmallVec::new(),
		body: body.into(),
	}
}

fn ok_json(body: &'static str) -> HttpResponse {
	response(200, "application/json", body)
}

fn png_fixture() -> Bytes {
	let mut output = io::Cursor::new(Vec::new());
	image::DynamicImage::new_rgba8(1, 1)
		.write_to(&mut output, image::ImageFormat::Png)
		.expect("encode PNG fixture");
	Bytes::from(output.into_inner())
}

fn zip_fixture() -> Bytes {
	let mut writer = Writer::new(Vec::new());
	writer
		.add_file("hello.txt", b"hello\n")
		.expect("add ZIP fixture member");
	Bytes::from(writer.finish().expect("finish ZIP fixture"))
}

fn sqlite_fixture() -> Bytes {
	let connection = rusqlite::Connection::open_in_memory().expect("open SQLite fixture");
	connection
		.execute_batch(
			"CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES \
			 ('alpha');",
		)
		.expect("populate SQLite fixture");
	let serialized = connection
		.serialize("main")
		.expect("serialize SQLite fixture");
	Bytes::copy_from_slice(&serialized)
}

fn assert_single_diag(rendered: &RenderResult, kind: DiagKind, severity: Severity) {
	assert_eq!(rendered.diags.len(), 1);
	let diag = &rendered.diags[0];
	assert_eq!(diag.native_kind(), Some(kind));
	assert_eq!(diag.severity, severity);
	assert_eq!(diag.continuation, None);
	assert_eq!(diag.artifact, None);
	assert_eq!(diag.omitted, None);
}

fn assert_github_api_request(request: &HttpRequest, expected_url: &str) {
	assert_eq!(request.url.as_str(), expected_url);
	assert_eq!(request.max_bytes, MAX_BYTES);
	assert_eq!(request.headers.len(), 2);
	assert_eq!(request.headers[0].0.as_str(), "Accept");
	assert_eq!(request.headers[0].1.as_str(), "application/vnd.github.v3+json");
	assert_eq!(request.headers[1].0.as_str(), "User-Agent");
	assert_eq!(request.headers[1].1.as_str(), concat!("omp/", env!("CARGO_PKG_VERSION")));
}

#[tokio::test]
async fn read_tool_frames_native_html_exactly() {
	let output = read_tool_text("https://example.test/", [
		response(
			200,
			"text/html",
			"<html><body><main><h1>Canned heading</h1><p>Canned paragraph with deliberately \
			 substantial prose so the native reader keeps the useful article instead of classifying \
			 this fixture as a JavaScript shell.</p></main></body></html>",
		),
		response(404, "text/plain", "no markdown suffix"),
		response(404, "text/plain", "no negotiated markdown"),
	])
	.await;
	assert_eq!(
		output,
		"URL: https://fixture.invalid/final\nContent-Type: text/html\nMethod: native\n\n---\n\n# \
		 Canned heading\n\nCanned paragraph with deliberately substantial prose so the native \
		 reader keeps the useful article instead of classifying this fixture as a JavaScript shell."
	);
}

#[tokio::test]
async fn raw_url_read_is_framed_but_not_numbered_or_html_shaped() {
	let output = read_tool_text("https://example.test/:raw", [response(
		200,
		"text/html",
		"<h1>raw &amp; literal</h1>",
	)])
	.await;
	assert_eq!(
		output,
		"URL: https://fixture.invalid/final\nContent-Type: text/html\nMethod: raw\n\n---\n\n<h1>raw \
		 &amp; literal</h1>"
	);
}

#[tokio::test]
async fn url_range_selectors_slice_the_complete_frame_with_standard_context() {
	let output = read_tool_text("https://example.test/:7-8", [response(
		200,
		"text/plain",
		"alpha\nbeta\ngamma\ndelta\nepsilon",
	)])
	.await;
	assert_eq!(output, "6:\n7:alpha\n8:beta\n9:gamma\n10:delta\n11:epsilon");
}

#[tokio::test]
async fn content_type_dispatch_is_observable_in_method_and_content() {
	let cases = [
		(
			"application/json",
			r#"{"alpha":1,"beta":[true]}"#,
			"json",
			"{\n  \"alpha\": 1,\n  \"beta\": [\n    true\n  ]\n}",
		),
		("text/plain", "canned plain text", "text", "canned plain text"),
		(
			"application/rtf",
			r"{\rtf1\ansi Canned RTF document\par}",
			"markit",
			"Canned RTF document",
		),
		(
			"application/atom+xml",
			"<feed><title>Canned feed</title><entry><title>Item</title><link href=\"https://example.test/item\"/><summary>Feed body</summary></entry></feed>",
			"feed",
			"# Canned feed",
		),
		(
			"application/x-ipynb+json",
			r##"{"nbformat":4,"nbformat_minor":5,"cells":[{"cell_type":"markdown","metadata":{},"source":["# Canned notebook"]}],"metadata":{}}"##,
			"notebook",
			"Canned notebook",
		),
	];
	for (content_type, body, method, expected) in cases {
		let rendered = web::read(
			&CannedHttp::from_responses([response(200, content_type, body)]),
			&Url::parse("https://example.test/data").expect("fixture URL parses"),
			false,
		)
		.await
		.expect("content dispatch succeeds");
		assert_eq!(rendered.method.as_str(), method, "{content_type}");
		assert!(
			rendered.content.contains(expected),
			"{content_type} output did not contain {expected:?}: {}",
			rendered.content
		);
	}
}

#[tokio::test]
async fn binary_content_types_take_their_specialized_dispatch_before_fallback() {
	for content_type in ["application/pdf", "application/zip", "application/vnd.sqlite3"] {
		let rendered = web::read(
			&CannedHttp::from_responses([response(200, content_type, "not a valid binary fixture")]),
			&Url::parse("https://example.test/download").expect("fixture URL parses"),
			false,
		)
		.await
		.expect("specialized dispatch falls back truthfully");
		assert_eq!(rendered.method.as_str(), "binary", "{content_type}");
		let prefix = format!("[Binary content: {content_type},");
		assert!(rendered.content.starts_with(prefix.as_str()));
		assert_single_diag(&rendered, DiagKind::Fallback, Severity::Warn);
	}
}

#[tokio::test]
async fn raw_binary_urls_keep_image_archive_and_sqlite_specialized_dispatch() {
	let image = web::read_resource(
		&CannedHttp::from_responses([response(200, "image/png", png_fixture())]),
		&Url::parse("https://example.test/image").expect("fixture URL parses"),
		true,
	)
	.await
	.expect("raw image dispatch succeeds");
	assert_eq!(
		image.render.content,
		"Read image file [image/webp]\n[Inspection: MIME image/webp; dimensions 1x1; channels 4; \
		 alpha yes]\n[Image: original 1x1, displayed at 200x200. Multiply coordinates by 0.01 to \
		 map to original image.]"
	);
	assert_eq!(image.render.content_type.as_deref(), Some("image/webp"));
	assert_eq!(image.render.method, "image");
	assert_single_diag(&image.render, DiagKind::Provenance, Severity::Info);
	let processed = image
		.image
		.expect("raw image retains processed media bytes");
	assert_eq!(processed.media_type, "image/webp");
	assert_eq!(processed.original_width, Some(1));
	assert_eq!(processed.original_height, Some(1));
	assert_eq!(processed.width, Some(200));
	assert_eq!(processed.height, Some(200));
	assert!(processed.was_resized);

	let archive = web::read(
		&CannedHttp::from_responses([response(200, "application/zip", zip_fixture())]),
		&Url::parse("https://example.test/archive").expect("fixture URL parses"),
		true,
	)
	.await
	.expect("raw archive dispatch succeeds");
	assert_eq!(archive.content, "hello.txt (6B)");
	assert_eq!(archive.content_type.as_deref(), Some("application/zip"));
	assert_eq!(archive.method, "archive");
	assert!(archive.diags.is_empty());

	let sqlite = web::read(
		&CannedHttp::from_responses([response(200, "application/vnd.sqlite3", sqlite_fixture())]),
		&Url::parse("https://example.test/database").expect("fixture URL parses"),
		true,
	)
	.await
	.expect("raw SQLite dispatch succeeds");
	assert_eq!(sqlite.content, "items (1 rows)");
	assert_eq!(sqlite.content_type.as_deref(), Some("application/vnd.sqlite3"));
	assert_eq!(sqlite.method, "sqlite");
	assert!(sqlite.diags.is_empty());
}

#[tokio::test]
async fn an_oversized_transport_response_is_rejected_at_the_fifty_mibibyte_boundary() {
	let oversized = Bytes::from(vec![b'x'; MAX_BYTES + 1]);
	let error = web::read(
		&CannedHttp::from_responses([response(200, "text/plain", oversized)]),
		&Url::parse("https://example.test/large").expect("fixture URL parses"),
		false,
	)
	.await
	.expect_err("the pure pipeline must distrust an oversized transport response");
	assert_eq!(error, WebError::ResponseTooLarge { max_bytes: MAX_BYTES });
	assert_eq!(error.to_string(), "response exceeds 52428800 bytes");
}

async fn assert_scrape(
	scraper: Scraper,
	target: &str,
	client: CannedHttp,
	method: &str,
	content: &str,
) -> RenderResult {
	let url = Url::parse(target).expect("fixture URL parses");
	let rendered = scraper
		.render(&client, &url)
		.await
		.expect("scraper succeeds")
		.unwrap_or_else(|| panic!("{scraper:?} accepted the URL but declined its canned response"));
	assert_eq!(rendered.method.as_str(), method, "{scraper:?}");
	assert!(
		rendered.content.contains(content),
		"{scraper:?} output did not contain {content:?}: {}",
		rendered.content
	);
	rendered
}

#[test]
fn registry_matching_and_first_match_precedence_are_explicit() {
	assert_eq!(Scraper::ALL, [
		Scraper::GitHubGist,
		Scraper::GitHub,
		Scraper::GitLab,
		Scraper::LongTail,
		Scraper::YouTube,
		Scraper::Twitter,
		Scraper::HackerNews,
		Scraper::Reddit,
		Scraper::StackOverflow,
		Scraper::Mdn,
		Scraper::DocsRs,
		Scraper::Npm,
		Scraper::PyPi,
		Scraper::CratesIo,
		Scraper::HuggingFace,
		Scraper::Arxiv,
		Scraper::Wikipedia,
	]);

	let matches = [
		("https://gist.github.com/ada/deadbeef", Scraper::GitHubGist),
		("https://github.com/owner/repo", Scraper::GitHub),
		("https://gitlab.com/group/project", Scraper::GitLab),
		("https://youtu.be/dQw4w9WgXcQ", Scraper::YouTube),
		("https://x.com/ada/status/123", Scraper::Twitter),
		("https://news.ycombinator.com/item?id=1", Scraper::HackerNews),
		("https://www.reddit.com/r/rust/comments/abc/topic/", Scraper::Reddit),
		("https://stackoverflow.com/questions/42/example", Scraper::StackOverflow),
		("https://developer.mozilla.org/en-US/docs/Web/Rust", Scraper::Mdn),
		("https://docs.rs/demo/1.0.0/demo/index.html", Scraper::DocsRs),
		("https://www.npmjs.com/package/demo", Scraper::Npm),
		("https://pypi.org/project/demo/", Scraper::PyPi),
		("https://crates.io/crates/demo", Scraper::CratesIo),
		("https://huggingface.co/owner/model", Scraper::HuggingFace),
		("https://arxiv.org/abs/2401.12345", Scraper::Arxiv),
		("https://en.wikipedia.org/wiki/Rust_(programming_language)", Scraper::Wikipedia),
	];
	for (target, expected) in matches {
		let url = Url::parse(target).expect("fixture URL parses");
		assert_eq!(scrapers::scraper_for(&url), Some(expected), "{target}");
	}

	for target in [
		"https://github.com/owner",
		"https://docs.rs/crate/demo",
		"https://developer.mozilla.org/en-US/blog/",
		"https://example.com/",
	] {
		let url = Url::parse(target).expect("fixture URL parses");
		assert_eq!(scrapers::scraper_for(&url), None, "{target}");
	}
}

#[tokio::test]
async fn a_matching_scraper_decline_preserves_plain_fetch_fallback() {
	let rendered = web::read(
		&CannedHttp::from_responses([
			// The Actions scraper probes the workflows API first; its decline
			// must fall back to an ordinary fetch of the authored URL.
			response(404, "application/json", r#"{"message":"Not Found"}"#),
			response(200, "text/plain", "ordinary fetch after scraper decline"),
		]),
		&Url::parse("https://github.com/owner/repo/actions").expect("fixture URL parses"),
		false,
	)
	.await
	.expect("plain fetch remains available after a matching scraper declines");
	assert_eq!(rendered.method.as_str(), "text");
	assert_eq!(rendered.content.as_str(), "ordinary fetch after scraper decline");
}

#[tokio::test]
async fn git_hosting_scrapers_render_canned_public_api_content() {
	assert_scrape(
		Scraper::GitHubGist,
		"https://gist.github.com/ada/deadbeef",
		CannedHttp::from_responses([ok_json(
			r#"{"description":"Canned gist","owner":{"login":"ada"},"created_at":"2024-01-01","updated_at":"2024-01-02","files":{"demo.rs":{"filename":"demo.rs","language":"Rust","content":"fn canned() {}"}}}"#,
		)]),
		"github-gist",
		"fn canned() {}",
	)
	.await;

	assert_scrape(
		Scraper::GitHub,
		"https://github.com/owner/repo/blob/main/demo.txt",
		CannedHttp::from_responses([response(200, "text/plain", "canned github raw")]),
		"github-raw",
		"canned github raw",
	)
	.await;

	assert_scrape(
		Scraper::GitLab,
		"https://gitlab.com/group/project",
		CannedHttp::from_responses([ok_json(
			r#"{"name":"Canned GitLab","description":"fixture project","star_count":7,"forks_count":2,"open_issues_count":1,"default_branch":"main","visibility":"public","created_at":"2024-01-01T00:00:00Z","last_activity_at":"2024-01-02T00:00:00Z","topics":["rust"],"readme_url":null}"#,
		)]),
		"gitlab-repo",
		"# Canned GitLab",
	)
	.await;
}

#[tokio::test]
async fn github_gist_parity_is_exact_for_anonymous_ordered_files_and_request() {
	let client = CannedHttp::from_responses([ok_json(
		r#"{"description":null,"created_at":"2024-01-01T01:02:03Z","updated_at":"2024-01-02T04:05:06Z","files":{"10":{"filename":"ten.txt","language":null,"content":"ten"},"2":{"filename":"two.txt","language":null,"content":"two"},"z.txt":{"filename":"z.txt","language":null,"content":"zeta"},"a.rs":{"filename":"a.rs","language":"Rust","content":"fn alpha() {}"}}}"#,
	)]);
	let rendered = Scraper::GitHubGist
		.render(
			&client,
			&Url::parse("https://gist.github.com/DEADBEEF?file=a.rs#file-a-rs")
				.expect("fixture URL parses"),
		)
		.await
		.expect("gist scraper succeeds")
		.expect("anonymous gist is rendered");

	assert_eq!(rendered.method.as_str(), "github-gist");
	assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	assert_eq!(
		rendered.content.as_str(),
		"# Gist by anonymous\n\n**Created:** 2024-01-01T01:02:03Z · **Updated:** \
		 2024-01-02T04:05:06Z\n**Files:** 4\n\n---\n\n## two.txt\n\n```\ntwo\n```\n\n---\n\n## \
		 ten.txt\n\n```\nten\n```\n\n---\n\n## z.txt\n\n```\nzeta\n```\n\n---\n\n## \
		 a.rs\n\n```rust\nfn alpha() {}\n```"
	);

	let requests = client.requests();
	assert_eq!(requests.len(), 1);
	assert_github_api_request(&requests[0], "https://api.github.com/gists/DEADBEEF");
}

#[tokio::test]
async fn github_repo_metadata_tree_readme_and_request_order_match_pi() {
	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"full_name":"owner/repo","description":"Repository summary","stargazers_count":7,"forks_count":2,"open_issues_count":3,"default_branch":"main","language":"Rust","license":{"name":"MIT"}}"#,
		),
		ok_json(
			r#"{"tree":[{"path":"src","type":"tree"},{"path":"src/lib.rs","type":"blob"},{"path":"README.md","type":"blob"}]}"#,
		),
		ok_json(r#"{"content":"IyBSRUFETUUKCmJvZHk=","encoding":"base64"}"#),
	]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/?tab=readme#readme")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub scraper succeeds")
		.expect("repository is rendered");

	assert_eq!(rendered.method.as_str(), "github-repo");
	assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	assert_eq!(
		rendered.content.as_str(),
		"# owner/repo\n\nRepository summary\n\nStars: 7 · Forks: 2 · Issues: 3\nLanguage: \
		 Rust\nLicense: MIT\n\n---\n\n## Files\n\n```\n[dir] src\n      src/lib.rs\n      \
		 README.md\n```\n\n## README\n\n# README\n\nbody"
	);

	let requests = client.requests();
	assert_eq!(requests.len(), 3);
	assert_github_api_request(&requests[0], "https://api.github.com/repos/owner/repo");
	assert_github_api_request(
		&requests[1],
		"https://api.github.com/repos/owner/repo/git/trees/main?recursive=1",
	);
	assert_github_api_request(&requests[2], "https://api.github.com/repos/owner/repo/readme");
}

#[tokio::test]
async fn github_tree_sorts_directory_first_and_renders_raw_readme_exactly() {
	let client = CannedHttp::from_responses([
		ok_json(r#"{"full_name":"owner/repo","default_branch":"main"}"#),
		ok_json(
			r#"[{"name":"z.txt","type":"file","size":0},{"name":"README.MD","type":"file","size":12},{"name":"adir","type":"dir","size":999},{"name":"link","type":"symlink","size":8}]"#,
		),
		response(200, "text/plain", "# Directory README\n\ncontents"),
	]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/tree/feature/src?plain=1#files")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub tree scraper succeeds")
		.expect("tree is rendered");

	assert_eq!(rendered.method.as_str(), "github-tree");
	assert_eq!(
		rendered.content.as_str(),
		"# owner/repo/src\n\n**Branch:** feature\n\n## Contents\n\n```\n[dir] adir\n      \
		 link\n      README.MD (12 bytes)\n      z.txt\n```\n\n---\n\n## README\n\n# Directory \
		 README\n\ncontents"
	);
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);

	let requests = client.requests();
	assert_eq!(requests.len(), 3);
	assert_github_api_request(&requests[0], "https://api.github.com/repos/owner/repo");
	assert_github_api_request(
		&requests[1],
		"https://api.github.com/repos/owner/repo/contents/src?ref=feature",
	);
	assert_eq!(
		requests[2],
		HttpRequest::new("https://raw.githubusercontent.com/owner/repo/feature/src/README.MD")
	);
}

#[tokio::test]
async fn github_blob_preserves_encoded_path_and_reports_canonical_raw_request() {
	let client = CannedHttp::from_responses([response(200, "text/plain", "raw body")]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/blob/main/dir/space%20name.txt?raw=1#L2")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub blob scraper succeeds")
		.expect("blob is rendered");

	assert_eq!(rendered.method.as_str(), "github-raw");
	assert_eq!(rendered.content_type.as_deref(), Some("text/plain"));
	assert_eq!(rendered.content.as_str(), "raw body");
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	assert_eq!(client.requests(), [HttpRequest::new(
		"https://raw.githubusercontent.com/owner/repo/main/dir/space%20name.txt"
	)]);
}

#[tokio::test]
async fn github_issue_comments_paginate_and_render_in_api_order_exactly() {
	let first_page = (1..=100)
		.map(|number| {
			json!({
				"user": { "login": format!("user-{number:03}") },
				"created_at": format!("2024-01-{number:03}"),
				"body": format!("body-{number:03}"),
			})
		})
		.collect::<Vec<_>>();
	let second_page = [json!({
		"user": { "login": "user-101" },
		"created_at": "2024-01-101",
		"body": "body-101",
	})];
	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"title":"Ordered comments","number":42,"state":"open","user":{"login":"author"},"created_at":"2024-01-01","updated_at":"2024-02-01","body":"Issue body","labels":[{"name":"bug"},{"name":"help wanted"}],"comments":101}"#,
		),
		response(
			200,
			"application/json",
			serde_json::to_vec(&first_page).expect("first comments page serializes"),
		),
		response(
			200,
			"application/json",
			serde_json::to_vec(&second_page).expect("second comments page serializes"),
		),
	]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/issues/42?notification_referrer_id=x")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub issue scraper succeeds")
		.expect("issue is rendered");

	let mut expected = String::from(
		"# Ordered comments\n\n**#42** · open · opened by @author\nCreated: 2024-01-01 · Updated: \
		 2024-02-01\nLabels: bug, help wanted\n\n---\n\nIssue body\n\n---\n\n## Comments (101)\n\n",
	);
	for number in 1..=101 {
		write!(
			expected,
			"### @user-{number:03} · 2024-01-{number:03}\n\nbody-{number:03}\n\n---\n\n"
		)
		.expect("writing to a String cannot fail");
	}
	assert_eq!(rendered.content.as_str(), expected.trim());
	assert_eq!(rendered.method.as_str(), "github-issue");
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);

	let requests = client.requests();
	assert_eq!(requests.len(), 3);
	assert_github_api_request(&requests[0], "https://api.github.com/repos/owner/repo/issues/42");
	assert_github_api_request(
		&requests[1],
		"https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=1",
	);
	assert_github_api_request(
		&requests[2],
		"https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2",
	);
}

#[tokio::test]
async fn github_commit_metadata_and_diff_fallback_match_pi_exactly() {
	let client = CannedHttp::from_responses([ok_json(
		r#"{"sha":"abcdef1234567890","commit":{"message":"Commit subject\n\nCommit body","author":{"name":"Grace","date":""}},"author":{"login":""},"parents":[{"sha":"0123456789abcdef"}],"stats":{"additions":3,"deletions":2},"files":[{"filename":"new.bin","previous_filename":"","status":"modified","additions":3,"deletions":2,"patch":""}]}"#,
	)]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/commit/abcdef1234567890")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub commit scraper succeeds")
		.expect("commit is rendered");

	assert_eq!(rendered.method.as_str(), "github-commit");
	assert_eq!(
		rendered.content.as_str(),
		"# Commit subject\n\n**abcdef123456** · authored by Grace\n1 file changed · +3 −2\nParents: \
		 0123456789ab\n\nCommit body\n\n---\n\n## Files (1)\n\n### new.bin\n\nmodified · +3 \
		 −2\n\n*No textual diff (binary or too large).*"
	);
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	let requests = client.requests();
	assert_eq!(requests.len(), 1);
	assert_github_api_request(
		&requests[0],
		"https://api.github.com/repos/owner/repo/commits/abcdef1234567890",
	);
}

#[tokio::test]
async fn github_pull_and_open_issue_list_methods_and_order_match_pi() {
	let pull_client = CannedHttp::from_responses([ok_json(
		r#"{"title":"Pull title","number":7,"state":"closed","user":{"login":"ada"},"created_at":"2024-01-01","updated_at":"2024-01-02","body":null,"labels":[],"comments":0}"#,
	)]);
	let pull = Scraper::GitHub
		.render(
			&pull_client,
			&Url::parse("https://github.com/owner/repo/pull/7/files").expect("fixture URL parses"),
		)
		.await
		.expect("GitHub pull scraper succeeds")
		.expect("pull is rendered");
	assert_eq!(pull.method.as_str(), "github-pr");
	assert_eq!(
		pull.content.as_str(),
		"# Pull title\n\n**#7** · closed · opened by @ada\nCreated: 2024-01-01 · Updated: \
		 2024-01-02\n\n---\n\n*No description provided.*\n\n---"
	);
	let requests = pull_client.requests();
	assert_eq!(requests.len(), 1);
	assert_github_api_request(&requests[0], "https://api.github.com/repos/owner/repo/pulls/7");

	let issues_client = CannedHttp::from_responses([ok_json(
		r#"[{"number":8,"title":"A pull","user":{"login":"grace"},"created_at":"2024-01-03","comments":2,"labels":[],"pull_request":{"url":"ignored"}},{"number":9,"title":"First issue","user":{"login":"ada"},"created_at":"2024-01-04","comments":1,"labels":[{"name":"bug"},{"name":"P1"}]},{"number":10,"title":"Second issue","user":{"login":"lin"},"created_at":"2024-01-05","comments":0,"labels":[] }]"#,
	)]);
	let issues = Scraper::GitHub
		.render(
			&issues_client,
			&Url::parse("https://github.com/owner/repo/issues").expect("fixture URL parses"),
		)
		.await
		.expect("GitHub issue-list scraper succeeds")
		.expect("issue list is rendered");
	assert_eq!(issues.method.as_str(), "github-issues");
	assert_eq!(
		issues.content.as_str(),
		"# owner/repo - Open Issues\n\n- **#9** First issue [bug, P1]\n  by @ada · 1 comments · \
		 2024-01-04\n\n- **#10** Second issue\n  by @lin · 0 comments · 2024-01-05"
	);
	let requests = issues_client.requests();
	assert_eq!(requests.len(), 1);
	assert_github_api_request(
		&requests[0],
		"https://api.github.com/repos/owner/repo/issues?state=open&per_page=30",
	);
}

#[tokio::test]
async fn github_repository_file_listing_uses_pi_hundred_entry_limit() {
	let tree = (0..101)
		.map(|number| json!({ "path": format!("file-{number:03}"), "type": "blob" }))
		.collect::<Vec<_>>();
	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"full_name":"owner/repo","description":null,"stargazers_count":0,"forks_count":0,"open_issues_count":0,"default_branch":"main","language":null,"license":null}"#,
		),
		response(
			200,
			"application/json",
			serde_json::to_vec(&json!({ "tree": tree })).expect("tree serializes"),
		),
		response(404, "application/json", "{}"),
	]);
	let rendered = Scraper::GitHub
		.render(&client, &Url::parse("https://github.com/owner/repo").expect("fixture URL parses"))
		.await
		.expect("GitHub repo scraper succeeds")
		.expect("repository is rendered");

	let mut expected =
		String::from("# owner/repo\n\nStars: 0 · Forks: 0 · Issues: 0\n\n---\n\n## Files\n\n```\n");
	for number in 0..100 {
		writeln!(expected, "      file-{number:03}").expect("writing to a String cannot fail");
	}
	expected.push_str("[…1 files elided…]\n```");
	assert_eq!(rendered.content.as_str(), expected);
}

#[tokio::test]
async fn github_raw_output_uses_shared_character_limit_and_diag_order() {
	let client =
		CannedHttp::from_responses([response(200, "text/plain", "x".repeat(MAX_OUTPUT_CHARS + 1))]);
	let rendered = Scraper::GitHub
		.render(
			&client,
			&Url::parse("https://github.com/owner/repo/blob/main/large.txt")
				.expect("fixture URL parses"),
		)
		.await
		.expect("GitHub blob scraper succeeds")
		.expect("blob is rendered");

	assert_eq!(rendered.content.chars().count(), MAX_OUTPUT_CHARS);
	assert!(rendered.content.chars().all(|character| character == 'x'));
	assert_eq!(rendered.diags.len(), 2);
	let provenance = &rendered.diags[0];
	assert_eq!(provenance.native_kind(), Some(DiagKind::Provenance));
	assert_eq!(provenance.severity, Severity::Info);
	assert_eq!(provenance.continuation, None);
	assert_eq!(provenance.artifact, None);
	assert_eq!(provenance.omitted, None);
	let bounded = &rendered.diags[1];
	assert_eq!(bounded.native_kind(), Some(DiagKind::OutputBounded));
	assert_eq!(bounded.severity, Severity::Warn);
	assert_eq!(bounded.continuation, None);
	assert_eq!(bounded.artifact, None);
	let omitted = bounded.omitted.as_ref().expect("truncation count is typed");
	assert_eq!(omitted.count, 1);
	assert_eq!(omitted.unit, Unit::Chars);
}

#[tokio::test]
async fn github_and_gist_failures_decline_without_inventing_content() {
	let unsupported = CannedHttp::default();
	let result = Scraper::GitHub
		.render(
			&unsupported,
			&Url::parse("https://github.com/owner/repo/releases/latest").expect("fixture URL parses"),
		)
		.await
		.expect("unsupported repository page cleanly declines");
	assert!(result.is_none());
	assert!(unsupported.requests().is_empty());

	for client in [
		CannedHttp::from_results([Err(WebError::request("offline"))]),
		CannedHttp::from_responses([response(404, "application/json", "{}")]),
		CannedHttp::from_responses([response(200, "application/json", "{not json")]),
	] {
		let result = Scraper::GitHubGist
			.render(
				&client,
				&Url::parse("https://gist.github.com/deadbeef").expect("fixture URL parses"),
			)
			.await
			.expect("anonymous API failure is a scraper miss");
		assert!(result.is_none());
		assert_eq!(client.requests().len(), 1);
	}

	for client in [
		CannedHttp::from_results([Err(WebError::request("offline"))]),
		CannedHttp::from_responses([response(404, "application/json", "{}")]),
		CannedHttp::from_responses([response(200, "application/json", "{not json")]),
	] {
		let result = Scraper::GitHub
			.render(&client, &Url::parse("https://github.com/owner/repo").expect("fixture URL parses"))
			.await
			.expect("repository API failure is a scraper miss");
		assert!(result.is_none());
		assert_eq!(client.requests().len(), 1);
	}

	let invalid_gist = CannedHttp::default();
	let result = Scraper::GitHubGist
		.render(
			&invalid_gist,
			&Url::parse("https://gist.github.com/owner/not-a-gist").expect("fixture URL parses"),
		)
		.await
		.expect("invalid gist URL cleanly declines");
	assert!(result.is_none());
	assert!(invalid_gist.requests().is_empty());
}

#[tokio::test]
async fn media_social_and_news_scrapers_render_canned_responses() {
	assert_scrape(
		Scraper::YouTube,
		"https://youtu.be/dQw4w9WgXcQ",
		CannedHttp::from_responses([response(
			200,
			"text/html",
			r#"<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"Canned video","author":"Ada","shortDescription":"fixture description","lengthSeconds":"42","viewCount":"7"}};</script>"#,
		)]),
		"youtube",
		"# Canned video",
	)
	.await;

	let mut nitter = String::from(
		r#"<article><a class="fullname">Ada</a><a class="username">@ada</a><div class="tweet-content">canned tweet body</div></article>"#,
	);
	nitter.push_str(&" ".repeat(600));
	assert_scrape(
		Scraper::Twitter,
		"https://x.com/ada/status/123",
		CannedHttp::from_responses([response(200, "text/html", nitter)]),
		"twitter-nitter",
		"canned tweet body",
	)
	.await;

	assert_scrape(
		Scraper::HackerNews,
		"https://news.ycombinator.com/item?id=1",
		CannedHttp::from_responses([ok_json(
			r#"{"id":1,"by":"ada","time":1700000000,"score":7,"title":"Canned HN story","url":"https://example.com/story","descendants":0}"#,
		)]),
		"hackernews",
		"# Canned HN story",
	)
	.await;

	assert_scrape(
		Scraper::Reddit,
		"https://www.reddit.com/r/rust/comments/abc/topic/",
		CannedHttp::from_responses([ok_json(
			r#"[{"data":{"children":[{"data":{"title":"Canned Reddit post","subreddit":"rust","author":"ada","score":7,"num_comments":0,"created_utc":1700000000,"selftext":"canned reddit body","is_self":true}}]}},{"data":{"children":[]}}]"#,
		)]),
		"reddit",
		"canned reddit body",
	)
	.await;
}

#[tokio::test]
async fn developer_documentation_scrapers_render_canned_api_responses() {
	assert_scrape(
		Scraper::StackOverflow,
		"https://stackoverflow.com/questions/42/example",
		CannedHttp::from_responses([
			ok_json(
				r#"{"items":[{"title":"Canned Stack Overflow question","body":"<p>question body</p>","score":7,"owner":{"display_name":"Ada"},"creation_date":1700000000,"tags":["rust"],"answer_count":1,"is_answered":true}]}"#,
			),
			ok_json(
				r#"{"items":[{"body":"<p>canned accepted answer</p>","score":9,"is_accepted":true,"owner":{"display_name":"Grace"}}]}"#,
			),
		]),
		"stackexchange",
		"canned accepted answer",
	)
	.await;

	assert_scrape(
		Scraper::Mdn,
		"https://developer.mozilla.org/en-US/docs/Web/Rust",
		CannedHttp::from_responses([ok_json(
			r#"{"doc":{"title":"Canned MDN page","summary":"<p>summary</p>","body":[{"type":"prose","value":{"title":"Usage","content":"<p>canned MDN prose</p>"}}]}}"#,
		)]),
		"mdn",
		"canned MDN prose",
	)
	.await;

	assert_scrape(
		Scraper::DocsRs,
		"https://docs.rs/demo/1.0.0/demo/index.html",
		CannedHttp::from_responses([ok_json(
			r#"{"root":0,"index":{"0":{"name":"demo","docs":"Canned rustdoc module","inner":{"module":{"items":[]}}}},"paths":{},"format_version":37}"#,
		)]),
		"docs.rs",
		"Canned rustdoc module",
	)
	.await;
}

#[tokio::test]
async fn package_registry_scrapers_render_canned_api_responses() {
	assert_scrape(
		Scraper::Npm,
		"https://www.npmjs.com/package/demo",
		CannedHttp::from_responses([
			ok_json(r#"{"name":"canned-npm","version":"1.2.3","description":"fixture npm package","license":"MIT","readme":"canned npm readme"}"#),
			ok_json(r#"{"downloads":1234}"#),
		]),
		"npm",
		"canned npm readme",
	)
	.await;

	assert_scrape(
		Scraper::PyPi,
		"https://pypi.org/project/demo/",
		CannedHttp::from_responses([
			ok_json(r#"{"info":{"name":"canned-pypi","version":"1.2.3","summary":"fixture PyPI package","description":"canned PyPI description"},"requires_dist":[]}"#),
			ok_json(r#"{"data":{"last_week":1234}}"#),
		]),
		"pypi",
		"canned PyPI description",
	)
	.await;

	assert_scrape(
		Scraper::CratesIo,
		"https://crates.io/crates/demo",
		CannedHttp::from_responses([
			ok_json(r#"{"crate":{"name":"canned-crate","description":"fixture crate","downloads":1200,"recent_downloads":7,"max_version":"1.2.3","repository":null,"homepage":null,"documentation":null,"categories":[],"keywords":[]},"versions":[]}"#),
			response(404, "text/plain", "missing readme"),
		]),
		"crates.io",
		"# canned-crate",
	)
	.await;
}

#[tokio::test]
async fn port_npm_scraper_parity() {
	for target in [
		"https://www.npmjs.com/package/canned",
		"https://npmjs.com/package/canned/v/9.9.9",
		"https://www.npmjs.com/package/@scope/canned",
		"https://www.npmjs.com/package/%40scope%2Fcanned/v/9.9.9",
	] {
		assert!(Scraper::Npm.matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
	}
	for target in [
		"https://example.com/package/canned",
		"https://www.npmjs.com/packages/canned",
		"https://www.npmjs.com/package/",
		"https://www.npmjs.com/package/%GG",
	] {
		assert!(!Scraper::Npm.matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
	}

	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"name":"@scope/canned","version":"1.2.3","description":"fixture npm package","license":"MIT","homepage":"https://npm.example/pkg","repository":{"url":"git+https://github.com/example/pkg.git"},"keywords":["alpha","beta"],"maintainers":[{"name":"Ada"},{"name":"Grace"}],"dependencies":{"dep-a":"^1","dep-b":"~2"},"readme":"canned npm readme"}"#,
		),
		ok_json(r#"{"downloads":1234}"#),
	]);
	let rendered = Scraper::Npm
		.render(
			&client,
			&Url::parse("https://www.npmjs.com/package/@scope/canned/v/9.9.9")
				.expect("fixture URL parses"),
		)
		.await
		.expect("npm scraper succeeds")
		.expect("npm package is rendered");
	assert_eq!(rendered.method.as_str(), "npm");
	assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
	assert_eq!(
		rendered.content.as_str(),
		"# @scope/canned\n\nfixture npm package\n\n**Latest:** 1.2.3 · **License:** \
		 MIT\n**Weekly Downloads:** 1.2K\n\n**Homepage:** https://npm.example/pkg\n**Repository:** \
		 https://github.com/example/pkg\n**Keywords:** alpha, beta\n**Maintainers:** Ada, \
		 Grace\n\n## Dependencies\n\n- dep-a: ^1\n- dep-b: ~2\n\n---\n\n## README\n\ncanned npm \
		 readme"
	);
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	assert_eq!(
		client
			.requests()
			.iter()
			.map(|request| request.url.as_str())
			.collect::<Vec<_>>(),
		[
			"https://registry.npmjs.org/@scope/canned/latest",
			"https://api.npmjs.org/downloads/point/last-week/%40scope%2Fcanned",
		]
	);

	let without_downloads = Scraper::Npm
		.render(
			&CannedHttp::from_responses([
				ok_json(r#"{"name":"canned","version":"1.0.0"}"#),
				response(503, "application/json", "{}"),
			]),
			&Url::parse("https://www.npmjs.com/package/canned").expect("fixture URL parses"),
		)
		.await
		.expect("download-count HTTP errors are optional")
		.expect("npm metadata still renders");
	assert_eq!(without_downloads.content.as_str(), "# canned\n\n**Latest:** 1.0.0");

	let missing = Scraper::Npm
		.render(
			&CannedHttp::from_responses([
				response(404, "application/json", "{}"),
				ok_json(r#"{"downloads":1234}"#),
			]),
			&Url::parse("https://www.npmjs.com/package/canned").expect("fixture URL parses"),
		)
		.await
		.expect("HTTP errors are scraper fallbacks");
	assert_eq!(missing, None);
}

#[tokio::test]
async fn port_pypi_scraper_parity() {
	for target in [
		"https://pypi.org/project/canned/",
		"https://www.pypi.org/project/canned/9.9.9/",
		"https://pypi.org/project/canned%2Dpkg/",
	] {
		assert!(Scraper::PyPi.matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
	}
	for target in [
		"https://example.com/project/canned/",
		"https://pypi.org/projects/canned/",
		"https://pypi.org/project/",
		"https://pypi.org/project/%GG/",
	] {
		assert!(!Scraper::PyPi.matches(&Url::parse(target).expect("fixture URL parses")), "{target}");
	}

	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"info":{"name":"canned-pkg","version":"1.2.3","summary":"fixture PyPI package","description":"canned PyPI description","author":"Ada","author_email":"ada@example.test","license":"MIT","home_page":"https://pypi.example/pkg","project_urls":{"Source":"https://git.example/pkg","Docs":"https://docs.example/pkg"},"requires_python":">=3.11","keywords":"alpha beta"},"requires_dist":["dep-a>=1","dep-b~=2"]}"#,
		),
		ok_json(r#"{"data":{"last_week":1234}}"#),
	]);
	let rendered = Scraper::PyPi
		.render(
			&client,
			&Url::parse("https://pypi.org/project/canned%2Dpkg/9.9.9/").expect("fixture URL parses"),
		)
		.await
		.expect("PyPI scraper succeeds")
		.expect("PyPI package is rendered");
	assert_eq!(rendered.method.as_str(), "pypi");
	assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
	assert_eq!(
		rendered.content.as_str(),
		"# canned-pkg\n\nfixture PyPI package\n\n**Latest:** 1.2.3 · **License:** \
		 MIT\n**Weekly Downloads:** 1.2K\n\n**Author:** Ada <ada@example.test>\n**Python:** \
		 >=3.11\n**Homepage:** https://pypi.example/pkg\n\n**Project URLs:**\n- Source: \
		 https://git.example/pkg\n- Docs: https://docs.example/pkg\n\n**Keywords:** alpha beta\n\n## \
		 Dependencies\n\n- dep-a>=1\n- dep-b~=2\n\n---\n\n## Description\n\ncanned PyPI description"
	);
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	assert_eq!(
		client
			.requests()
			.iter()
			.map(|request| request.url.as_str())
			.collect::<Vec<_>>(),
		[
			"https://pypi.org/pypi/canned-pkg/json",
			"https://pypistats.org/api/packages/canned-pkg/recent",
		]
	);

	let without_downloads = Scraper::PyPi
		.render(
			&CannedHttp::from_responses([
				ok_json(r#"{"info":{"name":"canned","version":"1.0.0"},"requires_dist":[]}"#),
				response(503, "application/json", "{}"),
			]),
			&Url::parse("https://pypi.org/project/canned/").expect("fixture URL parses"),
		)
		.await
		.expect("download-count HTTP errors are optional")
		.expect("PyPI metadata still renders");
	assert_eq!(without_downloads.content.as_str(), "# canned\n\n**Latest:** 1.0.0");

	let malformed = Scraper::PyPi
		.render(
			&CannedHttp::from_responses([ok_json("{"), response(503, "application/json", "{}")]),
			&Url::parse("https://pypi.org/project/canned/").expect("fixture URL parses"),
		)
		.await
		.expect("invalid API JSON is a scraper fallback");
	assert_eq!(malformed, None);
}

#[tokio::test]
async fn port_crates_io_scraper_parity() {
	for target in [
		"https://crates.io/crates/canned-crate",
		"https://www.crates.io/crates/canned-crate/9.9.9",
		"https://crates.io/crates/%63anned-crate",
	] {
		assert!(
			Scraper::CratesIo.matches(&Url::parse(target).expect("fixture URL parses")),
			"{target}"
		);
	}
	for target in [
		"https://example.com/crates/canned-crate",
		"https://crates.io/crate/canned-crate",
		"https://crates.io/crates/",
		"https://crates.io/crates/%GG",
	] {
		assert!(
			!Scraper::CratesIo.matches(&Url::parse(target).expect("fixture URL parses")),
			"{target}"
		);
	}

	let readme = "This canned README is deliberately longer than one hundred UTF-16 code units so \
	              the docs.rs lookup accepts it as useful package documentation in this \
	              deterministic fixture.";
	let client = CannedHttp::from_responses([
		ok_json(
			r#"{"crate":{"name":"canned-crate","description":"fixture crate","downloads":1234,"recent_downloads":7,"max_version":"1.2.3","repository":"https://git.example/pkg","homepage":"https://home.example/pkg","documentation":"https://docs.example/pkg","categories":["development-tools"],"keywords":["alpha","beta"]},"versions":[{"num":"1.2.3","downloads":2500,"created_at":"2024-01-02T03:04:05Z","license":"MIT","rust_version":"1.75"}]}"#,
		),
		response(200, "text/markdown", readme),
	]);
	let rendered = Scraper::CratesIo
		.render(
			&client,
			&Url::parse("https://crates.io/crates/canned-crate/9.9.9").expect("fixture URL parses"),
		)
		.await
		.expect("crates.io scraper succeeds")
		.expect("crate is rendered");
	assert_eq!(rendered.method.as_str(), "crates.io");
	assert_eq!(rendered.content_type.as_deref(), Some("text/markdown"));
	assert_eq!(
		rendered.content.as_str(),
		format!(
			"# canned-crate\n\nfixture crate\n\n**Latest:** 1.2.3 · **License:** MIT · **MSRV:** \
			 1.75\n**Downloads:** 1.2K total · 7 recent\n\n**Repository:** \
			 https://git.example/pkg\n**Homepage:** https://home.example/pkg\n**Docs:** \
			 https://docs.example/pkg\n**Keywords:** alpha, beta\n**Categories:** \
			 development-tools\n\n## Recent Versions\n\n- **1.2.3** (2024-01-02) - 2.5K \
			 downloads\n\n---\n\n## README\n\n{readme}"
		)
	);
	assert_single_diag(&rendered, DiagKind::Provenance, Severity::Info);
	let requests = client.requests();
	assert_eq!(
		requests
			.iter()
			.map(|request| request.url.as_str())
			.collect::<Vec<_>>(),
		[
			"https://crates.io/api/v1/crates/canned-crate",
			"https://docs.rs/crate/canned-crate/1.2.3/source/README.md",
		]
	);
	assert_eq!(
		requests[0]
			.headers
			.iter()
			.find(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
			.map(|(_, value)| value.as_str()),
		Some(omp_core::USER_AGENT)
	);

	let without_readme = Scraper::CratesIo
		.render(
			&CannedHttp::from_responses([
				ok_json(r#"{"crate":{"name":"canned-crate","description":null,"downloads":0,"recent_downloads":0,"max_version":"1.0.0","repository":null,"homepage":null,"documentation":null,"categories":[],"keywords":[]},"versions":[]}"#),
				response(404, "text/plain", "missing readme"),
			]),
			&Url::parse("https://crates.io/crates/canned-crate").expect("fixture URL parses"),
		)
		.await
		.expect("README HTTP errors are optional")
		.expect("crate metadata still renders");
	assert_eq!(
		without_readme.content.as_str(),
		"# canned-crate\n\n**Latest:** 1.0.0\n**Downloads:** 0 total · 0 recent"
	);

	let missing = Scraper::CratesIo
		.render(
			&CannedHttp::from_responses([response(404, "application/json", "{}")]),
			&Url::parse("https://crates.io/crates/missing").expect("fixture URL parses"),
		)
		.await
		.expect("metadata HTTP errors are scraper fallbacks");
	assert_eq!(missing, None);
}

#[tokio::test]
async fn ml_academic_and_reference_scrapers_render_canned_api_responses() {
	assert_scrape(
		Scraper::HuggingFace,
		"https://huggingface.co/owner/model",
		CannedHttp::from_responses([
			ok_json(r#"{"modelId":"owner/canned-model","pipeline_tag":"text-generation","tags":[],"downloads":7,"likes":2}"#),
			response(200, "text/markdown", "canned model card"),
		]),
		"huggingface",
		"canned model card",
	)
	.await;

	assert_scrape(
		Scraper::Arxiv,
		"https://arxiv.org/abs/2401.12345",
		CannedHttp::from_responses([response(
			200,
			"application/atom+xml",
			r#"<feed><entry><title>Canned arXiv paper</title><summary>canned abstract</summary><published>2024-01-01T00:00:00Z</published><author><name>Ada</name></author><category term="cs.SE"/></entry></feed>"#,
		)]),
		"arxiv",
		"canned abstract",
	)
	.await;

	assert_scrape(
		Scraper::Wikipedia,
		"https://en.wikipedia.org/wiki/Rust_(programming_language)",
		CannedHttp::from_responses([
			ok_json(r#"{"title":"Canned Wikipedia article","description":"fixture encyclopedia entry","extract":"canned summary"}"#),
			response(200, "text/html", "<section><h2>Details</h2><p>canned article body with enough detail</p></section>"),
		]),
		"wikipedia",
		"canned article body with enough detail",
	)
	.await;
}
