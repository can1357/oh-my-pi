//! Boot chrome goldens: the surface an interactive host paints at 120x40
//! and 80x24, and the composer status band byte-checked against pi's
//! `scripts/qa/fixtures/gallery/surfaces/chrome-*.txt` band rows (idle,
//! working, resized).

use std::time::Duration;

use omp_chat::{
	LocalFacts, ModelBadge,
	chrome::{StatusBand, StatusFacts},
	render_surface,
};
use omp_core::Str;
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropKey, Txn, Value};
use omp_session::{ComponentRegistry, Session};
use omp_tui::{Charset, Icon, Size, Ui, UiContext, frame_text};
use tempfile::tempdir;

/// The recorded band row at the given geometry, for exact-byte
/// comparison of the static content.
fn reference_band(name: &str, row: usize) -> String {
	let path =
		concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/qa/fixtures/gallery/surfaces/chrome-");
	let text = std::fs::read_to_string(format!("{path}{name}.txt")).expect("reference capture");
	text.lines().nth(row).expect("band row").to_owned()
}

fn boot_session() -> Session {
	let directory = tempdir().expect("temp directory");
	let path = directory.keep().join("boot.oms");
	let mut session = Session::create(path, ComponentRegistry::standard()).expect("create session");
	let cause = session.head().expect("genesis");
	let meta = session.dom().meta();
	let facts = serde_json::json!({
		"cwd": "/work/omp",
		"home": "/Users/owner",
		"model": {"identifier": "anthropic/claude-fable-5"},
	});
	let raw = serde_json::value::to_raw_value(&facts).expect("raw facts");
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("prompt.facts")),
			ops: vec![Op::Set {
				h:     meta,
				prop:  omp_dom::PropKey::Custom(Str::new_static("prompt-facts")),
				value: Value::Json(raw),
			}],
		})
		.expect("facts patch");
	session
}

fn badge() -> ModelBadge {
	ModelBadge {
		identifier:     Str::new_static("anthropic/claude-fable-5"),
		name:           Str::new_static("Claude Fable 5"),
		provider:       Str::new_static("anthropic"),
		context_window: Some(1_000_000),
		reasoning:      true,
	}
}

fn local() -> LocalFacts {
	LocalFacts { branch: Some(Str::new_static("main")), ..LocalFacts::default() }
}

fn ui() -> UiContext {
	UiContext { charset: Charset::Unicode, ..UiContext::default() }
}

fn surface_of(session: &mut Session, width: u16, height: u16) -> (Vec<String>, Option<(u16, u16)>) {
	let (snapshot, _events) = session.subscribe();
	let frame = render_surface(&snapshot, &badge(), &local(), Size::new(width, height), &ui());
	let mut rows = frame_text(&frame)
		.lines()
		.map(|line| line.trim_end().to_owned())
		.collect::<Vec<_>>();
	rows.resize(usize::from(frame.size().height), String::new());
	(rows, frame.cursor())
}

fn surface(width: u16, height: u16) -> (Vec<String>, Option<(u16, u16)>) {
	surface_of(&mut boot_session(), width, height)
}

fn directors_root(session: &Session) -> Handle {
	session
		.dom()
		.children(session.dom().meta())
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == omp_dom::Tag::Known(KnownTag::Directors))
		})
		.expect("directors root")
}

fn insert_director(
	session: &mut Session,
	parent: Handle,
	family: &'static str,
	state: &[(&'static str, Value)],
) -> Handle {
	let mut node = NodeSpec::new(KnownTag::Director)
		.with_prop(PropKey::Custom(Str::new_static("family")), Value::Str(Str::new_static(family)))
		.with_prop(PropKey::Custom(Str::new_static("status")), Value::Str(Str::new_static("active")));
	for (key, value) in state {
		node = node.with_prop(PropKey::Custom(Str::new_static(key)), value.clone());
	}
	let high = session.dom().high_water();
	let cause = session.head().expect("head");
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("director.test")),
			ops: vec![Op::Ins { parent, after: session.dom().children(parent).last().copied(), node }],
		})
		.expect("director patch");
	Handle::new(high + 1).expect("new handle")
}

/// The fresh-session band at `width`: the group, then the
/// embedded gauge with `0%` on the one accent cell, the compaction tick at
/// `threshold` percent of the scale, and the `1M` window label at the end.
fn expected_band(group: &str, width: u16, threshold: u16) -> String {
	let gap = width - omp_tui::cell_width(group);
	let scale = gap - 3;
	let tick = (f64::from(threshold) / 100.0 * f64::from(scale)).round() as u16;
	format!(
		"{group}─0%{}┃{}1M─",
		"─".repeat(usize::from(tick - 3)),
		"─".repeat(usize::from(scale - tick - 1)),
	)
}

#[test]
fn boot_surface_matches_pi_chrome_at_120x40() {
	let (rows, cursor) = surface(120, 40);
	assert_eq!(rows.len(), 40);
	insta::assert_snapshot!(rows.join("\n"));
	// The same row anchors as the reference capture: box rows 1..=20, tip on
	// 21, two blank rows, status on 24, composer on 25.
	assert!(rows[1].starts_with("╭─── omp v"), "{}", rows[1]);
	assert!(rows[20].starts_with('╰') && rows[20].contains('┴'), "{}", rows[20]);
	assert!(rows[21].starts_with(" Tip: "), "{}", rows[21]);
	assert_eq!(rows[22], "");
	assert_eq!(rows[23], "");
	// Band segment order with the `/work` root stripped from the path,
	// the git branch, the powerline cap, and the gauge running to the edge
	// with its `1M` window label.
	assert_eq!(rows[24], expected_band(" π  > ⬢ Fable 5 > 📁 omp > ⑂ main ▶", 120, 80));
	assert!(rows[25].starts_with("╰─ Ask anything, edit files, run tools"), "{}", rows[25]);
	assert_eq!(cursor, Some((3, 25)), "caret sits after the prompt gutter");
}

