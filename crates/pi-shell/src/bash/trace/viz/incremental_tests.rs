use super::*;

#[test]
fn an_unannounced_malformed_tail_is_not_parsed_or_transformed() {
	let mut fixture = Fixture::new("echo first\n");
	fixture.script = "echo first\nif then invalid".into();
	let p = fixture.present(&[], &Options { split: true, ..Options::default() });
	assert_eq!(text(&p.rows), "print(\"first\")\nif then invalid");
	assert_eq!(text(&p.original), "echo first\nif then invalid");
	assert!(p.message.is_none());
	assert!(fixture.cache.inner.lock().nested.is_empty());
}

#[test]
fn immutable_analysis_invalidates_when_same_count_syntax_changes() {
	let mut fixture = Fixture::new("echo first");
	assert!(text(&fixture.present(&[], &Options::default()).rows).contains("first"));
	let Fixture { script, units, cache: _ } = Fixture::new("echo later");
	fixture.script = script;
	fixture.units = units;
	let after = fixture.present(&[], &Options { split: true, ..Options::default() });
	assert_eq!(text(&after.rows), "print(\"later\")");
	assert_eq!(text(&after.original), "echo later");
}

#[test]
fn syntax_becoming_available_at_same_count_is_not_cached_as_raw() {
	struct Availability<'a> {
		fixture:   &'a Fixture,
		available: bool,
	}
	impl VizSource for Availability<'_> {
		fn script(&self) -> &BStr {
			self.fixture.script()
		}

		fn unit_count(&self) -> usize {
			self.fixture.unit_count()
		}

		fn unit(&self, index: usize) -> Option<super::super::super::runtime::SourceUnit<'_>> {
			self.fixture.unit(index).map(|mut unit| {
				if !self.available {
					unit.syntax = None;
				}
				unit
			})
		}

		fn cache(&self) -> &Cache {
			self.fixture.cache()
		}
	}
	let fixture = Fixture::new("echo announced");
	let options = Options::default();
	let unavailable = Availability { fixture: &fixture, available: false };
	let runtime = Runtime::reduce(&unavailable, [].iter(), &options, None, None, 0, false);
	assert_eq!(text(&render(&unavailable, &runtime, &options).rows), "echo announced");
	let available = fixture.present(&[], &options);
	assert_eq!(text(&available.rows), "print(\"announced\")");
}

#[test]
fn layer_switches_keep_original_and_structural_chips() {
	let script =
		"ROOT=/tmp\nif test -d /tmp; then curl \"$ROOT\" https://example.test | tail -1; fi\n";
	let fixture = Fixture::new(script);
	for view in [View::Raw, View::Pseudo] {
		for mask in 0..32 {
			let options = Options {
				view,
				split: true,
				layers: Layers {
					color:   mask & 1 != 0,
					inline:  mask & 2 != 0,
					idioms:  mask & 4 != 0,
					effects: mask & 8 != 0,
					unwrap:  mask & 16 != 0,
				},
				..Options::default()
			};
			let p = fixture.present(&[], &options);
			if view == View::Pseudo {
				assert_eq!(text(&p.original), script);
			} else {
				assert!(p.original.is_empty());
			}
			if !options.layers.effects {
				assert!(p.rows.iter().all(|r| r.effects.is_empty()));
			}
			if !options.layers.color {
				assert!(p.rows.iter().flat_map(|r| &r.segments).all(|s| {
					s.style.as_deref().is_none_or(|style| {
						style.split_whitespace().all(|token| {
							matches!(token, "chip" | "badge" | "emb" | "frame" | "section" | "uncompiled")
						})
					})
				}));
			}
		}
	}
}

#[test]
fn condition_arm_outcomes_use_each_actual_test() {
	let fixture = Fixture::new("if false; then echo no; elif true; then echo yes; fi");
	let CommandKind::If(branch) = fixture.root(0).kind() else {
		panic!("if")
	};
	let test = |k: usize| {
		let cond = branch.arms().nth(k).unwrap().cond;
		cond
			.items()
			.first()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.first()
			.unwrap()
			.id()
	};
	let first = NodeKey::engine(0, test(0));
	let second = NodeKey::engine(0, test(1));
	let history = [
		expanded(1, first, ResolvedKind::Intrinsic),
		end(2, first, 1),
		expanded(3, second, ResolvedKind::Intrinsic),
		end(4, second, 0),
	];
	let p = fixture.present(&history, &Options { cursor: Some(4), ..Options::default() });
	let heads = p
		.rows
		.iter()
		.filter(|r| r.role == Some("head"))
		.collect::<Vec<_>>();
	assert_eq!(heads[0].meta.as_deref(), Some("↷"));
	assert_eq!(heads[1].meta.as_deref(), Some("↳"));
	assert_eq!(heads[1].state, Some(State::Ok));
}

#[test]
fn arithmetic_uses_engine_expression_semantics_and_faithful_loop_control() {
	let fixture =
		Fixture::new("for ((i=0; i<3; i++)); do if ((i == 1)); then continue; fi; echo $i; done");
	let p = fixture.present(&[], &Options::default());
	let output = text(&p.rows);
	assert!(output.contains("for _ in arithmetic_loop(init=lambda: assign(i, 0)"));
	assert!(output.contains("condition=lambda: (i < 3)"));
	assert!(output.contains("step=lambda: post_inc(i)"));
	assert!(
		p.rows[0].segments[0]
			.tip
			.as_deref()
			.unwrap()
			.contains("continue")
	);
	let dynamic = Fixture::new("(( x = $DYNAMIC ))");
	let raw = text(&dynamic.present(&[], &Options::default()).rows);
	assert!(raw.contains("$DYNAMIC"));
}

