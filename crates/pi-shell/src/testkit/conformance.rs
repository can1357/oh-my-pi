//! `store_conformance`: the behaviour every [`StateStore`] must show, run
//! against `MemStore` here and against any other store a host provides.
//!
//! Two groups of cases. Store cases drive the trait directly: records and
//! blobs round-trip byte-exactly, each [`Change`] does what its docs say
//! (and rejects the wrong shape), scans stay in their table, the epoch moves
//! only when the embedder bumps it, a copy holds the same state. Shell cases
//! drive a [`Shell`] over the store and check that the store *is* the
//! shell's state: every write is visible after the op that made it, a host
//! write between two steps is seen by the next op, and a copy taken between
//! any two top-level commands restores a fresh shell that continues exactly
//! as the original does. The zsh cases pin the same for zsh
//! options, the current mode, a zsh function's saved state and sticky
//! emulation.

use std::sync::Arc;

use bstr::{BStr, BString, ByteSlice};

use crate::{
	bash::{
		Attrs, Budget, CallOutcome, Cx, Engine, EngineConfig, JobId, ModeId, RestoreOpts, RunId,
		Script, Shell, ShellApi, SigTarget, Signal, StateStore, Step, StoreError, UnitId, VarValue,
		Vpid,
		store::{
			BlobSlot, Change, Elem, Job, JobState, Key, KeyBuf, LossyKind, MiscKey, OptId, Record,
			Sticky, Table, TrapKey, Var, ZshScope,
		},
		zshopt::{ZshOpt, ZshOpts},
	},
	testkit::{
		fault::skeleton_init,
		host::FakeHost,
		memfs::MemFs,
		run::{Stop, advance, wait_runnable},
	},
};

/// Check the [`StateStore`] contract on the stores `make` returns (every
/// case gets a fresh one). Panics on the first violation, naming it.
///
/// - `bump_epoch`: what the embedder does after a write the engine did not
///   make. The harness makes such writes itself with [`StateStore::apply`],
///   then calls `bump_epoch`; [`StateStore::epoch`] must then differ, so the
///   engine drops what it derived from the store and the next op sees the
///   write.
/// - `copy`: a store holding the same state as its argument, as a heap snapshot
///   restored in another process would (`MemStore` clones; the JS store writes
///   and reads a full JS heap snapshot). The original must not change.
pub fn store_conformance<S: StateStore>(
	mut make: impl FnMut() -> S,
	mut bump_epoch: impl FnMut(&mut S),
	mut copy: impl FnMut(&S) -> S,
) {
	records_round_trip(&mut make());
	later_changes_win(&mut make());
	put_rejects_a_record_of_another_table(&mut make());
	set_scalar_replaces_the_value_and_keeps_the_attributes(&mut make());
	set_elem_keeps_indices_sorted_and_assoc_keys_in_order(&mut make());
	append_changes_keep_attributes_and_order(&mut make());
	del_elem_removes_one_element(&mut make());
	fine_grained_changes_reject_the_wrong_shape(&mut make());
	deleting_a_scope_drops_its_locals(&mut make());
	scan_visits_each_table_alone(&mut make());
	zsh_options_and_aliases_put_scan_del_and_follow_the_epoch(&mut make(), &mut bump_epoch);
	blobs_are_independent(&mut make());
	apply_never_moves_the_epoch(&mut make(), &mut bump_epoch);
	copies_hold_the_same_records(&mut make(), &mut copy);
	shell_sees_out_of_band_writes_after_an_epoch_bump(&mut make(), &mut bump_epoch);
	frames_resume_from_the_store(&mut make());
	assignments_are_visible_after_each_op(&mut make());
	a_local_is_visible_while_its_function_runs(&mut make());
	cd_set_o_and_alias_are_visible_after_each_op(&mut make());
	a_background_job_is_visible_while_it_runs(&mut make());
	a_host_write_ends_a_running_loop_at_its_next_test(&mut make(), &mut bump_epoch);
	a_host_option_write_reaches_the_next_glob(&mut make(), &mut bump_epoch);
	a_host_cwd_write_reaches_the_next_command(&mut make(), &mut bump_epoch);
	a_copy_between_commands_restores_in_a_fresh_shell(&mut make, &mut copy);
	a_trap_set_before_a_copy_runs_in_the_restored_shell(&mut make, &mut copy);
	a_trap_runs_in_a_shell_restored_mid_command(&mut make, &mut copy);
	emulate_and_setopt_are_visible_after_each_op(&mut make());
	a_host_zsh_option_write_reaches_the_next_split(&mut make(), &mut bump_epoch);
	a_zsh_function_scope_holds_the_callers_options(&mut make());
	a_sticky_function_survives_a_copy_between_commands(&mut make, &mut copy);
}

/// One op per step: what "after each op" means in the shell cases.
const ONE_OP: Budget = Budget { max_ops: 1, max_ns: u64::MAX };

/// Most single-op steps a shell case takes before it calls the run hung.
const MAX_STEPS: u32 = 100_000;

/// `Key::Var(name)`.
fn var(name: &[u8]) -> Key<'_> {
	Key::Var(BStr::new(name))
}

/// `Key::Local { depth, name }`.
fn local(depth: u32, name: &[u8]) -> Key<'_> {
	Key::Local { depth, name: BStr::new(name) }
}

/// A scalar variable record.
fn str_var(value: &[u8], attrs: Attrs) -> Record {
	Record::Var(Var { attrs, value: VarValue::Str(BString::from(value)) })
}

/// A variable record holding `value`.
const fn var_rec(attrs: Attrs, value: VarValue) -> Record {
	Record::Var(Var { attrs, value })
}

/// A scope record.
fn scope_rec(func: Option<&str>) -> Record {
	Record::Scope { func: func.map(BString::from), positional: None, zsh: None }
}

/// A sticky emulation naming options on and off.
fn sticky_sample() -> Sticky {
	Sticky {
		mode: ModeId::ZshSh,
		full: true,
		on:   vec![ZshOpt::Ksharrays, ZshOpt::Shwordsplit],
		off:  vec![ZshOpt::Nomatch],
	}
}

/// A zsh scope save with every field set, a saved trap and a slot that was
/// unset.
fn zsh_scope_sample() -> ZshScope {
	let mut opts = ZshOpts::defaults(ModeId::Zsh);
	opts.set(ZshOpt::Shwordsplit, true);
	opts.set(ZshOpt::Errexit, true);
	ZshScope {
		mode: ModeId::Bash,
		opts,
		sticky: Some(sticky_sample()),
		restore_sticky: true,
		traps: vec![
			(TrapKey::Exit, Some(Record::Trap { mode: ModeId::Zsh, action: bytes(b"echo \xffbye") })),
			(TrapKey::Signal(Signal::Usr1), None),
		],
		lossy: LossyKind::SparseGaps.bit() | LossyKind::Shadowed.bit(),
		pat_disables: vec![bytes(b"*")],
	}
}

/// Owned bytes.
fn bytes(b: &[u8]) -> BString {
	BString::from(b)
}

/// Apply `change`, which must succeed.
fn apply(store: &mut dyn StateStore, change: Change<'_>) {
	store.apply(change).expect("apply");
}

/// The record at `key`, copied.
fn read(store: &mut dyn StateStore, key: Key<'_>) -> Option<Record> {
	store.get(key).expect("get").cloned()
}

/// The value of the scalar variable at `key`.
fn read_scalar(store: &mut dyn StateStore, key: Key<'_>) -> Option<BString> {
	match store.get(key).expect("get") {
		Some(Record::Var(Var { value: VarValue::Str(s), .. })) => Some(s.clone()),
		_ => None,
	}
}

/// The decimal value of global `name`.
fn read_number(store: &mut dyn StateStore, name: &[u8]) -> u64 {
	read_scalar(store, var(name))
		.and_then(|v| v.to_str().ok()?.parse().ok())
		.unwrap_or_else(|| panic!("{} holds a number", name.as_bstr()))
}

/// Append `v` unless it equals the last value.
fn push_distinct<T: PartialEq>(seq: &mut Vec<T>, v: T) {
	if seq.last() != Some(&v) {
		seq.push(v);
	}
}

