//! Artifact Hub (`artifacthub.io/packages/<kind>/<repo>/<name>`): package
//! metadata for Helm charts, OLM operators, Falco rules and the rest, from the
//! Artifact Hub API in one request.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, str_of, strs_of, u64_of,
	unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "artifacthub", open };

const METHOD: &str = "artifacthub";
/// Versions listed.
const RECENT_VERSIONS: usize = 5;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "artifacthub.io" | "www.artifacthub.io") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "packages" {
		return None;
	}
	let kind = segments.next().filter(|part| !part.is_empty())?.to_owned();
	let repo = segments.next().filter(|part| !part.is_empty())?.to_owned();
	let name = segments.next().filter(|part| !part.is_empty())?.to_owned();
	fetch(
		Fetch::get(format!("https://artifacthub.io/api/v1/packages/{kind}/{repo}/{name}"))
			.accept_json(),
		move |reply, _| {
			let package = reply.json_value()?;
			let repository = package.get("repository")?;
			let kind_label = kind_label(&kind);
			let display_name = str_of(&package, "display_name")
				.or_else(|| str_of(&package, "name"))
				.unwrap_or("Package");
			let markdown = summary(&package, repository, &kind_label);
			Done::new(markdown, METHOD)
				.title(display_name)
				.note(format!("Fetched via Artifact Hub API ({kind_label})"))
				.finish()
		},
	)
}

fn summary(package: &Value, repository: &Value, kind_label: &str) -> String {
	let name = str_of(package, "display_name")
		.or_else(|| str_of(package, "name"))
		.unwrap_or("Package");
	let mut md = format!("# {name}\n\n");
	if let Some(description) = str_of(package, "description") {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = write!(
		md,
		"**Type:** {kind_label} · **Version:** {}",
		str_of(package, "version").unwrap_or_default()
	);
	if let Some(app_version) = str_of(package, "app_version") {
		let _ = write!(md, " · **App Version:** {app_version}");
	}
	if let Some(license) = str_of(package, "license") {
		let _ = write!(md, " · **License:** {license}");
	}
	md.push('\n');

	let mut badges: Vec<String> = Vec::new();
	if package
		.get("official")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		badges.push("Official".to_owned());
	}
	if package
		.get("signed")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		badges.push("Signed".to_owned());
	}
	if let Some(stars) = u64_of(package, "stars").filter(|stars| *stars > 0) {
		badges.push(format!("{} stars", format_number(stars as f64)));
	}
	if !badges.is_empty() {
		let _ = writeln!(md, "**{}**", badges.join(" · "));
	}
	md.push('\n');

	let repo_name = str_of(repository, "organization_display_name")
		.or_else(|| str_of(repository, "display_name"))
		.or_else(|| str_of(repository, "name"))
		.unwrap_or_default();
	let _ = write!(md, "**Repository:** {repo_name}");
	if let Some(repo_url) = str_of(repository, "url") {
		let _ = write!(md, " ([{repo_url}]({repo_url}))");
	}
	md.push('\n');

	if let Some(home_url) = str_of(package, "home_url") {
		let _ = writeln!(md, "**Homepage:** {home_url}");
	}
	let keywords = strs_of(package, "keywords");
	if !keywords.is_empty() {
		let _ = writeln!(md, "**Keywords:** {}", keywords.join(", "));
	}

	let maintainers = arr_of(package, "maintainers")
		.iter()
		.filter_map(|m| str_of(m, "name"))
		.collect::<Vec<_>>();
	if !maintainers.is_empty() {
		let _ = writeln!(md, "**Maintainers:** {}", maintainers.join(", "));
	}

	if let Some(report) = package.get("security_report_summary") {
		let parts = ["critical", "high", "medium", "low"]
			.iter()
			.filter_map(|level| Some(format!("{} {level}", u64_of(report, level).filter(|n| *n > 0)?)))
			.collect::<Vec<_>>();
		if !parts.is_empty() {
			let _ = writeln!(md, "**Security:** {}", parts.join(", "));
		}
	}

	let links = arr_of(package, "links");
	if !links.is_empty() {
		md.push_str("\n## Links\n\n");
		for link in links {
			let _ = writeln!(
				md,
				"- [{}]({})",
				str_of(link, "name").unwrap_or_default(),
				str_of(link, "url").unwrap_or_default()
			);
		}
	}

	if let Some(install) = str_of(package, "install") {
		let _ = write!(md, "\n## Installation\n\n```bash\n{}\n```\n", install.trim());
	}

	let versions = arr_of(package, "available_versions");
	if !versions.is_empty() {
		md.push_str("\n## Recent Versions\n\n");
		for version in versions.iter().take(RECENT_VERSIONS) {
			let date = u64_of(version, "ts").map_or_else(String::new, |ts| unix_date(ts as i64));
			let _ = writeln!(md, "- **{}** ({date})", str_of(version, "version").unwrap_or("?"));
		}
	}

	if let Some(readme) = str_of(package, "readme") {
		let _ = write!(md, "\n---\n\n## README\n\n{readme}\n");
	}
	md
}

