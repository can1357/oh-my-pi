//! Widget-tier behavior tests: focus ring, keyboard contract, mouse
//! routing, conditionals, validation, values, and damage containment.

use std::{env, fmt, fs, time};

use serde_json::json;

use crate::{
	Charset, Color, Component, Elements, OverlayOptions, Prop, Props, Rect, Theme, Ui, UiContext,
	component::{Cached, HitTag, Slot},
	components::{
		Boxed, Button, CustomElement, EditInput, EditorPane, Form, Input, Radio, Select, Tabs,
		TextLeaf, Tree, Wizard,
	},
	dom,
	input::{Key, Mouse, UiEvent},
	test_support::{frame_cell_style, frame_row_text},
};

#[test]
fn table_aligns_columns_across_rows_and_truncates_the_flexible_cell() {
	let ui = Ui::from_markup(
		"<table><tr><td truncate><text>google-antigravity/gemini-3.6-flash</text></td><td \
		 align=end><text>1m</text></td><td align=end><text>$1.5/7.5</text></td></tr><tr><td \
		 truncate><text>ollama/lfm2:2.6b</text></td><td align=end><text>128k</text></td><td \
		 align=end><text>free</text></td></tr></table>",
		40,
		UiContext::default(),
	)
	.unwrap();
	let rows = rows(&ui);
	assert_eq!(rows.len(), 2, "one row per <tr>");
	// The long name collapses to a single trailing ellipsis; the short one
	// stays intact — never the garbled mid-cell clipping of raw rows.
	assert_eq!(rows[0].matches('…').count(), 1, "row 0: {:?}", rows[0]);
	assert!(rows[1].contains("ollama/lfm2:2.6b"), "row 1: {:?}", rows[1]);
	// Stat columns share one solved edge across rows and right-align
	// within it (display columns, not byte offsets — the ellipsis is
	// multi-byte).
	let column_end = |row: &str, needle: &str| {
		let at = row.find(needle).expect("needle present");
		row[..at].chars().count() + needle.chars().count()
	};
	assert_eq!(
		column_end(&rows[0], "1m"),
		column_end(&rows[1], "128k"),
		"context column aligns: {rows:?}"
	);
	assert!(rows[0].ends_with("$1.5/7.5"), "row 0 cost: {:?}", rows[0]);
	assert!(rows[1].ends_with("free"), "row 1 cost: {:?}", rows[1]);
	assert_eq!(
		rows[0].chars().count(),
		rows[1].chars().count(),
		"cost column right edge aligns: {rows:?}"
	);
}

#[test]
fn truncate_start_keeps_the_tail_with_a_leading_ellipsis() {
	let ui = Ui::from_markup(
		"<col><text truncate=start>google-antigravity/gemini-3.6-flash</text><text \
		 truncate>google-antigravity/gemini-3.6-flash</text></col>",
		20,
		UiContext::default(),
	)
	.unwrap();
	let rows = rows(&ui);
	assert!(rows[0].starts_with('…') && rows[0].ends_with("flash"), "start: {:?}", rows[0]);
	assert!(rows[1].ends_with('…'), "end: {:?}", rows[1]);
	assert_eq!(rows[0].chars().count(), 20, "start fills the width: {:?}", rows[0]);
	assert_eq!(rows[1].chars().count(), 20, "end fills the width: {:?}", rows[1]);
}

#[test]
fn cell_truncate_start_collapses_styled_runs_from_the_head() {
	let ui = Ui::from_markup(
		"<table><tr><td \
		 truncate=start><text>google-antigravity/</text><text>gemini-3.6-flash</text></td><td \
		 align=end><text>1m</text></td></tr></table>",
		24,
		UiContext::default(),
	)
	.unwrap();
	let rows = rows(&ui);
	// The provider head clips behind one leading ellipsis; the id tail
	// stays whole and the ctx column keeps its right edge.
	assert!(rows[0].contains("gemini-3.6-flash"), "row: {:?}", rows[0]);
	assert_eq!(rows[0].matches('…').count(), 1, "row: {:?}", rows[0]);
	assert!(rows[0].starts_with('…'), "row: {:?}", rows[0]);
	assert!(rows[0].ends_with("1m"), "row: {:?}", rows[0]);
}

#[test]
fn select_cell_options_align_and_seeded_filter_prunes() {
	let mut ui = Ui::from_markup(
		"<select id=pick filter=\"fla\"><option value=flash label=\"google/gemini-flash\"><td \
		 truncate><text>google/gemini-flash</text></td><td \
		 align=end><text>1m</text></td></option><option value=opus \
		 label=\"anthropic/claude-opus\"><td truncate><text>anthropic/claude-opus</text></td><td \
		 align=end><text>200k</text></td></option></select>",
		60,
		UiContext::default(),
	)
	.unwrap();
	let env = ui.focus_ring()[0];
	let select = ui
		.root_mut()
		.find_slot(env)
		.unwrap()
		.comp()
		.downcast_ref::<Select>()
		.unwrap();
	assert_eq!(select.visible_len(), 1, "filter= seeds the initial query");
	assert_eq!(
		ui.handle_key(Key::Enter),
		UiEvent::Changed { id: "pick".into(), value: "flash".into() },
		"enter commits the only match"
	);
}

fn select_of(ui: &mut Ui) -> &Select {
	let slot = ui.focus_ring()[0];
	ui.root_mut()
		.find_slot(slot)
		.unwrap()
		.comp()
		.downcast_ref::<Select>()
		.unwrap()
}

/// A preselected (recommended) row deep in a long list is painted with the
/// cursor on the very first layout: the window jumps to it in one pass
/// instead of creeping one row per frame.
#[test]
fn select_scrolls_the_preselected_row_into_view_on_the_first_layout() {
	let options: String = (0..200)
		.map(|index| {
			let recommended = if index == 150 { " recommended" } else { "" };
			format!("<option value=m{index} label=\"model {index}\"{recommended}/>")
		})
		.collect();
	let mut ui = Ui::from_markup(
		&format!("<select id=pick filter h=6>{options}</select>"),
		40,
		UiContext::default(),
	)
	.unwrap();
	let select = select_of(&mut ui);
	assert_eq!(select.cursor_option(), Some(150), "focus rests on the chosen row");
	let scroll = select.scroll_offset();
	assert!((146..=150).contains(&scroll), "window contains the cursor: scroll {scroll}");
	let painted = rows(&ui).join("\n");
	assert!(painted.contains("model 150"), "the chosen row is on screen:\n{painted}");
	assert!(!painted.contains("model 0\n"), "the top of the list scrolled away:\n{painted}");
	// End jumps the whole distance in one frame too.
	ui.handle_key(Key::End);
	let painted = rows(&ui).join("\n");
	assert!(painted.contains("model 199"), "End lands on the last row:\n{painted}");
}

/// Filtering ranks whole-word and contiguous matches ahead of scattered
/// subsequences, puts the current (recommended) option
/// first among equals, and returns the cursor to the best match whenever
/// the rows above it changed.
#[test]
fn select_filter_ranks_word_matches_first_and_resets_the_cursor_to_the_best_match() {
	let mut ui = Ui::from_markup(
		"<select id=models filter h=8><option value=0 label=\"Abliteration llama-3 \
		 abliteration/llama-3\"/><option value=1 label=\"OpenRouter Qwen Plus \
		 openrouter/qwen/qwen-plus\"/><option value=2 label=\"OpenRouter gpt-oss-120b \
		 openrouter/openai/gpt-oss-120b\"/><option value=3 label=\"Zai glm-4-plus \
		 zai/glm-4-plus\"/><option value=4 label=\"Anthropic Claude Opus 4.6 \
		 anthropic/claude-opus-4-6\"/><option value=5 label=\"Anthropic Claude Opus 5 \
		 anthropic/claude-opus-5\" recommended/><option value=6 label=\"OpenRouter Claude Opus 5 \
		 openrouter/anthropic/claude-opus-5\"/></select>",
		80,
		UiContext::default(),
	)
	.unwrap();
	assert_eq!(select_of(&mut ui).cursor_option(), Some(5), "the current model preselects");
	for character in "opus".chars() {
		ui.handle_key(Key::Char(character));
	}
	let select = select_of(&mut ui);
	assert_eq!(select.visible_len(), 3, "o-p-u-s scattered across words never matches");
	assert_eq!(select.cursor_option(), Some(5), "the current model ranks first for `opus`");
	// Typing on keeps the cursor only while the rows above it are unchanged.
	ui.handle_key(Key::Down);
	assert_ne!(select_of(&mut ui).cursor_option(), Some(5));
	ui.handle_key(Key::Char(' '));
	ui.handle_key(Key::Char('4'));
	let select = select_of(&mut ui);
	assert_eq!(select.visible_len(), 1);
	assert_eq!(
		select.cursor_option(),
		Some(4),
		"the list changed above the cursor: back to the top"
	);
}

#[test]
fn segmented_and_checkbox_export_keyboard_and_mouse_transitions() {
	let mut ui = Ui::from_markup(
		"<col><segmented id=view value=tree><option value=path icon=view-path label=Path/><option \
		 value=tree icon=view-tree label=Tree/></segmented><checkbox id=amend checked label=\"Amend \
		 previous commit\"/></col>",
		60,
		UiContext::default(),
	)
	.unwrap();
	let ring = ui.focus_ring();
	let segmented = ring[0];
	let checkbox = ring[1];
	assert_eq!(ui.values()["view"], json!("tree"));
	assert_eq!(ui.values()["amend"], json!(true));

	ui.set_focus_slot(Some(segmented));
	assert_eq!(ui.handle_key(Key::Left), UiEvent::None);
	assert_eq!(ui.values()["view"], json!("path"));
	let tree = ui
		.hits()
		.iter()
		.find(|hit| hit.slot == segmented && hit.tag == HitTag::Chip(1))
		.copied()
		.unwrap();
	ui.handle_mouse(tree.rect.x, tree.rect.y, Mouse::Click);
	assert_eq!(ui.values()["view"], json!("tree"));

	ui.set_focus_slot(Some(checkbox));
	assert_eq!(ui.handle_key(Key::Space), UiEvent::None);
	assert_eq!(ui.values()["amend"], json!(false));
	let mark = ui
		.hits()
		.iter()
		.find(|hit| hit.slot == checkbox && hit.tag == HitTag::Press)
		.copied()
		.unwrap();
	ui.handle_mouse(mark.rect.x, mark.rect.y, Mouse::Click);
	assert_eq!(ui.values()["amend"], json!(true));
}