#[test]
fn actual_local_units_preserve_pending_tail_and_raw_literal_leaf_projection() {
	use crate::bash::trace::syntax::SourceParent;
	let mut fixture = Fixture::new("bash -c 'echo inner\nread x'");
	let CommandKind::Simple(parent) = fixture.root(0).kind() else {
		panic!("shell launch")
	};
	let word = parent.words().get(2).unwrap();
	let span = word.span();
	let parent = SourceParent { unit: 0, node: word.id().0, lo: span.lo, hi: span.hi };
	let child = Fixture::new("echo inner\nread x");
	let Fixture { script: _, mut units, cache: _ } = child;
	let mut first = units.remove(0);
	first.syntax.parent = Some(parent);
	let active = NodeKey::engine(1, match first.syntax.tree.view() {
		Root::List(list) => list
			.items()
			.first()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.first()
			.unwrap()
			.id(),
		_ => panic!("child list"),
	});
	fixture.units.push(first);
	let events = [event(1, Some(active), HistoryData::CmdStart)];
	let mut options = Options { cursor: Some(1), ..Options::default() };
	let expanded = fixture.present(&events, &options);
	assert!(text(&expanded.rows).contains("print(\"inner\")"));
	assert!(
		expanded
			.rows
			.iter()
			.any(|row| row.segments.iter().any(|segment| segment
				.style
				.as_deref()
				.is_some_and(|style| style.contains("uncompiled"))
				&& segment.text == "read x"))
	);
	options.layers.unwrap = false;
	let raw_literal = fixture.present(&events, &options);
	assert!(
		raw_literal
			.rows
			.iter()
			.flat_map(|row| &row.segments)
			.any(|segment| segment.node == Some(active) && segment.active == Some(true))
	);
	assert!(
		raw_literal
			.rows
			.iter()
			.flat_map(|row| &row.segments)
			.all(|segment| !segment.text.contains('\n'))
	);
	let mut next = units.remove(0);
	next.syntax.parent = Some(parent);
	fixture.units.push(next);
	options.layers.unwrap = true;
	let complete = fixture.present(&events, &options);
	assert!(
		complete
			.rows
			.iter()
			.flat_map(|row| &row.segments)
			.all(|segment| !segment
				.style
				.as_deref()
				.is_some_and(|style| style.contains("uncompiled")))
	);
}

#[test]
fn negated_and_until_predicates_have_real_boolean_outcomes() {
	for (script, until) in [("if ! false; then :; fi", false), ("until false; do :; done", true)] {
		let fixture = Fixture::new(script);
		let condition = match fixture.root(0).kind() {
			CommandKind::If(branch) => branch.arms().next().unwrap().cond,
			CommandKind::While(loop_) => loop_.cond(),
			_ => panic!("condition"),
		};
		let first = condition
			.items()
			.first()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.first()
			.unwrap();
		let key = NodeKey::engine(0, first.id());
		let events = [expanded(1, key, ResolvedKind::Intrinsic), end(2, key, 1)];
		let p = fixture.present(&events, &Options { cursor: Some(2), ..Options::default() });
		assert_eq!(p.rows[0].meta.as_deref(), Some("↳"), "until={until}");
		assert!(
			p.rows
				.iter()
				.flat_map(|r| &r.segments)
				.all(|s| s.state != Some(State::Fail))
		);
	}
}

#[test]
fn remote_bodies_keep_their_own_static_scope_and_all_semantic_layers() {
	let fixture =
		Fixture::new("ROOT=outer\nssh host 'ROOT=inner; f() { echo \"$1\"; }; echo \"$ROOT\"; f ok'");
	let p = fixture.present(&[], &Options::default());
	let output = text(&p.rows);
	assert!(output.contains("‹inner›"), "{output}");
	assert!(output.contains("def f(arg1):"), "{output}");
	assert!(output.contains("f(\"ok\")"), "{output}");
	assert!(
		p.rows
			.iter()
			.filter(|row| row.node.is_some_and(|key| key.source > 0))
			.all(|row| row.state.is_none())
	);
	let nested = Fixture::new("ssh host 'bash -c \"echo deep\"'");
	assert!(text(&nested.present(&[], &Options::default()).rows).contains("print(\"deep\")"));
}

#[test]
fn static_namespaces_are_independent_of_external_resolution_order() {
	let script = "docker exec box bash -c 'echo first; echo two'\nsudo bash -c 'echo second'";
	let live = Fixture::new(script);
	let second = expanded(1, live.key(1), ResolvedKind::External);
	let first = expanded(2, live.key(0), ResolvedKind::External);
	live.present(std::slice::from_ref(&second), &Options { cursor: Some(1), ..Options::default() });
	let a = live.present(&[second, first], &Options { cursor: Some(2), ..Options::default() });
	let restored = Fixture::new(script);
	let b = restored.present(
		&[
			expanded(1, restored.key(1), ResolvedKind::External),
			expanded(2, restored.key(0), ResolvedKind::External),
		],
		&Options { cursor: Some(2), ..Options::default() },
	);
	let keys = |p: Presentation| {
		p.rows
			.into_iter()
			.filter_map(|r| r.node)
			.filter(|k| k.source > 0)
			.collect::<Vec<_>>()
	};
	assert_eq!(keys(a), keys(b));
}
