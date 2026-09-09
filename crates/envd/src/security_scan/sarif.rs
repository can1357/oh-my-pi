use std::{
	collections::{BTreeMap, BTreeSet},
	path::{Path, PathBuf},
};

use omp_core::{Hash32, Str, Ulid};
use omp_tools::security_scan::{Fault, TargetKind, ValidationStatus};
use serde_json::{Value, json};
use url::Url;

use super::{
	model::{Evidence, Finding, Location, Producer, Provenance, Scan, Validation},
	now_stamp,
};

pub(super) fn import(input: Value, root: &Path, source: &Path) -> Result<Scan, Fault> {
	if input.get("version").and_then(Value::as_str) != Some("2.1.0") {
		return Err(Fault::InvalidSarif);
	}
	let runs = input
		.get("runs")
		.and_then(Value::as_array)
		.ok_or(Fault::InvalidSarif)?;
	let canonical_root = root.canonicalize().map_err(|_| Fault::Storage)?;
	let scan_id = Str::new(format!("secscan_{}", Ulid::generate()));
	let created = now_stamp();
	let mut findings = Vec::new();
	let mut seen = BTreeSet::new();
	let mut producer_name = Str::new_static("SARIF importer");
	let mut producer_version = None;
	for run in runs {
		let driver = run.pointer("/tool/driver").and_then(Value::as_object);
		if let Some(name) = driver
			.and_then(|driver| driver.get("name"))
			.and_then(Value::as_str)
		{
			producer_name = Str::new(name);
		}
		producer_version = driver
			.and_then(|driver| driver.get("version"))
			.and_then(Value::as_str)
			.map(Str::new);
		let mut rules = BTreeMap::new();
		if let Some(entries) = driver
			.and_then(|driver| driver.get("rules"))
			.and_then(Value::as_array)
		{
			for rule in entries {
				if let Some(id) = rule.get("id").and_then(Value::as_str) {
					rules.insert(id, rule);
				}
			}
		}
		for (ordinal, result) in run
			.get("results")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.enumerate()
		{
			let rule_id = result
				.get("ruleId")
				.and_then(Value::as_str)
				.unwrap_or("sarif.unknown");
			let rule = rules.get(rule_id).copied();
			let summary = result
				.pointer("/message/text")
				.or_else(|| result.pointer("/message/markdown"))
				.and_then(Value::as_str)
				.unwrap_or(rule_id);
			let title = rule
				.and_then(|rule| rule.pointer("/shortDescription/text"))
				.or_else(|| rule.and_then(|rule| rule.get("name")))
				.and_then(Value::as_str)
				.unwrap_or(rule_id);
			let locations = import_locations(result, run, &canonical_root)?;
			let vendor_fingerprints =
				string_map(result.get("fingerprints"), result.get("partialFingerprints"));
			let category = result
				.pointer("/properties/category")
				.and_then(Value::as_str)
				.unwrap_or_else(|| rule_id.split(['.', '/', '-']).next().unwrap_or("security"));
			let anchor = vendor_fingerprints
				.values()
				.next()
				.cloned()
				.unwrap_or_else(|| Str::new(format!("{rule_id}:{summary}:{ordinal}")));
			let fingerprint = fingerprint(rule_id, category, &anchor, &locations)?;
			if !seen.insert(fingerprint.clone()) {
				continue;
			}
			let digest = Hash32::sum(fingerprint.as_bytes()).to_hex();
			let tags = rule
				.and_then(|rule| rule.pointer("/properties/tags"))
				.and_then(Value::as_array)
				.map(|tags| {
					tags
						.iter()
						.filter_map(Value::as_str)
						.map(Str::new)
						.collect::<Vec<_>>()
				})
				.unwrap_or_default();
			let cwe = tags
				.iter()
				.filter(|tag| {
					tag.get(..4)
						.is_some_and(|prefix| prefix.eq_ignore_ascii_case("cwe-"))
				})
				.cloned()
				.collect();
			let producer = Producer {
				kind:    Str::new_static("sarif-import"),
				name:    producer_name.clone(),
				version: producer_version.clone(),
				vendor:  None,
			};
			let provenance = Provenance {
				producer: producer.clone(),
				created_at: created.clone(),
				imported_at: Some(now_stamp()),
				source_ids: BTreeMap::from([(
					Str::new_static("source_path"),
					Str::new(source.to_string_lossy()),
				)]),
				vendor_fingerprints,
				metadata: BTreeMap::new(),
			};
			let severity = severity(result);
			let validation = canonical_validation(result.pointer("/properties/validation"));
			let disposition = canonical_disposition(result.pointer("/properties/disposition"));
			findings.push(Finding {
				id: Str::new(format!("secf_{}", &digest[..24])),
				scan_id: scan_id.clone(),
				fingerprint,
				rule_id: Str::new(rule_id),
				title: Str::new(title),
				summary: Str::new(summary),
				severity,
				confidence: Str::new_static("medium"),
				category: Str::new(category),
				cwe,
				locations,
				evidence: Vec::<Evidence>::new(),
				remediation: None,
				validation: Validation {
					status:       serde_json::from_value(Value::String(validation.to_owned()))
						.unwrap_or(ValidationStatus::Unvalidated),
					summary:      None,
					evidence_ids: Vec::new(),
					validated_at: None,
				},
				disposition: Str::new_static(disposition),
				provenance,
			});
		}
	}
	let producer = Producer {
		kind:    Str::new_static("sarif-import"),
		name:    producer_name,
		version: producer_version,
		vendor:  None,
	};
	let provenance = Provenance {
		producer:            producer.clone(),
		created_at:          created.clone(),
		imported_at:         Some(now_stamp()),
		source_ids:          BTreeMap::from([(
			Str::new_static("source_path"),
			Str::new(source.to_string_lossy()),
		)]),
		vendor_fingerprints: BTreeMap::new(),
		metadata:            BTreeMap::new(),
	};
	Ok(Scan {
		id: scan_id,
		plan_id: None,
		status: Str::new_static("completed"),
		created_at: created.clone(),
		completed_at: Some(created),
		target: TargetKind::Repository,
		producer,
		provenance,
		report: Some(Str::new(format!(
			"# Imported SARIF security results\n\nFindings: {}\n",
			findings.len()
		))),
		findings,
		sarif: Some(input),
	})
}

