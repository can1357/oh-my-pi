use super::*;
#[path = "incremental_tests.rs"]
mod incremental_tests;
use bstr::{BStr, BString};

use crate::bash::{
	engine::{Engine, EngineConfig},
	event::AssignScope,
	ids::{ModeId, Vpid},
	trace::{
		Node,
		history::{HistoryData, HistoryEvent},
		syntax::UnitSyntax,
	},
};

struct Unit {
	at:     u32,
	source: BString,
	syntax: UnitSyntax,
	nodes:  Vec<Node>,
}
struct Fixture {
	script: BString,
	units:  Vec<Unit>,
	cache:  Cache,
}
impl Fixture {
	fn new(script: &str) -> Self {
		let mut units = Vec::new();
		let engine = Engine::new(EngineConfig::default());
		for command in parse_all(script.as_bytes(), Features::NONE)
			.expect("canonical parse")
			.commands
		{
			let at = command.span.lo;
			let lowered =
				engine.compile(command, script.as_bytes(), ModeId::Bash, Features::NONE, true);
			let parents = crate::bash::trace::nodes::parents(&lowered.nodes);
			let nodes = lowered
				.nodes
				.iter()
				.zip(parents)
				.map(|(info, parent)| Node::new(info.kind, info.lo, info.hi, parent))
				.collect();
			units.push(Unit {
				at,
				source: lowered.source.clone(),
				syntax: lowered
					.trace_syntax
					.get()
					.expect("observed native syntax")
					.as_ref()
					.clone(),
				nodes,
			});
		}
		Self { script: script.into(), units, cache: Cache::default() }
	}

	fn root(&self, unit: usize) -> &Command {
		let SyntaxTree::List(list) = &self.units[unit].syntax.tree else {
			panic!("canonical list")
		};
		&list.items[0].and_or.first.stages[0].cmd
	}

	fn key(&self, unit: usize) -> NodeKey {
		NodeKey::engine(unit as u32, self.root(unit).id)
	}

	fn present(&self, events: &[HistoryEvent], options: &Options) -> Presentation {
		let runtime = Runtime::reduce(
			self,
			events.iter(),
			options,
			None,
			Some(Vpid(1)),
			events.last().map_or(0, |e| e.t_ns),
			false,
		);
		render(self, &runtime, options)
	}
}
impl VizSource for Fixture {
	fn script(&self) -> &BStr {
		BStr::new(&self.script)
	}

	fn unit_count(&self) -> usize {
		self.units.len()
	}

	fn unit(&self, index: usize) -> Option<super::super::runtime::SourceUnit<'_>> {
		let unit = self.units.get(index)?;
		Some(super::super::runtime::SourceUnit {
			index:      index as u32,
			source:     BStr::new(&unit.source),
			at:         Some(unit.at),
			line:       1,
			syntax:     Some(&unit.syntax),
			projection: 0,
			nodes:      &unit.nodes,
			callout:    false,
		})
	}

	fn cache(&self) -> &Cache {
		&self.cache
	}
}
fn event(seq: u64, key: Option<NodeKey>, data: HistoryData) -> HistoryEvent {
	HistoryEvent {
		seq,
		t_ns: seq * 10,
		event_seq: Some(seq),
		segment: None,
		logical_end: false,
		logical_status: None,
		u: key.map(|k| k.unit),
		n: key.map(|k| k.node.0),
		command: None,
		vpid: Some(Vpid(1)),
		data,
	}
}
fn expanded(seq: u64, key: NodeKey, resolved: ResolvedKind) -> HistoryEvent {
	event(seq, Some(key), HistoryData::CmdExpanded {
		argv: Vec::new(),
		assigns: Vec::new(),
		resolved,
		redirs: Vec::new(),
	})
}
fn end(seq: u64, key: NodeKey, status: i32) -> HistoryEvent {
	event(seq, Some(key), HistoryData::CmdEnd { status, dur_ns: 10, pipestatus: Vec::new() })
}
fn assignment(seq: u64, key: Option<NodeKey>, value: &str) -> HistoryEvent {
	event(seq, key, HistoryData::Assign {
		name:     "x".into(),
		value:    value.into(),
		full_len: value.len(),
		scope:    AssignScope::Global,
	})
}
fn text(rows: &[Row]) -> String {
	rows
		.iter()
		.map(|r| {
			format!(
				"{}{}",
				"  ".repeat(r.depth as usize),
				r.segments
					.iter()
					.map(|s| s.text.as_str())
					.collect::<String>()
			)
		})
		.collect::<Vec<_>>()
		.join("\n")
}

