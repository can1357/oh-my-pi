//! Strict machine-output coverage admission for native package verification.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{self, Formatter},
};

use omp_core::Str;
use serde::{Deserialize, Serialize, de::Error};
use serde_json::Value;

struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct Visitor;
		impl<'de> serde::de::Visitor<'de> for Visitor {
			type Value = UniqueValue;

			fn expecting(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
				formatter.write_str("JSON without duplicate object keys")
			}

			fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
				Ok(UniqueValue(value.into()))
			}

			fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
				Ok(UniqueValue(value.into()))
			}

			fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
				Ok(UniqueValue(value.into()))
			}

			fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
				serde_json::Number::from_f64(value)
					.map(|number| UniqueValue(Value::Number(number)))
					.ok_or_else(|| E::custom("nonfinite number"))
			}

			fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
				Ok(UniqueValue(value.into()))
			}

			fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
				Ok(UniqueValue(value.into()))
			}

			fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
				Ok(UniqueValue(Value::Null))
			}

			fn visit_seq<A: serde::de::SeqAccess<'de>>(
				self,
				mut sequence: A,
			) -> Result<Self::Value, A::Error> {
				let mut values = Vec::new();
				while let Some(UniqueValue(value)) = sequence.next_element()? {
					values.push(value);
				}
				Ok(UniqueValue(Value::Array(values)))
			}

			fn visit_map<A: serde::de::MapAccess<'de>>(
				self,
				mut map: A,
			) -> Result<Self::Value, A::Error> {
				let mut values = serde_json::Map::new();
				while let Some((key, UniqueValue(value))) = map.next_entry::<String, UniqueValue>()? {
					if values.insert(key, value).is_some() {
						return Err(Error::custom("duplicate JSON key"));
					}
				}
				Ok(UniqueValue(Value::Object(values)))
			}
		}
		deserializer.deserialize_any(Visitor)
	}
}

fn json(bytes: &[u8]) -> Result<Value, InventoryError> {
	let UniqueValue(value) = serde_json::from_slice(bytes)?;
	Ok(value)
}

/// Frozen nextest inventory for one explicitly selected package.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TestInventory {
	/// Package selected by the trusted command plan.
	pub package: Str,
	/// Expected reporter prefixes and their nonignored test cases.
	pub suites:  BTreeMap<Str, InventorySuite>,
}

/// One listed test binary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct InventorySuite {
	/// Reporter kind (`lib` or `test`).
	pub kind:  Str,
	/// All cases, with whether they are ignored by default.
	pub cases: BTreeMap<Str, bool>,
}

/// Observed, completely reconciled test coverage; never inferred from exit
/// status.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(crate) struct TestCoverage {
	/// Required nonignored cases.
	pub selected: u64,
	/// Successfully completed cases.
	pub passed:   u64,
	/// Failed cases.
	pub failed:   u64,
	/// Explicitly ignored cases.
	pub ignored:  u64,
	/// Every expected case and suite has a matching terminal event.
	pub complete: bool,
}

