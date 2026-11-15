//! ADR 0050 S4 exit: reload-shaped rebind still reads; quarantine clears;
//! refused co-claimant does not fall through; built-in `pr://` stays dense.

use std::{collections::BTreeSet, sync::Arc};

use async_trait::async_trait;
use omp_core::{Principal, Str, sf};
use omp_envd::{
	HostResourceResult, HostResources, HostUriJudgment, SchemeClaim, SchemeGeneration,
	exthost::control::ControlConnectionIdentity, tool_url::scheme_generation::SchemeTestReader,
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

fn identity(extension: &str, host_generation: u64) -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension: Str::new(extension),
		principal: Principal::new(sf!("tester"), sf!("Tester")),
		artifact_digest: sf!("digest"),
		layer: sf!("project"),
		tier: sf!("trusted"),
		trust: sf!("trusted"),
		host_generation,
		session_generation: 1,
		capabilities: Arc::new(BTreeSet::new()),
	})
}

struct FixedReader {
	body: String,
}

#[async_trait]
impl SchemeTestReader for FixedReader {
	async fn read(&self, _scheme: &str, _url: &str) -> Result<HostResourceResult, Str> {
		Ok(HostResourceResult { content: Some(self.body.clone()), notes: Vec::new() })
	}
}

#[tokio::test]
async fn declared_scheme_reload_rebinds_identity_and_still_reads() {
	let generation = SchemeGeneration::new();
	let gen_n = identity("acme.widgets", 1);
	generation
		.replace_owner("acme.widgets", Some(Arc::clone(&gen_n)), vec![claim("widget")])
		.expect("fold gen N");
	generation.bind_test_reader(Arc::new(FixedReader { body: String::from("widget body") }));
	let first = HostResources::resolve_read(&generation, "widget://id")
		.await
		.expect("read before reload");
	assert_eq!(first.content.as_deref(), Some("widget body"));
	assert_eq!(
		generation
			.snapshot()
			.into_iter()
			.find(|live| live.scheme.as_str() == "widget")
			.expect("widget live")
			.identity
			.as_ref()
			.map(|id| id.host_generation),
		Some(1)
	);

	// Reload shape: clear while host is down (D6), then FREEZE re-folds with
	// the advanced CONTROL identity (same envd-owned map).
	generation.clear_owner("acme.widgets");
	assert!(!generation.is_live("widget"));
	let gen_n1 = identity("acme.widgets", 2);
	generation
		.replace_owner("acme.widgets", Some(Arc::clone(&gen_n1)), vec![claim("widget")])
		.expect("re-fold gen N+1");
	let second = HostResources::resolve_read(&generation, "widget://id")
		.await
		.expect("read after reload rebind");
	assert_eq!(second.content.as_deref(), Some("widget body"));
	let live = generation
		.snapshot()
		.into_iter()
		.find(|row| row.scheme.as_str() == "widget")
		.expect("widget rebound");
	assert_eq!(
		live.identity.as_ref().map(|id| id.host_generation),
		Some(2),
		"reload must rebind LiveScheme.identity.host_generation"
	);
}

#[tokio::test]
async fn declared_scheme_quarantine_drops_scheme_builtin_intact() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", Some(identity("acme.widgets", 1)), vec![claim("widget")])
		.expect("fold");
	generation.bind_test_reader(Arc::new(FixedReader { body: String::from("widget body") }));
	assert!(generation.is_live("widget"));

	generation.clear_owner("acme.widgets");
	assert!(!generation.is_live("widget"));
	assert_eq!(HostResources::judge(&generation, "widget://id"), HostUriJudgment::Undeclared);
	let err = HostResources::resolve_read(&generation, "widget://id")
		.await
		.expect_err("quarantined scheme must not read");
	assert!(
		err.as_str().contains("no handler") || err.as_str().contains("widget"),
		"expected undeclared/no-handler refusal, got {err}"
	);

	assert!(
		SchemeGeneration::is_builtin_wire_name("pr"),
		"built-in pr:// stays dense outside SchemeGeneration"
	);
	assert!(
		generation
			.snapshot()
			.iter()
			.all(|live| live.scheme.as_str() != "pr"),
		"clearing declared schemes must never register pr into the generation"
	);
	assert!(!generation.is_live("pr"));
	assert!(!generation.is_live("https"));
}

#[test]
fn declared_scheme_quarantine_does_not_fall_through() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", Some(identity("acme.widgets", 1)), vec![claim("widget")])
		.expect("owner A");
	let refused = generation
		.replace_owner("other.ext", Some(identity("other.ext", 1)), vec![claim("widget")])
		.expect_err("owner B collision");
	assert!(matches!(refused, omp_envd::SchemeFoldError::Collision { .. }));
	assert!(generation.is_live("widget"));
	assert_eq!(
		generation
			.snapshot()
			.into_iter()
			.find(|live| live.scheme.as_str() == "widget")
			.expect("A owns widget")
			.owner
			.as_str(),
		"acme.widgets"
	);

	generation.clear_owner("acme.widgets");
	assert!(!generation.is_live("widget"));
	assert_eq!(
		HostResources::judge(&generation, "widget://id"),
		HostUriJudgment::Undeclared,
		"refused co-claimant must not auto-inherit after quarantine"
	);
	assert!(
		generation
			.snapshot()
			.iter()
			.all(|live| live.owner.as_str() != "other.ext"),
		"B must stay absent until it folds successfully"
	);

	generation
		.replace_owner("other.ext", Some(identity("other.ext", 2)), vec![claim("widget")])
		.expect("B may claim only after an explicit successful fold");
	assert!(generation.is_live("widget"));
	assert_eq!(
		generation
			.snapshot()
			.into_iter()
			.find(|live| live.scheme.as_str() == "widget")
			.expect("B owns widget")
			.owner
			.as_str(),
		"other.ext"
	);
}