#[test]
fn layer_mouse_routing_translates_bands_and_reports_outside() {
	use crate::{OverlayAnchor, OverlayOptions, Size, markup::Dim};
	let mut ui = Ui::from_markup("<button id=go>Go</button>", 20, UiContext::default()).unwrap();
	let options = OverlayOptions::default()
		.anchor(OverlayAnchor::Bottom)
		.width(Dim::Pct(100));
	let viewport = Size::new(20, 12);
	let top = 12 - ui.height();
	assert_eq!(
		ui.handle_mouse_as_layer(&options, viewport, 2, top, Mouse::Click),
		Some(UiEvent::Pressed("go".into())),
		"clicks translate into the layer's local cells"
	);
	assert_eq!(
		ui.handle_mouse_as_layer(&options, viewport, 2, 0, Mouse::Click),
		None,
		"gestures outside the band fall through to the host"
	);
}

fn rows(ui: &Ui) -> Vec<String> {
	(0..ui.frame().size().height)
		.map(|y| frame_row_text(ui.frame(), y))
		.collect()
}

fn editor_pane(cached: &Cached) -> Option<&EditorPane> {
	if cached.comp().is::<EditorPane>() {
		return cached.comp().downcast_ref::<EditorPane>();
	}
	cached.comp().children().iter().find_map(editor_pane)
}

fn editor_pane_mut(cached: &mut Cached) -> Option<&mut EditorPane> {
	if cached.comp().is::<EditorPane>() {
		return cached.comp_mut().downcast_mut::<EditorPane>();
	}
	cached
		.comp_mut()
		.children_mut()
		.iter_mut()
		.find_map(editor_pane_mut)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
	Tabs,
	Form,
	Select,
	Tree,
	Segment,
	Input,
	Button,
	Editor,
	Wizard,
}

fn kind_of(ui: &mut Ui, slot: Slot) -> Kind {
	let comp = ui.root_mut().find_slot(slot).unwrap().comp();
	if comp.is::<Tabs>() {
		Kind::Tabs
	} else if comp.is::<Form>() {
		Kind::Form
	} else if comp.is::<Select>() {
		Kind::Select
	} else if comp.is::<Tree>() {
		Kind::Tree
	} else if comp.is::<Radio>() {
		Kind::Segment
	} else if comp.is::<Input>() {
		Kind::Input
	} else if comp.is::<Button>() {
		Kind::Button
	} else if comp.is::<EditorPane>() || comp.is::<EditInput>() {
		Kind::Editor
	} else if comp.is::<Wizard>() {
		Kind::Wizard
	} else {
		panic!("unexpected focus-ring component")
	}
}

fn id_of(ui: &mut Ui, slot: Slot) -> Option<String> {
	ui.root_mut()
		.find_slot(slot)
		.and_then(|cached| cached.comp().props().id())
		.map(|id| id.to_string())
}

const SINK: &str = r#"<col>
<tabs id=view><tab title="Config"><form id=cfg>
<field id=strict kind=bool label="Strict" value=true/>
<field id=region kind=enum label="Region" options="us eu ap" value=eu/>
<field id=name kind=text label="Name" value="omp"/>
<field id=theme kind=select label="Theme" options="dark light nord"/>
<field id=scopes kind=multi label="Scopes" options="repo issues actions" value="repo"/>
<field id=replicas kind=number label="Replicas" value=3 min=1 max=12/>
</form></tab><tab title="Notes"><editor id=notes value="line one"/></tab></tabs>
<select id=env label="Environment" custom filter>
<option value=prod recommended desc="full fleet">Production</option>
<option value=stage>Staging</option>
</select>
<select id=checks multi>
<option value=lint>lint</option>
<option value=unit>unit tests</option>
</select>
<tree id=target>
<node label="services" open><node label="api"/><node label="workers"/></node>
<node label="edge"/>
</tree>
<radio id=model options="sol terra kimi fable" value=fable/>
<input id=reason placeholder="why"/>
<progress value=40 label="ready"/>
<row gap=2>
<button id=abort cancel>Cancel</button>
<button id=reset confirm>Reset</button>
<button id=go submit>Deploy</button>
</row>
</col>"#;

#[test]
fn focus_ring_matches_document_order_and_tab_scope() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	let kinds: Vec<Kind> = ui
		.focus_ring()
		.iter()
		.map(|&n| kind_of(&mut ui, n))
		.collect();
	use Kind as K;
	assert_eq!(kinds, vec![
		K::Tabs,
		K::Form, // active pane only — the Notes editor is not here
		K::Select,
		K::Select,
		K::Tree,
		K::Segment,
		K::Input,
		K::Button,
		K::Button,
		K::Button,
	]);
}

#[test]
fn select_contract_recommended_edges_search_custom() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	// focus the env select (ring index 2)
	let env = ui.focus_ring()[2];
	ui.set_focus_slot(Some(env));
	assert_eq!(ui.values()["env"], json!("prod"), "recommended preselects");

	// Down to Staging; Enter commits it and surfaces the change
	ui.handle_key(Key::Down);
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Changed {
		id:    "env".into(),
		value: "stage".into(),
	});
	assert_eq!(ui.values()["env"], json!("stage"));

	// A filterable browser wraps at the edges instead of releasing focus
	ui.handle_key(Key::Up); // back to row 0
	let before = ui.focus_slot();
	ui.handle_key(Key::Up); // edge: wraps to the last row, focus retained
	assert_eq!(ui.focus_slot(), before, "filterable selects wrap at the top edge");

	// Type-to-filter: no `/` mode, the query surfaces with the cursor value
	assert_eq!(ui.handle_key(Key::Char('s')), UiEvent::Filtered {
		id:    "env".into(),
		query: "s".into(),
		value: Some("stage".into()),
	});
	let select = ui
		.root_mut()
		.find_slot(env)
		.unwrap()
		.comp()
		.downcast_ref::<Select>()
		.unwrap();
	assert_eq!(select.visible_len(), 1, "filtered to Staging");
	// The cancel ladder: a first Esc clears the query and keeps the widget;
	// the positional cursor now points at the full list's first row.
	assert_eq!(ui.handle_key(Key::Esc), UiEvent::Filtered {
		id:    "env".into(),
		query: "".into(),
		value: Some("prod".into()),
	});
	let select = ui
		.root_mut()
		.find_slot(env)
		.unwrap()
		.comp()
		.downcast_ref::<Select>()
		.unwrap();
	assert_eq!(select.visible_len(), 3);

	// custom entry: last row, enter -> inline edit, type, enter
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Enter);
	for c in "dr site".chars() {
		ui.handle_key(if c == ' ' { Key::Space } else { Key::Char(c) });
	}
	ui.handle_key(Key::Enter);
	assert_eq!(ui.values()["env"], json!("dr site"));
}

#[test]
fn multi_select_toggles_and_reports_array() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	let checks = ui.focus_ring()[3];
	ui.set_focus_slot(Some(checks));
	ui.handle_key(Key::Space);
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Space);
	assert_eq!(ui.values()["checks"], json!(["lint", "unit"]));
	ui.handle_key(Key::Space); // toggle unit back off
	assert_eq!(ui.values()["checks"], json!(["lint"]));
}

#[test]
fn form_covers_all_field_kinds() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	let form = ui.focus_ring()[1];
	ui.set_focus_slot(Some(form));

	ui.handle_key(Key::Space); // bool toggle
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Right); // enum cycles in place
	let focus_before = ui.focus_slot();
	assert_eq!(ui.focus_slot(), focus_before);
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Enter); // text edit mode
	ui.handle_key(Key::Char('x'));
	ui.handle_key(Key::Enter);
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Enter); // select submenu opens
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Enter); // pick 'light'
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Enter); // multi submenu
	ui.handle_key(Key::Down);
	ui.handle_key(Key::Space); // toggle issues
	ui.handle_key(Key::Esc);
	ui.handle_key(Key::Down);
	for _ in 0..20 {
		ui.handle_key(Key::Right); // number clamps at max
	}
	assert_eq!(
		ui.values()["cfg"],
		json!({
			"strict": false,
			"region": "ap",
			"name": "ompx",
			"theme": "light",
			"scopes": ["repo", "issues"],
			"replicas": 12,
		})
	);
}

#[test]
fn tabs_switch_changes_ring_and_value() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	assert_eq!(ui.values()["view"], json!("Config"));
	ui.handle_key(Key::Right); // tabs focused first; switch pane
	assert_eq!(ui.values()["view"], json!("Notes"));
	let kinds: Vec<Kind> = ui
		.focus_ring()
		.iter()
		.map(|&n| kind_of(&mut ui, n))
		.collect();
	assert!(kinds.contains(&Kind::Editor));
	assert!(!kinds.contains(&Kind::Form));
}

#[test]
fn tree_expand_collapse_select() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	let tree = ui.focus_ring()[4];
	ui.set_focus_slot(Some(tree));
	ui.handle_key(Key::Down); // api
	ui.handle_key(Key::Enter); // leaf select
	assert_eq!(ui.values()["target"], json!("services/api"));
	ui.handle_key(Key::Up);
	ui.handle_key(Key::Left); // collapse services
	assert_eq!(
		ui.root_mut()
			.find_slot(tree)
			.unwrap()
			.comp()
			.downcast_ref::<Tree>()
			.unwrap()
			.visible_rows_len(),
		2
	);
	ui.handle_key(Key::Right); // expand again
	assert_eq!(
		ui.root_mut()
			.find_slot(tree)
			.unwrap()
			.comp()
			.downcast_ref::<Tree>()
			.unwrap()
			.visible_rows_len(),
		4
	);
}