/// One record in every table: non-UTF-8 names and values, a NUL-leading
/// value, sparse indexed arrays with negative and huge indices, an assoc
/// array in non-sorted order, root scopes (outermost first) with a
/// variable and an `Unset` local; zsh options, global and suffix aliases of
/// the same name, a sticky function, a scope's zsh save, attributes with
/// every zsh flag and the widest width and base, the `zsh-sh` mode.
fn samples() -> Vec<(KeyBuf, Record)> {
	vec![
		(KeyBuf::Var(bytes(b"\xff\xfename")), str_var(b"\xff\x00\xfe not utf-8", Attrs::EXPORT)),
		(KeyBuf::Var(bytes(b"nul")), str_var(b"\x00lead", Attrs::NONE)),
		(KeyBuf::Var(bytes(b"empty")), str_var(b"", Attrs::NONE)),
		(KeyBuf::Var(bytes(b"ro")), str_var(b"7", Attrs::READONLY.with(Attrs::INTEGER))),
		(KeyBuf::Var(bytes(b"declared")), str_var(b"", Attrs::INTEGER.with(Attrs::INVISIBLE))),
		(
			KeyBuf::Var(bytes(b"wide")),
			str_var(
				b"007",
				Attrs::ZSH_ONLY
					.with(Attrs::INTEGER)
					.with_width(65535)
					.with_base(255),
			),
		),
		(
			KeyBuf::Var(bytes(b"sparse")),
			var_rec(
				Attrs::INDEXED,
				VarValue::Indexed(vec![
					(i64::MIN, bytes(b"min")),
					(-3, bytes(b"neg")),
					(0, bytes(b"a")),
					(5, bytes(b"b")),
					(1_000_000, bytes(b"c")),
					(i64::MAX, bytes(b"\xffmax")),
				]),
			),
		),
		(
			KeyBuf::Var(bytes(b"assoc")),
			var_rec(
				Attrs::ASSOC,
				VarValue::Assoc(
					vec![
						(bytes(b"z"), bytes(b"1")),
						(bytes(b"a"), bytes(b"2")),
						(bytes(b"\xff"), bytes(b"3")),
						(bytes(b"m"), bytes(b"")),
					]
					.into(),
				),
			),
		),
		(KeyBuf::Func(bytes(b"f\xff")), Record::Func {
			mode:   ModeId::Bash,
			sticky: None,
			source: bytes(b"f\xff () \n{ \n    :\n}"),
			unit:   UnitId([7; 32]),
			attrs:  Attrs::TRACE,
			file:   bytes(b"main"),
		}),
		(KeyBuf::Func(bytes(b"sticky")), Record::Func {
			mode:   ModeId::Zsh,
			sticky: Some(Box::new(sticky_sample())),
			source: bytes(b"sticky () {\n\tprint -l $x\n}"),
			unit:   UnitId([8; 32]),
			attrs:  Attrs::NONE,
			file:   bytes(b"zsh\xff"),
		}),
		(KeyBuf::ZshOpt(ZshOpt::Extendedglob), Record::Opt(true)),
		(KeyBuf::ZshOpt(ZshOpt::Nomatch), Record::Opt(false)),
		(
			KeyBuf::ZshAlias { suffix: false, name: bytes(b"G\xff") },
			Record::Alias(bytes(b"| grep \xfe")),
		),
		(KeyBuf::ZshAlias { suffix: true, name: bytes(b"G\xff") }, Record::Alias(bytes(b"vi"))),
		(KeyBuf::Misc(MiscKey::Mode), Record::Misc(bytes(b"zsh-sh"))),
		(KeyBuf::Alias(bytes(b"l\xffl")), Record::Alias(bytes(b"ls -l \xfe"))),
		(KeyBuf::Opt(OptId::Errexit), Record::Opt(true)),
		(KeyBuf::Opt(OptId::Nullglob), Record::Opt(false)),
		(KeyBuf::Trap(TrapKey::Exit), Record::Trap { mode: ModeId::Bash, action: bytes(b"") }),
		(KeyBuf::Trap(TrapKey::Signal(Signal::Usr1)), Record::Trap {
			mode:   ModeId::Bash,
			action: bytes(b"echo \xff"),
		}),
		(
			KeyBuf::Job(JobId(1)),
			Record::Job(Job {
				id:        JobId(1),
				number:    1,
				vpid:      Vpid(Vpid::BASE + 1),
				text:      bytes(b"sleep 1"),
				state:     JobState::Stopped(Signal::Tstp),
				control:   true,
				notified:  false,
				nohup:     true,
				inherited: false,
				wd:        bytes(b"/t\xffmp"),
				os_pid:    Some(4242),
			}),
		),
		(
			KeyBuf::Job(JobId(2)),
			Record::Job(Job {
				id:        JobId(2),
				number:    2,
				vpid:      Vpid(Vpid::BASE + 2),
				text:      bytes(b"{ :; }"),
				state:     JobState::Done(137),
				control:   false,
				notified:  true,
				nohup:     false,
				inherited: false,
				wd:        bytes(b"/"),
				os_pid:    None,
			}),
		),
		(KeyBuf::Proc(Vpid(Vpid::BASE + 1)), Record::Proc {
			parent: Some(Vpid(Vpid::BASE)),
			status: None,
		}),
		(KeyBuf::Proc(Vpid(Vpid::BASE + 2)), Record::Proc { parent: None, status: Some(0) }),
		(KeyBuf::DirStack, Record::DirStack(vec![bytes(b"/a"), bytes(b"/\xffb")])),
		(KeyBuf::CmdHash(bytes(b"ls")), Record::CmdHash { path: bytes(b"/bin/ls"), hits: 3 }),
		(
			KeyBuf::Misc(MiscKey::Positional),
			Record::Words(vec![bytes(b""), bytes(b"x y"), bytes(b"\xff")]),
		),
		(KeyBuf::Misc(MiscKey::Cwd), Record::Misc(bytes(b"/t\xffmp"))),
		(KeyBuf::Scope(0), Record::Scope {
			func:       Some(bytes(b"f\xff")),
			positional: Some(vec![bytes(b"a"), bytes(b"")]),
			zsh:        Some(Box::new(zsh_scope_sample())),
		}),
		(KeyBuf::Scope(1), Record::Scope { func: None, positional: None, zsh: None }),
		// One parameter, the same again (`f "$@"`), none: stores may keep
		// each differently (a JS-object store keeps one parameter as a
		// string and shares a repeated one).
		(KeyBuf::Scope(2), Record::Scope {
			func:       Some(bytes(b"one")),
			positional: Some(vec![bytes(b"\xffonly")]),
			zsh:        None,
		}),
		(KeyBuf::Scope(3), Record::Scope {
			func:       Some(bytes(b"again")),
			positional: Some(vec![bytes(b"\xffonly")]),
			zsh:        Some(Box::new(zsh_scope_sample())),
		}),
		(KeyBuf::Scope(4), Record::Scope {
			func:       Some(bytes(b"none")),
			positional: Some(vec![]),
			zsh:        None,
		}),
		(KeyBuf::Local { depth: 0, name: bytes(b"y") }, str_var(b"1", Attrs::NONE)),
		(KeyBuf::Local { depth: 0, name: bytes(b"u") }, Record::Unset),
		(KeyBuf::Local { depth: 1, name: bytes(b"IFS") }, str_var(b":", Attrs::NONE)),
	]
}

/// Put every [`samples`] record into `store`.
fn put_samples(store: &mut dyn StateStore, samples: &[(KeyBuf, Record)]) {
	for (k, r) in samples {
		apply(store, Change::Put(k.as_key(), r.clone()));
	}
}

/// Every record reads back exactly as it was put (bytes, order,
/// sparseness); absent keys read as `None`.
fn records_round_trip(store: &mut dyn StateStore) {
	let samples = samples();
	put_samples(store, &samples);
	for (k, r) in &samples {
		assert_eq!(
			store.get(k.as_key()).expect("get"),
			Some(r),
			"{k:?} round-trips exactly (bytes, order, sparseness)"
		);
	}
	assert_eq!(store.get(var(b"absent")).expect("get"), None, "absent keys read as None");
	assert_eq!(store.get(local(0, b"absent")).expect("get"), None, "absent locals read as None");
	assert_eq!(store.get(Key::Scope(5)).expect("get"), None, "absent scopes read as None");
}

/// Changes apply in the order they are made: the last `Put` wins, a `Del`
/// removes, deleting an absent record has no effect.
fn later_changes_win(store: &mut dyn StateStore) {
	apply(store, Change::Put(var(b"k"), str_var(b"1", Attrs::NONE)));
	apply(store, Change::Put(var(b"k"), str_var(b"2", Attrs::EXPORT)));
	assert_eq!(read(store, var(b"k")), Some(str_var(b"2", Attrs::EXPORT)), "the last Put wins");
	apply(store, Change::Del(var(b"k")));
	assert_eq!(read(store, var(b"k")), None, "a Del removes the record");
	apply(store, Change::Del(var(b"k")));
	assert_eq!(read(store, var(b"k")), None, "deleting an absent record has no effect");
	apply(store, Change::Put(var(b"k"), str_var(b"3", Attrs::NONE)));
	assert_eq!(read(store, var(b"k")), Some(str_var(b"3", Attrs::NONE)), "a Put after a Del");
}

