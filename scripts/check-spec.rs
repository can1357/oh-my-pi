#!/usr/bin/env -S cargo -Zscript
---
[package]
edition = "2024"

[dependencies]
omp-core = { path = "../crates/core" }
omp-tool = { path = "../crates/tool" }
serde_json = "1.0.151"
toml = "1.1"
---

use std::{
	collections::{BTreeMap, BTreeSet},
	env, fs,
	path::{Path, PathBuf},
};

use omp_core::{Duration, DurationUnit, InvocationPhase};
use omp_tool::{
	Authority, CallbackAbi, Durability, operation_spec, phase_legality_matrix,
	runtime_duration_metadata, runtime_symbols,
};
use serde_json::{Value as JsonValue, json};
use toml::Value as TomlValue;

const AGENT_ALLOWED_WORLD_EDGES: &[&str] = &["omp-env", "omp-storage"];
const AGENT_DENIED_DIRECT_EDGES: &[&str] = &["omp-docserver", "omp-shell", "omp-walker"];
// Pre-existing Python operations awaiting Part 1 rows. This fixed debt baseline
// may shrink; newly frozen CONTROL operations cannot be added without a row.
const PYTHON_SPEC_BASELINE: &[&str] = &[
	"omp.state.cas_get",
	"omp.state.cas_put",
	"omp.state_dir",
	"omp.urls.read",
];

fn main() {
	let root = workspace_root();
	let mut failures = Vec::new();
	check_symbols(&root, &mut failures);
	check_python_surface_specs(&root, &mut failures);
	check_agent_dependencies(&root, &mut failures);

	if !failures.is_empty() {
		for failure in failures {
			eprintln!("spec check: {failure}");
		}
		std::process::exit(1);
	}

	if let Some(output) = env::args_os().nth(1) {
		let output = root.join(output);
		if let Some(parent) = output.parent() {
			fs::create_dir_all(parent).unwrap_or_else(|error| {
				panic!("cannot create {}: {error}", parent.display())
			});
		}
		fs::write(&output, generated_spec_json()).unwrap_or_else(|error| {
			panic!("cannot write {}: {error}", output.display())
		});
	}
}

fn workspace_root() -> PathBuf {
	let current = env::current_dir().expect("current directory is unavailable");
	for candidate in current.ancestors() {
		let manifest = candidate.join("Cargo.toml");
		if manifest.is_file() {
			let text = fs::read_to_string(&manifest).expect("workspace Cargo.toml is unreadable");
			if text.contains("[workspace]") {
				return candidate.to_owned();
			}
		}
	}
	panic!("run the spec checker from inside the OMP workspace");
}

