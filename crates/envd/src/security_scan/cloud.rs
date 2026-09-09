use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_ai::auth::HeaderPlacement;
use omp_core::{Hash32, Str, Ulid};
use omp_tools::security_scan::{Fault, LookbackDays, TargetKind, ValidationStatus};
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::Zeroizing;

use super::{
	model::{Evidence, Finding, Location, Producer, Provenance, Scan, Validation},
	now_stamp,
};
use crate::github_url::GithubCredentialBridge;

const DEFAULT_BASE: &str = "https://chatgpt.com/backend-api/aardvark";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const MAX_IMPORT_TOTAL: usize = 32 * 1024 * 1024;
const MAX_CLOUD_ITEMS: usize = 20_000;

#[derive(Clone)]
pub(super) struct CloudClient {
	client:        Client,
	base:          Str,
	access_token:  Option<Arc<Zeroizing<String>>>,
	account_id:    Option<Str>,
	credential_id: Option<u64>,
	authority:     Option<Arc<GithubCredentialBridge>>,
}

impl CloudClient {
	pub fn from_environment() -> Option<Self> {
		let access_token =
			Arc::new(Zeroizing::new(std::env::var("OMP_CODEX_SECURITY_ACCESS_TOKEN").ok()?));
		let base =
			std::env::var("OMP_CODEX_SECURITY_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE.to_owned());
		let account_id = std::env::var("OMP_CODEX_SECURITY_ACCOUNT_ID")
			.ok()
			.filter(|value| !value.is_empty())
			.map(Str::new);
		let credential_id = std::env::var("OMP_CODEX_SECURITY_CREDENTIAL_ID")
			.ok()
			.and_then(|value| value.parse().ok());
		let client = omp_http::client_builder()
			.timeout(Duration::from_secs(120))
			.build()
			.ok()?;
		Some(Self {
			client,
			base: Str::new(base.trim_end_matches('/')),
			access_token: Some(access_token),
			account_id,
			credential_id,
			authority: None,
		})
	}

	#[cfg(test)]
	pub fn fixed(base: &str, token: &str, credential_id: u64) -> Self {
		let client = omp_http::client_builder()
			.timeout(Duration::from_secs(120))
			.build()
			.expect("test client");
		Self {
			client,
			base: Str::new(base.trim_end_matches('/')),
			access_token: Some(Arc::new(Zeroizing::new(token.to_owned()))),
			account_id: None,
			credential_id: Some(credential_id),
			authority: None,
		}
	}

	pub fn from_authority(authority: Arc<GithubCredentialBridge>) -> Option<Self> {
		let client = omp_http::client_builder()
			.timeout(Duration::from_secs(120))
			.build()
			.ok()?;
		let base =
			std::env::var("OMP_CODEX_SECURITY_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE.to_owned());
		Some(Self {
			client,
			base: Str::new(base.trim_end_matches('/')),
			access_token: std::env::var("OMP_CODEX_SECURITY_ACCESS_TOKEN")
				.ok()
				.map(Zeroizing::new)
				.map(Arc::new),
			account_id: std::env::var("OMP_CODEX_SECURITY_ACCOUNT_ID")
				.ok()
				.filter(|value| !value.is_empty())
				.map(Str::new),
			credential_id: std::env::var("OMP_CODEX_SECURITY_CREDENTIAL_ID")
				.ok()
				.and_then(|value| value.parse().ok()),
			authority: Some(authority),
		})
	}

	pub fn authorize(&self, requested: Option<u64>) -> Result<Self, Fault> {
		if self.authority.is_none() && requested.is_some() && requested != self.credential_id {
			return Err(Fault::Authentication);
		}
		let mut selected = self.clone();
		selected.credential_id = requested.or(self.credential_id);
		Ok(selected)
	}

	pub async fn configurations(
		&self,
		cancellation: &CancellationToken,
	) -> Result<Vec<Value>, Fault> {
		let mut items = Vec::new();
		let mut cursor: Option<String> = None;
		let mut seen_cursors = std::collections::BTreeSet::new();
		loop {
			let mut query = vec![("limit", "500".to_owned())];
			if let Some(value) = &cursor {
				query.push(("cursor", value.clone()));
			}
			let page = self
				.request(Method::GET, "scan_configurations", &query, None, cancellation)
				.await?;
			let page_items = page
				.get("items")
				.and_then(Value::as_array)
				.ok_or(Fault::Cloud)?;
			for item in page_items {
				items.push(normalize_configuration(item)?);
			}
			if items.len() > MAX_CLOUD_ITEMS {
				return Err(Fault::Cloud);
			}
			cursor = page
				.get("next_cursor")
				.and_then(Value::as_str)
				.map(str::to_owned);
			if cursor
				.as_ref()
				.is_none_or(|cursor| !seen_cursors.insert(cursor.clone()))
			{
				break;
			}
		}
		Ok(items)
	}

	pub async fn start(
		&self,
		repository_id: &str,
		repository_url: &str,
		environment_id: &str,
		lookback: Option<&LookbackDays>,
		cancellation: &CancellationToken,
	) -> Result<Value, Fault> {
		let owner = self.principal(cancellation).await?;
		let lookback = match lookback {
			Some(LookbackDays::Days(days)) => Value::from(*days),
			Some(LookbackDays::All(_)) => Value::Null,
			None => Value::from(30),
		};
		let body = json!({"scan_input": {
			"environment_id": environment_id,
			"lookback_days": lookback,
			"notification_rules": [],
			"owner_id": owner,
			"repo_id": repository_id,
			"repo_url": repository_url,
			"share_targets": [],
			"state": "enabled"
		}});
		let raw = self
			.request(Method::POST, "scan_configurations", &[], Some(body), cancellation)
			.await?;
		normalize_configuration(&raw)
	}

	pub async fn status(&self, id: &str, cancellation: &CancellationToken) -> Result<Value, Fault> {
		self
			.request(
				Method::GET,
				&format!("scan_configurations/{}/stats", segment(id)),
				&[],
				None,
				cancellation,
			)
			.await
	}

	pub async fn pull(
		&self,
		id: &str,
		root: &std::path::Path,
		cancellation: &CancellationToken,
	) -> Result<Scan, Fault> {
		let credential_affinity = self.credential_affinity(cancellation).await?;
		let configurations = self.configurations(cancellation).await?;
		let configuration = configurations
			.iter()
			.find(|entry| {
				entry.get("id").and_then(Value::as_str) == Some(id)
					|| entry.get("source_id").and_then(Value::as_str) == Some(id)
			})
			.ok_or(Fault::NotFound)?;
		let repository_url = configuration
			.get("repository_url")
			.and_then(Value::as_str)
			.ok_or(Fault::Cloud)?;
		verify_repository(root, repository_url)?;
		let mut summaries = Vec::new();
		let mut cursor: Option<String> = None;
		let mut seen_cursors = std::collections::BTreeSet::new();
		loop {
			let mut query = vec![
				("repo", repository_url.to_owned()),
				("limit", "500".to_owned()),
				("status", "new,triaged,in_progress,fixed,wontfix,duplicate,false_positive".to_owned()),
			];
			if let Some(value) = &cursor {
				query.push(("cursor", value.clone()));
			}
			let page = self
				.request(Method::GET, "scan-findings", &query, None, cancellation)
				.await?;
			summaries.extend(
				page
					.get("items")
					.and_then(Value::as_array)
					.ok_or(Fault::Cloud)?
					.iter()
					.cloned(),
			);
			if summaries.len() > MAX_CLOUD_ITEMS {
				return Err(Fault::Cloud);
			}
			cursor = page
				.get("next_cursor")
				.and_then(Value::as_str)
				.map(str::to_owned);
			if cursor
				.as_ref()
				.is_none_or(|cursor| !seen_cursors.insert(cursor.clone()))
			{
				break;
			}
		}
		let mut details = Vec::new();
		let mut retained_bytes = 0usize;
		for summary in &summaries {
			if cancellation.is_cancelled() {
				return Err(Fault::Unavailable);
			}
			let finding_id = summary
				.get("hid")
				.or_else(|| summary.get("id"))
				.and_then(Value::as_str)
				.ok_or(Fault::Cloud)?;
			let detail = self
				.request(
					Method::GET,
					&format!("scan-findings/{}", segment(finding_id)),
					&[],
					None,
					cancellation,
				)
				.await?;
			let attributed = detail
				.get("configured_scan_id")
				.and_then(Value::as_str)
				.is_none_or(|configured| configured == id);
			if attributed {
				retained_bytes = retained_bytes
					.saturating_add(serde_json::to_vec(&detail).map_err(|_| Fault::Cloud)?.len());
				if retained_bytes > MAX_IMPORT_TOTAL {
					return Err(Fault::Cloud);
				}
				details.push(detail);
			}
		}
		cloud_scan(configuration, details, root, credential_affinity)
	}

	async fn credential_affinity(
		&self,
		cancellation: &CancellationToken,
	) -> Result<Option<Str>, Fault> {
		if cancellation.is_cancelled() {
			return Err(Fault::Unavailable);
		}
		let identity = if let Some(authority) = &self.authority {
			authority
				.lease_for_account("openai-codex", self.credential_id)
				.await
				.map_err(|_| Fault::Authentication)?
				.map(|lease| Str::new(lease.meta().account.as_str()))
		} else if let Some(credential_id) = self.credential_id {
			Some(Str::new(credential_id.to_string()))
		} else {
			self.account_id.clone()
		};
		Ok(identity.map(|identity| {
			let digest = Hash32::sum(format!("openai-codex:{identity}").as_bytes()).to_hex();
			Str::new(format!("omp-security-credential/v1:sha256:{digest}"))
		}))
	}

	async fn principal(&self, cancellation: &CancellationToken) -> Result<Str, Fault> {
		if cancellation.is_cancelled() {
			return Err(Fault::Unavailable);
		}
		if let Some(authority) = &self.authority {
			if let Some(lease) = authority
				.lease_for_account("openai-codex", self.credential_id)
				.await
				.map_err(|_| Fault::Authentication)?
			{
				return Ok(Str::new(lease.meta().principal.as_str()));
			}
		}
		let token = self.access_token.as_ref().ok_or(Fault::Authentication)?;
		jwt_subject(token.as_str())
	}

	async fn request(
		&self,
		method: Method,
		path: &str,
		query: &[(&str, String)],
		body: Option<Value>,
		cancellation: &CancellationToken,
	) -> Result<Value, Fault> {
		let mut url = Url::parse(&format!("{}/{}", self.base, path.trim_start_matches('/')))
			.map_err(|_| Fault::Cloud)?;
		url.query_pairs_mut()
			.extend_pairs(query.iter().map(|(name, value)| (*name, value.as_str())));
		let lease = if let Some(authority) = &self.authority {
			authority
				.lease_for_account("openai-codex", self.credential_id)
				.await
				.map_err(|_| Fault::Authentication)?
		} else {
			None
		};
		let mut builder = self
			.client
			.request(method, url)
			.header("accept", "application/json");
		if let Some(account_id) = &self.account_id {
			builder = builder.header("chatgpt-account-id", account_id.as_str());
		}
		if let Some(body) = body {
			builder = builder.json(&body);
		}
		if lease.is_none() {
			let token = self.access_token.as_ref().ok_or(Fault::Authentication)?;
			builder = builder.bearer_auth(token.as_str());
		}
		let mut request = builder.build().map_err(|_| Fault::Cloud)?;
		if let Some(lease) = lease {
			lease
				.apply_header(&HeaderPlacement::bearer(), request.headers_mut())
				.map_err(|_| Fault::Authentication)?;
		}
		let response = tokio::select! {
			_ = cancellation.cancelled() => return Err(Fault::Unavailable),
			response = self.client.execute(request) => response.map_err(|_| Fault::Cloud)?,
		};
		if response.status() == StatusCode::UNAUTHORIZED {
			return Err(Fault::Authentication);
		}
		if !response.status().is_success() {
			return Err(Fault::Cloud);
		}
		if response
			.content_length()
			.is_some_and(|length| length > MAX_RESPONSE as u64)
		{
			return Err(Fault::Cloud);
		}
		let bytes = bounded_body(response, cancellation).await?;
		serde_json::from_slice(&bytes).map_err(|_| Fault::Cloud)
	}
}

async fn bounded_body(
	response: reqwest::Response,
	cancellation: &CancellationToken,
) -> Result<Bytes, Fault> {
	use futures::StreamExt as _;
	let mut stream = response.bytes_stream();
	let mut bytes = Vec::new();
	loop {
		let next = tokio::select! {
			_ = cancellation.cancelled() => return Err(Fault::Unavailable),
			next = stream.next() => next,
		};
		let Some(chunk) = next else { break };
		let chunk = chunk.map_err(|_| Fault::Cloud)?;
		if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
			return Err(Fault::Cloud);
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(Bytes::from(bytes))
}

fn jwt_subject(token: &str) -> Result<Str, Fault> {
	let encoded = token.split('.').nth(1).ok_or(Fault::Authentication)?;
	let mut normalized = encoded.replace('-', "+").replace('_', "/");
	while normalized.len() % 4 != 0 {
		normalized.push('=');
	}
	let bytes = omp_core::base64::decode(normalized.as_bytes())
		.into_vec()
		.map_err(|_| Fault::Authentication)?;
	let claims: Value = serde_json::from_slice(&bytes).map_err(|_| Fault::Authentication)?;
	claims
		.get("sub")
		.or_else(|| claims.get("user_id"))
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or(Fault::Authentication)
}

fn normalize_configuration(value: &Value) -> Result<Value, Fault> {
	let scan = value
		.get("scan_input")
		.and_then(Value::as_object)
		.ok_or(Fault::Cloud)?;
	let id = value
		.get("hid")
		.or_else(|| value.get("id"))
		.and_then(Value::as_str)
		.ok_or(Fault::Cloud)?;
	Ok(json!({
		"id": id,
		"source_id": value.get("id"),
		"repository_id": scan.get("repo_id").and_then(Value::as_str).ok_or(Fault::Cloud)?,
		"repository_url": scan.get("repo_url").and_then(Value::as_str).ok_or(Fault::Cloud)?,
		"environment_id": scan.get("environment_id").and_then(Value::as_str).ok_or(Fault::Cloud)?,
		"state": scan.get("state"),
		"current_step": value.get("current_step"),
		"remaining_scans": value.get("scans_remaining").or_else(|| value.get("remaining_scans")),
		"total_scans": value.get("total_scans"),
	}))
}

fn cloud_scan(
	configuration: &Value,
	details: Vec<Value>,
	_root: &std::path::Path,
	credential_affinity: Option<Str>,
) -> Result<Scan, Fault> {
	let created = now_stamp();
	let config_id = configuration
		.get("id")
		.and_then(Value::as_str)
		.ok_or(Fault::Cloud)?;
	let scan_id = Str::new(format!("secscan_{}", Ulid::generate()));
	let producer = Producer {
		kind:    Str::new_static("codex-security-cloud"),
		name:    Str::new_static("Codex Security cloud"),
		version: None,
		vendor:  Some(Str::new_static("OpenAI")),
	};
	let provenance = Provenance {
		producer:            producer.clone(),
		created_at:          created.clone(),
		imported_at:         Some(now_stamp()),
		source_ids:          BTreeMap::from([
			(Str::new_static("cloud_configuration_id"), Str::new(config_id)),
			(
				Str::new_static("repository_url"),
				Str::new(
					configuration
						.get("repository_url")
						.and_then(Value::as_str)
						.unwrap_or_default(),
				),
			),
		]),
		vendor_fingerprints: BTreeMap::new(),
		metadata:            credential_affinity
			.map(|affinity| {
				BTreeMap::from([(
					Str::new_static("credential_affinity"),
					Value::String(affinity.to_string()),
				)])
			})
			.unwrap_or_default(),
	};
	let mut findings = Vec::new();
	let mut seen_fingerprints = BTreeSet::new();
	for detail in details {
		let vendor_id = detail
			.get("hid")
			.or_else(|| detail.get("id"))
			.and_then(Value::as_str)
			.ok_or(Fault::Cloud)?;
		let commit = detail
			.get("commit_analysis")
			.and_then(Value::as_object)
			.ok_or(Fault::Cloud)?;
		let title = commit
			.get("title")
			.or_else(|| detail.get("title"))
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.ok_or(Fault::Cloud)?;
		let summary = commit
			.get("description")
			.or_else(|| detail.get("description"))
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.unwrap_or(title);
		let generated_rule;
		let rule = if let Some(rule) = commit
			.get("rule_id")
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
		{
			rule
		} else {
			generated_rule = format!(
				"codex-security:{}",
				&Hash32::sum(title.to_lowercase().as_bytes()).to_hex()[..16],
			);
			&generated_rule
		};
		let category = commit
			.get("category")
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.unwrap_or("codex-security");
		let mut locations = Vec::new();
		for line in commit
			.get("relevant_lines")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let Some(path) = line
				.get("path")
				.and_then(Value::as_str)
				.and_then(safe_relative)
			else {
				continue;
			};
			let Some(start_line) = line
				.get("start_line_number")
				.and_then(Value::as_u64)
				.filter(|line| *line > 0)
			else {
				continue;
			};
			locations.push(Location {
				path: Str::new(path),
				start_line,
				end_line: line.get("end_line_number").and_then(Value::as_u64),
				start_column: None,
				end_column: None,
				role: Some(Str::new_static("primary")),
			});
		}
		if locations.is_empty() {
			for path in commit
				.get("files_involved")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
			{
				let Some(path) = path.as_str().and_then(safe_relative) else {
					continue;
				};
				locations.push(Location {
					path:         Str::new(path),
					start_line:   1,
					end_line:     None,
					start_column: None,
					end_column:   None,
					role:         Some(Str::new_static("primary")),
				});
			}
		}
		if locations.is_empty() {
			return Err(Fault::Cloud);
		}
		let fingerprint_material = serde_json::to_vec(&json!({
			"rule_id": rule.to_lowercase(),
			"category": category.to_lowercase(),
			"locations": locations,
		}))
		.map_err(|_| Fault::Cloud)?;
		let fingerprint = Str::new(format!(
			"omp-security/v1:sha256:{}",
			Hash32::sum(&fingerprint_material).to_hex(),
		));
		if !seen_fingerprints.insert(fingerprint.clone()) {
			continue;
		}
		let finding_digest = Hash32::sum(fingerprint.as_bytes()).to_hex();
		let mut evidence = locations
			.iter()
			.enumerate()
			.map(|(index, location)| Evidence {
				id:          Str::new(format!(
					"sece_{}",
					&Hash32::sum(format!("{fingerprint}:cloud-source:{index}").as_bytes()).to_hex()
						[..24],
				)),
				kind:        Str::new_static("code"),
				label:       Str::new(format!("Cloud source evidence {}", index + 1)),
				explanation: Str::new_static("Source location reported by Codex Security cloud."),
				location:    Some(location.clone()),
				excerpt:     None,
			})
			.collect::<Vec<_>>();
		let validation_report = commit
			.get("validation_report")
			.or_else(|| commit.get("fix_check_report"))
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty());
		let validation_evidence = validation_report.map(|report| Evidence {
			id:          Str::new(format!(
				"sece_{}",
				&Hash32::sum(format!("{fingerprint}:cloud-validation").as_bytes()).to_hex()[..24],
			)),
			kind:        Str::new_static("validation"),
			label:       Str::new_static("Cloud validation report"),
			explanation: Str::new(report),
			location:    None,
			excerpt:     None,
		});
		let validation_evidence_id = validation_evidence.as_ref().map(|item| item.id.clone());
		evidence.extend(validation_evidence);
		let mut finding_provenance = provenance.clone();
		finding_provenance
			.vendor_fingerprints
			.insert(Str::new_static("codex_security_id"), Str::new(vendor_id));
		findings.push(Finding {
			id: Str::new(format!("secf_{}", &finding_digest[..24])),
			scan_id: scan_id.clone(),
			fingerprint,
			rule_id: Str::new(rule),
			title: Str::new(title),
			summary: Str::new(summary),
			severity: cloud_severity(
				detail
					.get("criticality")
					.or_else(|| commit.get("criticality"))
					.and_then(Value::as_str),
			),
			confidence: cloud_confidence(commit.get("validation_confidence")),
			category: Str::new(category),
			cwe: Vec::new(),
			locations,
			evidence,
			remediation: commit
				.get("proposed_patch")
				.or_else(|| detail.get("proposed_patch"))
				.and_then(Value::as_str)
				.map(Str::new),
			validation: Validation {
				status:       if commit.get("validated").and_then(Value::as_bool) == Some(true) {
					ValidationStatus::Validated
				} else {
					ValidationStatus::Unvalidated
				},
				summary:      validation_report.map(Str::new),
				evidence_ids: validation_evidence_id.into_iter().collect(),
				validated_at: commit
					.get("validation_finished_at")
					.and_then(Value::as_str)
					.map(Str::new),
			},
			disposition: cloud_disposition(detail.get("status").and_then(Value::as_str)),
			provenance: finding_provenance,
		});
	}
	Ok(Scan {
		id: scan_id,
		plan_id: None,
		status: Str::new_static("completed"),
		created_at: created.clone(),
		completed_at: Some(created),
		target: TargetKind::Repository,
		producer,
		provenance,
		findings,
		report: Some(Str::new_static("# Codex Security cloud import\n")),
		sarif: None,
	})
}

fn cloud_severity(value: Option<&str>) -> Str {
	Str::new_static(match value {
		Some("critical") => "critical",
		Some("high") => "high",
		Some("medium") => "medium",
		Some("low") => "low",
		_ => "informational",
	})
}

fn cloud_confidence(value: Option<&Value>) -> Str {
	let score = value.and_then(Value::as_f64);
	Str::new_static(match score {
		Some(score) if score >= 0.67 => "high",
		Some(score) if score >= 0.34 => "medium",
		Some(_) => "low",
		None => "medium",
	})
}

fn cloud_disposition(value: Option<&str>) -> Str {
	Str::new_static(match value {
		Some("fixed") => "fixed",
		Some("false_positive") => "false_positive",
		Some("wontfix") => "wont_fix",
		Some("duplicate") => "accepted_risk",
		_ => "open",
	})
}

fn verify_repository(root: &std::path::Path, cloud_url: &str) -> Result<(), Fault> {
	let output = std::process::Command::new("git")
		.arg("-C")
		.arg(root)
		.args(["config", "--get", "remote.origin.url"])
		.output()
		.map_err(|_| Fault::Storage)?;
	if !output.status.success() {
		return Err(Fault::InvalidArguments);
	}
	let origin = std::str::from_utf8(&output.stdout)
		.map_err(|_| Fault::Storage)?
		.trim();
	if canonical_repository(origin) != canonical_repository(cloud_url) {
		return Err(Fault::InvalidArguments);
	}
	Ok(())
}

fn canonical_repository(value: &str) -> String {
	let mut value = value
		.trim()
		.trim_end_matches('/')
		.trim_end_matches(".git")
		.to_lowercase();
	if let Some(rest) = value.strip_prefix("git@") {
		value = rest.replacen(':', "/", 1);
	} else if let Some((_, rest)) = value.split_once("://") {
		let rest = rest.trim_start_matches('/');
		value = rest
			.rsplit_once('@')
			.map_or(rest, |(_, host)| host)
			.to_owned();
	}
	value
}

fn safe_relative(value: &str) -> Option<&str> {
	let value = value.trim().trim_start_matches("./");
	(!value.is_empty()
		&& !value.starts_with('/')
		&& !value.contains('\\')
		&& !value.split('/').any(|part| part == ".."))
	.then_some(value)
}

fn segment(value: &str) -> String {
	let mut encoded = String::new();
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
			encoded.push(char::from(byte));
		} else {
			use std::fmt::Write as _;
			let _ = write!(encoded, "%{byte:02X}");
		}
	}
	encoded
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn exact_credential_selection_and_jwt_identity_fail_closed() {
		let client = CloudClient::fixed("https://example.invalid", "e30.eyJzdWIiOiJ1c2VyIn0.", 7);
		assert!(client.authorize(Some(7)).is_ok());
		assert!(matches!(client.authorize(Some(8)), Err(Fault::Authentication)));
		assert_eq!(
			jwt_subject(client.access_token.as_ref().expect("token").as_str()).expect("subject"),
			"user",
		);
		assert_eq!(segment("../secret"), "..%2Fsecret");
		assert_eq!(
			canonical_repository("git@github.com:Example/Repo.git"),
			canonical_repository("https://github.com/example/repo"),
		);
	}
}
