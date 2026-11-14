//! ADR 0050 S5 exit: joined install → read → selector → reload → quarantine
//! → builtin conformance, plus model-facing listing (`omp.schemes.live` /
//! `SchemeGeneration::listing_payload`) without changing `omp.urls.schemes`.

use std::{
	collections::BTreeSet,
	sync::{Arc, Mutex},
};

use async_trait::async_trait;
use omp_core::{Principal, Str, sf};
use omp_envd::{
	HostResourceResult, HostResources, HostUriJudgment, SchemeClaim, SchemeGeneration,
	exthost::control::ControlConnectionIdentity,
	tool_url::{
		host::HostUriResolver,
		scheme_generation::SchemeTestReader,
	},
};
use omp_py::{
	Engine,
	pyo3::{
		ffi::c_str,
		types::{PyDict, PyDictMethods},
	},
};
use omp_tool::FetchEffects;
use omp_tools::read::{
	resolver::{Resolve, Scheme},
	selector::{ParsedSelector, parse_uri},
};

fn claim(name: &str) -> SchemeClaim {
	SchemeClaim {
		scheme:      Str::new(name),
		description: Some(Str::new_static("Widget records by id")),
		writable:    false,
		immutable:   true,
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

fn listing_names(generation: &SchemeGeneration) -> Vec<String> {
	generation
		.snapshot()
		.into_iter()
		.map(|live| live.scheme.to_string())
		.collect()
}

#[tokio::test]
async fn declared_scheme_s5_joined_conformance() {
	let generation = Arc::new(SchemeGeneration::new());
	let gen_n = identity("acme.widgets", 1);

	// Install / fold.
	generation
		.replace_owner("acme.widgets", Some(Arc::clone(&gen_n)), vec![claim("widget")])
		.expect("fold");
	assert!(generation.is_live("widget"));
	assert_eq!(listing_names(&generation), ["widget"]);
	let payload = generation.listing_payload();
	let schemes = payload
		.get("schemes")
		.and_then(|value| value.as_array())
		.expect("schemes array");
	assert_eq!(schemes.len(), 1);
	assert_eq!(schemes[0].get("name").and_then(|v| v.as_str()), Some("widget"));
	assert_eq!(schemes[0].get("owner").and_then(|v| v.as_str()), Some("acme.widgets"));
	assert_eq!(schemes[0].get("immutable").and_then(|v| v.as_bool()), Some(true));
	assert_eq!(schemes[0].get("fetch").and_then(|v| v.as_bool()), Some(false));
	assert!(
		schemes.iter().all(|row| row.get("name").and_then(|v| v.as_str()) != Some("pr")),
		"listing must never include built-in pr"
	);

	// Read + selector peel.
	let seen = Arc::new(Mutex::new(Vec::new()));
	generation.bind_test_reader(Arc::new(CapturingReader {
		seen: Arc::clone(&seen),
		body: String::from("line1\nline2\nline3\nline4\n"),
	}));
	let plain = HostResources::resolve_read(generation.as_ref(), "widget://id")
		.await
		.expect("read");
	assert_eq!(plain.content.as_deref(), Some("line1\nline2\nline3\nline4\n"));
	assert_eq!(HostResources::judge(generation.as_ref(), "widget://id"), HostUriJudgment::Unknown);
	assert_eq!(
		Resolve::read_fetch(
			&HostUriResolver::new(Some(Arc::clone(&generation) as Arc<dyn HostResources>)),
			"widget://id",
			None,
		),
		None
	);

	let broker = Arc::clone(&generation) as Arc<dyn HostResources>;
	let resolver = HostUriResolver::new(Some(broker));
	let selected = Resolve::read(&resolver, "widget://id:2-3", &ParsedSelector::None)
		.await
		.expect("selector peel");
	assert_eq!(std::str::from_utf8(&selected).expect("utf8"), "line2\nline3\n");
	assert!(
		seen.lock().expect("seen").iter().any(|url| url == "widget://id"),
		"handler must see peeled URL"
	);

	// Undeclared + mcp stay opaque (S3 facts retained in the joined walk).
	let undeclared = parse_uri("custom://pending:raw")
		.expect("parse")
		.expect("uri");
	assert_eq!(undeclared.scheme, Scheme::Unknown);
	assert_eq!(undeclared.resource, "pending:raw");
	assert_eq!(
		HostResources::judge(generation.as_ref(), "custom://pending:raw"),
		HostUriJudgment::Undeclared
	);
	assert!(!Scheme::Mcp.accepts_selectors());

	// Reload rebind: clear while down, FREEZE-shaped re-fold with gen N+1.
	generation.clear_owner("acme.widgets");
	assert!(!generation.is_live("widget"));
	assert!(listing_names(&generation).is_empty());
	let gen_n1 = identity("acme.widgets", 2);
	generation
		.replace_owner("acme.widgets", Some(Arc::clone(&gen_n1)), vec![claim("widget")])
		.expect("re-fold");
	assert!(generation.is_live("widget"));
	assert_eq!(listing_names(&generation), ["widget"]);
	let rebound = HostResources::resolve_read(generation.as_ref(), "widget://id")
		.await
		.expect("read after reload");
	assert!(rebound.content.is_some());
	assert_eq!(
		generation
			.snapshot()
			.into_iter()
			.find(|live| live.scheme.as_str() == "widget")
			.expect("widget")
			.identity
			.as_ref()
			.map(|id| id.host_generation),
		Some(2)
	);

	// Quarantine drops scheme; built-in pr stays dense outside the generation.
	generation.clear_owner("acme.widgets");
	assert!(!generation.is_live("widget"));
	assert!(listing_names(&generation).is_empty());
	assert_eq!(
		HostResources::judge(generation.as_ref(), "widget://id"),
		HostUriJudgment::Undeclared
	);
	let err = HostResources::resolve_read(generation.as_ref(), "widget://id")
		.await
		.expect_err("quarantined");
	assert!(
		err.as_str().contains("no handler") || err.as_str().contains("widget"),
		"got {err}"
	);
	assert!(SchemeGeneration::is_builtin_wire_name("pr"));
	assert!(!matches!(Scheme::parse("pr"), Scheme::Unknown));
	assert!(!generation.is_live("pr"));
	assert!(!generation.is_live("https"));
	let empty = generation.listing_payload();
	assert_eq!(
		empty.get("schemes").and_then(|v| v.as_array()).map(Vec::len),
		Some(0)
	);
	let _ = FetchEffects { credentials: false };

	// Python live() + urls.schemes unchanged.
	let listing_json = generation.listing_payload().to_string();
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			let globals = PyDict::new(py);
			globals.set_item("LISTING_JSON", listing_json.as_str())?;
			py.run(
				c_str!(
					r#"
import asyncio
import json

import omp
import omp.schemes as schemes
import omp.urls as urls


class ListingBackend:
    def __init__(self, payload):
        self.payload = payload

    async def request(self, operation, arguments):
        assert operation == "omp.schemes.live"
        assert arguments == {}
        return self.payload


urls_before = dict(urls.schemes())
members_before = [(member.name, member.value) for member in urls.Scheme]
payload = json.loads(LISTING_JSON)
assert payload["schemes"] == []

async def exercise():
    try:
        await schemes.live()
    except omp.NotWiredError as raised:
        assert "omp.schemes.live" in str(raised)
    else:
        raise AssertionError("live without CONTROL must raise NotWiredError")

    omp._install_control_backend(ListingBackend({"schemes": [
        {
            "name": "widget",
            "description": "Widget records by id",
            "immutable": True,
            "writable": False,
            "owner": "acme.widgets",
            "fetch": False,
            "credentials": False,
        }
    ]}))
    rows = await schemes.live()
    assert rows == (
        schemes.LiveDeclaration(
            name="widget",
            description="Widget records by id",
            immutable=True,
            writable=False,
            owner="acme.widgets",
            fetch=False,
            credentials=False,
        ),
    )
    assert schemes.declared() == ()
    assert dict(urls.schemes()) == urls_before
    assert [(member.name, member.value) for member in urls.Scheme] == members_before

asyncio.run(exercise())
"#
				),
				Some(&globals),
				None,
			)
		})
		.expect("omp.schemes.live listing contract");
}

#[test]
fn listing_payload_excludes_builtins_and_orders_by_scheme() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.gadgets", None, vec![SchemeClaim {
			scheme:      Str::new_static("gadget"),
			description: None,
			writable:    false,
			immutable:   false,
			fetch:       true,
			credentials: false,
		}])
		.expect("gadget");
	generation
		.replace_owner("acme.widgets", None, vec![claim("widget")])
		.expect("widget");
	let payload = generation.listing_payload();
	let names = payload["schemes"]
		.as_array()
		.expect("array")
		.iter()
		.map(|row| row["name"].as_str().expect("name").to_owned())
		.collect::<Vec<_>>();
	assert_eq!(names, ["gadget", "widget"]);
	assert!(generation
		.listing_payload()["schemes"]
		.as_array()
		.expect("array")
		.iter()
		.all(|row| {
			let name = row["name"].as_str().unwrap_or("");
			!SchemeGeneration::is_builtin_wire_name(name)
		}));
}