pub(super) fn export(scan: &Scan, root: &Path) -> Value {
	let mut rules = BTreeMap::<&str, &Finding>::new();
	for finding in &scan.findings {
		rules.entry(&finding.rule_id).or_insert(finding);
	}
	let base = Url::from_directory_path(root)
		.ok()
		.map_or_else(|| Str::new_static("file:///"), |url| Str::new(url.as_str()));
	json!({
		"$schema": "https://json.schemastore.org/sarif-2.1.0.json",
		"version": "2.1.0",
		"runs": [{
			"tool": {"driver": {
				"name": scan.producer.name,
				"version": scan.producer.version,
				"informationUri": "https://omp.sh",
				"rules": rules.values().map(|finding| json!({
					"id": finding.rule_id,
					"name": finding.rule_id,
					"shortDescription": {"text": finding.title},
					"fullDescription": {"text": finding.summary},
					"properties": {"tags": finding.cwe},
				})).collect::<Vec<_>>()
			}},
			"results": scan.findings.iter().map(|finding| json!({
				"ruleId": finding.rule_id,
				"level": sarif_level(&finding.severity),
				"message": {"text": finding.summary},
				"locations": finding.locations.iter().map(|location| json!({
					"physicalLocation": {
						"artifactLocation": {"uri": location.path, "uriBaseId": "%SRCROOT%"},
						"region": {
							"startLine": location.start_line,
							"endLine": location.end_line,
							"startColumn": location.start_column,
							"endColumn": location.end_column,
						}
					}
				})).collect::<Vec<_>>(),
				"fingerprints": {"omp-security/v1": finding.fingerprint},
				"properties": {
					"findingId": finding.id,
					"confidence": finding.confidence,
					"validation": finding.validation.status,
					"disposition": finding.disposition,
					"category": finding.category,
				}
			})).collect::<Vec<_>>(),
			"originalUriBaseIds": {"%SRCROOT%": {"uri": base}},
		}]
	})
}