#[test]
fn editor_set_text_grows_layout_and_paints_every_row() {
	let mut ui = Ui::from_root(
		EditorPane::new().input(TextLeaf::new()).with(Prop::Id, "e"),
		40,
		UiContext::default(),
	);
	let initial_height = ui.height();

	assert!(ui.set_text("e", "one\ntwo\nthree"));
	assert_eq!(ui.height(), initial_height.saturating_add(2));
	assert_eq!(frame_row_text(ui.frame(), 0), "one");
	assert_eq!(frame_row_text(ui.frame(), 1), "two");
	assert_eq!(frame_row_text(ui.frame(), 2), "three");
}

#[test]
fn editor_typing_newline_join_and_value() {
	let mut ui = Ui::from_markup("<editor id=e value=\"ab\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Enter); // split at end -> two lines
	ui.handle_key(Key::Char('c'));
	assert_eq!(ui.values()["e"], json!("ab\nc"));
	ui.handle_key(Key::Home);
	ui.handle_key(Key::Backspace); // join back
	assert_eq!(ui.values()["e"], json!("abc"));
	// vertical edge releases focus
	ui.handle_key(Key::Up);
	ui.handle_key(Key::Up);
	assert_eq!(ui.focus_slot(), Some(editor), "single widget: ring wraps to itself");
}
#[test]
fn editor_readline_chords_edit_and_move() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"alpha beta gamma\"/>", 40, UiContext::default())
			.unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::End);
	ui.handle_key(Key::Ctrl('w')); // rubout "gamma"
	assert_eq!(ui.values()["e"], json!("alpha beta "));
	ui.handle_key(Key::Ctrl('a'));
	ui.handle_key(Key::WordRight); // end of "alpha"
	ui.handle_key(Key::Ctrl('k')); // kill to line end
	assert_eq!(ui.values()["e"], json!("alpha"));
	ui.handle_key(Key::Char('!'));
	ui.handle_key(Key::WordLeft); // '!' is its own word: lands before it
	ui.handle_key(Key::WordLeft); // start of "alpha"
	ui.handle_key(Key::Ctrl('u')); // nothing before the cursor at column 0
	assert_eq!(ui.values()["e"], json!("alpha!"));
	// ShiftEnter splits exactly like Enter
	ui.handle_key(Key::Ctrl('e'));
	ui.handle_key(Key::ShiftEnter);
	ui.handle_key(Key::Char('x'));
	assert_eq!(ui.values()["e"], json!("alpha!\nx"));
	// Ctrl-K at end of line consumes the newline
	ui.handle_key(Key::Up);
	ui.handle_key(Key::End);
	ui.handle_key(Key::Ctrl('k'));
	assert_eq!(ui.values()["e"], json!("alpha!x"));
}

#[test]
fn input_readline_chords_edit_and_move() {
	let mut ui =
		Ui::from_markup("<input id=i value=\"one two three\"/>", 40, UiContext::default()).unwrap();
	let input = ui.focus_ring()[0];
	ui.set_focus_slot(Some(input));
	ui.handle_key(Key::Ctrl('e'));
	ui.handle_key(Key::Ctrl('w'));
	assert_eq!(ui.values()["i"], json!("one two "));
	ui.handle_key(Key::WordLeft); // start of "two"
	ui.handle_key(Key::Ctrl('k'));
	assert_eq!(ui.values()["i"], json!("one "));
	ui.handle_key(Key::Ctrl('u')); // discard everything before the cursor
	assert_eq!(ui.values()["i"], json!(""));
}
#[test]
fn editor_horizontal_motion_wraps_across_lines() {
	let mut ui = Ui::from_markup("<editor id=e value=\"ab\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Enter); // "ab" / ""
	ui.handle_key(Key::Char('c')); // "ab" / "c"
	ui.handle_key(Key::Home);
	// Left at column 0 of line 2 lands at the end of line 1
	ui.handle_key(Key::Left);
	ui.handle_key(Key::Char('X'));
	assert_eq!(ui.values()["e"], json!("abX\nc"));
	// Right at end of line 1 lands at the start of line 2
	ui.handle_key(Key::Right);
	ui.handle_key(Key::Char('Y'));
	assert_eq!(ui.values()["e"], json!("abX\nYc"));
}
#[test]
fn editor_word_motion_crosses_line_boundaries() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"alpha beta\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Enter);
	ui.handle_key(Key::Char('c'));
	ui.handle_key(Key::Home);
	// Word-motion commands cross one logical-line boundary at a time.
	ui.handle_key(Key::WordLeft);
	ui.handle_key(Key::Char('X'));
	assert_eq!(ui.values()["e"], json!("alpha betaX\nc"));
	ui.handle_key(Key::End);
	ui.handle_key(Key::WordRight);
	ui.handle_key(Key::Char('Y'));
	assert_eq!(ui.values()["e"], json!("alpha betaX\nYc"));
}

#[test]
fn set_height_resizes_in_place_preserving_widget_state() {
	let src = "<tabs id=v><tab title=\"A\"><scroll id=pane h=4><text>alpha \
	           content</text></scroll></tab><tab title=\"B\"><text>beta pane</text></tab></tabs>";
	let mut ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	let focus = ui.focus_ring()[0];
	ui.set_focus_slot(Some(focus));
	ui.handle_key(Key::Right); // activate tab B
	assert_eq!(ui.values()["v"], json!("B"));
	assert!(ui.set_height("pane", 9));
	ui.resize(38);
	assert_eq!(ui.values()["v"], json!("B"), "resize keeps the active tab");
	assert!(!ui.set_height("nope", 3));
	// the new height is live once the pane's tab is active again
	ui.handle_key(Key::Left);
	assert_eq!(ui.values()["v"], json!("A"));
}
#[test]
fn editor_delete_removes_forward_and_joins_lines() {
	let mut ui = Ui::from_markup("<editor id=e value=\"ab\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Home);
	ui.handle_key(Key::Delete);
	assert_eq!(ui.values()["e"], json!("b"));
	// split, then forward-delete at end of line joins back
	ui.handle_key(Key::End);
	ui.handle_key(Key::Enter);
	ui.handle_key(Key::Char('c'));
	ui.handle_key(Key::Up);
	ui.handle_key(Key::End);
	ui.handle_key(Key::Delete);
	assert_eq!(ui.values()["e"], json!("bc"));
}

#[test]
fn set_text_on_hidden_tab_pane_defers_paint_until_activation() {
	let src = "<tabs id=v><tab title=\"A\"><text>alpha pane</text></tab><tab title=\"B\"><md \
	           id=doc>original</md></tab></tabs>";
	let mut ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	// pane B is inactive: the update must not paint anywhere
	assert!(ui.set_text("doc", "REPLACED"));
	let painted = rows(&ui);
	assert!(
		!painted.iter().any(|row| row.contains("REPLACED")),
		"hidden pane must not repaint over the active tab: {painted:?}"
	);
	assert!(painted.iter().any(|row| row.contains("alpha pane")));
	// activate pane B: the deferred content appears
	let focus = ui.focus_ring()[0];
	ui.set_focus_slot(Some(focus));
	ui.handle_key(Key::Right);
	let painted = rows(&ui);
	assert!(
		painted.iter().any(|row| row.contains("REPLACED")),
		"activation places and paints the updated text: {painted:?}"
	);
	assert!(!painted.iter().any(|row| row.contains("alpha pane")));
	// and switching back away again leaves no ghost of pane B
	ui.handle_key(Key::Left);
	let painted = rows(&ui);
	assert!(!painted.iter().any(|row| row.contains("REPLACED")), "{painted:?}");
}

#[test]
fn buttons_confirm_cancel_submit_pressed() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	let ring = ui.focus_ring();
	let (abort, reset, go) = (ring[7], ring[8], ring[9]);

	ui.set_focus_slot(Some(reset));
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::None); // arms
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Pressed("reset".into()));

	ui.set_focus_slot(Some(go));
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Submit);
	ui.set_focus_slot(Some(abort));
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Cancel);
	// Esc anywhere without a consumer cancels
	ui.set_focus_slot(Some(go));
	assert_eq!(ui.handle_key(Key::Esc), UiEvent::Cancel);
}

const WIZ: &str = r#"<wizard id=w submit>
<step title="name">
<input id=srv required match="[a-z][a-z0-9-]*" placeholder="name"/>
</step>
<step title="transport">
<form id=tp><field id=transport kind=enum label="Transport" options="stdio http"/></form>
<input id=command when="transport=stdio" required placeholder="cmd"/>
<input id=url when="transport!=stdio" required placeholder="url"/>
</step>
<step title="confirm">done</step>
</wizard>"#;