fn check_symbols(root: &Path, failures: &mut Vec<String>) {
	let symbols = runtime_symbols();
	let mut owners = BTreeMap::<&str, &str>::new();
	let mut lookup_keys = BTreeMap::<&str, &str>::new();
	for symbol in symbols {
		if symbol.public_name.trim().is_empty() {
			failures.push("runtime symbol has an empty public name".into());
			continue;
		}
		if let Some(previous) = owners.insert(symbol.public_name, symbol.owner) {
			failures.push(format!(
				"duplicate public symbol {} (owners {previous} and {})",
				symbol.public_name, symbol.owner
			));
		}
		for key in std::iter::once(symbol.public_name).chain(symbol.dispatch_key) {
			if let Some(previous) = lookup_keys.insert(key, symbol.public_name) {
				failures.push(format!(
					"duplicate operation lookup key {key} ({previous} and {})",
					symbol.public_name
				));
			}
		}
		if symbol.owner.trim().is_empty() || !root.join(symbol.owner).is_file() {
			failures.push(format!(
				"{} has missing owner {}",
				symbol.public_name, symbol.owner
			));
		}
		if symbol.signature.trim().is_empty() {
			failures.push(format!("{} has no signature", symbol.public_name));
		}
		if symbol.examples.is_empty()
			|| symbol.examples.iter().any(|example| example.trim().is_empty() || example.contains("TODO"))
		{
			failures.push(format!("{} has no concrete example", symbol.public_name));
		}
		if symbol.callback_abi == CallbackAbi::PayloadContext
			&& !symbol.signature.trim_start().starts_with("(payload, ctx)")
		{
			failures.push(format!(
				"{} violates the (payload, ctx) callback ABI",
				symbol.public_name
			));
		}
		if symbol.operation.minimum_phase == InvocationPhase::Settled {
			failures.push(format!(
				"{} first becomes legal in terminal phase SETTLED",
				symbol.public_name
			));
		}
		if symbol.public_name.starts_with("omp.env.") {
			if symbol.operation.minimum_phase != InvocationPhase::EffectsAuthorized {
				failures.push(format!("{} is legal before EFFECTS_AUTHORIZED", symbol.public_name));
			}
			if symbol.operation.authority != Authority::Environment {
				failures.push(format!("{} is not enforced by the Environment", symbol.public_name));
			}
		}
		if operation_spec(symbol.public_name) != Some(&symbol.operation) {
			failures.push(format!("{} is absent from operation_spec()", symbol.public_name));
		}
	}

	let server = fs::read_to_string(root.join("crates/app/src/envd/server.rs"))
		.expect("environment dispatch source is unreadable");
	for operation in server.split('"').filter(|token| {
		token.starts_with("omp.env.")
			&& !token.ends_with('.')
			&& token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'))
	}) {
		if operation_spec(operation).is_none() {
			failures.push(format!("DATA dispatch operation {operation} is missing from the runtime spec"));
		}
	}

	let duration_metadata = runtime_duration_metadata();
	let Some(interrupt_metadata) = duration_metadata
		.iter()
		.find(|metadata| metadata.public_name == "omp.params.interrupt_grace")
	else {
		failures.push("omp.params.interrupt_grace duration metadata is missing".into());
		return;
	};
	let interrupt_row = symbols
		.iter()
		.find(|symbol| symbol.public_name == interrupt_metadata.public_name);
	if interrupt_row.is_none_or(|symbol| symbol.timeout.is_some()) {
		failures.push("omp.params.interrupt_grace must be a live setting, not a fixed timeout".into());
	}
	if interrupt_metadata.default_value != Duration::new(150, DurationUnit::Milliseconds) {
		failures.push("runtime.interrupt_grace default must be the typed duration 150ms".into());
	}
	if interrupt_metadata.configuration_key != "runtime.interrupt_grace"
		|| interrupt_metadata.telemetry_ns != "omp.runtime.interrupt_grace.ns"
		|| interrupt_metadata.telemetry_unit != "omp.runtime.interrupt_grace.unit"
	{
		failures.push("interrupt-grace configuration or telemetry metadata drifted".into());
	}
	let settings = fs::read_to_string(root.join("crates/app/src/settings.rs"))
		.expect("runtime settings source is unreadable");
	if !settings.contains("omp_tool::DEFAULT_INTERRUPT_GRACE")
		|| !settings.contains("pub runtime:")
		|| !settings.contains("pub interrupt_grace: Duration")
	{
		failures.push("runtime.interrupt_grace setting default, key, or type drifted".into());
	}
	let telemetry = fs::read_to_string(root.join("crates/telemetry/src/attrs.rs"))
		.expect("telemetry attribute vocabulary is unreadable");
	if !telemetry.contains(interrupt_metadata.telemetry_ns)
		|| !telemetry.contains(interrupt_metadata.telemetry_unit)
	{
		failures.push("interrupt-grace telemetry attributes drifted".into());
	}

	match operation_spec("omp.journal.append") {
		Some(spec)
			if spec.minimum_phase == InvocationPhase::EffectsAuthorized
				&& spec.durability == Durability::Durable
				&& spec.authority == Authority::Core => {},
		_ => failures.push(
			"omp.journal.append must be a durable Core Request from EFFECTS_AUTHORIZED".into(),
		),
	}

	let matrix: Vec<_> = phase_legality_matrix().collect();
	if matrix.len() != symbols.len() {
		failures.push("phase legality matrix omitted a runtime symbol".into());
	}
	for (symbol, row) in symbols.iter().zip(matrix) {
		if row.public_name != symbol.public_name {
			failures.push(format!("phase matrix row order drifted at {}", symbol.public_name));
		}
		let expected = InvocationPhase::ALL
			.map(|phase| phase.allows_operation(symbol.operation.minimum_phase));
		if row.legal != expected || row.legal[InvocationPhase::Settled.ordinal() as usize] {
			failures.push(format!("{} has an illegal phase matrix row", symbol.public_name));
		}
	}

	let generated: JsonValue = serde_json::from_str(&generated_spec_json())
		.expect("generated runtime symbol spec must be valid JSON");
	for symbol in generated["symbols"].as_array().expect("symbols must be an array") {
		if let Some(timeout) = symbol.get("timeout").filter(|value| !value.is_null())
			&& !timeout["value"].is_u64()
		{
			failures.push(format!(
				"{} has floating-point timeout metadata",
				symbol["public_name"].as_str().unwrap_or("<unknown>")
			));
		}
	}
	for duration in generated["runtime_durations"]
		.as_array()
		.expect("runtime_durations must be an array")
	{
		if !duration["default"]["value"].is_u64() {
			failures.push(format!(
				"{} has floating-point default duration metadata",
				duration["public_name"].as_str().unwrap_or("<unknown>")
			));
		}
	}
}