fn import_locations(result: &Value, run: &Value, root: &Path) -> Result<Vec<Location>, Fault> {
	let root_url = Url::from_directory_path(root).map_err(|()| Fault::InvalidSarif)?;
	let mut locations = Vec::new();
	for entry in result
		.get("locations")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
	{
		let Some(uri) = entry
			.pointer("/physicalLocation/artifactLocation/uri")
			.and_then(Value::as_str)
		else {
			continue;
		};
		let base_id = entry
			.pointer("/physicalLocation/artifactLocation/uriBaseId")
			.and_then(Value::as_str);
		let base = if let Some(base_id) = base_id {
			if base_id == "%SRCROOT%" {
				root_url.clone()
			} else {
				let declared = run
					.pointer(&format!("/originalUriBaseIds/{}/uri", pointer_escape(base_id)))
					.and_then(Value::as_str)
					.ok_or(Fault::InvalidSarif)?;
				root_url.join(declared).map_err(|_| Fault::InvalidSarif)?
			}
		} else {
			root_url.clone()
		};
		let resolved = base
			.join(&uri.replace('\\', "/"))
			.map_err(|_| Fault::InvalidSarif)?;
		if resolved.scheme() != "file" {
			return Err(Fault::InvalidSarif);
		}
		let absolute = resolved.to_file_path().map_err(|()| Fault::InvalidSarif)?;
		let normalized = normalize_candidate(&absolute, root)?;
		let start_line = entry
			.pointer("/physicalLocation/region/startLine")
			.and_then(Value::as_u64);
		let Some(start_line) = start_line.filter(|line| *line > 0) else {
			continue;
		};
		locations.push(Location {
			path: Str::new(normalized.to_string_lossy().replace('\\', "/")),
			start_line,
			end_line: entry
				.pointer("/physicalLocation/region/endLine")
				.and_then(Value::as_u64),
			start_column: entry
				.pointer("/physicalLocation/region/startColumn")
				.and_then(Value::as_u64),
			end_column: entry
				.pointer("/physicalLocation/region/endColumn")
				.and_then(Value::as_u64),
			role: Some(Str::new_static("primary")),
		});
	}
	if locations.is_empty() {
		locations.push(Location {
			path:         Str::new_static("unknown"),
			start_line:   1,
			end_line:     None,
			start_column: None,
			end_column:   None,
			role:         Some(Str::new_static("unknown")),
		});
	}
	Ok(locations)
}

fn normalize_candidate(candidate: &Path, root: &Path) -> Result<PathBuf, Fault> {
	let absolute = if candidate.is_absolute() {
		candidate.to_path_buf()
	} else {
		root.join(candidate)
	};
	let canonical = if absolute.exists() {
		absolute.canonicalize().map_err(|_| Fault::InvalidSarif)?
	} else {
		absolute
	};
	canonical
		.strip_prefix(root)
		.map(Path::to_path_buf)
		.map_err(|_| Fault::InvalidSarif)
}

fn string_map(first: Option<&Value>, second: Option<&Value>) -> BTreeMap<Str, Str> {
	first
		.into_iter()
		.chain(second)
		.filter_map(Value::as_object)
		.flat_map(|values| values.iter())
		.filter_map(|(key, value)| value.as_str().map(|value| (Str::new(key), Str::new(value))))
		.collect()
}

fn fingerprint(
	rule: &str,
	category: &str,
	anchor: &str,
	locations: &[Location],
) -> Result<Str, Fault> {
	let bytes = serde_json::to_vec(&json!({"rule_id": rule.to_lowercase(), "category": category.to_lowercase(), "anchor": anchor.to_lowercase(), "locations": locations})).map_err(|_| Fault::Storage)?;
	Ok(Str::new(format!("omp-security/v1:sha256:{}", Hash32::sum(&bytes).to_hex())))
}

fn severity(result: &Value) -> Str {
	if let Some(score) = result
		.pointer("/properties/security-severity")
		.and_then(Value::as_f64)
	{
		return Str::new_static(if score >= 9.0 {
			"critical"
		} else if score >= 7.0 {
			"high"
		} else if score >= 4.0 {
			"medium"
		} else if score > 0.0 {
			"low"
		} else {
			"informational"
		});
	}
	Str::new_static(match result.get("level").and_then(Value::as_str) {
		Some("error") => "high",
		Some("warning") => "medium",
		Some("note") => "low",
		_ => "informational",
	})
}

fn sarif_level(severity: &str) -> &'static str {
	match severity {
		"critical" | "high" => "error",
		"medium" => "warning",
		"low" => "note",
		_ => "none",
	}
}

fn canonical_validation(value: Option<&Value>) -> &'static str {
	match value.and_then(Value::as_str) {
		Some("validated") => "validated",
		Some("rejected") => "rejected",
		Some("partial") => "partial",
		Some("error") => "error",
		_ => "unvalidated",
	}
}

fn canonical_disposition(value: Option<&Value>) -> &'static str {
	match value.and_then(Value::as_str) {
		Some("false_positive") => "false_positive",
		Some("accepted_risk") => "accepted_risk",
		Some("fixed") => "fixed",
		Some("wont_fix") => "wont_fix",
		_ => "open",
	}
}

fn pointer_escape(value: &str) -> String {
	value.replace('~', "~0").replace('/', "~1")
}
