use std::collections::BTreeMap;

use omp_core::Str;
use omp_tools::security_scan::{TargetKind, ValidationEvidence, ValidationStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Plan {
	pub id:                   Str,
	pub fingerprint:          Str,
	pub created_at:           Str,
	pub target:               TargetKind,
	pub include_paths:        Vec<Str>,
	pub exclude_paths:        Vec<Str>,
	pub base_revision:        Option<Str>,
	pub head_revision:        Option<Str>,
	pub knowledge_bases:      Vec<KnowledgeBase>,
	pub output_root:          Option<Str>,
	pub archive_existing:     bool,
	pub tree_digest:          Str,
	pub workflow_fingerprint: Str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct KnowledgeBase {
	pub path:   Str,
	pub sha256: Str,
	pub size:   u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Producer {
	pub kind:    Str,
	pub name:    Str,
	pub version: Option<Str>,
	pub vendor:  Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Provenance {
	pub producer:            Producer,
	pub created_at:          Str,
	pub imported_at:         Option<Str>,
	pub source_ids:          BTreeMap<Str, Str>,
	pub vendor_fingerprints: BTreeMap<Str, Str>,
	pub metadata:            BTreeMap<Str, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Location {
	pub path:         Str,
	pub start_line:   u64,
	pub end_line:     Option<u64>,
	pub start_column: Option<u64>,
	pub end_column:   Option<u64>,
	pub role:         Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Evidence {
	pub id:          Str,
	pub kind:        Str,
	pub label:       Str,
	pub explanation: Str,
	pub location:    Option<Location>,
	pub excerpt:     Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Validation {
	pub status:       ValidationStatus,
	pub summary:      Option<Str>,
	pub evidence_ids: Vec<Str>,
	pub validated_at: Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Finding {
	pub id:          Str,
	pub scan_id:     Str,
	pub fingerprint: Str,
	pub rule_id:     Str,
	pub title:       Str,
	pub summary:     Str,
	pub severity:    Str,
	pub confidence:  Str,
	pub category:    Str,
	pub cwe:         Vec<Str>,
	pub locations:   Vec<Location>,
	pub evidence:    Vec<Evidence>,
	pub remediation: Option<Str>,
	pub validation:  Validation,
	pub disposition: Str,
	pub provenance:  Provenance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Scan {
	pub id:           Str,
	pub plan_id:      Option<Str>,
	pub status:       Str,
	pub created_at:   Str,
	pub completed_at: Option<Str>,
	pub target:       TargetKind,
	pub producer:     Producer,
	pub provenance:   Provenance,
	pub findings:     Vec<Finding>,
	pub report:       Option<Str>,
	pub sarif:        Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Operation {
	pub id:            Str,
	pub scan_id:       Str,
	pub plan_id:       Str,
	pub phase:         Str,
	pub created_at:    Str,
	pub updated_at:    Str,
	pub finding_count: usize,
	pub error:         Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Remediation {
	pub id:          Str,
	pub scan_id:     Str,
	pub finding_ids: Vec<Str>,
	pub path:        Str,
	pub status:      Str,
	pub created_at:  Str,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct State {
	pub plans:        BTreeMap<Str, Plan>,
	pub operations:   BTreeMap<Str, Operation>,
	pub scans:        BTreeMap<Str, Scan>,
	pub remediations: BTreeMap<Str, Remediation>,
}

pub(super) fn validation_evidence(
	fingerprint: &str,
	existing: usize,
	input: Vec<ValidationEvidence>,
) -> Vec<Evidence> {
	input
		.into_iter()
		.enumerate()
		.map(|(index, item)| {
			let material = format!("{fingerprint}:validation:{}:{}", item.label, existing + index);
			let digest = omp_core::Hash32::sum(material.as_bytes()).to_hex();
			Evidence {
				id:          Str::new(format!("sece_{}", &digest[..24])),
				kind:        Str::new_static("validation"),
				label:       item.label,
				explanation: item.explanation,
				location:    None,
				excerpt:     None,
			}
		})
		.collect()
}