/// A `Put` whose record does not belong to the key's table, or a local of
/// a depth without a scope, fails with [`StoreError::Shape`] of that table
/// and stores nothing.
fn put_rejects_a_record_of_another_table(store: &mut dyn StateStore) {
	let cases = [
		(var(b"v"), Record::Alias(bytes(b"x"))),
		(var(b"v"), Record::Unset),
		(var(b"v"), scope_rec(None)),
		(Key::Alias(BStr::new("a")), str_var(b"x", Attrs::NONE)),
		(Key::Scope(0), str_var(b"x", Attrs::NONE)),
		(Key::Misc(MiscKey::Cwd), scope_rec(Some("f"))),
		(local(0, b"x"), str_var(b"no scope 0", Attrs::NONE)),
		(Key::ZshOpt(ZshOpt::Extendedglob), Record::Alias(bytes(b"x"))),
		// An env option lives in `Table::Opt` only (`ZshOpt::env_twin`).
		(Key::ZshOpt(ZshOpt::Errexit), Record::Opt(true)),
		(Key::ZshAlias { suffix: true, name: BStr::new("txt") }, Record::Opt(true)),
	];
	for (key, rec) in cases {
		let what = format!("Put({key:?}, {rec:?})");
		let table = key.table();
		let res = store.apply(Change::Put(key, rec));
		assert!(
			matches!(res, Err(StoreError::Shape { table: found }) if found == table),
			"{what} is a shape error of table {table}, got {res:?}"
		);
		assert_eq!(read(store, key), None, "the rejected {what} stored nothing");
	}
}

/// `SetScalar` replaces an existing scalar's value (any bytes, empty too)
/// and keeps its attributes, for globals and locals alike.
fn set_scalar_replaces_the_value_and_keeps_the_attributes(store: &mut dyn StateStore) {
	let attrs = Attrs::EXPORT.with(Attrs::INTEGER);
	apply(store, Change::Put(var(b"s"), str_var(b"old", attrs)));
	apply(store, Change::SetScalar(var(b"s"), BStr::new(b"\xff\xfe new")));
	assert_eq!(read(store, var(b"s")), Some(str_var(b"\xff\xfe new", attrs)), "value replaced");
	apply(store, Change::SetScalar(var(b"s"), BStr::new("")));
	assert_eq!(read(store, var(b"s")), Some(str_var(b"", attrs)), "an empty value");
	apply(store, Change::Put(Key::Scope(0), scope_rec(Some("f"))));
	apply(store, Change::Put(local(0, b"s"), str_var(b"l", Attrs::LOWER)));
	apply(store, Change::SetScalar(local(0, b"s"), BStr::new("l2")));
	assert_eq!(
		read(store, local(0, b"s")),
		Some(str_var(b"l2", Attrs::LOWER)),
		"a local's value replaced"
	);
	assert_eq!(read(store, var(b"s")), Some(str_var(b"", attrs)), "the global it hides is kept");
}

/// `SetElem` replaces an existing element in place, inserts a new index in
/// sorted position (negative and huge ones too), appends a new assoc key
/// and keeps an existing one where it is; attributes are kept.
fn set_elem_keeps_indices_sorted_and_assoc_keys_in_order(store: &mut dyn StateStore) {
	let attrs = Attrs::INDEXED.with(Attrs::EXPORT);
	let a = VarValue::Indexed(vec![(0, bytes(b"a")), (10, bytes(b"k"))]);
	apply(store, Change::Put(var(b"a"), var_rec(attrs, a)));
	let elems: [(i64, &[u8]); 4] = [(10, b"K"), (5, b"f"), (-2, b"neg"), (i64::MAX, b"\xffmax")];
	for (i, v) in elems {
		apply(store, Change::SetElem(var(b"a"), Elem::Index(i), BStr::new(v)));
	}
	let want = VarValue::Indexed(vec![
		(-2, bytes(b"neg")),
		(0, bytes(b"a")),
		(5, bytes(b"f")),
		(10, bytes(b"K")),
		(i64::MAX, bytes(b"\xffmax")),
	]);
	assert_eq!(read(store, var(b"a")), Some(var_rec(attrs, want)), "indices stay sorted");
	let m = VarValue::Assoc(vec![(bytes(b"z"), bytes(b"1")), (bytes(b"a"), bytes(b"2"))].into());
	apply(store, Change::Put(var(b"m"), var_rec(Attrs::ASSOC, m)));
	let elems: [(&[u8], &[u8]); 3] = [(b"a", b"A"), (b"\xff", b"new"), (b"b", b"b")];
	for (k, v) in elems {
		apply(store, Change::SetElem(var(b"m"), Elem::Key(BStr::new(k)), BStr::new(v)));
	}
	let want = VarValue::Assoc(
		vec![
			(bytes(b"z"), bytes(b"1")),
			(bytes(b"a"), bytes(b"A")),
			(bytes(b"\xff"), bytes(b"new")),
			(bytes(b"b"), bytes(b"b")),
		]
		.into(),
	);
	assert_eq!(
		read(store, var(b"m")),
		Some(var_rec(Attrs::ASSOC, want)),
		"a new key goes last, an existing one keeps its place"
	);
}

/// Append deltas preserve attributes and concatenate only the selected
/// value, creating missing elements with the same order as `SetElem`.
fn append_changes_keep_attributes_and_order(store: &mut dyn StateStore) {
	let attrs = Attrs::EXPORT.with(Attrs::LOWER);
	apply(store, Change::Put(var(b"s"), str_var(b"a", attrs)));
	apply(store, Change::AppendScalar(var(b"s"), BStr::new(b"\xffb")));
	apply(store, Change::AppendScalar(var(b"s"), BStr::new("")));
	assert_eq!(read(store, var(b"s")), Some(str_var(b"a\xffb", attrs)));
	apply(store, Change::Put(Key::Scope(0), scope_rec(Some("f"))));
	apply(store, Change::Put(local(0, b"s"), str_var(b"local", attrs)));
	apply(store, Change::AppendScalar(local(0, b"s"), BStr::new("+")));
	assert_eq!(read(store, local(0, b"s")), Some(str_var(b"local+", attrs)));
	let indexed = VarValue::Indexed(vec![(2, bytes(b"x")), (9, bytes(b"z"))]);
	apply(store, Change::Put(var(b"a"), var_rec(Attrs::INDEXED, indexed)));
	for (i, v) in [(9, "Z"), (5, "m"), (12, ""), (2, "")] {
		apply(store, Change::AppendElem(var(b"a"), Elem::Index(i), BStr::new(v)));
	}
	let want = VarValue::Indexed(vec![
		(2, bytes(b"x")),
		(5, bytes(b"m")),
		(9, bytes(b"zZ")),
		(12, bytes(b"")),
	]);
	assert_eq!(read(store, var(b"a")), Some(var_rec(Attrs::INDEXED, want)));
	let assoc = VarValue::Assoc(vec![(bytes(b"z"), bytes(b"1")), (bytes(b"a"), bytes(b"2"))].into());
	apply(store, Change::Put(var(b"m"), var_rec(Attrs::ASSOC, assoc)));
	for (k, v) in [("a", "+"), ("b", "3"), ("z", "")] {
		apply(store, Change::AppendElem(var(b"m"), Elem::Key(BStr::new(k)), BStr::new(v)));
	}
	let want = VarValue::Assoc(
		vec![(bytes(b"z"), bytes(b"1")), (bytes(b"a"), bytes(b"2+")), (bytes(b"b"), bytes(b"3"))]
			.into(),
	);
	assert_eq!(read(store, var(b"m")), Some(var_rec(Attrs::ASSOC, want)));
}

/// `DelElem` removes one element and keeps the others in order; an absent
/// element has no effect.
fn del_elem_removes_one_element(store: &mut dyn StateStore) {
	let a = VarValue::Indexed(vec![(0, bytes(b"a")), (3, bytes(b"d")), (7, bytes(b"h"))]);
	apply(store, Change::Put(var(b"a"), var_rec(Attrs::INDEXED, a)));
	apply(store, Change::DelElem(var(b"a"), Elem::Index(3)));
	apply(store, Change::DelElem(var(b"a"), Elem::Index(4)));
	let want = VarValue::Indexed(vec![(0, bytes(b"a")), (7, bytes(b"h"))]);
	assert_eq!(read(store, var(b"a")), Some(var_rec(Attrs::INDEXED, want)), "index 3 removed");
	let m = VarValue::Assoc(
		vec![(bytes(b"z"), bytes(b"1")), (bytes(b"a"), bytes(b"2")), (bytes(b"m"), bytes(b"3"))]
			.into(),
	);
	apply(store, Change::Put(var(b"m"), var_rec(Attrs::ASSOC, m)));
	apply(store, Change::DelElem(var(b"m"), Elem::Key(BStr::new("a"))));
	apply(store, Change::DelElem(var(b"m"), Elem::Key(BStr::new("q"))));
	let want = VarValue::Assoc(vec![(bytes(b"z"), bytes(b"1")), (bytes(b"m"), bytes(b"3"))].into());
	assert_eq!(read(store, var(b"m")), Some(var_rec(Attrs::ASSOC, want)), "key a removed");
}