#[test]
fn wizard_validation_conditionals_and_submit() {
	let mut ui = Ui::from_markup(WIZ, 60, UiContext::default()).unwrap();
	let ring = ui.focus_ring();
	let wizard = *ring.last().unwrap();
	assert_eq!(kind_of(&mut ui, wizard), Kind::Wizard);

	// Next blocked: required empty
	ui.set_focus_slot(Some(wizard));
	ui.handle_key(Key::Right);
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::None);
	let wizard_comp = ui
		.root_mut()
		.find_slot(wizard)
		.unwrap()
		.comp()
		.downcast_ref::<Wizard>()
		.unwrap();
	assert!(wizard_comp.error().is_some_and(|e| e.contains("required")));
	assert_eq!(wizard_comp.step_index(), 0);

	// invalid per match=
	let input = ring[0];
	ui.set_focus_slot(Some(input));
	for c in "Bad!".chars() {
		ui.handle_key(Key::Char(c));
	}
	ui.set_focus_slot(Some(wizard));
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::None);
	let wizard_comp = ui
		.root_mut()
		.find_slot(wizard)
		.unwrap()
		.comp()
		.downcast_ref::<Wizard>()
		.unwrap();
	assert!(wizard_comp.error().is_some_and(|e| e.contains("match")));

	// fix the name -> step 2
	ui.set_focus_slot(Some(input));
	for _ in 0..4 {
		ui.handle_key(Key::Backspace);
	}
	for c in "github".chars() {
		ui.handle_key(Key::Char(c));
	}
	ui.set_focus_slot(Some(wizard));
	ui.handle_key(Key::Enter);
	let wizard_comp = ui
		.root_mut()
		.find_slot(wizard)
		.unwrap()
		.comp()
		.downcast_ref::<Wizard>()
		.unwrap();
	assert_eq!(wizard_comp.step_index(), 1);

	// conditional: stdio -> command visible, url not
	let ring = ui.focus_ring();
	let ids: Vec<_> = ring
		.iter()
		.filter_map(|&slot| id_of(&mut ui, slot))
		.collect();
	assert!(ids.iter().any(|i| i == "command"));
	assert!(!ids.iter().any(|i| i == "url"));

	// flip transport -> url swaps in; command value would be excluded
	let form = *ring
		.iter()
		.find(|&&n| kind_of(&mut ui, n) == Kind::Form)
		.unwrap();
	ui.set_focus_slot(Some(form));
	ui.handle_key(Key::Right); // stdio -> http
	let ring = ui.focus_ring();
	let ids: Vec<_> = ring
		.iter()
		.filter_map(|&slot| id_of(&mut ui, slot))
		.collect();
	assert!(ids.iter().any(|i| i == "url"));
	assert!(!ids.iter().any(|i| i == "command"));
	assert!(ui.values().get("command").is_none(), "hidden values excluded");

	// fill url, advance, finish -> Submit
	let url = *ring
		.iter()
		.find(|&&slot| id_of(&mut ui, slot).as_deref() == Some("url"))
		.unwrap();
	ui.set_focus_slot(Some(url));
	for c in "https".chars() {
		ui.handle_key(Key::Char(c));
	}
	let wizard_ring = ui.focus_ring();
	ui.set_focus_slot(wizard_ring.last().copied());
	ui.handle_key(Key::Enter); // -> confirm
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Submit);
	assert_eq!(ui.values()["srv"], json!("github"));
	assert_eq!(ui.values()["url"], json!("https"));
}

#[test]
fn scroll_chases_focus_and_contains_damage() {
	let filler = (0..12).fold(String::new(), |mut filler, i| {
		let _ = fmt::Write::write_fmt(&mut filler, format_args!("<text>filler {i}</text>"));
		filler
	});
	let src = format!(
		"<col><text>top marker</text><scroll h=4>{filler}<input id=deep \
		 placeholder=x/></scroll><text>bottom marker</text></col>"
	);
	let mut ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	let before = rows(&ui);
	assert_eq!(before.len(), 6); // top + 4 window rows + bottom

	// initial focus is the scroll itself; one Tab reaches the buried
	// input and the viewport must chase it into the window
	ui.handle_key(Key::Tab);
	let deep = ui.focus_slot().unwrap();
	assert_eq!(id_of(&mut ui, deep).as_deref(), Some("deep"));
	let after_chase = rows(&ui);
	assert_eq!(after_chase[0], "top marker");
	assert_eq!(after_chase[5], "bottom marker");
	assert!(
		after_chase[1..5].iter().any(|r| r.contains('❯')),
		"input row visible inside window: {after_chase:?}"
	);

	// typing repaints ONLY window rows; outside rows byte-identical
	for c in "hi".chars() {
		ui.handle_key(Key::Char(c));
	}
	let after_typing = rows(&ui);
	assert_eq!(after_typing[0], "top marker");
	assert_eq!(after_typing[5], "bottom marker");
	assert!(after_typing[1..5].iter().any(|r| r.contains("hi")));
	assert_eq!(ui.values()["deep"], json!("hi"));
}

#[test]
fn mouse_clicks_route_through_translated_hits() {
	let mut ui = Ui::from_markup(SINK, 80, UiContext::default()).unwrap();
	// click the Staging row via its hit rect
	let env = ui.focus_ring()[2];
	let hit = ui
		.hits()
		.iter()
		.find(|h| h.slot == env && matches!(h.tag, crate::component::HitTag::Row(1)))
		.copied()
		.unwrap();
	ui.handle_mouse(hit.rect.x + 3, hit.rect.y, Mouse::Click);
	assert_eq!(ui.values()["env"], json!("stage"));
	assert_eq!(ui.focus_slot(), Some(env), "click steals focus");

	// radio chip click
	let radio = ui.focus_ring()[5];
	let chip = ui
		.hits()
		.iter()
		.find(|h| h.slot == radio && matches!(h.tag, crate::component::HitTag::Chip(0)))
		.copied()
		.unwrap();
	ui.handle_mouse(chip.rect.x + 1, chip.rect.y, Mouse::Click);
	assert_eq!(ui.values()["model"], json!("sol"));

	// hover sets and keyboard clears
	let go = ui.focus_ring()[9];
	let press = ui.hits().iter().find(|h| h.slot == go).copied().unwrap();
	ui.handle_mouse(press.rect.x + 1, press.rect.y, Mouse::Move);
	assert!(ui.hover_slot().is_some());
	ui.handle_key(Key::Down);
	assert!(ui.hover_slot().is_none(), "keyboard input clears hover");
}

#[test]
fn drag_over_scroll_pane_updates_hover() {
	let mut ui = Ui::from_markup(
		"<scroll h=2><button id=drag>drag target</button><text>tail</text></scroll>",
		30,
		UiContext::default(),
	)
	.unwrap();
	let target = ui
		.hits()
		.iter()
		.find(|hit| hit.tag == HitTag::Press)
		.copied()
		.unwrap();
	ui.handle_mouse(target.rect.x, target.rect.y, Mouse::Drag);
	assert_eq!(ui.hover_slot(), Some(target.slot));
}

#[test]
fn hover_and_lift_props_elevate_a_box_and_swap_its_chrome() {
	let mut ui = Ui::from_markup(
		"<box border=square bc=#334455 hover=#ff0000 lift=1><text>hi</text></box>",
		20,
		UiContext::default(),
	)
	.unwrap();
	let zone = ui
		.hits()
		.iter()
		.find(|hit| hit.tag == HitTag::Zone)
		.copied()
		.unwrap();
	assert_eq!(zone.rect, Rect::new(0, 0, 20, 4), "the zone spans the resting rectangle");
	assert_eq!(rows(&ui)[0], "", "lift reserves headroom above the resting chrome");
	let resting = frame_cell_style(ui.frame(), 0, 1).foreground_color();
	assert_eq!(resting, Color::Rgb(0x33, 0x44, 0x55));

	ui.handle_mouse(zone.rect.x + 1, zone.rect.y + 2, Mouse::Move);
	let lifted = rows(&ui);
	assert_ne!(lifted[0], "", "hover raises the chrome into the headroom");
	assert!(lifted[3].contains('▀'), "the vacated row carries the shadow");
	let hovered = frame_cell_style(ui.frame(), 0, 0).foreground_color();
	assert_eq!(hovered, Color::Rgb(0xff, 0x00, 0x00), "hover chrome swaps the border color");

	ui.handle_key(Key::Down);
	assert_eq!(rows(&ui)[0], "", "clearing hover drops the box back to rest");
	let rested = frame_cell_style(ui.frame(), 0, 1).foreground_color();
	assert_eq!(rested, Color::Rgb(0x33, 0x44, 0x55), "the displaced border color returns");
}

#[test]
fn ramped_hover_glows_toward_the_pointer() {
	let mut ui = Ui::from_markup(
		"<box border=square bc=#334455 hover=#ff0000..#0000ff><text>hi</text></box>",
		40,
		UiContext::default(),
	)
	.unwrap();
	ui.handle_mouse(1, 1, Mouse::Move);
	let near = frame_cell_style(ui.frame(), 0, 0).foreground_color();
	let far = frame_cell_style(ui.frame(), 39, 0).foreground_color();
	assert_ne!(near, Color::Rgb(0x33, 0x44, 0x55), "cells near the pointer glow");
	assert_eq!(far, Color::Rgb(0x33, 0x44, 0x55), "the glow fades with distance");
	ui.handle_mouse(0, 10, Mouse::Move);
	let rested = frame_cell_style(ui.frame(), 0, 0).foreground_color();
	assert_eq!(rested, Color::Rgb(0x33, 0x44, 0x55), "the border returns off-hover");
}

#[test]
fn keyboard_focus_bloom_spreads_from_the_chrome_center() {
	// Both ramp stops are red so any tint change reads on one channel.
	let mut ui = Ui::from_markup(
		"<box focus id=card border=square bc=#334455 hover=#ff0000..#ff0000 lift=1 \
		 anim=220><text>hi</text></box>",
		21,
		UiContext::default(),
	)
	.unwrap();
	let red = |ui: &Ui, x: u16, y: u16| match frame_cell_style(ui.frame(), x, y).foreground_color() {
		Color::Rgb(r, ..) => r,
		other => panic!("border cell must be rgb, got {other:?}"),
	};
	ui.handle_key(Key::Tab);
	// The bloom starts from nothing instead of swapping in full-width.
	assert_eq!(red(&ui, 0, 1), 0x33);
	assert_eq!(red(&ui, 10, 1), 0x33);
	// Past the first FRAME wake: the lift has hopped (keyboard pace) but
	// the bloom is still early in its declared 220ms linear spread.
	ui.tick(time::Duration::from_millis(50));
	// Mid-flight the glow is strongest at the top-center and still fading
	// toward the corners: a spread, not a uniform crossfade.
	assert!(
		red(&ui, 10, 0) > red(&ui, 0, 0),
		"the bloom radiates from the center: top-middle {} vs corner {}",
		red(&ui, 10, 0),
		red(&ui, 0, 0),
	);
	assert!(red(&ui, 10, 0) < 0xc8, "the spread is still mid-flight, not an instant swap");
	ui.tick(time::Duration::from_millis(400));
	assert!(
		red(&ui, 10, 0) > 0xc8 && red(&ui, 0, 0) > 0xc8,
		"the ramp blankets the ring at rest: top-middle {} corner {}",
		red(&ui, 10, 0),
		red(&ui, 0, 0),
	);
	assert_eq!(ui.next_wake(), None, "a settled keyboard bloom schedules no further wakes");
}