#[test]
fn raw_is_exact_for_every_layer_combination() {
	let script = "# retained 😀\n\techo 'a b'  # trailing\n\necho \\\n  tail\n";
	let fixture = Fixture::new(script);
	for mask in 0..32 {
		let options = Options {
			view: View::Raw,
			layers: Layers {
				color:   mask & 1 != 0,
				inline:  mask & 2 != 0,
				idioms:  mask & 4 != 0,
				effects: mask & 8 != 0,
				unwrap:  mask & 16 != 0,
			},
			..Options::default()
		};
		let presentation = fixture.present(&[], &options);
		assert_eq!(text(&presentation.rows), script);
		assert!(presentation.original.is_empty());
	}
}

#[test]
fn pseudo_preserves_control_fallback_and_function_parameters() {
	let f = Fixture::new(
		"f() { echo \"$1\"; }\nfor x in a b; do if [ -f \"$x\" ]; then f \"$x\"; else echo no; fi; \
		 done\ncase \"$x\" in a) echo A;; *) echo other;; esac\n[ -n \"$x\" ] && false || echo \
		 recovered",
	);
	let output = text(&f.present(&[], &Options::default()).rows);
	for expected in
		["def f(arg1):", "for x in", "is_file(", "else:", "match ", "\n  and false\n  or print"]
	{
		assert!(output.contains(expected), "missing {expected}: {output}");
	}
}

#[test]
fn safe_inline_constants_are_inspectable_and_layers_reversible() {
	let f = Fixture::new("ROOT=/very/long/project/path\necho \"$ROOT\"");
	let p = f.present(&[], &Options::default());
	assert!(text(&p.rows).contains("‹/very/long/project/path›"));
	assert!(p.rows.iter().flat_map(|r| &r.segments).any(|s| {
		s.expanded
			.as_deref()
			.is_some_and(|v| v.contains("ROOT=/very/long/project/path"))
	}));
	let mut options = Options::default();
	options.layers.inline = false;
	let plain = text(&f.present(&[], &options).rows);
	assert!(plain.contains("ROOT = \"/very/long/project/path\""));
	assert!(plain.contains("{ROOT}"));
}

#[test]
fn pseudo_inline_retains_parameter_operand_setters_and_unrelated_constants_fold() {
	for operand in [
		"${OTHER#$X}",
		"${OTHER%%$X}",
		"${OTHER/$X/replacement}",
		"${OTHER/pattern/$X}",
		"${OTHER^$X}",
		"${OTHER,,$X}",
		"${OTHER#\"$X\"}",
		"${OTHER/pattern/\"$X\"}",
	] {
		let script = format!("X=a\nSAFE=/safe/path\necho \"$SAFE\" \"$X\" \"{operand}\"\n");
		let fixture = Fixture::new(&script);
		let output = text(&fixture.present(&[], &Options::default()).rows);
		assert!(output.contains("X = \"a\""), "missing setter for {operand}: {output}");
		assert!(output.contains("{X}"), "missing reference for {operand}: {output}");
		assert!(!output.contains("‹a›"), "unsafe substitution for {operand}: {output}");
		assert!(output.contains("‹/safe/path›"), "unrelated constant for {operand}: {output}");

		let mut options = Options::default();
		options.layers.inline = false;
		let plain = text(&fixture.present(&[], &options).rows);
		assert!(plain.contains("SAFE = \"/safe/path\""), "{operand}: {plain}");
		assert!(plain.contains("{SAFE}"), "{operand}: {plain}");
	}
}