/// Set, append and delete deltas on an absent record, a non-variable, a
/// value of the other kind or an element of the other kind fail with
/// [`StoreError::Shape`] of the key's table and change nothing.
fn fine_grained_changes_reject_the_wrong_shape(store: &mut dyn StateStore) {
	let scalar = str_var(b"s", Attrs::NONE);
	let indexed = var_rec(Attrs::INDEXED, VarValue::Indexed(vec![(1, bytes(b"x"))]));
	let assoc = var_rec(Attrs::ASSOC, VarValue::Assoc(vec![(bytes(b"k"), bytes(b"v"))].into()));
	let alias = Record::Alias(bytes(b"echo"));
	apply(store, Change::Put(var(b"s"), scalar.clone()));
	apply(store, Change::Put(var(b"a"), indexed.clone()));
	apply(store, Change::Put(var(b"m"), assoc.clone()));
	apply(store, Change::Put(Key::Alias(BStr::new("al")), alias.clone()));
	let value = BStr::new("v");
	let assoc_key = Elem::Key(BStr::new("k"));
	let cases = [
		Change::SetScalar(var(b"absent"), value),
		Change::SetScalar(var(b"a"), value),
		Change::SetScalar(var(b"m"), value),
		Change::SetScalar(Key::Alias(BStr::new("al")), value),
		Change::SetScalar(local(0, b"s"), value),
		Change::AppendScalar(var(b"absent"), value),
		Change::AppendScalar(var(b"a"), value),
		Change::AppendScalar(var(b"m"), value),
		Change::AppendScalar(Key::Alias(BStr::new("al")), value),
		Change::AppendScalar(local(0, b"s"), value),
		Change::AppendElem(var(b"absent"), Elem::Index(0), value),
		Change::AppendElem(var(b"s"), Elem::Index(0), value),
		Change::AppendElem(var(b"a"), assoc_key, value),
		Change::AppendElem(var(b"m"), Elem::Index(0), value),
		Change::SetElem(var(b"absent"), Elem::Index(0), value),
		Change::SetElem(var(b"s"), Elem::Index(0), value),
		Change::SetElem(var(b"a"), assoc_key, value),
		Change::SetElem(var(b"m"), Elem::Index(0), value),
		Change::DelElem(var(b"absent"), Elem::Index(0)),
		Change::DelElem(var(b"s"), Elem::Index(0)),
		Change::DelElem(var(b"a"), assoc_key),
		Change::DelElem(var(b"m"), Elem::Index(0)),
	];
	for change in cases {
		let what = format!("{change:?}");
		let table = match change {
			Change::Put(key, _)
			| Change::Del(key)
			| Change::SetScalar(key, _)
			| Change::AppendScalar(key, _)
			| Change::SetElem(key, ..)
			| Change::AppendElem(key, ..)
			| Change::DelElem(key, _) => key.table(),
		};
		let res = store.apply(change);
		assert!(
			matches!(res, Err(StoreError::Shape { table: found }) if found == table),
			"{what} is a shape error of table {table}, got {res:?}"
		);
	}
	assert_eq!(read(store, var(b"s")), Some(scalar), "rejected changes leave the scalar");
	assert_eq!(read(store, var(b"a")), Some(indexed), "rejected changes leave the indexed array");
	assert_eq!(read(store, var(b"m")), Some(assoc), "rejected changes leave the assoc array");
	assert_eq!(read(store, Key::Alias(BStr::new("al"))), Some(alias), "and the alias");
	assert_eq!(read(store, var(b"absent")), None, "and create nothing");
}

/// `Del(Scope(d))` of the innermost scope drops it with every local of
/// depth `d` and nothing else; a scope pushed again starts empty; deleting
/// one local leaves its scope.
fn deleting_a_scope_drops_its_locals(store: &mut dyn StateStore) {
	apply(store, Change::Put(Key::Scope(0), scope_rec(Some("f"))));
	apply(store, Change::Put(Key::Scope(1), scope_rec(None)));
	apply(store, Change::Put(local(0, b"a"), str_var(b"0a", Attrs::NONE)));
	apply(store, Change::Put(local(1, b"a"), str_var(b"1a", Attrs::NONE)));
	apply(store, Change::Put(local(1, b"b"), Record::Unset));
	apply(store, Change::Put(var(b"a"), str_var(b"g", Attrs::NONE)));
	apply(store, Change::Del(local(0, b"missing")));
	apply(store, Change::Del(Key::Scope(1)));
	assert_eq!(read(store, Key::Scope(1)), None, "the scope is gone");
	assert_eq!(read(store, local(1, b"a")), None, "with its variables");
	assert_eq!(read(store, local(1, b"b")), None, "and its unset locals");
	assert_eq!(read(store, Key::Scope(0)), Some(scope_rec(Some("f"))), "the outer scope stays");
	assert_eq!(read(store, local(0, b"a")), Some(str_var(b"0a", Attrs::NONE)), "with its locals");
	assert_eq!(read(store, var(b"a")), Some(str_var(b"g", Attrs::NONE)), "globals stay");
	apply(store, Change::Put(Key::Scope(1), scope_rec(Some("g"))));
	assert_eq!(read(store, local(1, b"a")), None, "a scope pushed again starts empty");
	apply(store, Change::Del(local(0, b"a")));
	assert_eq!(read(store, local(0, b"a")), None, "deleting a local removes it");
	assert_eq!(read(store, Key::Scope(0)), Some(scope_rec(Some("f"))), "but not its scope");
	apply(store, Change::Del(Key::Scope(1)));
	apply(store, Change::Del(Key::Scope(0)));
	let mut left = 0;
	store
		.scan(Table::Scope, &mut |_, _| left += 1)
		.expect("scan");
	store
		.scan(Table::Local, &mut |_, _| left += 1)
		.expect("scan");
	assert_eq!(left, 0, "popping every scope leaves no scope or local");
}

/// Every table, `Scope` and `Local` included.
const TABLES: [Table; 14] = [
	Table::Var,
	Table::Func,
	Table::Alias,
	Table::Opt,
	Table::Trap,
	Table::Job,
	Table::Proc,
	Table::DirStack,
	Table::CmdHash,
	Table::Misc,
	Table::Scope,
	Table::Local,
	Table::ZshOpt,
	Table::ZshAlias,
];

/// A scan of each table visits exactly that table's records, once each.
fn scan_visits_each_table_alone(store: &mut dyn StateStore) {
	let samples = samples();
	put_samples(store, &samples);
	for table in TABLES {
		let mut seen = Vec::new();
		store
			.scan(table, &mut |k, r| {
				assert_eq!(k.table(), table, "a scan of {table} visited {k:?}");
				seen.push((k.to_buf(), r.clone()));
			})
			.expect("scan");
		seen.sort_by(|x, y| x.0.cmp(&y.0));
		let mut want: Vec<(KeyBuf, Record)> = samples
			.iter()
			.filter(|(k, _)| k.as_key().table() == table)
			.cloned()
			.collect();
		want.sort_by(|x, y| x.0.cmp(&y.0));
		assert!(!want.is_empty(), "the samples cover table {table}");
		assert_eq!(seen, want, "a scan of {table} visits exactly its records");
	}
}

/// zsh options put, read, scan and delete like any keyed record, and a
/// write followed by an epoch bump is what the store reads next; a global
/// and a suffix alias of the same name are separate records.
fn zsh_options_and_aliases_put_scan_del_and_follow_the_epoch<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let split = Key::ZshOpt(ZshOpt::Shwordsplit);
	let ksh = Key::ZshOpt(ZshOpt::Ksharrays);
	assert_eq!(read(store, split), None, "absent: the zsh default applies");
	apply(store, Change::Put(split, Record::Opt(true)));
	apply(store, Change::Put(ksh, Record::Opt(false)));
	assert_eq!(read(store, split), Some(Record::Opt(true)), "a zsh option reads back");
	let mut seen = Vec::new();
	store
		.scan(Table::ZshOpt, &mut |k, r| seen.push((k.to_buf(), r.clone())))
		.expect("scan");
	seen.sort_by(|x, y| x.0.cmp(&y.0));
	assert_eq!(
		seen,
		[(ksh.to_buf(), Record::Opt(false)), (split.to_buf(), Record::Opt(true))],
		"a scan of zsh options visits both"
	);
	let e0 = store.epoch();
	apply(store, Change::Put(split, Record::Opt(false)));
	assert_eq!(store.epoch(), e0, "an engine write leaves the epoch");
	bump(&mut *store);
	assert_ne!(store.epoch(), e0, "the embedder's bump moves it");
	assert_eq!(read(store, split), Some(Record::Opt(false)), "after the bump the write is read");
	apply(store, Change::Del(split));
	assert_eq!(read(store, split), None, "a Del removes a zsh option");
	bump(&mut *store);
	assert_eq!(read(store, split), None, "and stays removed after a bump");
	assert_eq!(read(store, ksh), Some(Record::Opt(false)), "the other option stays");

	let global = Key::ZshAlias { suffix: false, name: BStr::new("pdf") };
	let suffix = Key::ZshAlias { suffix: true, name: BStr::new("pdf") };
	apply(store, Change::Put(global, Record::Alias(bytes(b"| less"))));
	apply(store, Change::Put(suffix, Record::Alias(bytes(b"zathura"))));
	assert_eq!(read(store, global), Some(Record::Alias(bytes(b"| less"))), "the global alias");
	assert_eq!(read(store, suffix), Some(Record::Alias(bytes(b"zathura"))), "the suffix alias");
	assert_eq!(read(store, Key::Alias(BStr::new("pdf"))), None, "neither is a regular alias");
	apply(store, Change::Del(global));
	bump(&mut *store);
	assert_eq!(read(store, global), None, "deleting the global alias");
	let mut left = Vec::new();
	store
		.scan(Table::ZshAlias, &mut |k, r| left.push((k.to_buf(), r.clone())))
		.expect("scan");
	assert_eq!(
		left,
		[(suffix.to_buf(), Record::Alias(bytes(b"zathura")))],
		"leaves the suffix alias of the same name"
	);
}