#[test]
fn keyboard_focus_hops_outpace_the_declared_ease() {
	let mut ui = Ui::from_markup(
		"<box focus id=card border=square bc=#334455 hover=#ff0000 lift=1 \
		 anim=220><text>hi</text></box>",
		20,
		UiContext::default(),
	)
	.unwrap();
	assert_eq!(rows(&ui)[0], "", "the box rests below its headroom");
	ui.handle_key(Key::Tab);
	ui.tick(time::Duration::from_millis(80));
	// The declared linear 220ms pace would still round the rise to zero
	// at 80ms; the keyboard hop (110ms, ease-out) already claimed the row.
	assert_ne!(rows(&ui)[0], "", "keyboard hops rise at the snappy pace");
}

#[test]
fn arrow_keys_walk_a_wrapped_grid_spatially() {
	let mut ui = Ui::from_markup(
		"<row wrap><box focus id=a w=8 border=square><text>a</text></box><box focus id=b w=8 \
		 border=square><text>b</text></box><box focus id=c w=8 \
		 border=square><text>c</text></box><box focus id=d w=8 \
		 border=square><text>d</text></box></row>",
		16,
		UiContext::default(),
	)
	.unwrap();
	let ring = ui.focus_ring();
	assert_eq!(ui.focus_slot(), Some(ring[0]));
	ui.handle_key(Key::Down);
	assert_eq!(ui.focus_slot(), Some(ring[2]), "down lands on the card below, not the ring next");
	ui.handle_key(Key::Right);
	assert_eq!(ui.focus_slot(), Some(ring[3]));
	ui.handle_key(Key::Up);
	assert_eq!(ui.focus_slot(), Some(ring[1]), "up returns to the row above in the same column");
	ui.handle_key(Key::Up);
	assert_eq!(ui.focus_slot(), Some(ring[0]), "no row above falls back to ring order");
}

#[test]
fn focus_prop_joins_the_ring_and_presses_on_enter() {
	let mut ui = Ui::from_markup(
		"<col><button id=first>first</button><box focus id=card border=square bc=#334455 \
		 hover=#ff0000 lift=1><text>hi</text></box></col>",
		20,
		UiContext::default(),
	)
	.unwrap();
	// Initial focus lands on the button; the box rests below its headroom.
	assert_eq!(rows(&ui)[1], "", "the box rests below its headroom");
	ui.handle_key(Key::Tab);
	assert_ne!(rows(&ui)[1], "", "keyboard focus lifts the decorated box");
	let focused = frame_cell_style(ui.frame(), 0, 1).foreground_color();
	assert_eq!(focused, Color::Rgb(0xff, 0x00, 0x00), "focus swaps the hover chrome");
	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Pressed("card".into()), "enter presses the id");
}

#[test]
fn one_chrome_cursor_across_input_modalities() {
	let mut ui = Ui::from_markup(
		"<col><box focus id=a border=square bc=#334455 hover=#ff0000 \
		 lift=1><text>a</text></box><box focus id=b border=square bc=#334455 hover=#ff0000 \
		 lift=1><text>b</text></box></col>",
		20,
		UiContext::default(),
	)
	.unwrap();
	// Initial focus is mouse-neutral: nothing rings before any input.
	assert_eq!(rows(&ui)[0], "", "no chrome cursor before input");

	ui.handle_key(Key::Char('x'));
	assert_ne!(rows(&ui)[0], "", "keyboard input rings the focused box");

	// Pointer over the second box: the chrome cursor moves with it and the
	// focused box drops its ring — never two cursors at once.
	ui.handle_mouse(1, 6, Mouse::Move);
	let moused = rows(&ui);
	assert_eq!(moused[0], "", "mouse motion takes the chrome from focus");
	assert_ne!(moused[4], "", "the hovered box lifts instead");

	ui.handle_key(Key::Char('x'));
	let keyed = rows(&ui);
	assert_ne!(keyed[0], "", "keyboard reclaims the chrome for focus");
	assert_eq!(keyed[4], "", "the previously hovered box rests again");
}

#[test]
fn click_without_motion_takes_the_chrome_cursor() {
	let mut ui = Ui::from_markup(
		"<box border=square bc=#334455 hover=#ff0000..#0000ff><text>hi</text></box>",
		40,
		UiContext::default(),
	)
	.unwrap();
	// No Move report first: the click itself proves the pointer position.
	ui.handle_mouse(1, 1, Mouse::Click);
	assert!(ui.hover_slot().is_some(), "the click hovers the box it landed on");
	let near = frame_cell_style(ui.frame(), 0, 0).foreground_color();
	assert_ne!(near, Color::Rgb(0x33, 0x44, 0x55), "the glow lights without a motion report");
}

#[test]
fn descendant_hover_keeps_the_decorated_ancestor_lifted() {
	let mut ui = Ui::from_markup(
		"<box border=square bc=#334455 hover=#ff0000 lift=1><button id=go>go</button></box>",
		20,
		UiContext::default(),
	)
	.unwrap();
	let press = ui
		.hits()
		.iter()
		.find(|hit| hit.tag == HitTag::Press)
		.copied()
		.unwrap();
	ui.handle_mouse(press.rect.x, press.rect.y, Mouse::Move);
	assert_eq!(ui.hover_slot(), Some(press.slot), "the button owns the hover hit");
	assert_ne!(rows(&ui)[0], "", "the box still rises for a hovered descendant");
	ui.handle_mouse(0, 10, Mouse::Move);
	assert_eq!(rows(&ui)[0], "", "leaving the subtree drops the box");
}

#[test]
fn editor_wheel_scrolls_visible_rows_without_moving_cursor() {
	let mut ui = Ui::from_markup(
		"<editor id=e h=4 value=\"one\ntwo\nthree\nfour\"/>",
		30,
		UiContext::default(),
	)
	.unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.repaint_slot(editor);
	assert!(rows(&ui).iter().any(|r| r.contains("three")), "rows: {:?}", rows(&ui));
	let cursor = editor_pane(ui.root()).unwrap().buffer().cursor();
	let rect = ui.root_mut().find_slot(editor).unwrap().rect;
	ui.handle_mouse(rect.x, rect.y, Mouse::WheelUp);
	assert!(rows(&ui).iter().any(|r| r.contains("two")), "rows: {:?}", rows(&ui));
	let state = editor_pane(ui.root()).unwrap();
	assert_eq!(state.buffer().cursor(), cursor);
}

#[test]
fn radio_arrow_keys_wrap_at_both_edges() {
	let mut ui = Ui::from_markup(
		"<radio id=s options=\"one two three\" value=one/>",
		30,
		UiContext::default(),
	)
	.unwrap();
	let radio = ui.focus_ring()[0];
	ui.set_focus_slot(Some(radio));
	ui.handle_key(Key::Left);
	assert_eq!(ui.values()["s"], json!("three"));
	ui.handle_key(Key::Right);
	assert_eq!(ui.values()["s"], json!("one"));
}

#[test]
fn img_renders_ppm_and_placeholder() {
	// synthesize a 4x4 red/blue PPM
	let dir = env::temp_dir().join("omp-tui-img-test");
	fs::create_dir_all(&dir).unwrap();
	let path = dir.join("t.ppm");
	let mut ppm: Vec<u8> = b"P6\n4 4\n255\n".to_vec();
	for y in 0..4u8 {
		for _x in 0..4u8 {
			if y < 2 {
				ppm.extend([255, 0, 0]);
			} else {
				ppm.extend([0, 0, 255]);
			}
		}
	}
	fs::write(&path, ppm).unwrap();
	let source = format!("<img src={} w=4/>", path.display());
	let ui = Ui::from_markup(source.clone(), 20, UiContext::default()).unwrap();
	assert_eq!(ui.height(), 2, "4px tall = 2 half-block rows");
	assert!(rows(&ui)[0].contains('▀'));

	let ascii =
		Ui::from_markup(source, 20, UiContext { charset: Charset::Ascii, ..UiContext::default() })
			.unwrap();
	assert!(rows(&ascii)[0].contains('#'), "ASCII upper-half fallback");
	assert!(!rows(&ascii).join("").contains('▀'));

	let missing =
		Ui::from_markup("<img src=/nope/missing.png w=8/>", 30, UiContext::default()).unwrap();
	assert_eq!(missing.height(), 3, "placeholder box");
	assert!(rows(&missing)[1].contains("missing.png"));
	let missing_ascii = Ui::from_markup("<img src=/nope/missing.png w=8/>", 30, UiContext {
		charset: Charset::Ascii,
		..UiContext::default()
	})
	.unwrap();
	let text = rows(&missing_ascii).join("\n");
	assert!(text.contains('+') && text.contains('|'), "{text}");
	assert!(!text.contains('┌') && !text.contains('┆'), "{text}");
}

