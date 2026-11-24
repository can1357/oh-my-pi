//! `ast-grep test`: runs the `valid`/`invalid` code of rule test cases
//! against the project's rules and compares what invalid code reports with
//! the YAML snapshots stored next to the test cases.

use std::{
	collections::{BTreeMap, HashMap, HashSet},
	io::Write,
	path::{Path, PathBuf},
};

use ast_grep_config::{LabelStyle, RuleCollection, RuleConfig, Severity};
use ast_grep_core::tree_sitter::LanguageExt;
use clap::Args;
use omp_ast::SupportLang;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::{
	CONFIG_GUIDE, ColorArg, PLAYGROUND, Project, TOOL_OVERVIEW, fail, load_project, print_diff_hunks, read_text,
	yaml_files,
};
use crate::host::Host;

const TEST_GUIDE: &str = "/guide/test-rule.html";

/// Snapshot directory name, relative to the test directory, when none is configured.
const SNAPSHOT_DIR: &str = "__snapshots__";

/// `ast-grep test` options.
#[derive(Args, Debug)]
pub(super) struct Test {
	/// the directories to search test YAML files
	#[arg(short, long)]
	test_dir: Option<PathBuf>,

	/// Specify the directory name storing snapshots. Default to __snapshots__.
	#[arg(long)]
	snapshot_dir: Option<PathBuf>,

	/// Only check if the test code is valid, without checking rule output.
	/// Turn it on when you want to ignore the output of rules.
	/// Conflicts with --update-all.
	#[arg(long, conflicts_with = "update_all")]
	skip_snapshot_tests: bool,

	/// Update the content of all snapshots that have changed in test.
	/// Conflicts with --skip-snapshot-tests.
	#[arg(short = 'U', long)]
	update_all: bool,

	/// Only run rule test cases that matches REGEX.
	#[arg(short, long, value_name = "REGEX")]
	filter: Option<Regex>,

	/// Include `severity:off` rules in test
	#[arg(long)]
	include_off: bool,

	/// Follow symbolic links while searching test YAML files.
	#[arg(long)]
	follow: bool,

	/// Controls output color; the builtin always prints plain text.
	#[arg(long = "color", default_value = "auto", value_name = "WHEN")]
	_color: ColorArg,
}

/// One test case document: the rule id and the code it must (`invalid`) or
/// must not (`valid`) report.
#[derive(Deserialize)]
struct TestCase {
	id:      String,
	#[serde(default)]
	valid:   Vec<String>,
	#[serde(default)]
	invalid: Vec<String>,
}

/// One `<id>-snapshot.yml`: the expected report per invalid code.
#[derive(Serialize, Deserialize, Clone)]
struct TestSnapshots {
	id:        String,
	snapshots: BTreeMap<String, TestSnapshot>,
}

/// What a rule reports for one invalid code: its first match's fix result and labels.
#[derive(Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
struct TestSnapshot {
	#[serde(skip_serializing_if = "Option::is_none")]
	fixed:  Option<String>,
	labels: Vec<LabelSnapshot>,
}

/// One label of a snapshot: its text, byte range, style and message.
#[derive(Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
struct LabelSnapshot {
	source:  String,
	#[serde(skip_serializing_if = "Option::is_none")]
	message: Option<String>,
	style:   LabelStyle,
	start:   usize,
	end:     usize,
}

impl TestSnapshot {
	/// The snapshot of `rule` on `case`; `Ok(None)` when it reports nothing,
	/// `Err` when its fix cannot be applied.
	fn generate(rule: &RuleConfig<SupportLang>, case: &str) -> Result<Option<Self>, ()> {
		let mut ast = rule.language.ast_grep(case);
		let Some(matched) = ast.root().find(&rule.matcher) else {
			return Ok(None);
		};
		let labels = rule
			.get_labels(&matched)
			.into_iter()
			.map(|label| {
				let range = label.range();
				LabelSnapshot {
					source:  case[range.clone()].to_owned(),
					message: label.message.map(str::to_owned),
					style:   label.style,
					start:   range.start,
					end:     range.end,
				}
			})
			.collect();
		let fixers = rule.get_fixer().map_err(drop)?;
		let Some(fixer) = fixers.first() else {
			return Ok(Some(Self { fixed: None, labels }));
		};
		ast.replace(&rule.matcher, fixer).map_err(drop)?;
		Ok(Some(Self { fixed: Some(ast.source().to_owned()), labels }))
	}
}