/// Blob slots are independent; blobs round-trip any bytes.
fn blobs_are_independent(store: &mut dyn StateStore) {
	let unit = BlobSlot::Unit(UnitId([1; 32]));
	store.put_blob(BlobSlot::Frames, b"frames").expect("put");
	store.put_blob(unit, b"\x00unit\xff").expect("put");
	assert_eq!(store.get_blob(BlobSlot::Frames).expect("get").as_deref(), Some(&b"frames"[..]));
	assert_eq!(store.get_blob(unit).expect("get").as_deref(), Some(&b"\x00unit\xff"[..]));
	store.del_blob(BlobSlot::Frames).expect("del");
	assert_eq!(store.get_blob(BlobSlot::Frames).expect("get"), None, "deleting one slot");
	assert!(store.get_blob(unit).expect("get").is_some(), "leaves the others");
}

/// Engine writes (every `Change`, blobs) never move the epoch; every
/// `bump_epoch` does.
fn apply_never_moves_the_epoch<S: StateStore>(store: &mut S, bump: &mut impl FnMut(&mut S)) {
	let e0 = store.epoch();
	apply(store, Change::Put(var(b"e"), str_var(b"1", Attrs::NONE)));
	apply(store, Change::SetScalar(var(b"e"), BStr::new("2")));
	apply(store, Change::Put(Key::Scope(0), scope_rec(Some("f"))));
	apply(store, Change::Put(local(0, b"e"), Record::Unset));
	apply(store, Change::Del(Key::Scope(0)));
	apply(store, Change::Del(var(b"e")));
	store.put_blob(BlobSlot::Frames, b"f").expect("put_blob");
	store.del_blob(BlobSlot::Frames).expect("del_blob");
	assert_eq!(store.epoch(), e0, "engine writes never move the epoch");
	bump(&mut *store);
	let e1 = store.epoch();
	assert_ne!(e1, e0, "bump_epoch moves the epoch");
	bump(&mut *store);
	assert_ne!(store.epoch(), e1, "every bump moves it again");
}

/// `copy` holds every record and blob of the original, and writes to the
/// copy leave the original alone.
fn copies_hold_the_same_records<S: StateStore>(store: &mut S, copy: &mut impl FnMut(&S) -> S) {
	let samples = samples();
	put_samples(store, &samples);
	let unit = BlobSlot::Unit(UnitId([2; 32]));
	store.put_blob(unit, b"\xffunit\x00").expect("put_blob");
	let mut dup = copy(&*store);
	for (k, r) in &samples {
		assert_eq!(dup.get(k.as_key()).expect("get"), Some(r), "the copy holds {k:?} exactly");
	}
	assert_eq!(dup.get_blob(unit).expect("get_blob").as_deref(), Some(&b"\xffunit\x00"[..]));
	apply(&mut dup, Change::SetScalar(var(b"empty"), BStr::new("changed")));
	apply(&mut dup, Change::Del(Key::Scope(1)));
	assert_eq!(
		read(store, var(b"empty")),
		Some(str_var(b"", Attrs::NONE)),
		"writes to the copy leave the original"
	);
	assert_eq!(
		read(store, local(1, b"IFS")),
		Some(str_var(b":", Attrs::NONE)),
		"scopes of the original survive a pop in the copy"
	);
}

/// A fresh shell over `store` (`$0` = bash, `PATH` only).
fn create<S: StateStore>(host: &mut FakeHost, store: &mut S) -> Shell {
	let engine = Engine::new(EngineConfig::default());
	Shell::create(&engine, &mut Cx { host: &mut *host, store: &mut *store }, skeleton_init(&[]))
		.expect("create")
}

/// Run `src` to completion with the default budget; its status.
fn run<S: StateStore>(shell: &mut Shell, host: &mut FakeHost, store: &mut S, src: &str) -> i32 {
	let id = shell.submit(Script::command(src.as_bytes()));
	for _ in 0..MAX_STEPS {
		match advance(shell, host, &mut *store, id, Budget::default()) {
			Stop::Done(status) => return status,
			Stop::Yield => {},
			other => panic!("`{src}`: unexpected {other:?}"),
		}
	}
	panic!("`{src}` did not finish");
}

/// What one top-level command did.
#[derive(Debug, PartialEq, Eq)]
struct Ran {
	status: i32,
	stdout: BString,
	stderr: BString,
}

/// Run `src`, then step the shell until it is idle (background vprocs
/// finish); its status and the output it and they wrote.
fn run_settled<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	src: &str,
) -> Ran {
	let (out0, err0) = (host.stdout.bytes().len(), host.stderr.bytes().len());
	let status = run(shell, host, store, src);
	host.assert_no_leaks(shell, &mut *store);
	let (out, err) = (host.stdout.bytes(), host.stderr.bytes());
	Ran { status, stdout: bytes(&out[out0..]), stderr: bytes(&err[err0..]) }
}

/// Step `run` by at most one op; `Some(status)` once it finished. A
/// callout is first shown to `at_call` (the store as the tool sees it),
/// then answered from the host's tool table.
fn one_op<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	run: RunId,
	at_call: &mut dyn FnMut(&mut S),
) -> Option<i32> {
	let step = shell.step(&mut Cx { host: &mut *host, store: &mut *store }, ONE_OP);
	match step {
		Step::Done { run: r, status } if r == run => Some(status),
		Step::Call { id, call } => {
			at_call(&mut *store);
			let tool = host
				.tool_fn(call.tool)
				.expect("callout registered with the host");
			let mut cx = Cx { host: &mut *host, store: &mut *store };
			let outcome = {
				let mut api = shell.api(&mut cx, id).expect("call is outstanding");
				tool(&mut api, &call.argv)
			};
			shell.complete(id, outcome);
			None
		},
		Step::Blocked => {
			if !host.fire_next_timer() {
				wait_runnable(&shell.control());
			}
			None
		},
		Step::Done { .. } | Step::Yield | Step::SuspendReady => None,
		Step::Paused => panic!("{run:?}: paused without a pause request"),
		Step::Idle => panic!("{run:?} is neither running nor reported done"),
	}
}

/// Run `src` one op per step, showing the store to `observe` after every
/// step (`false`) and at every callout (`true`); its status.
fn each_op<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	src: &str,
	observe: &mut dyn FnMut(&mut S, bool),
) -> i32 {
	let run = shell.submit(Script::command(src.as_bytes()));
	for _ in 0..MAX_STEPS {
		let done = one_op(shell, host, store, run, &mut |s: &mut S| observe(s, true));
		observe(&mut *store, false);
		if let Some(status) = done {
			return status;
		}
	}
	panic!("`{src}` did not finish in {MAX_STEPS} ops");
}

/// Step `run` one op at a time until it finishes; its status.
fn finish<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	run: RunId,
	max_ops: u32,
	what: &str,
) -> i32 {
	for _ in 0..max_ops {
		if let Some(status) = one_op(shell, host, store, run, &mut |_| {}) {
			return status;
		}
	}
	panic!("{what}: not finished within {max_ops} ops");
}

/// The distinct consecutive values of the record at `key` while `src` runs
/// one op per step, starting with the value before it.
fn distinct_values<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	src: &str,
	key: Key<'_>,
) -> Vec<Option<Record>> {
	let mut seen = vec![read(store, key)];
	let status =
		each_op(shell, host, store, src, &mut |s, _| push_distinct(&mut seen, read(s, key)));
	assert_eq!(status, 0, "`{src}`");
	seen
}

/// An embedder write between commands, followed by an epoch bump, is what
/// the next command sees.
fn shell_sees_out_of_band_writes_after_an_epoch_bump<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	run(&mut shell, &mut host, store, "x=1; echo $x");
	assert_eq!(
		read(store, var(b"x")),
		Some(str_var(b"1", Attrs::NONE)),
		"the engine wrote its assignment through"
	);
	apply(store, Change::Put(var(b"x"), str_var(b"2", Attrs::NONE)));
	bump(&mut *store);
	run(&mut shell, &mut host, store, "echo $x");
	assert_eq!(host.stdout.bytes(), b"1\n2\n", "an epoch bump makes the engine re-read the store");
}