#[test]
fn boot_surface_keeps_the_composer_reachable_at_80x24() {
	let (rows, cursor) = surface(80, 24);
	assert_eq!(rows.len(), 24);
	insta::assert_snapshot!(rows.join("\n"));
	let prompt = rows
		.iter()
		.position(|row| row.starts_with("╰─ Ask anything"))
		.expect("composer row visible");
	assert_eq!(cursor.map(|(_, row)| row), Some(u16::try_from(prompt).unwrap()));
	assert!(rows.iter().any(|row| row.contains("Welcome back!")));
	// The resize capture keeps the whole band with the gauge at its
	// label-preserving minimum; ours keeps every chip at 80 columns too.
	assert_eq!(rows[prompt - 1], expected_band(" π  > ⬢ Fable 5 > 📁 omp > ⑂ main ▶", 80, 80));
}

#[test]
fn headless_surface_projects_director_mode_and_advisor_health_from_the_snapshot() {
	let mut session = boot_session();
	let root = directors_root(&session);
	let advisor = insert_director(&mut session, root, "advisor", &[
		("state/status", Value::Str(Str::new_static("running"))),
		("state/yielded", Value::Bool(false)),
	]);
	insert_director(&mut session, advisor, "plan", &[]);
	let (rows, _) = surface_of(&mut session, 120, 40);
	let band = rows
		.iter()
		.find(|row| row.contains("Plan"))
		.expect("status band carries the mode chip");
	assert!(
		band.contains(ui().charset.icon(Icon::Advisor)),
		"advisor badge comes from the snapshot: {band}"
	);
	assert!(
		rows.iter().any(|row| row.starts_with('▎')),
		"plan Director reshapes the headless composer into its rail"
	);
}

#[test]
fn working_surface_swaps_the_brand_for_spinner_and_timer() {
	let mut session = boot_session();
	session.begin_turn().expect("turn");
	session
		.user("hello world", Vec::new())
		.expect("user message");
	let (rows, _) = surface_of(&mut session, 120, 40);
	insta::assert_snapshot!(rows.join("\n"));
	let band = rows
		.iter()
		.find(|row| row.contains("Fable 5 >"))
		.expect("band row");
	assert!(band.starts_with(" ⠋ 0s  > ⬢ Fable 5 > 📁 omp > ⑂ main ▶"), "{band}");
}

/// The capture's facts: a scratch project under `/tmp`, thinking `high`,
/// ~2.35% of a 1M window (the `2%` label sits on cell 1 at 120 columns and
/// cell 3 at 184), and an 85% compaction threshold.
fn capture_facts(scenario: &str) -> StatusFacts {
	StatusFacts {
		model: Str::new_static("Fable 5"),
		thinking: Some(Str::new_static("high")),
		cwd: Str::new(format!("pi-face-filler-{scenario}/pi-capture")),
		scratch: true,
		branch: Some(Str::new_static("main")),
		tokens: 23_500,
		context_window: Some(1_000_000),
		compact_percent: 85,
		..StatusFacts::default()
	}
}

fn band_row(facts: StatusFacts, width: u16) -> String {
	let ui = Ui::from_root(StatusBand::new(facts), width, ui());
	frame_text(ui.frame())
		.lines()
		.next()
		.unwrap_or_default()
		.trim_end()
		.to_owned()
}

#[test]
fn status_band_matches_pi_capture_bytes_at_120_184_and_80_columns() {
	assert_eq!(
		band_row(capture_facts("boot-120x40-parent-C61sEN"), 120),
		reference_band("boot-120x40", 24),
	);
	assert_eq!(
		band_row(capture_facts("boot-184x48-parent-jTmU1G"), 184),
		reference_band("boot-184x48", 24),
	);
	assert_eq!(
		band_row(capture_facts("resize-80x24-parent-cjj4Tr"), 80),
		reference_band("resize-80x24", 22),
	);
}

#[test]
fn status_band_working_row_carries_spinner_and_elapsed_time() {
	let mut ui = Ui::from_root(
		StatusBand::new(StatusFacts {
			working: Some(Duration::ZERO),
			..capture_facts("boot-120x40-parent-C61sEN")
		}),
		120,
		ui(),
	);
	ui.tick(Duration::from_millis(12_080));
	let row = frame_text(ui.frame())
		.lines()
		.next()
		.unwrap()
		.trim_end()
		.to_owned();
	let reference = reference_band("boot-120x40", 24);
	let group = reference[..reference.find('▶').expect("cap") + '▶'.len_utf8()].replacen(
		" π  >",
		" ⠙ 12s  >",
		1,
	);
	// The timer widens the brand by four cells, so the gauge re-plans on a
	// 45-cell gap: `2%` still sits on cell 1, the 85% tick moves with the
	// scale, and the window label keeps its trailing rule cell.
	let gap = 120 - omp_tui::cell_width(&group);
	let scale = gap - 3;
	let tick = (0.85 * f64::from(scale)).round() as u16;
	assert_eq!(
		row,
		format!(
			"{group}─2%{}┃{}1M─",
			"─".repeat(usize::from(tick - 3)),
			"─".repeat(usize::from(scale - tick - 1))
		),
	);
}
