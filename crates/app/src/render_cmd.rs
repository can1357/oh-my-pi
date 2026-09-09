//! Headless durable-session replay through the production transcript projection
//! and chat scene.

use std::{
	env,
	fmt::Write as _,
	fs,
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use clap::{Args, ValueEnum};
use miette::{IntoDiagnostic as _, miette};
use omp_chat::{
	HostMailbox, HostOptions, ModelBadge, NativeHost, overlays::NoServices, welcome::WelcomeFacts,
};
use omp_core::{Str, encoding::base64};
use omp_dom::{KnownTag, PropId, Tag, Value};
use omp_tui::{Frame, Size, UiContext, frame_ansi, frame_text, slots::ResizePolicy};

/// Output projection selected by `omp render --format`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum RenderFormat {
	/// Production terminal transcript, including presentation styling.
	#[default]
	Terminal,
	/// Stable answer/tool text with no terminal chrome.
	Text,
	/// Stable provider-payload-free JSON document.
	Json,
	/// Concise Markdown history.
	Markdown,
}

/// Headless transcript replay and finalized-history rendering options.
#[derive(Clone, Debug, Args)]
pub struct RenderArgs {
	/// Session journal path or project-local session ID prefix.
	#[arg(value_name = "SESSION")]
	pub session:  Option<Str>,
	/// Render width in terminal columns.
	#[arg(long, short = 'w')]
	pub width:    Option<u16>,
	/// Print phase timings and rendered row counts to standard error.
	#[arg(long, short = 't')]
	pub timing:   bool,
	/// Benchmark this many extra pure finalized-history batch renders.
	#[arg(long, value_name = "N")]
	pub repaint:  Option<u32>,
	/// Output projection.
	#[arg(long, value_enum, default_value = "terminal")]
	pub format:   RenderFormat,
	/// Include reasoning in Markdown output.
	#[arg(long)]
	pub thinking: bool,
	/// Strip ANSI styling from terminal transcript output.
	#[arg(long)]
	pub plain:    bool,
	/// Suppress transcript output for timing-only runs.
	#[arg(long, short = 'q')]
	pub quiet:    bool,
}

/// File produced by `omp --export <SESSION_OMS>`.
pub struct ExportedSession {
	/// Standalone HTML transcript.
	pub html: PathBuf,
}

struct RenderOutput {
	path:          PathBuf,
	transcript:    String,
	source_bytes:  u64,
	items:         usize,
	rows:          u16,
	open:          Duration,
	project:       Duration,
	replay:        Duration,
	batch_render:  Duration,
	repaint_times: Vec<Duration>,
}

/// Exports one durable session as a standalone HTML transcript.
pub fn export_session(
	selector: &Path,
	data_dir: &Path,
	cwd: &Path,
) -> miette::Result<ExportedSession> {
	let selector = selector.to_string_lossy();
	let source = resolve_target(Some(&selector), data_dir, cwd)?;
	let stem = source
		.file_stem()
		.and_then(|value| value.to_str())
		.unwrap_or("session");
	let html = cwd.join(format!("omp-session-{stem}.html"));
	export_html(&source, &html)?;
	Ok(ExportedSession { html })
}

/// Writes a standalone HTML transcript for an already-resolved journal.
pub fn export_html(source: &Path, output: &Path) -> miette::Result<()> {
	let session = omp_session::Session::open(source, omp_session::ComponentRegistry::standard())
		.into_diagnostic()?;
	export_html_snapshot(source, session.dom(), session.blobs(), output)
}

/// Writes standalone HTML from an actor-owned live DOM without acquiring a
/// second journal writer lock.
pub fn export_html_snapshot(
	source: &Path,
	dom: &omp_dom::Dom,
	blobs: &omp_journal::blob::BlobStore,
	output: &Path,
) -> miette::Result<()> {
	if source == output {
		return Err(miette!("export path must not overwrite the session journal"));
	}
	let document = crate::print_mode::transcript_json(dom, blobs);
	let entries = omp_journal::Journal::scan(source).into_diagnostic()?;
	let html = standalone_html(
		source
			.file_stem()
			.and_then(|value| value.to_str())
			.unwrap_or("session"),
		&document,
		&entries,
	);
	fs::write(output, html).into_diagnostic()
}