/// A script suspended mid-loop resumes from the `Frames` blob in a fresh
/// shell and continues its output exactly where it stopped.
fn frames_resume_from_the_store<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	let id = shell.submit(Script::command(&b"for i in 1 2 3; do echo $i; done"[..]));
	let budget = Budget { max_ops: 5, max_ns: u64::MAX };
	assert_eq!(advance(&mut shell, &mut host, &mut *store, id, budget), Stop::Yield);
	shell.control().request_suspend();
	let mut cx = Cx { host: &mut host, store: &mut *store };
	assert!(matches!(shell.step(&mut cx, budget), Step::SuspendReady));
	shell.externalize(&mut cx).expect("externalize");
	drop(shell);
	let engine = Engine::new(EngineConfig::default());
	let (mut shell, report) =
		Shell::restore(&engine, &mut cx, RestoreOpts::default()).expect("restore");
	assert_eq!(report.runs, 1, "the script in flight is restored");
	assert_eq!(advance(&mut shell, &mut host, &mut *store, id, Budget::default()), Stop::Done(0));
	assert_eq!(host.stdout.bytes(), b"1\n2\n3\n", "output continues exactly where it stopped");
}

/// Write-through, not write-back: stepping a loop one op at a time, the
/// store shows every value a scalar and an array take (a cache written back
/// at the end of the command shows only the last one).
fn assignments_are_visible_after_each_op<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	let mut xs = vec![read_scalar(store, var(b"x"))];
	let status =
		each_op(&mut shell, &mut host, store, "for v in 1 2 3 4 5; do x=$v; done", &mut |s, _| {
			push_distinct(&mut xs, read_scalar(s, var(b"x")));
		});
	assert_eq!(status, 0);
	let want: Vec<Option<BString>> = std::iter::once(None)
		.chain((1..=5).map(|v| Some(BString::from(v.to_string()))))
		.collect();
	assert_eq!(xs, want, "x holds each value in turn after the op that assigned it");
	let indexed = |s: &mut S| match s.get(var(b"a")).expect("get") {
		Some(Record::Var(Var { value: VarValue::Indexed(items), .. })) => items.clone(),
		_ => Vec::new(),
	};
	let mut lens = vec![0];
	let status = each_op(
		&mut shell,
		&mut host,
		store,
		"for v in 1 2 3 4 5; do a[$v]=$v; done",
		&mut |s, _| push_distinct(&mut lens, indexed(s).len()),
	);
	assert_eq!(status, 0);
	assert_eq!(lens, [0, 1, 2, 3, 4, 5], "each element is in the store after its assignment");
	let want: Vec<(i64, BString)> = (1..=5).map(|i| (i, BString::from(i.to_string()))).collect();
	assert_eq!(indexed(&mut *store), want, "the array holds every element");
}

/// While a function runs, its scope is `Scope(0)` (func `f`) and its
/// local `y` is `Local { depth: 0, name: "y" }`, with every value it takes;
/// the global `y` is never written; after the return both are gone.
fn a_local_is_visible_while_its_function_runs<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	host.tool("probe", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut shell = create(&mut host, store);
	type Seen = (Option<Option<BString>>, Option<BString>, Option<BString>);
	let mut calls: Vec<Seen> = Vec::new();
	let status = each_op(
		&mut shell,
		&mut host,
		store,
		"f() { local y=1; probe; y=2; probe; }; f; probe",
		&mut |s, at_call| {
			if at_call {
				let func = match s.get(Key::Scope(0)).expect("get") {
					Some(Record::Scope { func, .. }) => Some(func.clone()),
					_ => None,
				};
				calls.push((func, read_scalar(s, local(0, b"y")), read_scalar(s, var(b"y"))));
			}
		},
	);
	assert_eq!(status, 0);
	let f = Some(Some(BString::from("f")));
	let want: Vec<Seen> = vec![
		(f.clone(), Some(BString::from("1")), None),
		(f, Some(BString::from("2")), None),
		(None, None, None),
	];
	assert_eq!(calls, want, "(Scope(0) func, local y, global y) at each callout");
}

/// `cd`, `set -o`/`set +o` and `alias`/`unalias` are in the store after
/// the op that made them, one change at a time.
fn cd_set_o_and_alias_are_visible_after_each_op<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	for d in ["/a", "/b", "/c"] {
		host.fs.add_dir(d);
	}
	let mut shell = create(&mut host, store);
	let cwd =
		distinct_values(&mut shell, &mut host, store, "cd /a; cd /b; cd /c", Key::Misc(MiscKey::Cwd));
	let want: Vec<Option<Record>> = ["/a", "/b", "/c"]
		.iter()
		.map(|d| Some(Record::Misc(BString::from(*d))))
		.collect();
	assert_eq!(cwd[1..], want, "the root cwd after each cd");
	let pipefail = distinct_values(
		&mut shell,
		&mut host,
		store,
		"set -o pipefail; set +o pipefail; set -o pipefail",
		Key::Opt(OptId::Pipefail),
	);
	let mut on: Vec<bool> = pipefail
		.iter()
		.map(|r| matches!(r, Some(Record::Opt(true))))
		.collect();
	on.dedup();
	assert_eq!(on, [false, true, false, true], "pipefail after each set");
	let alias = distinct_values(
		&mut shell,
		&mut host,
		store,
		"alias a=1; alias a=2; unalias a; alias a=3",
		Key::Alias(BStr::new("a")),
	);
	let want: Vec<Option<Record>> = vec![
		None,
		Some(Record::Alias(bytes(b"1"))),
		Some(Record::Alias(bytes(b"2"))),
		None,
		Some(Record::Alias(bytes(b"3"))),
	];
	assert_eq!(alias, want, "alias a after each alias/unalias");
}

/// A background vproc job's `Record::Job` (running) and its running
/// `Record::Proc` are in the store while it runs, and its exit is written
/// as it happens.
fn a_background_job_is_visible_while_it_runs<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	let mut vpid: Option<Vpid> = None;
	let mut seen: Vec<(Option<JobState>, Option<Option<i32>>)> = vec![(None, None)];
	let status = each_op(&mut shell, &mut host, store, "{ :; } & wait", &mut |s, _| {
		let mut jobs = Vec::new();
		s.scan(Table::Job, &mut |_, r| {
			if let Record::Job(j) = r {
				jobs.push(j.clone());
			}
		})
		.expect("scan");
		assert!(jobs.len() <= 1, "one job at most: {jobs:?}");
		let job = jobs.pop();
		if let Some(j) = &job {
			assert_eq!(*vpid.get_or_insert(j.vpid), j.vpid, "the job keeps its vpid");
		}
		let proc = vpid.and_then(|v| match s.get(Key::Proc(v)).expect("get") {
			Some(Record::Proc { status, .. }) => Some(*status),
			_ => None,
		});
		push_distinct(&mut seen, (job.map(|j| j.state), proc));
	});
	assert_eq!(status, 0);
	let at = seen
		.iter()
		.position(|o| *o == (Some(JobState::Running), Some(None)))
		.unwrap_or_else(|| panic!("a running job with a running proc record: {seen:?}"));
	assert!(
		seen[at + 1..].iter().any(|o| o.1 != Some(None)),
		"the job's exit is written through as it happens: {seen:?}"
	);
}

/// A loop stepped one op at a time ends at its next test once the host
/// sets the variable it tests (`Put` + epoch bump between two steps).
fn a_host_write_ends_a_running_loop_at_its_next_test<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	let src = "x=go; n=0; while [ \"$x\" != stop ]; do n=$((n+1)); done; echo \"$x $n\"";
	let run = shell.submit(Script::command(src.as_bytes()));
	for _ in 0..200 {
		let done = one_op(&mut shell, &mut host, store, run, &mut |_| {});
		assert_eq!(done, None, "the loop runs until the host stops it");
	}
	let n0 = read_number(store, b"n");
	assert!(n0 >= 3, "the loop ran before the host write ({n0} iterations)");
	apply(store, Change::Put(var(b"x"), str_var(b"stop", Attrs::NONE)));
	bump(&mut *store);
	let status = finish(&mut shell, &mut host, store, run, 200, "the loop after x=stop");
	assert_eq!(status, 0);
	let n = read_number(store, b"n");
	assert!(n == n0 || n == n0 + 1, "the loop ended at its next test: {n0} then {n}");
	assert_eq!(host.stdout.bytes(), format!("stop {n}\n").as_bytes());
}

/// An option the host turns on between two steps (`noglob`) changes the
/// next pathname expansion: the engine's option bits follow the epoch.
fn a_host_option_write_reaches_the_next_glob<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let mut host = FakeHost::new();
	host.fs.add_file("/d/a", b"", 0o644);
	let mut shell = create(&mut host, store);
	let src = "n=0; set -- /d/*; while [ \"$1\" != '/d/*' ]; do n=$((n+1)); set -- /d/*; done; \
	           echo \"$1 $n\"";
	let run = shell.submit(Script::command(src.as_bytes()));
	for _ in 0..200 {
		let done = one_op(&mut shell, &mut host, store, run, &mut |_| {});
		assert_eq!(done, None, "the glob matches until the host sets noglob");
	}
	let n0 = read_number(store, b"n");
	assert!(n0 >= 3, "the loop ran before the host write ({n0} iterations)");
	apply(store, Change::Put(Key::Opt(OptId::Noglob), Record::Opt(true)));
	bump(&mut *store);
	let status = finish(&mut shell, &mut host, store, run, 200, "the loop after set -f");
	assert_eq!(status, 0);
	let n = read_number(store, b"n");
	assert!(n == n0 || n == n0 + 1, "the next glob saw noglob: {n0} then {n}");
	assert_eq!(host.stdout.bytes(), format!("/d/* {n}\n").as_bytes());
}