/// The outcome of one valid or invalid code.
enum CaseStatus<'a> {
	/// Valid code reported nothing.
	Validated,
	/// Invalid code reported (as its snapshot expects).
	Reported,
	/// `--update-all` accepted a new snapshot.
	Updated { source: &'a str, updated: TestSnapshot },
	/// Invalid code reported, but not as its snapshot expects (or has none).
	Wrong { source: &'a str, actual: TestSnapshot, expected: Option<TestSnapshot> },
	/// Invalid code reported nothing.
	Missing(&'a str),
	/// Valid code reported something.
	Noisy(&'a str),
	/// The rule's fix could not be applied.
	Error,
}

impl<'a> CaseStatus<'a> {
	/// Checks that `rule` reports nothing in valid `case`.
	fn verify_valid(rule: &RuleConfig<SupportLang>, case: &'a str) -> Self {
		if rule.language.ast_grep(case).root().find(&rule.matcher).is_some() {
			Self::Noisy(case)
		} else {
			Self::Validated
		}
	}

	/// Checks that `rule` reports something in invalid `case`.
	fn verify_invalid(rule: &RuleConfig<SupportLang>, case: &'a str) -> Self {
		if rule.language.ast_grep(case).root().find(&rule.matcher).is_some() {
			Self::Reported
		} else {
			Self::Missing(case)
		}
	}

	/// Checks that `rule` reports invalid `case` as its `expected` snapshot says.
	fn verify_snapshot(rule: &RuleConfig<SupportLang>, case: &'a str, expected: Option<&TestSnapshot>) -> Self {
		let actual = match TestSnapshot::generate(rule, case) {
			Ok(Some(snapshot)) => snapshot,
			Ok(None) => return Self::Missing(case),
			Err(()) => return Self::Error,
		};
		match expected {
			Some(expected) if *expected == actual => Self::Reported,
			expected => Self::Wrong { source: case, actual, expected: expected.cloned() },
		}
	}

	/// Accepts a wrong snapshot as the new baseline.
	fn accept(&mut self) {
		if let Self::Wrong { source, actual, .. } = self {
			let source = *source;
			let updated = std::mem::replace(actual, TestSnapshot { fixed: None, labels: Vec::new() });
			*self = Self::Updated { source, updated };
		}
	}

	/// Whether the case passed.
	const fn is_pass(&self) -> bool {
		matches!(self, Self::Validated | Self::Reported | Self::Updated { .. })
	}

	/// The case's summary marker.
	const fn marker(&self) -> char {
		match self {
			Self::Validated | Self::Reported => '.',
			Self::Wrong { .. } => 'W',
			Self::Updated { .. } => 'U',
			Self::Missing(_) => 'M',
			Self::Noisy(_) => 'N',
			Self::Error => 'E',
		}
	}
}

/// The outcomes of one test case document.
struct CaseResult<'a> {
	id:    &'a str,
	cases: Vec<CaseStatus<'a>>,
}

impl CaseResult<'_> {
	/// Whether every case passed.
	fn passed(&self) -> bool {
		self.cases.iter().all(CaseStatus::is_pass)
	}

	/// Whether it failed only on snapshot mismatches.
	fn snapshot_mismatch_only(&self) -> bool {
		let mut failed = false;
		for case in self.cases.iter().filter(|case| !case.is_pass()) {
			if !matches!(case, CaseStatus::Wrong { .. }) {
				return false;
			}
			failed = true;
		}
		failed
	}

	/// The `--update-all`-accepted snapshots.
	fn updated_snapshots(&self) -> impl Iterator<Item = (String, TestSnapshot)> {
		self.cases.iter().filter_map(|case| match case {
			CaseStatus::Updated { source, updated } => Some(((*source).to_owned(), updated.clone())),
			_ => None,
		})
	}

	/// The per-rule summary marker string: one marker per case, or counts
	/// centered in dots beyond 40 cases.
	fn summary(&self) -> String {
		if self.cases.len() <= 40 {
			return self.cases.iter().map(CaseStatus::marker).collect();
		}
		let labels = [('.', "Pass"), ('U', "Updated"), ('W', "Wrong"), ('M', "Missing"), ('N', "Noisy"), ('E', "Error")];
		let counts: Vec<String> = labels
			.iter()
			.filter_map(|(marker, label)| {
				let count = self.cases.iter().filter(|case| case.marker() == *marker).count();
				(count > 0).then(|| format!("{label} × {count}"))
			})
			.collect();
		format!("{:.^50}", counts.join(", "))
	}
}

/// Test cases and snapshots found in the test directories.
#[derive(Default)]
struct Harness {
	cases:     Vec<TestCase>,
	snapshots: HashMap<String, TestSnapshots>,
	/// Snapshot directory per test case id.
	snapshot_dirs: HashMap<String, PathBuf>,
}

impl Harness {
	/// Reads the test cases and snapshots below `test_dir`.
	async fn read(
		&mut self,
		host: &mut Host,
		test_dir: &Path,
		snapshot_dir: Option<&Path>,
		filter: Option<&Regex>,
		follow: bool,
	) -> Result<(), i32> {
		let snapshot_dir = snapshot_dir.unwrap_or(Path::new(SNAPSHOT_DIR));
		let snapshot_path = test_dir.join(snapshot_dir);
		let included = |id: &str| filter.is_none_or(|filter| filter.is_match(id));
		for file in yaml_files(host, test_dir, follow).await? {
			let name = file.path.display().to_string();
			let text = read_text(
				host,
				&file.path,
				&format!("Cannot read rule {name}"),
				"The rule file either does not exist or cannot be opened.",
			)
			.await?;
			let parse_error = |host: &mut Host, error: serde_yaml::Error| {
				fail(
					host,
					&format!("Cannot parse test case {name}"),
					"The file is not a valid ast-grep test case. Please refer to doc and fix the error.",
					Some(TEST_GUIDE),
					Some(error.to_string()),
					8,
				)
			};
			if Path::new(&file.display).starts_with(snapshot_dir) || file.path.starts_with(&snapshot_path) {
				let snapshots: TestSnapshots = serde_yaml::from_str(&text).map_err(|error| parse_error(host, error))?;
				if !included(&snapshots.id) {
					continue;
				}
				let id = snapshots.id.clone();
				if self.snapshots.insert(id.clone(), snapshots).is_some() {
					let _ = writeln!(host.stderr, "Warning: found duplicate test case snapshot for `{id}`");
				}
				continue;
			}
			for document in serde_yaml::Deserializer::from_str(&text) {
				let case = TestCase::deserialize(document).map_err(|error| parse_error(host, error))?;
				if included(&case.id) {
					self.snapshot_dirs.insert(case.id.clone(), snapshot_path.clone());
					self.cases.push(case);
				}
			}
		}
		Ok(())
	}
}

/// How a test run ends.
enum Verdict {
	/// Every test case passed.
	Pass(String),
	/// A rule reported wrongly, or nothing ran.
	RuleFail(String),
	/// Only snapshots differ from what the rules report.
	SnapshotMismatch(String),
}

/// Writes `code` indented by two spaces, one line at a time.
fn indented(out: &mut Vec<u8>, code: &str) {
	for line in code.lines() {
		let _ = writeln!(out, "  {line}");
	}
}

/// ast-grep's YAML rendering of a snapshot.
fn to_yaml(value: &impl Serialize) -> Result<String, String> {
	serde_saphyr::to_string(value).map_err(|error| error.to_string())
}

/// Writes the details of one failing (or just updated) case.
fn write_detail(out: &mut Vec<u8>, id: &str, status: &CaseStatus<'_>) -> Result<(), String> {
	match status {
		CaseStatus::Validated | CaseStatus::Reported => {},
		CaseStatus::Updated { source, .. } => {
			let _ = writeln!(out, "[Updated] Rule {id}'s snapshot baseline has been updated.\n");
			indented(out, source);
			out.push(b'\n');
		},
		CaseStatus::Wrong { source, actual, expected } => {
			let actual = to_yaml(actual)?;
			if let Some(expected) = expected {
				let _ = writeln!(out, "[Wrong] {id} snapshot is different from baseline.\nDiff:");
				print_diff_hunks(out, &to_yaml(expected)?, &actual, 3);
			} else {
				let _ = writeln!(out, "[Wrong] No {id} baseline found.\nGenerated Snapshot:");
				indented(out, &actual);
			}
			let _ = writeln!(out, "For Code:");
			indented(out, source);
			out.push(b'\n');
		},
		CaseStatus::Missing(source) => {
			let _ = writeln!(out, "[Missing] Expect rule {id} to report issues, but none found in:\n");
			indented(out, source);
			out.push(b'\n');
		},
		CaseStatus::Noisy(source) => {
			let _ = writeln!(out, "[Noisy] Expect {id} to report no issue, but some issues found in:\n");
			indented(out, source);
			out.push(b'\n');
		},
		CaseStatus::Error => {
			let _ = writeln!(out, "[Error] Fail to apply fix to {id}");
		},
	}
	Ok(())
}

impl Test {
	/// Runs the project's (or `--test-dir`'s) test cases; exit status 4 when
	/// one fails or matches no rule.
	pub(super) async fn execute(&self, host: &mut Host, config: Option<&str>) -> Result<bool, i32> {
		let Project { root, config: project, mut rules } = load_project(host, config).await?;
		if let Some(filter) = &self.filter {
			rules.retain(|rule| filter.is_match(&rule.id));
			if rules.is_empty() {
				return Err(fail(
					host,
					&format!("Rule not found: {filter}"),
					&format!("Rule with id '{filter}' not found in project configuration. Please make sure it exists."),
					Some(TOOL_OVERVIEW),
					None,
					3,
				));
			}
		}
		// Test cases of `severity: off` rules are skipped silently unless
		// `--include-off` runs them.
		let all_ids: HashSet<String> = rules.iter().map(|rule| rule.id.clone()).collect();
		if self.include_off {
			for rule in &mut rules {
				rule.severity = Severity::Hint;
			}
		}
		let rules = RuleCollection::try_new(rules).map_err(|error| {
			fail(
				host,
				"Cannot parse glob pattern in config",
				"The pattern in files/ignore is not a valid glob. Please refer to doc and fix the error.",
				Some(CONFIG_GUIDE),
				Some(error.to_string()),
				9,
			)
		})?;

		let mut harness = Harness::default();
		let filter = self.filter.as_ref();
		if let Some(test_dir) = &self.test_dir {
			let test_dir = host.resolve(test_dir);
			harness.read(host, &test_dir, self.snapshot_dir.as_deref(), filter, self.follow).await?;
		} else {
			for test in project.test_configs.iter().flatten() {
				harness
					.read(host, &root.join(&test.test_dir), test.snapshot_dir.as_deref(), filter, self.follow)
					.await?;
			}
		}
		let Harness { cases, snapshots, snapshot_dirs } = harness;
		let snapshots = (!self.skip_snapshot_tests).then_some(snapshots);

		let mut out = Vec::new();
		let _ = writeln!(out, "Running {} tests", cases.len());
		let mut missing = 0;
		let mut results = Vec::new();
		for case in &cases {
			let Some(rule) = rules.get_rule(&case.id) else {
				if !all_ids.contains(&case.id) {
					let _ = writeln!(out, "Configuration not found! {}", case.id);
					missing += 1;
				}
				continue;
			};
			let valid = case.valid.iter().map(|code| CaseStatus::verify_valid(rule, code));
			let statuses: Vec<CaseStatus<'_>> = match &snapshots {
				Some(snapshots) => {
					let expected = snapshots.get(&case.id);
					let invalid = case.invalid.iter().map(|code| {
						let snapshot = expected.and_then(|expected| expected.snapshots.get(code));
						CaseStatus::verify_snapshot(rule, code, snapshot)
					});
					valid.chain(invalid).collect()
				},
				None => valid.chain(case.invalid.iter().map(|code| CaseStatus::verify_invalid(rule, code))).collect(),
			};
			results.push(CaseResult { id: &case.id, cases: statuses });
		}

		let _ = writeln!(out, "\n----------- Case Details -----------");
		for result in results.iter_mut().filter(|result| !result.passed()) {
			for status in &mut result.cases {
				if self.update_all {
					status.accept();
				}
				if let Err(error) = write_detail(&mut out, result.id, status) {
					return Err(raw_error(host, &out, &error).await);
				}
			}
		}
		if let Some(snapshots) = snapshots
			&& self.update_all
			&& let Err(error) = write_snapshots(host, snapshots, &results, &snapshot_dirs).await
		{
			return Err(raw_error(host, &out, &error).await);
		}
		for result in &results {
			let status = if result.cases.is_empty() {
				"SKIP"
			} else if result.passed() {
				"PASS"
			} else {
				"FAIL"
			};
			let _ = writeln!(out, "{status} {}  {}", result.id, result.summary());
		}
		out.push(b'\n');

		let verdict = verdict(&results);
		match &verdict {
			Verdict::Pass(message) => {
				let _ = writeln!(out, "{message}");
			},
			Verdict::RuleFail(message) | Verdict::SnapshotMismatch(message) if missing > 0 => {
				let _ = writeln!(out, "{message}");
			},
			_ => {},
		}
		write_stdout(host, &out).await;
		if missing > 0 {
			return Err(test_fail(host, &format!("{missing} test case(s) matched no rule.")));
		}
		match verdict {
			Verdict::Pass(_) => Ok(true),
			Verdict::RuleFail(message) => Err(test_fail(host, &message)),
			Verdict::SnapshotMismatch(message) => Err(fail(
				host,
				&message,
				"Test failed due to mismatching snapshots. Run with `--update-all` to update all snapshots, or \
				 `--interactive` to update selectively.",
				Some(TEST_GUIDE),
				None,
				4,
			)),
		}
	}
}

