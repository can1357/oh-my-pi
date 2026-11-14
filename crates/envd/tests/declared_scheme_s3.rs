//! ADR 0050 S3 exit: core line-selector peel for live schemes, D5 host
//! judgment (no blanket Host Fetch), undeclared + mcp opacity.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use omp_core::Str;
use omp_envd::{
	HostResourceResult, HostResources, HostUriJudgment, SchemeClaim, SchemeGeneration,
	tool_url::{
		host::HostUriResolver,
		scheme_generation::{SchemeTestReader, judgment_from_flags},
	},
};
use omp_tool::{Effects, FetchEffects};
use omp_tools::read::{
	resolver::{Resolve, Scheme},
	selector::{ParsedSelector, parse_uri},
};

fn claim(name: &str) -> SchemeClaim {
	SchemeClaim {
		scheme:      Str::new(name),
		description: None,
		writable:    false,
		immutable:   false,
		fetch:       false,
		credentials: false,
	}
}

fn claim_flags(name: &str, fetch: bool, credentials: bool) -> SchemeClaim {
	SchemeClaim { fetch, credentials, ..claim(name) }
}

struct CapturingReader {
	seen: Arc<Mutex<Vec<String>>>,
	body: String,
}

#[async_trait]
impl SchemeTestReader for CapturingReader {
	async fn read(&self, _scheme: &str, url: &str) -> Result<HostResourceResult, Str> {
		self.seen.lock().expect("seen").push(url.to_owned());
		Ok(HostResourceResult { content: Some(self.body.clone()), notes: Vec::new() })
	}
}

#[test]
fn declared_omit_fetch_and_credentials_judges_unknown() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", None, vec![claim("widget")])
		.expect("fold");
	assert_eq!(HostResources::judge(&generation, "widget://id"), HostUriJudgment::Unknown);
	assert_eq!(judgment_from_flags(false, false), HostUriJudgment::Unknown);
	// D5 regression facts: Unknown is the named judgment for Effects::unknown().
	let _ = Effects::unknown();
	assert!(matches!(HostResources::judge(&generation, "widget://id"), HostUriJudgment::Unknown));
}

#[test]
fn undeclared_never_inherits_declared_scheme_judgment() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", None, vec![claim_flags("widget", true, true)])
		.expect("fold");
	assert_eq!(
		HostResources::judge(&generation, "widget://id"),
		HostUriJudgment::Fetch(FetchEffects { credentials: true })
	);
	assert_eq!(
		HostResources::judge(&generation, "custom://pending:raw"),
		HostUriJudgment::Undeclared
	);
	assert!(!generation.is_live("custom"));
	assert!(generation.is_live("widget"));
}

#[tokio::test]
async fn live_scheme_peels_line_selector() {
	let generation = Arc::new(SchemeGeneration::new());
	generation
		.replace_owner("acme.widgets", None, vec![claim("widget")])
		.expect("fold");
	let seen = Arc::new(Mutex::new(Vec::new()));
	generation.bind_test_reader(Arc::new(CapturingReader {
		seen: Arc::clone(&seen),
		body: String::from("line1\nline2\nline3\nline4\n"),
	}));
	let broker = Arc::clone(&generation) as Arc<dyn HostResources>;
	let resolver = HostUriResolver::new(Some(broker));
	let bytes = Resolve::read(&resolver, "widget://id:2-3", &ParsedSelector::None)
		.await
		.expect("live peel read");
	assert_eq!(std::str::from_utf8(&bytes).expect("utf8"), "line2\nline3\n");
	assert_eq!(seen.lock().expect("seen").as_slice(), ["widget://id"]);
}

#[tokio::test]
async fn undeclared_keeps_selector_opaque_in_resource() {
	let generation = Arc::new(SchemeGeneration::new());
	// Undeclared: resolve_read fails (no handler). Prove opacity via parse + judge.
	let parsed = parse_uri("custom://pending:raw")
		.expect("parse")
		.expect("uri");
	assert_eq!(parsed.scheme, Scheme::Unknown);
	assert_eq!(parsed.resource, "pending:raw");
	assert_eq!(parsed.selector, ParsedSelector::None);
	assert_eq!(
		HostResources::judge(generation.as_ref(), "custom://pending:raw"),
		HostUriJudgment::Undeclared
	);
}

#[test]
fn mcp_stays_selector_opaque() {
	assert!(!Scheme::Mcp.accepts_selectors());
	assert!(!Scheme::Unknown.accepts_selectors());
	let parsed = parse_uri("mcp://server/resource:50")
		.expect("parse")
		.expect("uri");
	assert_eq!(parsed.scheme, Scheme::Mcp);
	assert_eq!(parsed.resource, "server/resource:50");
	assert_eq!(parsed.selector, ParsedSelector::None);
}

#[test]
fn host_read_fetch_is_not_blanket_anonymous() {
	let generation = Arc::new(SchemeGeneration::new());
	generation
		.replace_owner("acme.widgets", None, vec![
			claim("widget"),
			claim_flags("gadget", true, false),
		])
		.expect("fold");
	let broker = Arc::clone(&generation) as Arc<dyn HostResources>;
	let resolver = HostUriResolver::new(Some(broker));
	assert_eq!(
		Resolve::read_fetch(&resolver, "widget://id", None),
		None,
		"omit-fetch declared scheme must not blanket Fetch"
	);
	assert_eq!(
		Resolve::read_fetch(&resolver, "gadget://id", None),
		Some(FetchEffects { credentials: false })
	);
	assert_eq!(
		Resolve::read_fetch(&resolver, "custom://pending:raw", None),
		None,
		"undeclared must not inherit Fetch"
	);
}

#[test]
fn credentials_without_fetch_never_becomes_fetch_judgment() {
	assert_eq!(judgment_from_flags(false, true), HostUriJudgment::Unknown);
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", None, vec![claim_flags("widget", false, true)])
		.expect("fold");
	assert_eq!(HostResources::judge(&generation, "widget://id"), HostUriJudgment::Unknown);
}
