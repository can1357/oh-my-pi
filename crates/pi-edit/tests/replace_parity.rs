mod common;

use common::run_fixture;
use pi_edit::{
	EditMode, EditStore, PathPolicy,
	fuzzy::{FindMatchOptions, find_match},
	path_policy::canonical_key,
	text::adjust_indentation,
};

const fn fuzzy_options(threshold: Option<f64>) -> FindMatchOptions<'static> {
	FindMatchOptions { allow_fuzzy: true, threshold, excluded_ranges: &[] }
}

#[tokio::test]
async fn replace_executor_parity_fixtures() {
	run_fixture("replace/parity_execute.json", EditMode::Replace).await;
}

#[test]
fn returns_empty_for_no_match() {
	let result = find_match("line1\nline2", "notfound", &FindMatchOptions {
		allow_fuzzy:     false,
		threshold:       None,
		excluded_ranges: &[],
	});
	assert!(result.matched.is_none());
	assert!(result.occurrences.is_none());
}

#[test]
fn reports_fuzzy_matches_count_when_multiple_above_threshold() {
	let result = find_match("  item1\n  item2\n  item3", "  itemX", &fuzzy_options(Some(0.7)));
	assert!(result.fuzzy_matches.is_some_and(|count| count > 1));
}

#[test]
fn preserves_empty_lines() {
	assert_eq!(
		adjust_indentation("foo\n\nbar", "    foo\n\n    bar", "foo\n\nbaz"),
		"    foo\n\n    baz"
	);
}

#[test]
fn uses_tab_from_actual_text_when_adding_indentation() {
	assert_eq!(adjust_indentation("foo", "\t\tfoo", "bar"), "\t\tbar");
}

#[test]
fn handles_mixed_content_with_different_indent_levels() {
	assert_eq!(
		adjust_indentation(
			"if (x) {\n  return y;\n}",
			"    if (x) {\n      return y;\n    }",
			"if (x) {\n  return z;\n}",
		),
		"    if (x) {\n      return z;\n    }"
	);
}

#[test]
fn does_not_go_negative_on_removal() {
	assert_eq!(adjust_indentation("    foo", "foo", "  bar"), "bar");
}

fn path_policy(cwd: &std::path::Path, home: &std::path::Path) -> PathPolicy {
	PathPolicy {
		cwd:                  cwd.to_owned(),
		home_dir:             home.to_owned(),
		local_sandbox_root:   None,
		vault_roots:          None,
		plan_active:          false,
		block_auto_generated: true,
	}
}

#[test]
fn resolves_parent_targets_outside_cwd() {
	let root = tempfile::tempdir().expect("tempdir");
	let cwd = root.path().join("workspace");
	let home = root.path().join("home");
	std::fs::create_dir_all(&cwd).expect("workspace");
	let policy = path_policy(&cwd, &home);

	assert_eq!(policy.resolve("../outside.txt").unwrap().absolute, root.path().join("outside.txt"));
}

#[test]
fn preserves_absolute_targets_outside_cwd() {
	let root = tempfile::tempdir().expect("tempdir");
	let cwd = root.path().join("workspace");
	let home = root.path().join("home");
	std::fs::create_dir_all(&cwd).expect("workspace");
	let policy = path_policy(&cwd, &home);
	let absolute = root.path().join("absolute.txt");

	assert_eq!(policy.resolve(absolute.to_str().unwrap()).unwrap().absolute, absolute);
}

#[test]
fn expands_home_targets_outside_cwd() {
	let root = tempfile::tempdir().expect("tempdir");
	let cwd = root.path().join("workspace");
	let home = root.path().join("home");
	std::fs::create_dir_all(&cwd).expect("workspace");
	std::fs::create_dir_all(&home).expect("home");
	let policy = path_policy(&cwd, &home);

	assert_eq!(
		policy.resolve("~/.claude/settings.json").unwrap().absolute,
		home.join(".claude/settings.json")
	);
}

#[test]
fn canonical_snapshot_key_returns_input_when_no_ancestor_exists() {
	let root = tempfile::tempdir().expect("tempdir");
	let missing = root.path().join("missing-parent/child/file.txt");
	assert_eq!(canonical_key(&missing), missing);
}

#[cfg(unix)]
#[test]
fn canonical_snapshot_keys_fuse_symlink_equivalent_paths() {
	let root = tempfile::tempdir().expect("tempdir");
	let real = root.path().join("real");
	let alias = root.path().join("alias");
	std::fs::create_dir(&real).expect("real directory");
	std::os::unix::fs::symlink(&real, &alias).expect("directory symlink");
	let real_file = real.join("a.txt");
	let alias_file = alias.join("a.txt");
	std::fs::write(&real_file, "x\n").expect("fixture");

	let real_key = canonical_key(&real_file);
	let alias_key = canonical_key(&alias_file);
	assert_eq!(alias_key, real_key);

	let store = EditStore::new();
	let hash = store.record(&real_key, "x\n", None);
	assert_eq!(store.by_hash(&alias_key, &hash).unwrap().text.as_ref(), "x\n");
}