#[test]
fn match_simple_subset() {
	use crate::components::wizard::match_simple;
	assert!(match_simple("[a-z][a-z0-9-]*", "github"));
	assert!(match_simple("[a-z][a-z0-9-]*", "a-1"));
	assert!(!match_simple("[a-z][a-z0-9-]*", "1abc"));
	assert!(!match_simple("[a-z][a-z0-9-]*", "Bad!"));
	assert!(match_simple("a+b?c", "aac"));
	assert!(match_simple("a+b?c", "abc"));
	assert!(!match_simple("a+b?c", "bc"));
	assert!(match_simple("[^0-9]+", "abc-"));
	assert!(!match_simple("[^0-9]+", "a1"));
	assert!(match_simple(".*", "anything at all"));
}

#[test]
fn conditional_static_render_excludes_hidden() {
	let src = r#"<col>
<radio id=mode options="a b" value=a/>
<text when="mode=a">alpha pane</text>
<text when="mode=b">beta pane</text>
</col>"#;
	let mut ui = Ui::from_markup(src, 30, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("alpha pane") && !text.contains("beta pane"));
	// flip the segment: visibility swaps and layout matches a rebuild
	let focus = ui.focus_ring()[0];
	ui.set_focus_slot(Some(focus));
	ui.handle_key(Key::Right);
	let text = rows(&ui).join("\n");
	assert!(!text.contains("alpha pane") && text.contains("beta pane"));
}

#[test]
fn callout_renders_header_rail_and_markdown_body() {
	let src = "<callout warn title=\"Advisor\" badge=\"1 note\">`disown` is **still** incomplete \
	           for compound jobs</callout>";
	let ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	let text = rows(&ui);
	assert!(text[0].contains("Advisor"), "{text:?}");
	assert!(text[0].contains("1 note"));
	assert!(text[0].contains('ℹ'), "default icon present");
	assert!(text[1].starts_with('▎'), "rail on body rows: {text:?}");
	assert!(text[1].contains("disown"));
	// the rail carries the requested color (warn), not a hardcoded one
	let cell = ui.frame().cell(0, 1);
	assert_eq!(
		cell.style.foreground_color(),
		crate::Theme::default().warn,
		"rail colored by the warn token"
	);

	// headerless callout degrades to a plain rail blockquote
	let plain =
		Ui::from_markup("<callout>just a quote body</callout>", 30, UiContext::default()).unwrap();
	let text = rows(&plain);
	assert!(text[0].starts_with('▎') && text[0].contains("just a quote"));
}

#[test]
fn icon_catalog_resolves_short_names_and_qualified_aliases() {
	use crate::{Charset, Icon};
	let lock = Icon::from_name("lock").unwrap();
	assert_eq!(lock, Icon::from_name("action.lock").unwrap());
	assert_eq!(lock.name(), "lock");
	assert_eq!(lock.alias(), Some("action.lock"));

	let folder = Icon::from_name("folder").unwrap();
	assert_eq!(folder, Icon::from_name("icon.folder").unwrap());
	assert_eq!(Charset::Ascii.icon(folder), "[D]");
	assert_eq!(Charset::Unicode.icon(folder), "📁");
	assert_eq!(Charset::NerdFont.icon(folder), "");

	let cancellable = Icon::from_name("cancellable").unwrap();
	assert_eq!(cancellable, Icon::from_name("action.cancellable").unwrap());
	assert_eq!(Charset::Ascii.icon(cancellable), "esc");
	assert_eq!(Charset::Unicode.icon(cancellable), "⎋");
	assert_eq!(Charset::NerdFont.icon(cancellable), "󱊷");

	let omp = Icon::from_name("omp").unwrap();
	assert_eq!(omp, Icon::from_name("icon.omp").unwrap());
	assert_eq!(Charset::Ascii.icon(omp), "pi");
	assert_eq!(Charset::Unicode.icon(omp), "π");
	assert_eq!(Charset::NerdFont.icon(omp), "󰵗");
	assert_eq!(Charset::NerdFont.icon(Icon::Csharp), "\u{e7b2}");
	let command_types = [
		(Icon::SlashCommand, ["/", "⌘", ""]),
		(Icon::Prompt, ["PR", "✎", ""]),
		(Icon::McpExtension, ["MCP", "🔌", ""]),
		(Icon::Skill, ["SK", "✦", ""]),
		(Icon::ExtensionCommand, ["EX", "🧩", ""]),
		(Icon::Session, ["id", "🆔", "󰁑"]),
	];
	for (icon, [ascii, unicode, nerd_font]) in command_types {
		assert_eq!(Charset::Ascii.icon(icon), ascii);
		assert_eq!(Charset::Unicode.icon(icon), unicode);
		assert_eq!(Charset::NerdFont.icon(icon), nerd_font);
	}

	let future = Icon::from_name("placeholder-rail").unwrap();
	assert_eq!(future.alias(), None, "new rows need no qualified alias");
	assert!(Icon::ALL.len() >= 300, "extensive catalog");
	assert!(
		Icon::ALL
			.windows(2)
			.all(|pair| pair[0].name() < pair[1].name()),
		"short names are unique and sorted"
	);
	assert!(Icon::ALL.iter().all(|icon| !icon.name().contains('.')));
}

#[test]
fn icon_takes_coloring_attributes_directly() {
	let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
	for markup in ["<icon color=err>error</icon>", "<icon fg=err icon=error/>"] {
		let ui = Ui::from_markup(markup, 6, ctx.clone()).unwrap();
		assert_eq!(frame_row_text(ui.frame(), 0), "[!!]", "{markup}");
		assert_eq!(frame_cell_style(ui.frame(), 0, 0).foreground_color(), ctx.theme.err, "{markup}");
	}
}

#[test]
fn callout_icon_accepts_short_catalog_names() {
	let ui = Ui::from_markup("<callout icon=folder title=Files>body</callout>", 30, UiContext {
		charset: Charset::Ascii,
		..UiContext::default()
	})
	.unwrap();
	let text = rows(&ui);
	assert!(text[0].contains("[D] Files"), "{text:?}");
	assert!(!text[0].contains("folder"), "name resolved rather than painted literally");
}

#[test]
fn bare_css_color_flags_style_inline_spans_end_to_end() {
	use crate::Color;
	// PoC `styled()` accepts bare named colors as flags; semantic tokens
	// still win over CSS names of the same spelling
	let ui = Ui::from_markup(
		"<span cyan>cy</span> <span rebeccapurple bold>rp</span>",
		30,
		UiContext::default(),
	)
	.unwrap();
	let row = rows(&ui).remove(0);
	assert_eq!(row.trim_end(), "cy rp");
	let cy = u16::try_from(row.find("cy").unwrap()).unwrap();
	let rp = u16::try_from(row.find("rp").unwrap()).unwrap();
	assert_eq!(
		ui.frame().cell(cy, 0).style,
		crate::Style::new().fg(Color::Rgb(0x00, 0xff, 0xff)),
		"bare `cyan` flag colors the span"
	);
	assert_eq!(
		ui.frame().cell(rp, 0).style,
		crate::Style::new().fg(Color::Rgb(0x66, 0x33, 0x99)).bold(),
		"flags still compose after a color flag"
	);
	// unknown bare attrs stay inert
	let inert = Ui::from_markup("<span mystery>m</span>", 10, UiContext::default()).unwrap();
	let base = Theme::default().fg;
	assert_eq!(inert.frame().cell(0, 0).style.foreground_color(), base);
}

#[test]
fn ico_tags_resolve_inline_and_in_titles_across_charsets() {
	// inline markdown text, box title (quoted `>` inside the attribute),
	// and a code span that must stay literal
	let src =
		"<box title=\"<ico:folder/> Files\"><ico:status.success/> passed `<ico:folder/>`</box>";
	let ui = Ui::from_markup(src, 44, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("📁 Files"), "title icon resolved: {text}");
	assert!(text.contains("✔ passed"), "inline qualified alias resolved: {text}");
	assert!(!text.contains("ico:folder/> Files"), "no literal tag in title: {text}");
	assert!(
		text.contains("`<ico:folder/>`") || text.contains("<ico:folder/>"),
		"code span literal: {text}"
	);

	let ascii =
		Ui::from_markup(src, 44, UiContext { charset: Charset::Ascii, ..UiContext::default() })
			.unwrap();
	let text = rows(&ascii).join("\n");
	assert!(text.contains("[D] Files"), "ascii title icon: {text}");

	// unknown names stay visible as the bare name, never a broken link
	let ui = Ui::from_markup("<ico:no-such-icon/> hmm", 30, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("no-such-icon hmm"), "{text}");
}

#[test]
fn ascii_charset_swaps_every_glyph_family() {
	use crate::{Charset, UiContext};
	let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
	let src = r#"<box title="t"><select id=s><option value=a>alpha<text>preview</text></option></select>
<tree id=tr><node label="dir" open><node label="leaf"/></node></tree>
<hr title="split"/>
<progress value=50/></box>"#;
	let ui = Ui::from_markup(src, 30, ctx.clone()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains('+') && text.contains('-') && text.contains('|'), "{text}");
	assert!(text.contains("(o)") || text.contains("( )"), "ascii radio: {text}");
	assert!(text.contains("v ") || text.contains("> "), "ascii expander");
	assert!(text.contains('#') && text.contains('.'), "ascii progress bar");
	assert!(text.contains("preview"), "option preview rendered: {text}");
	assert!(
		!text.contains('┌')
			&& !text.contains('◉')
			&& !text.contains('█')
			&& !text.contains('─')
			&& !text.contains('│'),
		"{text}"
	);

	let mut wizard = Ui::from_markup(WIZ, 60, ctx).unwrap();
	let id = *wizard.focus_ring().last().unwrap();
	wizard.focus = Some(id);
	wizard.handle_key(Key::Right);
	assert_eq!(wizard.handle_key(Key::Enter), UiEvent::None);
	let text = rows(&wizard).join("\n");
	assert!(text.contains("[!]") && !text.contains('⚠'), "{text}");
}