/// Replays one session, writes its materialized transcript, and optionally
/// reports phase costs.
pub fn run(args: RenderArgs, data_dir: &Path) -> miette::Result<()> {
	if args.width == Some(0) {
		return Err(miette!("--width must be greater than zero"));
	}
	if args.repaint == Some(0) {
		return Err(miette!("--repaint must be a positive integer"));
	}
	let cwd = env::current_dir().into_diagnostic()?;
	let _ctx = crate::process_ctx(&cwd)?;
	let output = render_session(&args, data_dir, &cwd)?;
	if !args.quiet {
		let mut stdout = io::stdout().lock();
		stdout
			.write_all(output.transcript.as_bytes())
			.into_diagnostic()?;
		if !output.transcript.ends_with('\n') {
			stdout.write_all(b"\n").into_diagnostic()?;
		}
	}
	if args.timing || args.repaint.is_some() {
		eprintln!("{}", timing_report(&output));
	}
	Ok(())
}

fn render_session(args: &RenderArgs, data_dir: &Path, cwd: &Path) -> miette::Result<RenderOutput> {
	let open_start = Instant::now();
	let path = resolve_target(args.session.as_deref(), data_dir, cwd)?;
	let source_bytes = fs::metadata(&path).into_diagnostic()?.len();
	let open = open_start.elapsed();

	let replay_start = Instant::now();
	let mut session = omp_session::Session::open(&path, omp_session::ComponentRegistry::standard())
		.into_diagnostic()?;
	let replay = replay_start.elapsed();
	let items = omp_session::project_thread(session.dom()).len();
	let width = args.width.unwrap_or(100);

	let project_start = Instant::now();
	let transcript = match args.format {
		RenderFormat::Terminal => {
			let host = production_host(&mut session, width, cwd)?;
			rendered_transcript(&host, args.plain)
		},
		RenderFormat::Text => {
			crate::print_mode::transcript_text_with_blobs(session.dom(), session.blobs())
		},
		RenderFormat::Json => serde_json::to_string_pretty(&crate::print_mode::transcript_json(
			session.dom(),
			session.blobs(),
		))
		.into_diagnostic()?,
		RenderFormat::Markdown => {
			crate::print_mode::transcript_markdown(session.dom(), session.blobs(), args.thinking)
		},
	};
	let project = project_start.elapsed();

	let batch_start = Instant::now();
	let batch_render = batch_start.elapsed();
	let rows = u16::try_from(transcript.lines().count()).unwrap_or(u16::MAX);

	let mut repaint_times = Vec::with_capacity(args.repaint.unwrap_or(0) as usize);
	for _ in 0..args.repaint.unwrap_or(0) {
		let start = Instant::now();
		match args.format {
			RenderFormat::Terminal => {
				let _ = production_transcript(&mut session, width, args.plain, cwd)?;
			},
			RenderFormat::Text => {
				let _ = crate::print_mode::transcript_text_with_blobs(session.dom(), session.blobs());
			},
			RenderFormat::Json => {
				let _ = crate::print_mode::transcript_json(session.dom(), session.blobs());
			},
			RenderFormat::Markdown => {
				let _ = crate::print_mode::transcript_markdown(
					session.dom(),
					session.blobs(),
					args.thinking,
				);
			},
		}
		repaint_times.push(start.elapsed());
	}

	Ok(RenderOutput {
		path,
		transcript,
		source_bytes,
		items,
		rows,
		open,
		project,
		replay,
		batch_render,
		repaint_times,
	})
}

fn production_transcript(
	session: &mut omp_session::Session,
	width: u16,
	plain: bool,
	project: &Path,
) -> miette::Result<String> {
	let host = production_host(session, width, project)?;
	Ok(rendered_transcript(&host, plain))
}

