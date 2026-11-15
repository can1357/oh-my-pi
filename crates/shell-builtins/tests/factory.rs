//! Registration contracts for the builtin factories (ADR 0054 slice 1).
//!
//! The default registration is pinned by name, not by count: a name added to or
//! dropped from [`utility_builtins`] changes what existing commands do, so it
//! must fail here and be a reviewed edit of `utility_builtins.txt`.

use std::collections::BTreeSet;

use omp_core::Str;
use omp_shell::{builtins::default_builtins, extensions::DefaultShellExtensions};
use omp_shell_builtins::{
	ALL_EXTRAS, ExtraBuiltinError, OFFERED_EXTRAS, extra_builtins, process_builtins,
	utility_builtins, validate_extra_names,
};

const CHECKED_IN: &str = include_str!("utility_builtins.txt");

fn names(list: &[&str]) -> Vec<Str> {
	list.iter().map(|name| Str::from(*name)).collect()
}

/// The names `utility_builtins.txt` lists for this host.
fn checked_in_names() -> BTreeSet<&'static str> {
	CHECKED_IN
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty() && !line.starts_with('#'))
		.filter_map(|line| {
			let mut parts = line.split_whitespace();
			let name = parts.next()?;
			match parts.next() {
				None => Some(name),
				Some("unix") => cfg!(unix).then_some(name),
				Some(other) => panic!("unknown host marker `{other}` for `{name}`"),
			}
		})
		.collect()
}

fn registered(registrations: &[(&'static str, impl Sized)]) -> Vec<&'static str> {
	registrations.iter().map(|(name, _)| *name).collect()
}

#[test]
fn utility_builtins_register_exactly_the_checked_in_names() {
	let registrations = utility_builtins::<DefaultShellExtensions>();
	let registered = registered(&registrations);
	let unique = registered.iter().copied().collect::<BTreeSet<_>>();
	assert_eq!(unique.len(), registered.len(), "a name is registered twice: {registered:?}");
	let expected = checked_in_names();
	let added = unique.difference(&expected).collect::<Vec<_>>();
	let dropped = expected.difference(&unique).collect::<Vec<_>>();
	assert!(
		added.is_empty() && dropped.is_empty(),
		"utility_builtins() drifted from tests/utility_builtins.txt: added {added:?}, dropped \
		 {dropped:?}"
	);
}

#[test]
fn an_empty_enabled_set_registers_no_extra_builtin() {
	assert!(extra_builtins::<DefaultShellExtensions>(&[]).is_empty());
}

#[test]
fn the_all_keyword_registers_exactly_the_offered_names() {
	let registrations = extra_builtins::<DefaultShellExtensions>(&names(&[ALL_EXTRAS]));
	assert_eq!(registered(&registrations), OFFERED_EXTRAS);
}

#[test]
fn names_the_build_does_not_offer_register_nothing() {
	let registrations = extra_builtins::<DefaultShellExtensions>(&names(&["rsync", "tar", "cat"]));
	assert!(
		registered(&registrations)
			.iter()
			.all(|name| OFFERED_EXTRAS.contains(name))
	);
	assert!(!registered(&registrations).contains(&"cat"));
}

#[test]
fn no_extra_name_collides_with_an_existing_registration() {
	let existing = utility_builtins::<DefaultShellExtensions>()
		.into_iter()
		.map(|(name, _)| name.to_owned())
		.chain(
			process_builtins::<DefaultShellExtensions>()
				.into_iter()
				.map(|(name, _)| name.to_owned()),
		)
		.chain(default_builtins::<DefaultShellExtensions>().keys().cloned())
		.collect::<BTreeSet<_>>();
	let mut seen = BTreeSet::new();
	for name in OFFERED_EXTRAS {
		assert!(!existing.contains(*name), "`{name}` is already a registered builtin");
		assert!(seen.insert(*name), "`{name}` is offered twice");
		assert_ne!(*name, ALL_EXTRAS, "`{ALL_EXTRAS}` is the select-everything keyword");
	}
}

#[test]
fn validation_accepts_the_empty_list_the_keyword_and_offered_names() {
	assert_eq!(validate_extra_names(&[]), Ok(()));
	assert_eq!(validate_extra_names(&names(&[ALL_EXTRAS])), Ok(()));
	assert_eq!(validate_extra_names(&names(OFFERED_EXTRAS)), Ok(()));
}

#[test]
fn validation_rejects_the_first_unknown_name() {
	// `rsync` is never shadowed (ADR 0054 D9) and `no-such-tool` is nobody's;
	// the first of them is the one reported.
	let rejected = validate_extra_names(&names(&[ALL_EXTRAS, "rsync", "no-such-tool"]));
	assert_eq!(rejected, Err(ExtraBuiltinError::Unknown { name: Str::from("rsync") }));
	// An existing, default-registered utility is not an extra either.
	assert_eq!(
		validate_extra_names(&names(&["cat"])),
		Err(ExtraBuiltinError::Unknown { name: Str::from("cat") })
	);
	// The keyword is matched exactly.
	assert_eq!(
		validate_extra_names(&names(&["ALL"])),
		Err(ExtraBuiltinError::Unknown { name: Str::from("ALL") })
	);
}