#[test]
fn theme_override_recolors_widgets_without_code_changes() {
	use crate::{Color, Theme, UiContext};
	let loud = Color::Rgb(0xff, 0x00, 0xaa);
	let ctx =
		UiContext { theme: Theme { accent: loud, ..Theme::default() }, ..UiContext::default() };
	let mut ui =
		Ui::from_markup("<select id=s><option value=a>alpha</option></select>", 30, ctx).unwrap();
	let focus = ui.focus_ring()[0];
	ui.set_focus_slot(Some(focus));
	ui.handle_key(Key::Down); // repaint focused
	// the focus cursor glyph row must carry the overridden accent
	let mut found = false;
	for x in 0..30u16 {
		if ui.frame().cell(x, 0).style.foreground_color() == loud {
			found = true;
			break;
		}
	}
	assert!(found, "overridden accent appears in painted cells");
}

#[test]
fn editor_pi_word_motion_keeps_joined_words_together() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"foo-bar baz\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::WordLeft);
	ui.handle_key(Key::WordLeft);
	ui.handle_key(Key::Char('X'));
	assert_eq!(ui.values()["e"], json!("Xfoo-bar baz"));
}

#[test]
fn editor_pi_word_deletes_merge_logical_lines() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"first\nsecond\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Home);
	ui.handle_key(Key::Ctrl('w'));
	assert_eq!(ui.values()["e"], json!("firstsecond"));

	let mut ui =
		Ui::from_markup("<editor id=e value=\"first\nsecond\"/>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Up);
	ui.handle_key(Key::End);
	ui.handle_key(Key::WordDelete);
	assert_eq!(ui.values()["e"], json!("firstsecond"));
}

#[test]
fn editor_vertical_motion_preserves_sticky_column_and_snaps_at_top() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"abcdef\nx\nabcdef\"/>", 40, UiContext::default())
			.unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Home);
	for _ in 0..5 {
		ui.handle_key(Key::Right);
	}
	ui.handle_key(Key::Up);
	ui.handle_key(Key::Up);
	let state = editor_pane(ui.root()).unwrap();
	assert_eq!((state.buffer().cursor_line(), state.buffer().cursor_column()), (0, 5));
	ui.handle_key(Key::Up);
	let state = editor_pane(ui.root()).unwrap();
	assert_eq!((state.buffer().cursor_line(), state.buffer().cursor_column()), (0, 0));
	ui.handle_key(Key::Up);
	assert_eq!(ui.focus_slot(), Some(editor), "released Up wraps the single-item focus ring");
}

#[test]
fn submit_input_in_overlay_emits_submit_without_editing_its_value() {
	let mut ui = Ui::from_markup("<text>base</text>", 40, UiContext::default()).unwrap();
	let overlay = ui.show_overlay(
		Input::new()
			.with(Prop::Id, "token")
			.with(Prop::Value, "sk-live")
			.with(Prop::Submit, true),
		OverlayOptions::default(),
	);

	assert_eq!(ui.handle_key(Key::Enter), UiEvent::Submit);
	assert_eq!(
		ui.overlay(overlay).expect("input overlay").values()["token"],
		json!("sk-live"),
		"submitting preserves the value and inserts no newline"
	);
}

#[test]
fn editor_without_submit_inserts_newline_on_enter() {
	let mut ui = Ui::from_markup("<editor id=e value=line/>", 40, UiContext::default()).unwrap();

	assert_eq!(ui.handle_key(Key::Enter), UiEvent::None);
	assert_eq!(ui.values()["e"], json!("line\n"));
}

#[test]
fn bracketed_paste_sanitizes_multiline_editor_and_single_line_input() {
	let mut ui =
		Ui::from_markup("<col><editor id=e/><input id=i/></col>", 40, UiContext::default()).unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	assert_eq!(ui.handle_paste("a\r\nb\u{0007}e\u{301}"), UiEvent::None);
	assert_eq!(ui.values()["e"], json!("a\nbé"));

	let input = ui.focus_ring()[1];
	ui.set_focus_slot(Some(input));
	assert_eq!(ui.handle_paste("a\r\nb"), UiEvent::Changed {
		id:    "i".into(),
		value: "a b".into(),
	});
	assert_eq!(ui.values()["i"], json!("a b"));
}

#[test]
fn widget_editor_delegates_power_editing_and_visual_motion_to_edit_buffer() {
	let mut ui =
		Ui::from_markup("<editor id=e value=\"alpha beta gamma\" h=3/>", 40, UiContext::default())
			.unwrap();
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.root_mut().find_slot(editor).unwrap().rect = Rect::new(0, 0, 9, 3);
	ui.handle_key(Key::Ctrl('w'));
	ui.handle_key(Key::Ctrl('w'));
	ui.handle_key(Key::Ctrl('y'));
	assert_eq!(ui.values()["e"], json!("alpha beta gamma"));
	ui.handle_key(Key::Ctrl('-'));
	assert_eq!(ui.values()["e"], json!("alpha "));

	editor_pane_mut(ui.root_mut())
		.unwrap()
		.replace_external("abcdef abcdef abcdef\nx\nabcdef", true);
	ui.handle_key(Key::Ctrl(']'));
	ui.handle_key(Key::Char('f'));
	let state = editor_pane(ui.root()).unwrap();
	assert_eq!(state.buffer().cursor(), 5);
	ui.handle_key(Key::PageDown);
	let state = editor_pane(ui.root()).unwrap();
	assert!(state.buffer().cursor_line() >= 1, "page motion crosses wrapped visual rows");
}

// ---------------------------------------------------------------------------
// PoC parity: the ui-poc.py demo documents are the acceptance corpus for the
// markup grammar. Each source below is verbatim from `DEMOS[...]` and must
// parse and render without leaking literal tags.

#[test]
fn poc_welcome_demo_renders_art_spans_and_wrapping_row() {
	let src = r#"
<box border=square title="omp v17.2.11">
  <row gap=1 wrap>
    <box border=square pad="1 2" align=center>
      **Welcome back!**
      <spacer/>
      <pre fg="magenta..cyan" angle=45>
      ▄▄▄▄▄▄▄▄▄▄▄▄
      ▀▀▐█▌▀▀▐█▌▀▀
        ▐█▌  ▐█▌
        ▐█▌  ▐█▌
        ▝█▘  ▝█▘
      </pre>
      <spacer/>
      Claude Fable 5
      <span dim>anthropic</span>
    </box>
    <col grow pad="0 1">
      <span accent bold>Tips</span>
      | <span muted>#</span> | for prompt actions |
      | <span muted>/</span> | for commands |
      <hr/>
      <span accent bold>LSP Servers</span>
      <span muted><ico:status.enabled/></span> rust-analyzer <span dim>.rs</span>
    </col>
  </row>
  <hr/>
  <col pad="0 1">
    <span dim>*Tip: Tired of typing "keep going"? Just send a '.'*</span>
  </col>
</box>
"#;
	for width in [84u16, 46] {
		let ui = Ui::from_markup(src, width, UiContext::default()).unwrap();
		let text = rows(&ui).join("\n");
		assert!(text.contains("Welcome back!"), "w={width}: {text}");
		assert!(text.contains("▐█▌"), "art body verbatim, w={width}");
		assert!(text.contains("omp v17.2.11") && text.contains("Tips"), "w={width}");
		for leak in ["<pre", "<span", "</span>", "<ico:"] {
			assert!(!text.contains(leak), "leaked {leak} at w={width}: {text}");
		}
	}
}

#[test]
fn poc_settings_demo_renders_icon_tabs_and_accent_pill() {
	let src = r#"
<box border=square pad="0 1">
  <span accent bold>Settings</span>
  <row gap=1>
    <span on=accent fg=black bold> <ico:tab.appearance/> Appearance </span>
    <span muted> <ico:tab.model/> Model </span>
    <span muted> <ico:tab.shell/> Shell </span>
  </row>
  <hr/>
  <row gap=3 pad="0 1">
    <col w=18%>
      <span accent>Theme</span>
      Status Line
    </col>
    <col grow>
      <span underline>Theme</span>
      | <span accent><ico:nav.cursor/> Dark Theme</span>        | <span info>titanium</span> |
      | Light Theme                    | light |
    </col>
  </row>
  <hr/>
  <span dim>Enter/Space to change · Tab to jump sections · ←/→ to switch tabs · Esc to close</span>
</box>
"#;
	let ui = Ui::from_markup(src, 96, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("Settings") && text.contains("🎨 Appearance"), "{text}");
	assert!(text.contains("❯ Dark Theme"), "nav.cursor icon in table cell: {text}");
	for leak in ["<span", "</span>", "<ico:"] {
		assert!(!text.contains(leak), "leaked {leak}: {text}");
	}
	// the active tab pill carries the accent background from `on=accent`
	let accent = Theme::default().accent;
	let frame = ui.frame();
	let pill = (0..frame.size().height).any(|y| {
		(0..frame.size().width).any(|x| frame.cell(x, y).style.background_color() == accent)
	});
	assert!(pill, "on=accent span painted with accent background");
}

#[test]
fn poc_icons_demo_resolves_every_key_in_title_and_body() {
	let src = r#"
<box border=round title="<ico:tab.appearance/> icon layer — same doc, --symbols unicode|nerd|ascii" pad="0 2">
  | <ico:status.success/> | `status.success` | build passed |
  | <ico:status.error/> | `status.error` | 2 tests failed |
  | <ico:checkbox.checked/> | `checkbox.checked` | strict mode |
  <hr/>
  <ico:nav.cursor/> <ico:lang.rust/> omp-core · <ico:lang.typescript/> coding-agent <spacer/>
  <span dim><ico:icon.git/> main <ico:icon.branch/> ui-ext · <ico:icon.tokens/> 12.4k</span>
</box>
"#;
	let ui = Ui::from_markup(src, 72, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("icon layer"), "title text kept: {text}");
	assert!(text.contains('✔') && text.contains('❯'), "glyphs resolved: {text}");
	// code spans keep the literal key names; nothing outside them leaks
	assert!(text.contains("status.success"), "{text}");
	assert!(!text.contains("<ico:"), "no unresolved icon tags: {text}");
}