fn production_host(
	session: &mut omp_session::Session,
	width: u16,
	project: &Path,
) -> miette::Result<NativeHost> {
	let (snapshot, dom_events) = session.subscribe();
	let (_, kernel_events) = flume::unbounded();
	let (commands, _) = flume::unbounded();
	let (up, _) = flume::unbounded();
	let con = Arc::new(HostMailbox::new().attach(omp_con::Ctx::builder()).build());
	con.run("cl_startup_quiet 1").into_diagnostic()?;
	let model = session
		.dom()
		.children(session.dom().body())
		.iter()
		.flat_map(|turn| session.dom().children(*turn))
		.find_map(|handle| {
			let node = session.dom().get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Assistant))
				.then(|| node.prop(&PropId::Model.into()).and_then(Value::as_str))
				.flatten()
		})
		.unwrap_or("session");
	Ok(NativeHost::new(
		HostOptions {
			snapshot,
			dom_events,
			kernel_events,
			commands,
			up,
			con,
			models: Vec::new(),
			cycle: Vec::new(),
			resize_policy: ResizePolicy::Rebuild,
			model: ModelBadge::from_identifier(model),
			project: project.to_path_buf(),
			welcome: WelcomeFacts::default(),
			ui: UiContext::default(),
			services: Arc::new(NoServices),
			speech: None,
			resuming: true,
			initial_panel: None,
		},
		Size::new(width, 32),
	))
}

fn rendered_transcript(host: &NativeHost, plain: bool) -> String {
	let status_rows = host.status_frame().map_or(0, |frame| frame.size().height);
	let transcript_rows = host
		.frame()
		.size()
		.height
		.saturating_sub(status_rows)
		.saturating_sub(host.editor_rows());
	let mut transcript = Frame::new(Size::new(host.frame().size().width, transcript_rows));
	transcript.blit(host.frame(), 0, transcript_rows, 0, 0);
	if plain {
		frame_text(&transcript)
	} else {
		frame_ansi(&transcript)
	}
}

fn standalone_html(
	title: &str,
	document: &serde_json::Value,
	entries: &[omp_journal::Entry],
) -> String {
	let mut html = String::with_capacity(
		serde_json::to_string(document).map_or(16_384, |value| value.len().saturating_add(16_384)),
	);
	html.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
	html.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>");
	escape_html(&mut html, title);
	html.push_str(
		"</title><style>:root{color-scheme:dark;--bg:#111318;--panel:#191c23;--text:#e8e9ed;--muted:\
		 #969ba8;--line:#30343e;--user:#242936;--accent:#72a7ff;--error:#ff7b86}*{box-sizing:\
		 border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 \
		 ui-sans-serif,system-ui,sans-serif}main{display:grid;grid-template-columns:minmax(15rem,\
		 22rem) minmax(0,52rem);gap:2rem;max-width:78rem;margin:auto;padding:2rem}.\
		 timeline{position:sticky;top:1rem;align-self:start;max-height:calc(100vh - \
		 2rem);overflow:auto;border:1px solid \
		 var(--line);border-radius:10px;background:var(--panel);padding:1rem}h1{font-size:1.1rem;\
		 margin:0 0 1rem}.timeline ol{list-style:none;margin:0;padding:0}.timeline li{padding:.3rem \
		 .45rem;border-left:2px solid \
		 var(--accent);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:\
		 ellipsis}.timeline \
		 li.abandoned{border-color:var(--line);opacity:.55}.transcript{min-width:0}.message,.\
		 notice{margin:0 0 1rem;padding:1rem;border-radius:10px;background:var(--panel);border:1px \
		 solid var(--line)}.user{background:var(--user)}.label{font-size:.75rem;color:var(--muted);\
		 text-transform:uppercase;letter-spacing:.08em;margin-bottom:.55rem}pre{white-space:\
		 pre-wrap;overflow-wrap:anywhere;margin:.4rem 0;font:inherit}details{margin:.55rem \
		 0;border-left:2px solid \
		 var(--line);padding-left:.8rem}summary{cursor:pointer;color:var(--accent)}.thinking{color:\
		 var(--muted);font-style:italic}.error{color:var(--error)}img{display:block;max-width:100%;\
		 max-height:36rem;border-radius:8px;margin:.5rem \
		 0}@media(max-width:760px){main{grid-template-columns:1fr;padding:1rem}.timeline{position:\
		 static;max-height:16rem}}</style></head><body><main>",
	);
	let live = omp_journal::live_chain(entries)
		.map(|entry| entry.id)
		.collect::<omp_core::FastHashSet<_>>();
	html.push_str("<nav class=\"timeline\"><h1>");
	escape_html(&mut html, title);
	html.push_str("</h1><ol>");
	for entry in entries {
		let class = if live.contains(&entry.id) {
			"live"
		} else {
			"abandoned"
		};
		let _ = write!(html, "<li class=\"{class}\" title=\"");
		escape_html(&mut html, &entry.id.to_string());
		html.push_str("\">");
		escape_html(&mut html, &entry.kind.to_string());
		if entry.prior.is_some() {
			html.push_str(" · branch");
		}
		html.push_str("</li>");
	}
	html.push_str("</ol></nav><section class=\"transcript\">");
	render_html_messages(&mut html, document);
	if let Some(notices) = document["notices"].as_array() {
		for notice in notices {
			html.push_str("<article class=\"notice\"><div class=\"label\">");
			escape_html(&mut html, notice["kind"].as_str().unwrap_or("notice"));
			html.push_str("</div><pre>");
			escape_html(&mut html, notice["text"].as_str().unwrap_or_default());
			html.push_str("</pre></article>");
		}
	}
	if let Some(exit) = document.get("sessionExit") {
		html.push_str("<article class=\"notice error\"><div class=\"label\">Session exit</div><pre>");
		escape_html(
			&mut html,
			&serde_json::to_string_pretty(exit).unwrap_or_else(|_| "{}".to_owned()),
		);
		html.push_str("</pre></article>");
	}
	html.push_str("</section></main><script id=\"session-data\" type=\"application/octet-stream\">");
	let data = serde_json::to_vec(document).unwrap_or_default();
	let _ = write!(&mut html, "{}", base64::encode(&data));
	html.push_str("</script></body></html>");
	html
}