fn check_python_surface_specs(root: &Path, failures: &mut Vec<String>) {
	let package = root.join("crates/py/python/omp");
	let mut pending = vec![package];
	while let Some(path) = pending.pop() {
		let entries = fs::read_dir(&path)
			.unwrap_or_else(|error| panic!("cannot read Python package {}: {error}", path.display()));
		for entry in entries {
			let entry = entry.expect("Python package entry is unreadable");
			let path = entry.path();
			if path.is_dir() {
				pending.push(path);
				continue;
			}
			if path.extension().and_then(|extension| extension.to_str()) != Some("py") {
				continue;
			}
			let source = fs::read_to_string(&path)
				.unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
			let mut rest = source.as_str();
			while let Some(offset) = rest.find("_control_request(") {
				rest = &rest[offset + "_control_request(".len()..];
				let Some(start) = rest.find('"') else {
					break;
				};
				let quoted = &rest[start + 1..];
				let Some(end) = quoted.find('"') else {
					break;
				};
				let operation = &quoted[..end];
				if operation.starts_with("omp.")
					&& !operation.ends_with('.')
					&& operation
						.bytes()
						.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'))
					&& !PYTHON_SPEC_BASELINE.contains(&operation)
					&& operation_spec(operation).is_none()
				{
					let relative = path.strip_prefix(root).unwrap_or(&path);
					failures.push(format!(
						"Python CONTROL operation {operation} in {} has no generated spec row",
						relative.display()
					));
				}
				rest = &quoted[end + 1..];
			}
		}
	}
}


fn check_agent_dependencies(root: &Path, failures: &mut Vec<String>) {
	let workspace = parse_toml(&root.join("Cargo.toml"));
	let agent = parse_toml(&root.join("crates/agent/Cargo.toml"));
	let policy = &workspace["workspace"]["metadata"]["omp"]["dependency-lints"]["omp-agent"];
	check_policy_list(policy, "allowed-world-boundary", AGENT_ALLOWED_WORLD_EDGES, failures);
	check_policy_list(policy, "denied-direct", AGENT_DENIED_DIRECT_EDGES, failures);

	let mut packages = BTreeSet::new();
	collect_dependency_packages(&agent, &mut packages);
	if packages.is_empty() {
		failures.push("crates/agent/Cargo.toml has no dependency tables".into());
	}
	for denied in AGENT_DENIED_DIRECT_EDGES {
		if packages.contains(denied) {
			failures.push(format!("omp-agent has forbidden direct dependency {denied}"));
		}
	}
	let world_crates = AGENT_ALLOWED_WORLD_EDGES
		.iter()
		.chain(AGENT_DENIED_DIRECT_EDGES)
		.copied()
		.collect::<BTreeSet<_>>();
	for package in packages.intersection(&world_crates) {
		if !AGENT_ALLOWED_WORLD_EDGES.contains(package) {
			failures.push(format!("omp-agent bypasses omp-env through {package}"));
		}
	}
}

