//! Headless durable-session replay through the production transcript projection
//! and chat scene.

use std::{
	env, fs,
	io::{self, Write as _},
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use clap::Args;
use miette::{IntoDiagnostic as _, miette};
use omp_chat_ui::Chat;
use omp_core::Str;
use omp_proto::thread::v1;
use omp_storage::transcript;
use omp_tool::{Registry, render::RenderRegistry};
use omp_tui::{CellContent, Frame, RichSink as _, Size, Style, UiContext};

use crate::{chat_ui, chat_ui::ResumeChoice};

/// Headless transcript replay and finalized-history rendering options.
#[derive(Clone, Debug, Args)]
pub struct RenderArgs {
	/// Session journal path or project-local session ID prefix.
	#[arg(value_name = "SESSION")]
	pub session: Option<Str>,
	/// Render width in terminal columns.
	#[arg(long, short = 'w')]
	pub width:   Option<u16>,
	/// Print phase timings and rendered row counts to standard error.
	#[arg(long, short = 't')]
	pub timing:  bool,
	/// Benchmark this many extra pure finalized-history batch renders.
	#[arg(long, value_name = "N")]
	pub repaint: Option<u32>,
	/// Strip ANSI styling from transcript output.
	#[arg(long)]
	pub plain:   bool,
	/// Suppress transcript output for timing-only runs.
	#[arg(long, short = 'q')]
	pub quiet:   bool,
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

	// `load_live` folds the live chain, so the journal load is timed with the
	// phase the report labels "journal live-set projection".
	let project_start = Instant::now();
	let view = omp_storage::transcript::load_live(&path).into_diagnostic()?;
	let registry = Registry::new();
	let renderers = builtin_renderers()?;
	let projection = omp_agent::project_journal(&view, &registry, &omp_driver::chat::CHAT_CAPS_BASE)
		.into_diagnostic()?;
	let project = project_start.elapsed();

	let replay_start = Instant::now();
	let mut chat = replay_chat(&projection.items, &renderers);
	let replay = replay_start.elapsed();

	let width = args.width.unwrap_or(120);
	let batch_start = Instant::now();
	let frame = retirement_frame(&mut chat, width);
	let batch_render = batch_start.elapsed();
	let transcript = materialize(&frame, args.plain);

	let mut repaint_times = Vec::with_capacity(args.repaint.unwrap_or(0) as usize);
	for _ in 0..args.repaint.unwrap_or(0) {
		let start = Instant::now();
		let _ = retirement_frame(&mut chat, width);
		repaint_times.push(start.elapsed());
	}

	Ok(RenderOutput {
		path,
		transcript,
		source_bytes,
		items: projection.items.len(),
		rows: frame.size().height,
		open,
		project,
		replay,
		batch_render,
		repaint_times,
	})
}

fn replay_chat(items: &[v1::Item], renderers: &RenderRegistry) -> Chat {
	let mut chat = Chat::new(&UiContext::default());
	for event in chat_ui::replay_backend_events(items, renderers) {
		let _ = chat.apply_backend_event(event);
	}
	chat
}
/// Builds the default builtin renderer registry used by headless replay,
/// where no live tool registry exists to derive revisions from.
fn builtin_renderers() -> miette::Result<RenderRegistry> {
	let gallery = omp_tools::gallery::builtin_renderer_gallery();
	let mut renderers = RenderRegistry::new();
	omp_tools::register_builtin_renderers(&mut renderers, gallery.identities).into_diagnostic()?;
	Ok(renderers)
}

fn retirement_frame(chat: &mut Chat, width: u16) -> Frame {
	chat
		// Zero-height viewport: headless export drains the complete
		// finalized prefix regardless of capacity pressure.
		.retirement_batch(Size::new(width, 0))
		.map_or_else(|| Frame::new(Size::new(width, 0)), |batch| batch.frame)
}

/// Renders the canonical journal as a finalized history frame for inspection.
pub(crate) fn history_frame(
	path: &Path,
	registry: &Registry,
	renderers: &RenderRegistry,
) -> miette::Result<Frame> {
	let view = omp_storage::transcript::load_live(path).into_diagnostic()?;
	let projection = omp_agent::project_journal(&view, registry, &omp_driver::chat::CHAT_CAPS_BASE)
		.into_diagnostic()?;
	let mut chat = replay_chat(&projection.items, renderers);
	Ok(retirement_frame(&mut chat, 120))
}

fn resolve_target(selector: Option<&str>, data_dir: &Path, cwd: &Path) -> miette::Result<PathBuf> {
	if let Some(selector) = selector {
		let candidate = Path::new(selector);
		if candidate.is_file() {
			return fs::canonicalize(candidate).into_diagnostic();
		}
		if candidate.components().count() > 1 || selector.ends_with(".jsonl") {
			return Err(miette!("session file not found: {}", candidate.display()));
		}
	}

	let root = fs::canonicalize(cwd).into_diagnostic()?;
	let sessions_dir = omp_env::project_state::directory(data_dir, &root)
		.into_diagnostic()?
		.join("sessions");
	let choices = omp_driver::chat::resume_choices(&sessions_dir, &root, None).into_diagnostic()?;
	let id = match selector {
		Some(selector) => resolve_choice(selector, &choices)?,
		None => choices
			.iter()
			.max_by_key(|choice| {
				fs::metadata(sessions_dir.join(format!("{}.jsonl", choice.id)))
					.and_then(|metadata| metadata.modified())
					.ok()
			})
			.map(|choice| choice.id.clone())
			.ok_or_else(|| miette!("no sessions found for {}", root.display()))?,
	};
	Ok(sessions_dir.join(format!("{id}.jsonl")))
}

fn resolve_choice(selector: &str, choices: &[ResumeChoice]) -> miette::Result<Str> {
	if let Some(choice) = choices.iter().find(|choice| choice.id == selector) {
		return Ok(choice.id.clone());
	}
	let mut matches = choices
		.iter()
		.filter(|choice| choice.id.starts_with(selector));
	let first = matches
		.next()
		.ok_or_else(|| miette!("session \"{selector}\" not found"))?;
	if matches.next().is_some() {
		return Err(miette!("session \"{selector}\" is ambiguous"));
	}
	Ok(first.id.clone())
}

fn materialize(frame: &Frame, plain: bool) -> String {
	let rows = frame.size().height;
	let mut lines = Vec::with_capacity(usize::from(rows));
	for y in 0..rows {
		let width = frame.size().width;
		let end = (0..width)
			.rfind(|x| {
				!matches!(frame.cell(*x, y).content(), CellContent::Blank | CellContent::Continuation)
			})
			.map_or(0, |x| x.saturating_add(1));
		let mut line = String::new();
		if plain {
			for x in 0..end {
				match frame.cell(x, y).content() {
					CellContent::Blank | CellContent::Image { .. } => line.push(' '),
					CellContent::Grapheme { text, .. } => line.push_str(text),
					CellContent::Continuation => {},
				}
			}
		} else {
			let mut run = String::new();
			let mut style: Option<Style> = None;
			for x in 0..end {
				let cell = frame.cell(x, y);
				let text = match cell.content() {
					CellContent::Blank | CellContent::Image { .. } => " ",
					CellContent::Grapheme { text, .. } => text.as_str(),
					CellContent::Continuation => continue,
				};
				if style.is_some_and(|current| current != cell.style()) {
					line.run(style.expect("style exists with buffered run"), &run);
					run.clear();
				}
				style = Some(cell.style());
				run.push_str(text);
			}
			if let Some(style) = style {
				line.run(style, &run);
				line.push_str("\x1b[0m");
			}
		}
		lines.push(line);
	}
	while lines.last().is_some_and(String::is_empty) {
		lines.pop();
	}
	lines.join("\n")
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
	use omp_core::sf;
	use omp_proto::thread::v1::{Item, Message, Part, Role, item, part};
	use omp_storage::transcript::{Event, Header, ItemRecord, Kind, SessionId, Writer};
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn fixture_replays_deterministically_through_the_chat_scene() {
		let scratch = tempdir().expect("scratch");
		let root = scratch.path().join("project");
		fs::create_dir(&root).expect("project");
		let path = scratch.path().join("fixture.jsonl");
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(sf!("01K3A000000000000000000000")),
			created: 1,
			cwd:     root.clone(),
		})
		.expect("fixture journal");
		for (seq, role, text) in
			[(0, Role::User, "hello fixture"), (1, Role::Assistant, "hello back")]
		{
			writer
				.append(&Event {
					ts:   seq + 2,
					kind: Kind::Item(ItemRecord {
						item:        Item {
							seq,
							created_at_ms: seq + 2,
							kind: Some(item::Kind::Message(Message {
								role:  i32::from(role),
								parts: vec![Part { kind: Some(part::Kind::Text(text.to_owned())) }],
							})),
							props: None,
						},
						turn_id:     None,
						prompt_hash: None,
					}),
				})
				.expect("fixture item");
		}
		drop(writer);
		let args = RenderArgs {
			session: Some(Str::from(path.to_string_lossy().as_ref())),
			width:   Some(80),
			timing:  true,
			repaint: Some(1),
			plain:   true,
			quiet:   false,
		};
		let first = render_session(&args, scratch.path(), &root).expect("first replay");
		let second = render_session(&args, scratch.path(), &root).expect("second replay");
		assert_eq!(first.transcript, second.transcript);
		assert!(first.transcript.contains("hello fixture"));
		assert!(first.transcript.contains("hello back"));
		let timing = timing_report(&first);
		assert!(timing.contains("open") && timing.contains("project") && timing.contains("replay"));
		assert!(timing.contains("batch") && timing.contains("repaint"));
	}
}