/// A working directory the host writes (`MiscKey::Cwd` + epoch bump)
/// between two commands is the next command's: `pwd` prints it.
fn a_host_cwd_write_reaches_the_next_command<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let mut host = FakeHost::new();
	host.fs.add_dir("/a");
	host.fs.add_dir("/b");
	let mut shell = create(&mut host, store);
	assert_eq!(run(&mut shell, &mut host, store, "cd /a"), 0);
	apply(store, Change::Put(Key::Misc(MiscKey::Cwd), Record::Misc(bytes(b"/b"))));
	bump(&mut *store);
	let ran = run_settled(&mut shell, &mut host, store, "pwd");
	assert_eq!(ran.stdout, "/b\n", "pwd prints the cwd the host wrote");
}

/// The session of [`a_copy_between_commands_restores_in_a_fresh_shell`]:
/// one top-level command per entry. Not covered: `ulimit -n` (`FakeHost`
/// reports no resource limits, so the engine offers no `-n`).
const SESSION: &[&str] = &[
	"declare -i n=3+4; declare -l low=HeLLo; declare -r ro=fixed; declare -x ex=out; echo $n $low \
	 $ro $ex",
	"n+=1; low+=WORLD; declare -p n low ro ex",
	"sparse=([0]=a [5]=b [1000000]=c); sparse[-1]=z; unset 'sparse[5]'",
	"echo \"${!sparse[@]}\" \"${sparse[@]}\"; sparse+=(next)",
	"declare -A m=([z]=1 [a]=2 [m]=3); m[$'\\xfe']=4; unset 'm[a]'",
	"printf '%q ' \"${!m[@]}\" \"${m[@]}\"; echo",
	"bytes=$'\\xff\\xfe'; printf '%q\\n' \"$bytes\"",
	"declare -n ref=n; ref=42; echo $n ${!ref}",
	"f() {\n\tlocal y=$1\n\techo \"f:$y:$LINENO:${FUNCNAME[0]}\"\n\treturn 3\n}",
	"f one; echo $?",
	"shopt -s expand_aliases; alias say='echo said'",
	"say hi; alias",
	"set -o pipefail; shopt -s nullglob",
	"false | true",
	"echo \"$? ${PIPESTATUS[*]}\"; shopt -po pipefail; shopt -p nullglob",
	"trap 'echo t' USR1; trap -p USR1",
	"cd /work; pushd /tmp; umask 027",
	"dirs; pwd; umask; popd; pwd",
	"set -- a b c; shift",
	"echo \"$# $*\"; hash -p /usr/bin/tool tool; hash -t tool",
	"{ :; } &",
	"echo $!",
	"jobs",
	"RANDOM=7",
	"echo $RANDOM $RANDOM",
	"getopts ab:c opt -a -b val -c; echo \"$opt $OPTIND\"",
	"getopts ab:c opt -a -b val -c; echo \"$opt $OPTIND $OPTARG\"",
	"getopts ab:c opt -a -b val -c; echo \"$opt $OPTIND\"; f two; declare -p sparse m bytes; \
	 declare -f f; trap -p; echo \"$-\"",
];

/// The store between any two top-level commands is the complete shell
/// state: for every split k, a copy of shell A's store after commands
/// `0..k` holds no `Frames` blob, restores a fresh shell B (new engine,
/// fresh host over the same filesystem) with nothing lost, and B runs
/// commands `k..` with the same status, stdout and stderr as A.
fn a_copy_between_commands_restores_in_a_fresh_shell<S: StateStore>(
	make: &mut impl FnMut() -> S,
	copy: &mut impl FnMut(&S) -> S,
) {
	let fs = MemFs::new();
	fs.add_dir("/work");
	let mut host_a = FakeHost::new().with_fs(fs.clone());
	let mut store_a = make();
	let mut shell_a = create(&mut host_a, &mut store_a);
	let mut original = Vec::with_capacity(SESSION.len());
	let mut resumed = Vec::with_capacity(SESSION.len() + 1);
	for k in 0..=SESSION.len() {
		let mut store_b = copy(&store_a);
		assert!(
			store_b
				.get_blob(BlobSlot::Frames)
				.expect("get_blob")
				.is_none(),
			"split {k}: the store of an idle shell holds no Frames blob"
		);
		let mut host_b = FakeHost::new().with_fs(fs.clone());
		let engine = Engine::new(EngineConfig::default());
		let (mut shell_b, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host_b, store: &mut store_b },
			RestoreOpts::default(),
		)
		.expect("restore");
		assert!(report.lost.is_empty(), "split {k}: nothing is lost, got {:?}", report.lost);
		let mut ran = Vec::with_capacity(SESSION.len() - k);
		for src in &SESSION[k..] {
			ran.push(run_settled(&mut shell_b, &mut host_b, &mut store_b, src));
		}
		drop(shell_b);
		host_b.assert_released();
		resumed.push(ran);
		if let Some(src) = SESSION.get(k) {
			original.push(run_settled(&mut shell_a, &mut host_a, &mut store_a, src));
		}
	}
	for (k, ran) in resumed.iter().enumerate() {
		for (i, (b, a)) in ran.iter().zip(&original[k..]).enumerate() {
			assert_eq!(
				b,
				a,
				"split at {k}: command {} (`{}`) differs on the restored shell",
				k + i,
				SESSION[k + i]
			);
		}
	}
	host_a.assert_no_leaks(&mut shell_a, &mut store_a);
}

/// The root vproc of a shell built with the default [`EngineConfig`]: where
/// a host's OS-signal bridge sends the signals the shell traps.
fn root_vpid() -> Vpid {
	Vpid(EngineConfig::default().vpid_base)
}

/// A fresh shell over `store` that ran `trap 'echo t' USR1`.
fn trapping_shell<S: StateStore>(host: &mut FakeHost, store: &mut S) -> Shell {
	let mut shell = create(host, store);
	assert_eq!(run(&mut shell, host, store, "trap 'echo t' USR1"), 0);
	shell
}

/// Send `USR1` to the root vproc on the virtual signal bus, as a host
/// forwards a caught OS signal, then step `run` to its end; what it wrote
/// to stdout meanwhile.
fn signal_and_finish<S: StateStore>(
	shell: &mut Shell,
	host: &mut FakeHost,
	store: &mut S,
	run: RunId,
) -> BString {
	let before = host.stdout.bytes().len();
	shell
		.control()
		.signal(SigTarget::Vpid(root_vpid()), Signal::Usr1);
	assert_eq!(advance(shell, host, &mut *store, run, Budget::default()), Stop::Done(0));
	bytes(&host.stdout.bytes()[before..])
}

/// A signal trap is root state in the store: a copy taken between two
/// top-level commands restores a fresh shell (new engine, fresh host) that
/// runs the trap when the host signals its root vproc before the next
/// command, as the original shell does.
fn a_trap_set_before_a_copy_runs_in_the_restored_shell<S: StateStore>(
	make: &mut impl FnMut() -> S,
	copy: &mut impl FnMut(&S) -> S,
) {
	let mut host_a = FakeHost::new();
	let mut store_a = make();
	let mut shell_a = trapping_shell(&mut host_a, &mut store_a);
	let mut store_b = copy(&store_a);
	let mut host_b = FakeHost::new();
	let engine = Engine::new(EngineConfig::default());
	let (mut shell_b, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host_b, store: &mut store_b },
		RestoreOpts::default(),
	)
	.expect("restore");
	assert!(report.lost.is_empty(), "nothing is lost, got {:?}", report.lost);
	let id = shell_b.submit(Script::command(&b"echo next"[..]));
	let restored = signal_and_finish(&mut shell_b, &mut host_b, &mut store_b, id);
	assert_eq!(restored, "t\nnext\n", "the restored shell runs the trap before the next command");
	let id = shell_a.submit(Script::command(&b"echo next"[..]));
	let original = signal_and_finish(&mut shell_a, &mut host_a, &mut store_a, id);
	assert_eq!(original, restored, "the original shell runs it the same way");
}