fn render_html_messages(html: &mut String, document: &serde_json::Value) {
	let Some(messages) = document["messages"].as_array() else {
		return;
	};
	let mut results = omp_core::FastHashMap::<&str, &serde_json::Value>::default();
	for message in messages {
		if message["role"] == "toolResult"
			&& let Some(id) = message["toolCallId"].as_str()
		{
			results.insert(id, message);
		}
	}
	let mut consumed = omp_core::FastHashSet::<&str>::default();
	for message in messages {
		match message["role"].as_str() {
			Some("user" | "developer") => {
				let role = message["role"].as_str().unwrap_or("user");
				html.push_str("<article class=\"message user\"><div class=\"label\">");
				escape_html(html, role);
				html.push_str("</div>");
				render_html_content(html, &message["content"], &results, &mut consumed);
				html.push_str("</article>");
			},
			Some("assistant") => {
				html.push_str(
					"<article class=\"message assistant\"><div class=\"label\">Assistant</div>",
				);
				render_html_content(html, &message["content"], &results, &mut consumed);
				if let Some(error) = message["errorMessage"].as_str() {
					html.push_str("<pre class=\"error\">");
					escape_html(html, error);
					html.push_str("</pre>");
				} else if message["stopReason"] == "aborted" {
					html.push_str("<pre class=\"error\">Aborted</pre>");
				}
				html.push_str("</article>");
			},
			Some("toolResult") => {
				let id = message["toolCallId"].as_str().unwrap_or_default();
				if consumed.contains(id) {
					continue;
				}
				html.push_str("<article class=\"message\"><div class=\"label\">Tool result</div>");
				render_html_tool_result(html, message);
				html.push_str("</article>");
			},
			_ => {},
		}
	}
}

fn render_html_content<'a>(
	html: &mut String,
	content: &'a serde_json::Value,
	results: &omp_core::FastHashMap<&'a str, &'a serde_json::Value>,
	consumed: &mut omp_core::FastHashSet<&'a str>,
) {
	if let Some(text) = content.as_str() {
		html.push_str("<pre>");
		escape_html(html, text);
		html.push_str("</pre>");
		return;
	}
	let Some(parts) = content.as_array() else {
		return;
	};
	for part in parts {
		match part["type"].as_str() {
			Some("text") => {
				html.push_str("<pre>");
				escape_html(html, part["text"].as_str().unwrap_or_default());
				html.push_str("</pre>");
			},
			Some("thinking") => {
				html.push_str("<details class=\"thinking\"><summary>Thinking</summary><pre>");
				escape_html(html, part["thinking"].as_str().unwrap_or_default());
				html.push_str("</pre></details>");
			},
			Some("toolCall") => {
				let id = part["id"].as_str().unwrap_or_default();
				let result = results.get(id).copied();
				if result.is_some() {
					consumed.insert(id);
				}
				html.push_str("<details class=\"tool\" open><summary>");
				escape_html(html, part["name"].as_str().unwrap_or("tool"));
				html.push_str("</summary><pre>");
				escape_html(
					html,
					&serde_json::to_string_pretty(&part["arguments"])
						.unwrap_or_else(|_| "{}".to_owned()),
				);
				html.push_str("</pre>");
				if let Some(result) = result {
					render_html_tool_result(html, result);
				}
				html.push_str("</details>");
			},
			Some("image") => {
				let mime = part["mimeType"]
					.as_str()
					.unwrap_or("application/octet-stream");
				let data = part["data"].as_str().unwrap_or_default();
				if data.is_empty() {
					html.push_str("<pre>[image]</pre>");
				} else {
					html.push_str("<img alt=\"attachment\" src=\"data:");
					escape_html(html, mime);
					html.push_str(";base64,");
					html.push_str(data);
					html.push_str("\">");
				}
			},
			Some(kind) => {
				html.push_str("<pre>[");
				escape_html(html, kind);
				if let Some(uri) = part["uri"].as_str() {
					html.push_str(": ");
					escape_html(html, uri);
				}
				html.push_str("]</pre>");
			},
			None => {},
		}
	}
}