/// The run's verdict and its summary line.
fn verdict(results: &[CaseResult<'_>]) -> Verdict {
	if results.iter().all(|result| result.cases.is_empty()) {
		return Verdict::RuleFail("No test cases were run.".to_owned());
	}
	let passed = results.iter().filter(|result| result.passed()).count();
	let failed = results.len() - passed;
	let message = format!("{passed} passed; {failed} failed;");
	if failed == 0 {
		Verdict::Pass(format!("test result: ok. {message}"))
	} else if results.iter().filter(|result| !result.passed()).all(CaseResult::snapshot_mismatch_only) {
		Verdict::SnapshotMismatch(format!("test failed. {message}"))
	} else {
		Verdict::RuleFail(format!("test failed. {message}"))
	}
}

/// Writes the existing snapshots merged with the `--update-all`-accepted ones:
/// one `<id>-snapshot.yml` per test case id in its snapshot directory.
async fn write_snapshots(
	host: &mut Host,
	mut snapshots: HashMap<String, TestSnapshots>,
	results: &[CaseResult<'_>],
	snapshot_dirs: &HashMap<String, PathBuf>,
) -> Result<(), String> {
	for result in results {
		snapshots
			.entry(result.id.to_owned())
			.or_insert_with(|| TestSnapshots { id: result.id.to_owned(), snapshots: BTreeMap::new() })
			.snapshots
			.extend(result.updated_snapshots());
	}
	let vfs = host.vfs();
	let merged: BTreeMap<_, _> = snapshots.into_iter().collect();
	for (id, snapshots) in merged {
		let Some(dir) = snapshot_dirs.get(&id) else {
			continue;
		};
		if vfs.metadata(dir).await.is_err() {
			vfs.create_dir(dir).await.map_err(|error| error.to_string())?;
		}
		let yaml = to_yaml(&snapshots)?;
		vfs.write(dir.join(format!("{id}-snapshot.yml")), yaml).await.map_err(|error| error.to_string())?;
	}
	Ok(())
}

/// `TestFail`: the summary as the error title (exit status 4).
fn test_fail(host: &mut Host, message: &str) -> i32 {
	fail(host, message, "You can use ast-grep playground to debug your rules and test cases.", Some(PLAYGROUND), None, 4)
}

/// Prints what ran so far and an error without ast-grep context the way
/// ast-grep reports it (exit status 1).
async fn raw_error(host: &mut Host, out: &[u8], error: &str) -> i32 {
	write_stdout(host, out).await;
	let _ = writeln!(host.stderr, "Error: {error}");
	1
}

/// Writes `out` to stdout.
async fn write_stdout(host: &mut Host, out: &[u8]) {
	let mut stdout = host.stdout_writer();
	let _ = stdout.write_all(out);
	let _ = stdout.flush();
	let _ = host.flush_output().await;
}