#[test]
fn setup_and_pipeline_idioms_restore_real_operands() {
	let f = Fixture::new(
		"cd /tmp\nset -a\n. .env\nset +a\ntimeout 3 curl https://example.test 2>&1 | tail -n 2 || \
		 true",
	);
	let mut options = Options::default();
	let folded = text(&f.present(&[], &options).rows);
	for expected in ["cwd /tmp", "exports all", "⏱ 3s", "may fail", "⇣ last 2"] {
		assert!(folded.contains(expected), "{folded}");
	}
	options.layers.idioms = false;
	let plain = text(&f.present(&[], &options).rows);
	for expected in
		["cd /tmp", "set -a", "set +a", "timeout 3 curl", "2>&1", "tail -n 2", " or true"]
	{
		assert!(plain.contains(expected), "{plain}");
	}
}

#[test]
fn embedded_documents_are_physical_rows_and_unwrap_restores_delimiters() {
	let script="python3 -c 'print(1)'\nnode -e 'const x = 1'\njq '.foo | length'\nawk 'BEGIN { print $1 }'\ncurl -d '{\"key\": true}' https://example.test\nrg 'a[0-9]+'\ndocker inspect --format '{{.Name}}' x\ncat >x.toml <<'TOML'\n[section]\nx = true\nTOML\ngit commit -F - <<'COMMIT'\nfeat(ui): add thing\nCOMMIT\n";
	let f = Fixture::new(script);
	let mut options = Options::default();
	let p = f.present(&[], &options);
	let languages = p
		.rows
		.iter()
		.flat_map(|r| &r.segments)
		.filter_map(|s| s.language.as_deref())
		.collect::<HashSet<_>>();
	for language in ["py", "js", "jq", "awk", "json", "regex", "gotmpl", "toml", "commit"] {
		assert!(languages.contains(language), "missing {language}");
	}
	assert!(
		p.rows
			.iter()
			.flat_map(|r| &r.segments)
			.all(|s| !s.text.contains('\n'))
	);
	options.layers.unwrap = false;
	let plain = text(&f.present(&[], &options).rows);
	assert!(plain.contains("python3 -c 'print(1)'"));
	assert!(plain.contains("<<'TOML'"));
	assert!(plain.contains("[section]"));
	assert!(plain.contains("  TOML"));
}

#[test]
fn guards_suppress_only_real_builtin_status_one_and_keep_leaf_identity() {
	for guard in [
		"[[ phase == build ]]",
		"(( attempt == 2 ))",
		"test -n \"$phase\"",
		"[ \"$phase\" = build ]",
		"false",
	] {
		for resolved in [ResolvedKind::Intrinsic, ResolvedKind::External, ResolvedKind::Function] {
			let f = Fixture::new(&format!("if {guard}; then echo yes; fi"));
			let CommandKind::If(branch) = &f.root(0).kind else {
				panic!("if")
			};
			let tested = &branch.arms[0].cond.items[0].and_or.first.stages[0].cmd;
			let key = NodeKey::engine(0, tested.id);
			let events = vec![expanded(1, key, resolved), end(2, key, 1)];
			let options = Options { cursor: Some(events.len()), ..Options::default() };
			let p = f.present(&events, &options);
			let fail = p
				.rows
				.iter()
				.flat_map(|r| &r.segments)
				.any(|s| s.state == Some(State::Fail));
			assert_eq!(fail, resolved != ResolvedKind::Intrinsic, "{guard} {resolved:?}");
			assert!(
				p.rows[0]
					.meta
					.as_deref()
					.is_some_and(|meta| meta.contains("↷"))
			);
			assert!(
				p.rows[0]
					.detail
					.as_deref()
					.unwrap()
					.contains("exit status: 1")
			);
			assert!(p.rows[0].execution_seq.is_none());
		}
	}
	let f = Fixture::new("((0))");
	let events = vec![end(1, f.key(0), 1)];
	let p = f.present(&events, &Options { cursor: Some(1), ..Options::default() });
	assert_eq!(p.rows[0].state, Some(State::Fail));
}

#[test]
fn fast_completions_are_real_and_never_copied_to_compound_scaffolding() {
	let f = Fixture::new("for x in a; do true; done");
	let CommandKind::For(loop_) = &f.root(0).kind else {
		panic!("for")
	};
	let child = NodeKey::engine(0, loop_.body.items[0].and_or.first.stages[0].cmd.id);
	let events = vec![end(1, child, 0), end(2, f.key(0), 0)];
	let p = f.present(&events, &Options { cursor: Some(2), ..Options::default() });
	assert!(
		p.rows
			.iter()
			.filter(|r| r.role == Some("head") || r.role == Some("tail"))
			.all(|r| r.execution_seq.is_none())
	);
	let row = p.rows.iter().find(|r| r.node == Some(child)).unwrap();
	assert_eq!(row.execution_seq, Some(1));
	assert!(row.meta.is_none());
}