fn render_html_tool_result(html: &mut String, result: &serde_json::Value) {
	let class = if result["isError"].as_bool().unwrap_or(false) {
		" class=\"error\""
	} else {
		""
	};
	let _ = write!(html, "<pre{class}>");
	escape_html(html, &html_content_text(&result["content"]));
	html.push_str("</pre>");
}

fn html_content_text(content: &serde_json::Value) -> String {
	if let Some(text) = content.as_str() {
		return text.to_owned();
	}
	content
		.as_array()
		.map(|parts| {
			parts
				.iter()
				.filter_map(|part| match part["type"].as_str() {
					Some("text") => part["text"].as_str().map(ToOwned::to_owned),
					Some("image") => Some("[image]".to_owned()),
					Some(kind) => Some(format!("[{kind}]")),
					None => None,
				})
				.collect::<Vec<_>>()
				.join("\n")
		})
		.unwrap_or_default()
}

fn escape_html(output: &mut String, text: &str) {
	for character in text.chars() {
		match character {
			'&' => output.push_str("&amp;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'"' => output.push_str("&quot;"),
			'\'' => output.push_str("&#39;"),
			_ => output.push(character),
		}
	}
}

fn resolve_target(selector: Option<&str>, data_dir: &Path, cwd: &Path) -> miette::Result<PathBuf> {
	if let Some(selector) = selector {
		let candidate = Path::new(selector);
		if candidate.is_file() {
			return fs::canonicalize(candidate).into_diagnostic();
		}
		if candidate.components().count() > 1 || selector.ends_with(".oms") {
			return Err(miette!("session file not found: {}", candidate.display()));
		}
	}

	let root = fs::canonicalize(cwd).into_diagnostic()?;
	let sessions_dir = omp_env::project_state::directory(data_dir, &root)
		.into_diagnostic()?
		.join("sessions");
	let mut journals = fs::read_dir(&sessions_dir)
		.into_diagnostic()?
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| path.extension().is_some_and(|extension| extension == "oms"))
		.collect::<Vec<_>>();
	if let Some(selector) = selector {
		journals.retain(|path| {
			path
				.file_stem()
				.and_then(|name| name.to_str())
				.is_some_and(|name| name.starts_with(selector))
		});
		if journals.len() > 1 {
			return Err(miette!("session \"{selector}\" is ambiguous"));
		}
		return journals
			.pop()
			.ok_or_else(|| miette!("session \"{selector}\" not found"));
	}
	journals.sort_by_key(|path| {
		fs::metadata(path)
			.and_then(|metadata| metadata.modified())
			.ok()
	});
	journals
		.pop()
		.ok_or_else(|| miette!("no sessions found for {}", root.display()))
}

fn timing_report(output: &RenderOutput) -> String {
	let mut report = vec![
		format!("session  {}", output.path.display()),
		format!(
			"         {}, {} items, {} transcript rows",
			format_bytes(output.source_bytes),
			output.items,
			output.rows
		),
		format!("open     {}", format_duration(output.open)),
		format!("project  {}  (journal live-set projection)", format_duration(output.project)),
		format!("replay   {}  (production backend event projection)", format_duration(output.replay)),
		format!("batch    {}  (finalized-history render)", format_duration(output.batch_render),),
	];
	if !output.repaint_times.is_empty() {
		let total: Duration = output.repaint_times.iter().copied().sum();
		let average = total / output.repaint_times.len() as u32;
		report.push(format!(
			"repaint  {} avg over {} pure batch renders",
			format_duration(average),
			output.repaint_times.len(),
		));
	}
	report.join("\n")
}