fn collect_dependency_packages<'a>(manifest: &'a TomlValue, packages: &mut BTreeSet<&'a str>) {
	let Some(table) = manifest.as_table() else {
		return;
	};
	for (key, value) in table {
		if matches!(key.as_str(), "dependencies" | "dev-dependencies" | "build-dependencies") {
			if let Some(dependencies) = value.as_table() {
				for (name, dependency) in dependencies {
					let package = dependency
						.get("package")
						.and_then(TomlValue::as_str)
						.unwrap_or(name);
					packages.insert(package);
				}
			}
		} else {
			collect_dependency_packages(value, packages);
		}
	}
}

fn check_policy_list(
	policy: &TomlValue,
	key: &str,
	expected: &[&str],
	failures: &mut Vec<String>,
) {
	let actual = policy
		.get(key)
		.and_then(TomlValue::as_array)
		.map(|values| values.iter().filter_map(TomlValue::as_str).collect::<BTreeSet<_>>())
		.unwrap_or_default();
	let expected = expected.iter().copied().collect::<BTreeSet<_>>();
	if actual != expected {
		failures.push(format!("workspace dependency policy {key} was weakened or drifted"));
	}
}

fn parse_toml(path: &Path) -> TomlValue {
	let text = fs::read_to_string(path)
		.unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
	text.parse()
		.unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn generated_spec_json() -> String {
	let phases = InvocationPhase::ALL.map(|phase| {
		let name: &'static str = phase.into();
		name
	});
	let symbols = runtime_symbols().iter().map(|symbol| {
		let minimum_phase: &'static str = symbol.operation.minimum_phase.into();
		let durability: &'static str = symbol.operation.durability.into();
		let cost: &'static str = symbol.operation.cost.into();
		let authority: &'static str = symbol.operation.authority.into();
		let callback_abi: &'static str = symbol.callback_abi.into();
		let timeout = symbol.timeout.map(|duration| {
			json!({"value": duration.value(), "unit": duration.unit().to_string()})
		});
		json!({
			"owner": symbol.owner,
			"public_name": symbol.public_name,
			"dispatch_key": symbol.dispatch_key,
			"signature": symbol.signature,
			"callback_abi": callback_abi,
			"operation_spec": {
				"minimum_phase": minimum_phase,
				"durability": durability,
				"cost": cost,
				"authority": authority,
			},
			"timeout": timeout,
			"examples": symbol.examples,
		})
	}).collect::<Vec<_>>();
	let durations = runtime_duration_metadata().iter().map(|metadata| {
		let value = metadata.default_value;
		json!({
			"public_name": metadata.public_name,
			"configuration_key": metadata.configuration_key,
			"default": {"value": value.value(), "unit": value.unit().to_string()},
			"telemetry_ns": metadata.telemetry_ns,
			"telemetry_unit": metadata.telemetry_unit,
		})
	}).collect::<Vec<_>>();
	let legality = phase_legality_matrix().map(|row| {
		json!({"public_name": row.public_name, "legal": row.legal})
	}).collect::<Vec<_>>();
	serde_json::to_string_pretty(&json!({
		"schema_version": 1,
		"invocation_phases": phases,
		"symbols": symbols,
		"runtime_durations": durations,
		"phase_legality": legality,
	})).expect("runtime symbol spec is serializable")
}