#[test]
fn actual_last_setter_moves_once_and_replay_removes_it() {
	let f = Fixture::new("x=first\nx=second\nread x");
	let events = vec![
		assignment(1, Some(f.key(0)), "first"),
		assignment(2, Some(f.key(1)), "second"),
		assignment(3, Some(f.key(2)), "stdin"),
	];
	for (cursor, value, owner) in [(1, "first", 0), (2, "second", 1), (3, "stdin", 2)] {
		for view in [View::Raw, View::Pseudo] {
			let p = f.present(&events, &Options {
				view,
				cursor: Some(cursor),
				split: true,
				..Options::default()
			});
			let rows = p
				.rows
				.iter()
				.filter(|r| r.annotations.is_some())
				.collect::<Vec<_>>();
			assert_eq!(rows.len(), 1);
			assert_eq!(rows[0].annotations.as_ref().unwrap()[0].value, value);
			assert_eq!(p.watches[0].node, Some(f.key(owner)));
			assert!(p.original.iter().all(|r| r.annotations.is_none()));
		}
	}
	let reset = f.present(&events, &Options { cursor: Some(0), ..Options::default() });
	assert!(reset.watches.is_empty());
	assert!(reset.rows.iter().all(|r| r.annotations.is_none()));
	let unlocated =
		f.present(&[assignment(1, None, "real")], &Options { cursor: Some(1), ..Options::default() });
	assert_eq!(unlocated.rows.last().unwrap().id, "variable-setters-unlocated");
	assert!(unlocated.watches[0].node.is_none());
}

#[test]
fn static_remote_scripts_have_exact_unicode_ranges_but_no_fabricated_outcomes() {
	let script = "ssh -p 22 host \"echo \\\"😀\\\"; printf café\"";
	let f = Fixture::new(script);
	let p = f.present(&[], &Options::default());
	assert!(text(&p.rows).contains("remote/untraced"));
	let inner = p
		.rows
		.iter()
		.filter(|r| r.node.is_some_and(|k| k.source > 0))
		.collect::<Vec<_>>();
	assert!(!inner.is_empty());
	assert!(
		inner
			.iter()
			.all(|r| r.state.is_none() && r.active != Some(true))
	);
	assert!(
		inner
			.iter()
			.flat_map(|r| &r.segments)
			.any(|s| s.range.is_some() && s.text.contains('😀'))
	);
}

#[test]
fn external_literals_wait_for_real_external_resolution() {
	let f = Fixture::new("docker exec box bash -lc 'echo external'");
	let before = f.present(&[], &Options::default());
	assert!(!text(&before.rows).contains("external/untraced"));
	let events = [expanded(1, f.key(0), ResolvedKind::External)];
	let after = f.present(&events, &Options { cursor: Some(1), ..Options::default() });
	assert!(text(&after.rows).contains("external/untraced"));
	assert!(text(&after.rows).contains("print(\"external\")"));
}

#[test]
fn live_and_restored_sources_share_the_same_semantic_renderer() {
	let script = "X=/tmp\necho \"$X\"\n";
	let f = Fixture::new(script);
	let units=f.units.iter().map(|u|serde_json::json!({"at":u.at,"line":1,"bytes":u.source.len(),"source":String::from_utf8_lossy(&u.source),"syntax":u.syntax,"nodes":u.nodes})).collect::<Vec<_>>();
	let snapshot = serde_json::json!({"script":script,"units":units,"history":[],"t_ns":0});
	let stored =
		super::super::StoredVisualization::from_snapshot_json(&snapshot.to_string()).unwrap();
	let restored: serde_json::Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	let live = serde_json::to_value(f.present(&[], &Options::default())).unwrap();
	assert_eq!(restored["rows"], live["rows"]);
	assert_eq!(restored["original"], live["original"]);
}