/// Human label for a package kind slug.
fn kind_label(kind: &str) -> String {
	let known = match kind {
		"helm" => Some("Helm Chart"),
		"helm-plugin" => Some("Helm Plugin"),
		"falco" => Some("Falco Rules"),
		"opa" => Some("OPA Policy"),
		"olm" => Some("OLM Operator"),
		"tbaction" => Some("Tinkerbell Action"),
		"krew" => Some("Krew Plugin"),
		"tekton" => Some("Tekton Task"),
		"tekton-pipeline" => Some("Tekton Pipeline"),
		"keda" => Some("KEDA Scaler"),
		"coredns" => Some("CoreDNS Plugin"),
		"keptn" => Some("Keptn Integration"),
		"container" => Some("Container Image"),
		"kubewarden" => Some("Kubewarden Policy"),
		"gatekeeper" => Some("Gatekeeper Policy"),
		"kyverno" => Some("Kyverno Policy"),
		"knative-client" => Some("Knative Client Plugin"),
		"backstage" => Some("Backstage Plugin"),
		"argo" => Some("Argo Template"),
		"kubearmor" => Some("KubeArmor Policy"),
		"kcl" => Some("KCL Module"),
		"headlamp" => Some("Headlamp Plugin"),
		"inspektor" => Some("Inspektor Gadget"),
		"meshery-design" => Some("Meshery Design"),
		"opencost-plugin" => Some("OpenCost Plugin"),
		"radius" => Some("Radius Recipe"),
		_ => None,
	};
	known.map_or_else(
		|| {
			let mut chars = kind.chars();
			chars.next().map_or_else(String::new, |first| {
				first.to_uppercase().collect::<String>() + chars.as_str()
			})
		},
		str::to_owned,
	)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"name": "nginx", "display_name": "NGINX", "description": "NGINX Open Source Helm chart",
			"version": "15.1.1", "app_version": "1.25.3", "license": "Apache-2.0",
			"home_url": "https://nginx.org", "readme": "# NGINX\n\nA high performance web server.",
			"install": "helm install my-nginx bitnami/nginx", "keywords": ["nginx", "web"],
			"maintainers": [{ "name": "Bitnami" }],
			"links": [{ "name": "Source", "url": "https://github.com/bitnami/charts" }],
			"repository": { "name": "bitnami", "display_name": "Bitnami", "url": "https://charts.bitnami.com" },
			"ts": 1_700_000_000, "official": true, "signed": true, "stars": 42,
			"security_report_summary": { "critical": 1, "high": 0, "medium": 3 },
			"available_versions": [
				{ "version": "15.1.1", "ts": 1_700_000_000 },
				{ "version": "15.1.0", "ts": 1_699_000_000 }
			]
		})
	}

	#[test]
	fn a_package_page_renders_the_api_response() {
		let mut requests = Vec::new();
		let done = run("https://artifacthub.io/packages/helm/bitnami/nginx", |request| {
			requests.push(request.url.clone());
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(requests, ["https://artifacthub.io/api/v1/packages/helm/bitnami/nginx"]);
		assert_eq!((done.method, done.title.as_deref()), ("artifacthub", Some("NGINX")));
		assert_eq!(done.notes, ["Fetched via Artifact Hub API (Helm Chart)"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# NGINX\n\nNGINX Open Source Helm chart\n\n**Type:** Helm Chart · **Version:** 15.1.1 · \
			 **App Version:** 1.25.3 · **License:** Apache-2.0\n"
		));
		assert!(md.contains("**Official · Signed · 42 stars**\n"));
		assert!(md.contains("**Repository:** Bitnami ([https://charts.bitnami.com](https://charts.bitnami.com))\n**Homepage:** https://nginx.org\n**Keywords:** nginx, web\n**Maintainers:** Bitnami\n**Security:** 1 critical, 3 medium\n"));
		assert!(md.contains("## Links\n\n- [Source](https://github.com/bitnami/charts)\n"));
		assert!(
			md.contains("## Installation\n\n```bash\nhelm install my-nginx bitnami/nginx\n```\n")
		);
		assert!(
			md.contains(
				"## Recent Versions\n\n- **15.1.1** (2023-11-14)\n- **15.1.0** (2023-11-03)\n"
			)
		);
		assert!(md.contains("---\n\n## README\n\n# NGINX\n\nA high performance web server.\n"));
	}

	#[test]
	fn an_unknown_kind_is_title_cased() {
		let done =
			run("https://www.artifacthub.io/packages/widget/acme/gizmo", |_| Fetched::json(&api()))
				.unwrap();
		assert!(done.markdown.contains("**Type:** Widget ·"));
		assert_eq!(done.notes, ["Fetched via Artifact Hub API (Widget)"]);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://artifacthub.io/packages/search", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://example.test/packages/helm/bitnami/nginx", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://artifacthub.io/packages/helm/bitnami/nginx", |_| Fetched::status(500)),
			None
		);
	}
}