#[test]
fn poc_showcase_demo_covers_dash_borders_justify_truncate_and_gradients() {
	let src = r#"
<hr title="borders & edge colors"/>

<row gap=2>
  <box title="round" border=round grow align=center><span dim>default edge</span></box>
  <box title="heavy" border=heavy edge=err grow align=center><span dim>edge=err</span></box>
  <box title="dash" border=dash edge=info grow align=center><span dim>edge=info</span></box>
</row>

<row gap=1 pad="1 0">
  <span accent reverse> accent </span>
  <span err reverse> err </span>
  <spacer/>
  <span fg=#ff8800 on=#26221c> #ff8800 </span>
</row>

**bold** · *italic* · `code` · ~~strike~~ · <span underline>underline</span> · <span reverse>reverse</span>

<row justify=between pad="1 0">
  <span ok>◀ prev</span>
  <span bold>page 3 / 7</span>
  <span ok>next ▶</span>
</row>

<row gap=1 pad="1 0">
  <box title="truncate" truncate grow>
    this line is far too long to fit and will be cut with an ellipsis instead of wrapping
  </box>
  <box title="wrap (default)" grow>
    this line is far too long to fit and will wrap onto the following lines like normal prose
  </box>
</row>

<row gap=4 pad="1 0">
  <col align=center>
    <pre fg="magenta..cyan" angle=0>
    ██████████
    </pre>
    <span dim>angle=0</span>
  </col>
  <col align=center>
    <pre fg="yellow..red" angle=90>
    ██████████
    </pre>
    <span dim>angle=90</span>
  </col>
</row>
"#;
	let ui = Ui::from_markup(src, 100, UiContext::default()).unwrap();
	let text = rows(&ui);
	let joined = text.join("\n");
	assert!(joined.contains('╌') && joined.contains('┆'), "dash border glyphs: {joined}");
	assert!(joined.contains('…'), "truncate ellipsis: {joined}");
	assert!(joined.contains("██████████"), "gradient art body: {joined}");
	for leak in ["<span", "</span>", "<pre", "border=dash"] {
		assert!(!joined.contains(leak), "leaked {leak}: {joined}");
	}
	let pager = text
		.iter()
		.find(|row| row.contains("page 3 / 7"))
		.expect("pager row");
	assert!(pager.starts_with("◀ prev"), "justify=between flushes left: {pager:?}");
	assert!(pager.trim_end().ends_with("next ▶"), "justify=between flushes right: {pager:?}");
}

#[test]
fn custom_element_registry_factory_paints_boxed_props_and_children() {
	let ctx = UiContext {
		elements: Elements::builder()
			.with("user-card", |_: &str, props: Props, children: Vec<Cached>| {
				Box::new(
					Boxed::new()
						.with(Prop::Title, props.title().cloned().unwrap_or_default())
						.child(children),
				) as Box<dyn Component>
			})
			.build(),
		..Default::default()
	};

	let ui = Ui::from_markup("<col><user-card title=hi/></col>", 24, ctx).unwrap();
	let painted = rows(&ui);
	assert!(painted.first().is_some_and(|row| row.starts_with("┌─ hi ")), "{painted:?}");
	assert!(painted.last().is_some_and(|row| row.starts_with('└')), "{painted:?}");
}

#[test]
fn unregistered_custom_elements_render_as_div_fallbacks() {
	let note = Ui::from_markup("<note>hello</note>", 24, UiContext {
		elements: Elements::default(),
		..Default::default()
	})
	.unwrap();
	assert!(rows(&note).iter().any(|row| row.contains("hello")));

	let gone = Ui::from_markup("<gone/>", 24, UiContext {
		elements: Elements::default(),
		..Default::default()
	})
	.unwrap();
	assert_eq!(gone.frame().size().height, 0);
}

#[test]
fn stray_unclosed_inline_tag_remains_literal_prose() {
	let ui = Ui::from_markup("before <b>after", 24, UiContext::default()).unwrap();
	assert!(rows(&ui).iter().any(|row| row.contains("before <b>after")));
}

#[test]
fn custom_element_preserves_named_and_custom_props() {
	let mut ui =
		Ui::from_markup("<note data-x=1 title=hi>hello</note>", 24, UiContext::default()).unwrap();
	let custom = ui.root_mut().comp().children()[0]
		.comp()
		.downcast_ref::<CustomElement>()
		.expect("root child is the custom element");
	assert_eq!(
		crate::Component::props(custom).custom("data-x"),
		Some(&crate::PropValue::Str("1".into())),
	);
	assert_eq!(
		crate::Component::props(custom)
			.title()
			.map(|title| title.as_str()),
		Some("hi")
	);
}

#[test]
fn editor_markup_accepts_status_and_keeps_default_input() {
	let mut ui = Ui::from_markup(
		"<editor id=e><status><segment fg=green>S1</segment></status></editor>",
		60,
		UiContext::default(),
	)
	.unwrap();
	assert!(rows(&ui)[0].contains("S1"));
	let editor = ui.focus_ring()[0];
	ui.set_focus_slot(Some(editor));
	ui.handle_key(Key::Char('x'));
	let editor = editor_pane(ui.root()).expect("markup root should contain an editor");
	assert_eq!(editor.buffer().text(), "x");
}

#[test]
fn editor_markup_replacement_input_receives_focus_and_typing() {
	let mut ui =
		Ui::from_markup("<editor><input id=custom/></editor>", 60, UiContext::default()).unwrap();
	let input = ui.focus_ring()[0];
	ui.set_focus_slot(Some(input));
	ui.handle_key(Key::Char('x'));
	assert_eq!(ui.values()["custom"], json!("x"));
}

#[test]
fn editor_markup_rejects_extra_or_text_children() {
	for (source, error_at) in [
		("<editor><input/><input/></editor>", "<editor><input/>".len()),
		("<editor>text<input/></editor>", "<editor>".len()),
	] {
		let Err(error) = Ui::from_markup(source, 60, UiContext::default()) else {
			panic!("invalid editor children must be rejected");
		};
		assert_eq!(error.message, "<editor> takes at most one input child and one <status>");
		assert_eq!(error.at, error_at);
	}
}

#[test]
fn editor_layout_macro_accepts_status_child() {
	let ui = Ui::from_root(
		dom! {
			<editor><status><segment>{"S1"}</segment></status></editor>
		},
		60,
		UiContext::default(),
	);
	assert!(rows(&ui)[0].contains("S1"));
}

#[test]
fn todo_markup_renders_groups_counts_statuses_and_guides() {
	let src = r#"
<todo>
  <task label="Part A">
    <task status=done>A4 tui test strings</task>
    <task status=active>A5 examples</task>
    <task status=blocked desc="waiting on CI">A6 README</task>
    <task>A7 ui-poc.py</task>
  </task>
  <task status=done>flat follow-up</task>
</todo>
"#;
	let ui = Ui::from_markup(src, 48, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("TODO"), "{text}");
	// group header with automatic closed/total count
	assert!(text.contains("├─ Part A 1/4"), "{text}");
	// The overall progress spine precedes the group's nested connectors.
	assert!(text.contains("│  ├─ ☑ A4 tui test strings"), "{text}");
	assert!(text.contains("│  ├─ ☐ A5 examples"), "{text}");
	assert!(text.contains("│  ├─ ☐ A6 README (blocked: waiting on CI)"), "{text}");
	assert!(text.contains("│  └─ ☐ A7 ui-poc.py"), "{text}");
	assert!(text.contains("\n├─ ☑ flat follow-up"), "{text}");
	assert!(text.contains("\n└─────"), "{text}");
	for leak in ["<todo", "<task", "</task>"] {
		assert!(!text.contains(leak), "leaked {leak}: {text}");
	}
}

#[test]
fn todo_rejects_unknown_status_and_foreign_children() {
	let parse = |src| Ui::from_markup(src, 40, UiContext::default());
	assert!(parse("<todo><task status=wat>x</task></todo>").is_err());
	assert!(parse("<todo><text>x</text></todo>").is_err());
	assert!(parse("<col><task>x</task></col>").is_err());
}

#[test]
fn todo_guides_family_and_nested_gutters() {
	let src = r#"
<todo guides=round>
  <task label="outer">
    <task label="mid">
      <task>deep-first</task>
      <task>deep-last</task>
    </task>
    <task>outer-last</task>
  </task>
</todo>
"#;
	let ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	// `mid` still has a sibling below, so its gutter runs through the deep rows.
	// The first rail is the Todo's overall progress spine.
	assert!(text.contains("│  │ ├─ ☐ deep-first"), "{text}");
	assert!(text.contains("│  │ ╰─ ☐ deep-last"), "{text}");
	assert!(text.contains("│  ╰─ ☐ outer-last"), "{text}");
}

#[test]
fn tree_guides_paint_connectors_for_open_branches() {
	let src = r#"
<tree guides>
  <node label="root" open>
    <node label="one"/>
    <node label="two"/>
  </node>
</tree>
"#;
	let ui = Ui::from_markup(src, 40, UiContext::default()).unwrap();
	let text = rows(&ui).join("\n");
	assert!(text.contains("├─ one"), "{text}");
	assert!(text.contains("└─ two"), "{text}");
}

#[test]
fn todo_layout_macro_builds_nested_tasks() {
	let ui = Ui::from_root(
		dom! {
			<todo guides=round>
				<task label="phase">
					<task status="done">{"a"}</task>
					<task>{"b"}</task>
				</task>
			</todo>
		},
		40,
		UiContext::default(),
	);
	let text = rows(&ui).join("\n");
	assert!(text.contains("phase 1/2"), "{text}");
	assert!(text.contains("├─ ☑ a"), "{text}");
	assert!(text.contains("╰─ ☐ b"), "{text}");
}