/// Invalid, unsupported, or incomplete machine evidence.
#[derive(Debug, thiserror::Error)]
pub enum InventoryError {
	/// Invalid JSON, including invalid UTF-8.
	#[error("invalid verification JSON")]
	Json(#[from] serde_json::Error),
	/// The evidence does not satisfy the admitted protocol.
	#[error("unsupported or inconsistent verification protocol: {0}")]
	Protocol(ProtocolFault),
}

/// Closed reasons why machine evidence cannot be admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum ProtocolFault {
	/// A required field is absent.
	MissingField,
	/// A string field has the wrong type.
	ExpectedString,
	/// A count has the wrong type.
	ExpectedCount,
	/// An object has the wrong type.
	ExpectedObject,
	/// Package identity or listing status differs.
	ForeignOrUnlistedSuite,
	/// Binary kind is unsupported.
	UnsupportedBinaryKind,
	/// A case is unsupported or filtered.
	UnsupportedOrFilteredCase,
	/// An ignored flag has the wrong type.
	ExpectedIgnoredFlag,
	/// Reporter prefixes collide.
	AmbiguousSuitePrefix,
	/// Inventory totals disagree.
	InventoryCountMismatch,
	/// Captured output exceeds the parser bound.
	OutputLimitExceeded,
	/// Suite terminal counts disagree.
	SuiteSummaryMismatch,
	/// A test repeats or occurs outside an active suite.
	TestOutsideActiveSuiteOrDuplicate,
	/// Test state transition is unsupported.
	UnsupportedTestTransition,
	/// Suite identity is unknown.
	UnknownSuite,
	/// Reporter kind differs from inventory.
	SuiteKindMismatch,
	/// Reporter suite count differs from inventory.
	SuiteCountMismatch,
	/// Suite state transition is unsupported.
	UnsupportedSuiteTransition,
	/// Test identity lacks a binary prefix.
	MissingTestPrefix,
	/// Test refers to an unknown suite.
	UnknownTestSuite,
	/// Test refers to an unknown case.
	UnknownTestCase,
	/// Default ignored status differs from actual execution.
	IgnoredCaseExecutedOrRequiredCaseSkipped,
	/// Event type is unsupported.
	UnknownEventType,
	/// Required cases or suite terminals are missing.
	IncompleteInventoryCoverage,
	/// A doctest has a nextest descriptor.
	UnexpectedNextestDescriptor,
	/// Doctest event is unsupported.
	UnsupportedDoctestEvent,
	/// Doctest terminal evidence is missing.
	MissingDoctestSummary,
	/// Rustdoc's optional timing report is malformed or out of order.
	InvalidDoctestReport,
	/// Just declares global values or modules.
	JustGlobalDefinitions,
	/// Just changes exported environment.
	JustUnexports,
	/// Just setting differs from admitted defaults.
	UnsupportedJustSetting,
	/// Package recipe differs from the admitted plan.
	UnsupportedJustRecipe,
	/// Recipe attributes are malformed.
	JustAttributes,
	/// Recipe attribute has executable effects.
	UnsafeJustAttribute,
	/// Recipe parameters are malformed.
	JustParameters,
	/// Recipe parameter differs from the admitted contract.
	UnsupportedJustParameter,
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, InventoryError> {
	v.get(key)
		.ok_or(InventoryError::Protocol(ProtocolFault::MissingField))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, InventoryError> {
	field(v, key)?
		.as_str()
		.ok_or(InventoryError::Protocol(ProtocolFault::ExpectedString))
}
fn number(v: &Value, key: &str) -> Result<u64, InventoryError> {
	field(v, key)?
		.as_u64()
		.ok_or(InventoryError::Protocol(ProtocolFault::ExpectedCount))
}
fn object(v: &Value) -> Result<&serde_json::Map<String, Value>, InventoryError> {
	v.as_object()
		.ok_or(InventoryError::Protocol(ProtocolFault::ExpectedObject))
}

/// Parse a complete nextest JSON inventory, rejecting filtered or foreign
/// suites.
pub(crate) fn parse_nextest_inventory(
	bytes: &[u8],
	package: &str,
) -> Result<TestInventory, InventoryError> {
	let value = json(bytes)?;
	let mut suites = BTreeMap::new();
	let mut count = 0;
	for (id, suite) in object(field(&value, "rust-suites")?)? {
		if string(suite, "package-name")? != package
			|| string(suite, "binary-id")? != id
			|| string(suite, "status")? != "listed"
		{
			return Err(InventoryError::Protocol(ProtocolFault::ForeignOrUnlistedSuite));
		}
		let kind = string(suite, "kind")?;
		if !matches!(kind, "lib" | "test") {
			return Err(InventoryError::Protocol(ProtocolFault::UnsupportedBinaryKind));
		}
		let prefix: Str = format!("{package}::{}", string(suite, "binary-name")?).into();
		let mut cases = BTreeMap::new();
		for (name, case) in object(field(suite, "testcases")?)? {
			if string(case, "kind")? != "test"
				|| string(field(case, "filter-match")?, "status")? != "matches"
				|| name.is_empty()
			{
				return Err(InventoryError::Protocol(ProtocolFault::UnsupportedOrFilteredCase));
			}
			let ignored = field(case, "ignored")?
				.as_bool()
				.ok_or(InventoryError::Protocol(ProtocolFault::ExpectedIgnoredFlag))?;
			cases.insert(name.as_str().into(), ignored);
			count += 1;
		}
		if suites
			.insert(prefix, InventorySuite { kind: kind.into(), cases })
			.is_some()
		{
			return Err(InventoryError::Protocol(ProtocolFault::AmbiguousSuitePrefix));
		}
	}
	if count != number(&value, "test-count")? {
		return Err(InventoryError::Protocol(ProtocolFault::InventoryCountMismatch));
	}
	Ok(TestInventory { package: package.into(), suites })
}

#[derive(Default)]
struct SuiteState {
	started:  bool,
	finished: bool,
	running:  BTreeSet<Str>,
	done:     BTreeSet<Str>,
	coverage: TestCoverage,
}

fn lines(bytes: &[u8]) -> Result<Vec<Value>, InventoryError> {
	if bytes.len() > 64 * 1024 * 1024 {
		return Err(InventoryError::Protocol(ProtocolFault::OutputLimitExceeded));
	}
	bytes
		.split(|byte| *byte == b'\n')
		.filter(|line| !line.is_empty())
		.map(json)
		.collect()
}

fn finish(value: &Value, state: &mut SuiteState) -> Result<(), InventoryError> {
	if !state.started
		|| state.finished
		|| !state.running.is_empty()
		|| number(value, "passed")? != state.coverage.passed
		|| number(value, "failed")? != state.coverage.failed
		|| number(value, "ignored")? != state.coverage.ignored
		|| number(value, "measured")? != 0
		|| number(value, "filtered_out")? != 0
		|| state.coverage.selected
			!= state.coverage.passed + state.coverage.failed + state.coverage.ignored
		|| (string(value, "event")? == "ok") != (state.coverage.failed == 0)
	{
		return Err(InventoryError::Protocol(ProtocolFault::SuiteSummaryMismatch));
	}
	state.finished = true;
	Ok(())
}

fn test_event(value: &Value, name: &str, state: &mut SuiteState) -> Result<(), InventoryError> {
	if !state.started || state.finished || state.done.contains(name) {
		return Err(InventoryError::Protocol(ProtocolFault::TestOutsideActiveSuiteOrDuplicate));
	}
	match string(value, "event")? {
		"started" if state.running.insert(name.into()) => {},
		"ok" | "failed" if state.running.remove(name) => {
			if string(value, "event")? == "ok" {
				state.coverage.passed += 1;
			} else {
				state.coverage.failed += 1;
			}
			state.done.insert(name.into());
		},
		"ignored" if !state.running.contains(name) => {
			state.coverage.ignored += 1;
			state.done.insert(name.into());
		},
		_ => return Err(InventoryError::Protocol(ProtocolFault::UnsupportedTestTransition)),
	}
	Ok(())
}

/// Reconcile nextest libtest-json-plus events against the frozen inventory.
pub(crate) fn validate_nextest_results(
	bytes: &[u8],
	inventory: &TestInventory,
) -> Result<TestCoverage, InventoryError> {
	let mut states: BTreeMap<Str, SuiteState> = inventory
		.suites
		.keys()
		.map(|key| (key.clone(), SuiteState::default()))
		.collect();
	for value in lines(bytes)? {
		match string(&value, "type")? {
			"suite" => {
				let descriptor = field(&value, "nextest")?;
				let prefix =
					format!("{}::{}", string(descriptor, "crate")?, string(descriptor, "test_binary")?);
				let suite = inventory
					.suites
					.get(prefix.as_str())
					.ok_or(InventoryError::Protocol(ProtocolFault::UnknownSuite))?;
				if string(descriptor, "kind")? != suite.kind.as_str() {
					return Err(InventoryError::Protocol(ProtocolFault::SuiteKindMismatch));
				}
				let state = states
					.get_mut(prefix.as_str())
					.ok_or(InventoryError::Protocol(ProtocolFault::UnknownSuite))?;
				match string(&value, "event")? {
					"started" if !state.started => {
						state.coverage.selected = number(&value, "test_count")?;
						if state.coverage.selected != suite.cases.len() as u64 {
							return Err(InventoryError::Protocol(ProtocolFault::SuiteCountMismatch));
						}
						state.started = true;
					},
					"ok" | "failed" => finish(&value, state)?,
					_ => {
						return Err(InventoryError::Protocol(ProtocolFault::UnsupportedSuiteTransition));
					},
				}
			},
			"test" => {
				let name = string(&value, "name")?;
				let (prefix, case) = name
					.split_once('$')
					.ok_or(InventoryError::Protocol(ProtocolFault::MissingTestPrefix))?;
				let suite = inventory
					.suites
					.get(prefix)
					.ok_or(InventoryError::Protocol(ProtocolFault::UnknownTestSuite))?;
				let ignored = suite
					.cases
					.get(case)
					.ok_or(InventoryError::Protocol(ProtocolFault::UnknownTestCase))?;
				if *ignored != (string(&value, "event")? == "ignored") {
					return Err(InventoryError::Protocol(
						ProtocolFault::IgnoredCaseExecutedOrRequiredCaseSkipped,
					));
				}
				test_event(
					&value,
					case,
					states
						.get_mut(prefix)
						.ok_or(InventoryError::Protocol(ProtocolFault::UnknownTestSuite))?,
				)?;
			},
			_ => return Err(InventoryError::Protocol(ProtocolFault::UnknownEventType)),
		}
	}
	let mut coverage = TestCoverage { complete: true, ..TestCoverage::default() };
	for (prefix, state) in states {
		if !state.finished || state.done.len() != inventory.suites[&prefix].cases.len() {
			return Err(InventoryError::Protocol(ProtocolFault::IncompleteInventoryCoverage));
		}
		coverage.selected += state.coverage.selected - state.coverage.ignored;
		coverage.passed += state.coverage.passed;
		coverage.failed += state.coverage.failed;
		coverage.ignored += state.coverage.ignored;
	}
	Ok(coverage)
}

/// Validate sequential rustdoc libtest JSON suites, including explicit
/// zero-test suites.
pub(crate) fn parse_doctest_results(bytes: &[u8]) -> Result<TestCoverage, InventoryError> {
	let mut state = SuiteState::default();
	let mut total = TestCoverage { complete: true, ..TestCoverage::default() };
	let mut suites = 0;
	let mut reported = false;
	for value in lines(bytes)? {
		if value.get("nextest").is_some() {
			return Err(InventoryError::Protocol(ProtocolFault::UnexpectedNextestDescriptor));
		}
		if reported {
			return Err(InventoryError::Protocol(ProtocolFault::InvalidDoctestReport));
		}
		if string(&value, "type")? == "report" {
			if suites == 0
				|| !state.finished
				|| object(&value)?.len() != 3
				|| !["total_time", "compilation_time"].iter().all(|key| {
					value
						.get(key)
						.and_then(Value::as_f64)
						.is_some_and(|time| time.is_finite() && time >= 0.0)
				}) {
				return Err(InventoryError::Protocol(ProtocolFault::InvalidDoctestReport));
			}
			reported = true;
			continue;
		}
		match (string(&value, "type")?, string(&value, "event")?) {
			("suite", "started") if !state.started || state.finished => {
				state = SuiteState::default();
				state.started = true;
				state.coverage.selected = number(&value, "test_count")?;
			},
			("suite", "ok" | "failed") => {
				finish(&value, &mut state)?;
				suites += 1;
				total.selected += state.coverage.selected - state.coverage.ignored;
				total.passed += state.coverage.passed;
				total.failed += state.coverage.failed;
				total.ignored += state.coverage.ignored;
			},
			("test", _) => test_event(&value, string(&value, "name")?, &mut state)?,
			_ => return Err(InventoryError::Protocol(ProtocolFault::UnsupportedDoctestEvent)),
		}
	}
	if suites == 0 || !state.finished {
		return Err(InventoryError::Protocol(ProtocolFault::MissingDoctestSummary));
	}
	Ok(total)
}

/// Admit only the repository's side-effect-free package-check recipe contract.
/// Execution uses an instrumented native Cargo plan after this admission.
pub(crate) fn validate_just_recipes(bytes: &[u8]) -> Result<(), InventoryError> {
	let dump = json(bytes)?;
	for key in ["assignments", "modules"] {
		if !object(field(&dump, key)?)?.is_empty() {
			return Err(InventoryError::Protocol(ProtocolFault::JustGlobalDefinitions));
		}
	}
	if !field(&dump, "unexports")?
		.as_array()
		.is_some_and(Vec::is_empty)
	{
		return Err(InventoryError::Protocol(ProtocolFault::JustUnexports));
	}
	let settings = object(field(&dump, "settings")?)?;
	for (key, value) in settings {
		let allowed = match key.as_str() {
			"shell" => {
				*value == serde_json::json!({"command":"bash","arguments":["-euo","pipefail","-c"]})
			},
			"dotenv_command" => *value == serde_json::json!([]),
			"dotenv_filename" | "dotenv_path" | "indentation" | "tempdir" | "windows_shell"
			| "working_directory" => value.is_null(),
			"allow_duplicate_recipes"
			| "allow_duplicate_variables"
			| "default_list"
			| "default_script"
			| "dotenv_load"
			| "dotenv_override"
			| "dotenv_required"
			| "export"
			| "fallback"
			| "guards"
			| "ignore_comments"
			| "lazy"
			| "lists"
			| "no_cd"
			| "no_exit_message"
			| "positional_arguments"
			| "quiet"
			| "unstable"
			| "windows_powershell" => value == &Value::Bool(false),
			_ => false,
		};
		if !allowed {
			return Err(InventoryError::Protocol(ProtocolFault::UnsupportedJustSetting));
		}
	}
	for (name, body) in [
		("check-pkg", serde_json::json!([["cargo check -p ", [["variable", "pkg"]], " --locked"]])),
		(
			"test-pkg",
			serde_json::json!([["cargo nextest run -p ", [["variable", "pkg"]], " --locked"], [
				"cargo test --doc -p ",
				[["variable", "pkg"]],
				" --locked"
			]]),
		),
	] {
		let recipe = field(field(&dump, "recipes")?, name)?;
		if field(recipe, "body")? != &body
			|| !field(recipe, "dependencies")?
				.as_array()
				.is_some_and(Vec::is_empty)
			|| number(recipe, "priors")? != 0
			|| field(recipe, "shebang")? != &Value::Bool(false)
			|| string(recipe, "name")? != name
			|| string(recipe, "namepath")? != name
		{
			return Err(InventoryError::Protocol(ProtocolFault::UnsupportedJustRecipe));
		}
		for attribute in field(recipe, "attributes")?
			.as_array()
			.ok_or(InventoryError::Protocol(ProtocolFault::JustAttributes))?
		{
			let attribute = object(attribute)?;
			if attribute.len() != 1 || !attribute.get("group").is_some_and(Value::is_string) {
				return Err(InventoryError::Protocol(ProtocolFault::UnsafeJustAttribute));
			}
		}
		let parameters = field(recipe, "parameters")?
			.as_array()
			.ok_or(InventoryError::Protocol(ProtocolFault::JustParameters))?;
		if parameters.len() != 1
			|| parameters[0]
				!= serde_json::json!({
					"default":null,"export":false,"flag":false,"help":null,"kind":"singular","long":null,
					"max":null,"min":null,"multiple":false,"name":"pkg","pattern":null,"short":null,"value":null
				}) {
			return Err(InventoryError::Protocol(ProtocolFault::UnsupportedJustParameter));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn inventory() -> TestInventory {
		TestInventory {
			package: "pkg".into(),
			suites:  BTreeMap::from([("pkg::binary".into(), InventorySuite {
				kind:  "test".into(),
				cases: BTreeMap::from([("case".into(), false)]),
			})]),
		}
	}
	fn output(event: &str) -> Vec<u8> {
		format!(
			"{{\"type\":\"suite\",\"event\":\"started\",\"test_count\":1,\"nextest\":{{\"crate\":\"\
			 pkg\",\"test_binary\":\"binary\",\"kind\":\"test\"}}}}\n{{\"type\":\"test\",\"event\":\"\
			 started\",\"name\":\"pkg::binary$case\"}}\n{{\"type\":\"test\",\"event\":\"{event}\",\"\
			 name\":\"pkg::binary$case\"}}\n{{\"type\":\"suite\",\"event\":\"{event}\",\"passed\":{},\
			 \"failed\":{},\"ignored\":0,\"measured\":0,\"filtered_out\":0,\"nextest\":{{\"crate\":\"\
			 pkg\",\"test_binary\":\"binary\",\"kind\":\"test\"}}}}\n",
			u64::from(event == "ok"),
			u64::from(event == "failed")
		)
		.into_bytes()
	}
	#[test]
	fn inventory_rejects_filtered_foreign_and_duplicate_metadata() {
		let valid = serde_json::json!({"test-count":1,"rust-suites":{"pkg::binary":{
			"package-name":"pkg","binary-id":"pkg::binary","binary-name":"binary",
			"kind":"test","status":"listed","testcases":{"case":{
				"kind":"test","ignored":false,"filter-match":{"status":"matches"}
			}}
		}}})
		.to_string();
		assert!(parse_nextest_inventory(valid.as_bytes(), "pkg").is_ok());
		assert!(parse_nextest_inventory(valid.as_bytes(), "foreign").is_err());
		assert!(
			parse_nextest_inventory(valid.replace("matches", "mismatch").as_bytes(), "pkg").is_err()
		);
		assert!(
			parse_nextest_inventory(b"{\"test-count\":0,\"test-count\":1,\"rust-suites\":{}}", "pkg")
				.is_err()
		);
	}
	#[test]
	fn exact_coverage_distinguishes_success_and_failure() {
		assert_eq!(
			validate_nextest_results(&output("ok"), &inventory())
				.unwrap()
				.passed,
			1
		);
		assert_eq!(
			validate_nextest_results(&output("failed"), &inventory())
				.unwrap()
				.failed,
			1
		);
	}
	#[test]
	fn rejects_foreign_duplicate_missing_and_fabricated_counts() {
		let valid = String::from_utf8(output("ok")).unwrap();
		for invalid in [
			valid.replace("$case", "$foreign"),
			valid.replace("\"passed\":1", "\"passed\":2"),
			valid.lines().take(3).collect::<Vec<_>>().join("\n"),
			format!("{valid}{valid}"),
		] {
			assert!(validate_nextest_results(invalid.as_bytes(), &inventory()).is_err());
		}
	}
	#[test]
	fn zero_doctests_require_explicit_matching_summary() {
		let zero = b"{\"type\":\"suite\",\"event\":\"started\",\"test_count\":0}\n{\"type\":\"suite\",\"event\":\"ok\",\"passed\":0,\"failed\":0,\"ignored\":0,\"measured\":0,\"filtered_out\":0}\n";
		assert_eq!(parse_doctest_results(zero).unwrap().selected, 0);
		assert!(parse_doctest_results(b"").is_err());
		assert!(parse_doctest_results(b"test result: ok. 100 passed").is_err());
	}

	#[test]
	fn rustdoc_timing_report_is_optional_final_metadata_only() {
		let suite = r#"{"type":"suite","event":"started","test_count":1}
{"type":"test","event":"started","name":"doc"}
{"type":"test","event":"ok","name":"doc"}
{"type":"suite","event":"ok","passed":1,"failed":0,"ignored":0,"measured":0,"filtered_out":0}
"#;
		let report = "{\"type\":\"report\",\"total_time\":0.1326,\"compilation_time\":0.1294}\n";
		let expected = parse_doctest_results(suite.as_bytes()).expect("complete suite");
		let actual =
			parse_doctest_results(format!("{suite}{report}").as_bytes()).expect("final timing report");
		assert_eq!(
			(actual.selected, actual.passed, actual.failed),
			(expected.selected, expected.passed, expected.failed)
		);
		for invalid in [
			format!("{report}{suite}"),
			format!("{suite}{report}{report}"),
			format!("{suite}{report}{suite}"),
			format!("{suite}{}", report.replace("0.1326", "-0.1")),
			format!("{suite}{}", report.replace("0.1294", "\"unknown\"")),
			format!("{suite}{}", report.replace("0.1326", "1e999")),
		] {
			assert!(parse_doctest_results(invalid.as_bytes()).is_err());
		}
		let zero = "{\"type\":\"suite\",\"event\":\"started\",\"test_count\":0}\n{\"type\":\"suite\"\
		            ,\"event\":\"ok\",\"passed\":0,\"failed\":0,\"ignored\":0,\"measured\":0,\"\
		            filtered_out\":0}\n";
		assert_eq!(
			parse_doctest_results(format!("{zero}{report}").as_bytes())
				.expect("explicit zero suite")
				.selected,
			0
		);
	}
}