fn format_duration(duration: Duration) -> String {
	format!("{:.2} ms", duration.as_secs_f64() * 1_000.0)
}

fn format_bytes(bytes: u64) -> String {
	if bytes >= 1024 * 1024 {
		format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
	} else if bytes >= 1024 {
		format!("{:.1} KiB", bytes as f64 / 1024.0)
	} else {
		format!("{bytes} B")
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{KnownTag, PropId, Tag};
	use serde_json::value::RawValue;
	use tempfile::tempdir;

	use super::*;

	fn assistant_with(
		session: &mut omp_session::Session,
		thinking: Option<&str>,
		text: &str,
		stop: &str,
	) {
		session
			.assistant_start("fixture/model", "fixture", "fixture/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = session
			.dom()
			.children(turn)
			.iter()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			})
			.expect("assistant node");
		if let Some(thinking) = thinking {
			let stream = session
				.stream_open(assistant, PropId::Thinking.into())
				.expect("thinking stream");
			session.stream_append(stream, thinking).expect("thinking");
			session.stream_close(stream).expect("thinking close");
		}
		let stream = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text stream");
		session.stream_append(stream, text).expect("text");
		session.stream_close(stream).expect("text close");
		session.assistant_end(stop).expect("assistant end");
	}

	#[test]
	fn fixture_replays_deterministically_through_the_chat_scene() {
		let scratch = tempdir().expect("scratch");
		let root = scratch.path().join("project");
		fs::create_dir(&root).expect("project");
		let path = scratch.path().join("fixture.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard())
				.expect("fixture journal");
		session.begin_turn().expect("turn");
		session.user("hello fixture", Vec::new()).expect("user");
		session
			.assistant_start("fixture/model", "fixture", "fixture/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn node");
		let assistant = session
			.dom()
			.children(turn)
			.iter()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			})
			.expect("assistant node");
		let stream = session
			.stream_open(assistant, PropId::Text.into())
			.expect("open text");
		session
			.stream_append(stream, "hello back")
			.expect("append text");
		session.stream_close(stream).expect("close text");
		session
			.assistant_end("tool_calls")
			.expect("finish assistant");
		let call = session
			.call(
				"custom_tool",
				1,
				"call-render",
				None,
				Some(
					RawValue::from_string(
						r#"{"i":"Inspecting fixture","path":"a/very/long/fixture/path.txt"}"#.to_owned(),
					)
					.expect("args"),
				),
				None,
			)
			.expect("tool call");
		session
			.settle(
				call,
				RawValue::from_string(
					r#"{"content":[{"type":"text","text":"tool result body"}]}"#.to_owned(),
				)
				.expect("outcome"),
			)
			.expect("tool result");
		drop(session);
		let args = RenderArgs {
			session:  Some(Str::from(path.to_string_lossy().as_ref())),
			width:    Some(80),
			timing:   true,
			repaint:  Some(1),
			format:   RenderFormat::Terminal,
			thinking: false,
			plain:    true,
			quiet:    false,
		};
		let first = render_session(&args, scratch.path(), &root).expect("first replay");
		let second = render_session(&args, scratch.path(), &root).expect("second replay");
		assert_eq!(first.transcript, second.transcript);
		assert!(first.transcript.contains("hello fixture"), "user block missing");
		assert!(first.transcript.contains("hello back"), "assistant block missing");
		assert!(first.transcript.contains("custom_tool"), "tool card missing");
		assert!(first.transcript.contains("tool result body"), "tool result missing");
		assert!(!first.transcript.contains('\u{1b}'), "--plain leaked ANSI");

		let mut narrow = args.clone();
		narrow.width = Some(24);
		let narrow = render_session(&narrow, scratch.path(), &root).expect("narrow replay");
		assert_ne!(first.transcript, narrow.transcript, "--width did not change layout");
		assert!(
			narrow
				.transcript
				.lines()
				.all(|line| omp_tui::cell_width(line) <= 24),
			"rendered line exceeded requested width",
		);

		let mut styled = args.clone();
		styled.plain = false;
		let styled = render_session(&styled, scratch.path(), &root).expect("styled replay");
		assert!(styled.transcript.contains('\u{1b}'), "styled render omitted ANSI");

		let mut markdown = args.clone();
		markdown.format = RenderFormat::Markdown;
		let markdown = render_session(&markdown, scratch.path(), &root).expect("Markdown replay");
		assert!(markdown.transcript.contains("## user"));
		assert!(markdown.transcript.contains("## assistant"));
		assert!(markdown.transcript.contains("→ custom_tool("));
		assert!(!markdown.transcript.contains("tool result body"));

		let mut json = args.clone();
		json.format = RenderFormat::Json;
		let json = render_session(&json, scratch.path(), &root).expect("JSON replay");
		let document: serde_json::Value =
			serde_json::from_str(&json.transcript).expect("JSON transcript");
		assert_eq!(document["format"], "omp-transcript@1");
		assert!(document["messages"].as_array().is_some_and(|messages| {
			messages
				.iter()
				.any(|message| message["role"] == "toolResult")
		}));

		let exported = root.join("fixture.html");
		export_html(&path, &exported).expect("HTML export");
		let html = fs::read_to_string(exported).expect("read HTML");
		assert!(html.starts_with("<!doctype html>"));
		assert!(html.contains("hello fixture"));
		assert!(html.contains("custom_tool"));
		assert!(html.contains("tool result body"));
		assert!(html.contains("application/octet-stream"));

		let timing = timing_report(&first);
		assert!(timing.contains("open") && timing.contains("project") && timing.contains("replay"));
		assert!(timing.contains("batch") && timing.contains("repaint"));
	}

	#[test]
	fn standalone_export_uses_live_branch_and_marks_abandoned_entries() {
		let scratch = tempdir().expect("scratch");
		let path = scratch.path().join("branched.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		let branch_point = session.user("root", Vec::new()).expect("root");
		assistant_with(&mut session, None, "lost-secret", "stop");
		session.rewind(branch_point).expect("rewind");
		session.begin_turn().expect("replacement turn");
		session.user("live-user", Vec::new()).expect("live user");
		assistant_with(&mut session, None, "live-answer", "stop");

		let output = scratch.path().join("branch.html");
		export_html_snapshot(&path, session.dom(), session.blobs(), &output)
			.expect("live export without a second writer");
		let html = fs::read_to_string(output).expect("HTML");
		assert!(html.contains("live-user") && html.contains("live-answer"));
		assert!(!html.contains("lost-secret"), "abandoned message leaked into live transcript");
		assert!(html.contains("class=\"abandoned\""), "branch timeline lost abandoned entries");
	}

	#[test]
	fn standalone_export_preserves_blocks_and_escapes_untrusted_text() {
		let document = serde_json::json!({
			"format": "omp-transcript@1",
			"messages": [{
				"role": "assistant",
				"content": [
					{"type":"text","text":"before <script>alert(1)</script>"},
					{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"README.md"}},
					{"type":"thinking","thinking":"private trace"},
					{"type":"image","mimeType":"image/png","data":"YQ=="},
					{"type":"text","text":"after"}
				],
				"stopReason": "error",
				"errorMessage": "provider failed"
			}, {
				"role":"toolResult",
				"toolCallId":"call-1",
				"toolName":"read",
				"content":[{"type":"text","text":"result"}],
				"isError":false
			}],
			"notices": [],
		});
		let html = standalone_html("unsafe <title>", &document, &[]);
		assert!(html.contains("unsafe &lt;title&gt;"));
		assert!(html.contains("before &lt;script&gt;alert(1)&lt;/script&gt;"));
		assert!(!html.contains("<script>alert(1)</script>"));
		let before = html.find("before &lt;script").expect("first text");
		let tool = html[before..]
			.find("<details class=\"tool\"")
			.expect("tool")
			+ before;
		let thinking = html[tool..].find("private trace").expect("thinking") + tool;
		let image = html[thinking..].find("<img ").expect("image") + thinking;
		let after = html[image..].find(">after</pre>").expect("last text") + image;
		assert!(before < tool && tool < thinking && thinking < image && image < after);
		assert!(html.contains("provider failed"));
	}
}