/// The same with a command in flight: externalized mid-loop (the copy holds
/// a `Frames` blob), the copy restores a fresh shell that runs the trap at
/// its next op once the signal arrives, then finishes the loop.
fn a_trap_runs_in_a_shell_restored_mid_command<S: StateStore>(
	make: &mut impl FnMut() -> S,
	copy: &mut impl FnMut(&S) -> S,
) {
	let mut host_a = FakeHost::new();
	let mut store_a = make();
	let mut shell_a = trapping_shell(&mut host_a, &mut store_a);
	let id = shell_a.submit(Script::command(
		&b"i=0; while [ $i -lt 3 ]; do i=$((i + 1)); done; echo done $i"[..],
	));
	let budget = Budget { max_ops: 5, max_ns: u64::MAX };
	assert_eq!(advance(&mut shell_a, &mut host_a, &mut store_a, id, budget), Stop::Yield);
	shell_a.control().request_suspend();
	let mut cx = Cx { host: &mut host_a, store: &mut store_a };
	assert!(matches!(shell_a.step(&mut cx, budget), Step::SuspendReady));
	shell_a.externalize(&mut cx).expect("externalize");
	let mut store_b = copy(&store_a);
	assert!(
		store_b
			.get_blob(BlobSlot::Frames)
			.expect("get_blob")
			.is_some(),
		"the copy holds the Frames blob"
	);
	let mut host_b = FakeHost::new();
	let engine = Engine::new(EngineConfig::default());
	let (mut shell_b, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host_b, store: &mut store_b },
		RestoreOpts::default(),
	)
	.expect("restore");
	assert_eq!(report.runs, 1, "the loop in flight is restored");
	let restored = signal_and_finish(&mut shell_b, &mut host_b, &mut store_b, id);
	assert_eq!(
		restored, "t\ndone 3\n",
		"the restored shell runs the trap, then the rest of the loop"
	);
	let original = signal_and_finish(&mut shell_a, &mut host_a, &mut store_a, id);
	assert_eq!(original, restored, "the original shell runs it the same way");
}

/// `emulate zsh` writes the current mode (`zsh`) through, and each
/// `setopt` writes its zsh option, after the op that made it; the mode
/// persists across commands.
fn emulate_and_setopt_are_visible_after_each_op<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	let mode = Key::Misc(MiscKey::Mode);
	let zsh = Some(Record::Misc(bytes(b"zsh")));
	let modes = distinct_values(&mut shell, &mut host, store, "emulate zsh", mode);
	assert_eq!(modes.last(), Some(&zsh), "the mode after emulate zsh: {modes:?}");
	assert_ne!(modes.first(), Some(&zsh), "and not before it: {modes:?}");
	let ext = Key::ZshOpt(ZshOpt::Extendedglob);
	assert_ne!(read(store, ext), Some(Record::Opt(true)), "emulate zsh leaves extendedglob off");
	let seen = distinct_values(
		&mut shell,
		&mut host,
		store,
		"setopt extendedglob; setopt noextendedglob; setopt EXTENDED_GLOB",
		ext,
	);
	let mut on: Vec<bool> = seen
		.iter()
		.map(|r| matches!(r, Some(Record::Opt(true))))
		.collect();
	on.dedup();
	assert_eq!(on, [false, true, false, true], "extendedglob after each setopt: {seen:?}");
	assert_eq!(read(store, mode), zsh, "the switch persists");
}

/// A zsh option the host turns on between two steps of a zsh-mode loop
/// (`shwordsplit`) changes the next expansion of `$x`.
fn a_host_zsh_option_write_reaches_the_next_split<S: StateStore>(
	store: &mut S,
	bump: &mut impl FnMut(&mut S),
) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	assert_eq!(run(&mut shell, &mut host, store, "emulate zsh"), 0);
	let src =
		"x='a b'; n=0; set -- $x; while [ $# = 1 ]; do n=$((n+1)); set -- $x; done; echo \"$# $n\"";
	let run = shell.submit(Script::command(src.as_bytes()));
	for _ in 0..200 {
		let done = one_op(&mut shell, &mut host, store, run, &mut |_| {});
		assert_eq!(done, None, "$x stays one word until the host sets shwordsplit");
	}
	let n0 = read_number(store, b"n");
	assert!(n0 >= 3, "the loop ran before the host write ({n0} iterations)");
	apply(store, Change::Put(Key::ZshOpt(ZshOpt::Shwordsplit), Record::Opt(true)));
	bump(&mut *store);
	let status = finish(&mut shell, &mut host, store, run, 200, "the loop after shwordsplit");
	assert_eq!(status, 0);
	let n = read_number(store, b"n");
	assert!(n == n0 || n == n0 + 1, "the next expansion split $x: {n0} then {n}");
	assert_eq!(host.stdout.bytes(), format!("2 {n}\n").as_bytes());
}

/// While a zsh function that sets `localoptions` runs (one op per step),
/// `Scope(0)` is its scope and holds the zsh save with the caller's mode
/// and options, while the option it set is written through; after the
/// return the scope is gone and the option is back.
fn a_zsh_function_scope_holds_the_callers_options<S: StateStore>(store: &mut S) {
	let mut host = FakeHost::new();
	let mut shell = create(&mut host, store);
	assert_eq!(run(&mut shell, &mut host, store, "emulate zsh"), 0);
	let split = Key::ZshOpt(ZshOpt::Shwordsplit);
	type Seen = (Option<BString>, Option<(ModeId, bool)>, Option<Record>);
	let mut inside: Vec<Seen> = Vec::new();
	let status = each_op(
		&mut shell,
		&mut host,
		store,
		"f() { setopt localoptions shwordsplit; i=0; while [ $i -lt 5 ]; do i=$((i+1)); done; }; f; \
		 echo $i",
		&mut |s, _| {
			if let Some(Record::Scope { func, zsh, .. }) = read(s, Key::Scope(0)) {
				let saved = zsh.map(|z| (z.mode, z.opts.get(ZshOpt::Shwordsplit)));
				push_distinct(&mut inside, (func, saved, read(s, split)));
			}
		},
	);
	assert_eq!(status, 0);
	assert!(!inside.is_empty(), "f's scope was seen while it ran");
	assert!(
		inside
			.iter()
			.all(|(func, saved, _)| func.as_ref().is_some_and(|f| f == "f")
				&& *saved == Some((ModeId::Zsh, false))),
		"every step inside f shows its scope with the caller's mode and options: {inside:?}"
	);
	assert!(
		inside
			.iter()
			.any(|(.., live)| *live == Some(Record::Opt(true))),
		"setopt inside f is written through: {inside:?}"
	);
	assert_eq!(read(store, Key::Scope(0)), None, "the scope is gone after the return");
	assert_ne!(read(store, split), Some(Record::Opt(true)), "localoptions restored shwordsplit");
	assert_eq!(host.stdout.bytes(), b"5\n");
}

/// A function defined by `emulate zsh -c` from bash code is a zsh function
/// with a plain zsh sticky emulation; a copy of the store between commands
/// restores a fresh shell that still runs it with zsh semantics (`$x` one
/// word) while its own bash code splits `$x`, as the original does.
fn a_sticky_function_survives_a_copy_between_commands<S: StateStore>(
	make: &mut impl FnMut() -> S,
	copy: &mut impl FnMut(&S) -> S,
) {
	let mut host_a = FakeHost::new();
	let mut store_a = make();
	let mut shell_a = create(&mut host_a, &mut store_a);
	let define = "emulate zsh -c 'g() { print -l $x; }'";
	assert_eq!(run(&mut shell_a, &mut host_a, &mut store_a, define), 0);
	match read(&mut store_a, Key::Func(BStr::new("g"))) {
		Some(Record::Func { mode, sticky, .. }) => {
			assert_eq!(mode, ModeId::Zsh, "g's body is zsh");
			assert_eq!(
				sticky,
				Some(Box::new(Sticky { mode: ModeId::Zsh, full: false, on: vec![], off: vec![] })),
				"g carries the emulation it was defined under"
			);
		},
		other => panic!("g is a function record, got {other:?}"),
	}
	assert_ne!(
		read(&mut store_a, Key::Misc(MiscKey::Mode)),
		Some(Record::Misc(bytes(b"zsh"))),
		"emulate -c does not keep the switch"
	);
	let mut store_b = copy(&store_a);
	let mut host_b = FakeHost::new();
	let engine = Engine::new(EngineConfig::default());
	let (mut shell_b, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host_b, store: &mut store_b },
		RestoreOpts::default(),
	)
	.expect("restore");
	assert!(report.lost.is_empty(), "nothing is lost, got {:?}", report.lost);
	let src = "x='a b'; g; printf '%s\\n' $x";
	let restored = run_settled(&mut shell_b, &mut host_b, &mut store_b, src);
	assert_eq!(restored.stdout, "a b\na\nb\n", "g keeps zsh splitting, bash code splits");
	drop(shell_b);
	host_b.assert_released();
	let original = run_settled(&mut shell_a, &mut host_a, &mut store_a, src);
	assert_eq!(original, restored, "the original shell runs it the same way");
	host_a.assert_no_leaks(&mut shell_a, &mut store_a);
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::MemStore;

	#[test]
	fn mem_store_conforms() {
		store_conformance(MemStore::new, MemStore::bump_epoch, MemStore::clone);
	}
}
