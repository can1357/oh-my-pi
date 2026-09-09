//! Combined provider/MCP credential-vault operator.

use std::{
	collections::BTreeSet,
	fs::{self, OpenOptions},
	io,
	path::{Path, PathBuf},
	time::SystemTime,
};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::{
	account::{AccountRecord, AccountStateStore},
	auth::{CredentialOrigin, OAuthCredentialImport},
	call::AccountRoutingContext,
	id::{AccountId, PrincipalId},
};
use omp_catalog::{ProviderId, provider::OAuthFlowSpec, snapshot};
use omp_core::SecretString;
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::Deserialize;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use url::Url;
use zeroize::Zeroizing;

use crate::{
	auth_cli,
	cli::{AuthBrokerArgs, AuthBrokerCommand, AuthCommand},
	daemon::{DaemonConfig, DaemonHandle},
	ssh_cmd,
};

#[derive(Deserialize)]
struct CliProxyCredential {
	#[serde(rename = "type")]
	kind:          Option<String>,
	access_token:  Option<String>,
	refresh_token: Option<String>,
	expired:       Option<String>,
	email:         Option<String>,
	account_id:    Option<String>,
	#[serde(default)]
	disabled:      bool,
}

struct ImportPlan {
	source:     PathBuf,
	provider:   ProviderId,
	account:    AccountId,
	principal:  PrincipalId,
	access:     SecretString,
	refresh:    SecretString,
	expires_at: SystemTime,
	disabled:   bool,
	routes:     BTreeSet<omp_catalog::RouteId>,
}

/// Executes one combined credential-authority operation.
pub async fn run(args: AuthBrokerArgs) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	fs::create_dir_all(&data_dir).into_diagnostic()?;
	match args.command {
		AuthBrokerCommand::Serve { endpoint } => {
			let handle = DaemonHandle::start(DaemonConfig::local(endpoint).with_data_dir(data_dir))
				.await
				.into_diagnostic()?;
			handle.wait().await.into_diagnostic()
		},
		AuthBrokerCommand::Token { regenerate } => token(&data_dir, regenerate),
		AuthBrokerCommand::Login { provider, via, dry_run } => {
			if let Some(alias) = via {
				remote_login(provider.as_str(), alias.as_str(), dry_run).await
			} else {
				auth_cli::run(data_dir.join("credentials.db"), AuthCommand::Login { provider }).await
			}
		},
		AuthBrokerCommand::Logout { provider } => logout(&data_dir, provider.as_str()).await,
		AuthBrokerCommand::List => {
			auth_cli::run(data_dir.join("credentials.db"), AuthCommand::List { provider: None }).await
		},
		AuthBrokerCommand::Import { path, provider, include_disabled, dry_run } => {
			import(&data_dir, &path, provider.as_deref(), include_disabled, dry_run)
		},
		AuthBrokerCommand::Migrate { dry_run } => migrate(&data_dir, dry_run),
		AuthBrokerCommand::Status => status(&data_dir),
	}
}

pub(crate) fn token(data_dir: &Path, regenerate: bool) -> miette::Result<()> {
	let path = data_dir.join("auth-broker.token");
	if !regenerate && path.is_file() {
		let value = fs::read_to_string(&path).into_diagnostic()?;
		println!("{}", value.trim());
		return Ok(());
	}
	let mut bytes = Zeroizing::new([0_u8; 32]);
	SystemRandom::new()
		.fill(bytes.as_mut())
		.map_err(|_| miette!("system random source failed"))?;
	let value = Zeroizing::new(hex(&*bytes));
	write_owner_only(&path, value.as_bytes())?;
	println!("{}", value.as_str());
	Ok(())
}

async fn remote_login(provider: &str, alias: &str, dry_run: bool) -> miette::Result<()> {
	use tokio::io;
	let callback_port = oauth_callback_port(provider)?;
	let command = format!("omp auth-broker login {}", shell_quote(provider));
	if dry_run {
		if let Some(port) = callback_port {
			println!("native ssh {alias}: forward 127.0.0.1:{port} to 127.0.0.1:{port}; {command}");
		} else {
			println!("native ssh {alias}: interactive paste-code login; {command}");
		}
		return Ok(());
	}
	let service = ssh_cmd::service(alias, &ssh_cmd::host_paths()?)?;
	let forward = match callback_port {
		Some(port) => Some(
			service
				.local_forward(alias, port, "127.0.0.1", port)
				.await
				.into_diagnostic()?,
		),
		None => None,
	};
	let channel = service
		.open_interactive(alias, &command)
		.await
		.into_diagnostic()?;
	let mut stdin = io::stdin();
	let mut stdout = io::stdout();
	let mut stderr = io::stderr();
	let mut input = [0_u8; 8 * 1024];
	let mut input_open = true;
	let status = loop {
		tokio::select! {
			read = stdin.read(&mut input), if input_open => {
				let read = read.into_diagnostic()?;
				if read == 0 {
					channel.eof().await.into_diagnostic()?;
					input_open = false;
				} else {
					channel.write(&input[..read]).await.into_diagnostic()?;
				}
			},
			event = channel.next_event() => {
				match event.into_diagnostic()? {
					Some(omp_envd::ssh::InteractiveEvent::Stdout(bytes)) => {
						stdout.write_all(bytes.as_ref()).await.into_diagnostic()?;
						stdout.flush().await.into_diagnostic()?;
					},
					Some(omp_envd::ssh::InteractiveEvent::Stderr(bytes)) => {
						stderr.write_all(bytes.as_ref()).await.into_diagnostic()?;
						stderr.flush().await.into_diagnostic()?;
					},
					Some(omp_envd::ssh::InteractiveEvent::ExitStatus(status)) => break status,
					None => return Err(miette!("remote authentication channel closed")),
				}
			},
			error = async {
				match &forward {
					Some(forward) => forward.next_error().await,
					None => std::future::pending().await,
				}
			} => {
				return match error {
					Some(error) => Err(error).into_diagnostic(),
					None => Err(miette!("SSH local-forward listener closed")),
				};
			},
		}
	};
	if let Some(forward) = forward {
		forward.close().await.into_diagnostic()?;
	}
	if status != 0 {
		return Err(miette!("remote authentication exited with status {status}"));
	}
	println!("remote OAuth login completed");
	Ok(())
}

fn oauth_callback_port(provider: &str) -> miette::Result<Option<u16>> {
	let catalog = snapshot::Catalog::try_embedded().map_err(|error| miette!(error.to_string()))?;
	let provider = catalog
		.providers()
		.iter()
		.find(|candidate| candidate.id.as_str() == provider)
		.ok_or_else(|| miette!("unknown OAuth provider `{provider}`"))?;
	let port = provider
		.auth
		.iter()
		.filter_map(|id| catalog.auth_spec(id))
		.filter_map(|auth| auth.oauth.as_ref())
		.filter_map(|id| catalog.oauth_spec(id))
		.filter_map(|oauth| match &oauth.flow {
			OAuthFlowSpec::Pkce { redirect_uri, .. } => Some(redirect_uri.as_str()),
			OAuthFlowSpec::Custom { parameters, .. } => parameters
				.iter()
				.find(|parameter| parameter.name == "redirect_uri")
				.map(|parameter| parameter.value.as_str()),
			OAuthFlowSpec::DeviceCode { .. } | OAuthFlowSpec::Paste { .. } => None,
		})
		.find_map(|redirect| {
			Url::parse(redirect)
				.ok()
				.and_then(|url| url.port_or_known_default())
		});
	Ok(port)
}

fn shell_quote(value: &str) -> String {
	let mut quoted = String::with_capacity(value.len() + 2);
	quoted.push('\'');
	quoted.push_str(&value.replace('\'', "'\"'\"'"));
	quoted.push('\'');
	quoted
}

async fn logout(data_dir: &Path, provider: &str) -> miette::Result<()> {
	let state = AccountStateStore::open(data_dir.join("credentials.db")).into_diagnostic()?;
	let accounts = state
		.load_accounts()
		.into_diagnostic()?
		.into_iter()
		.filter(|record| record.provider.as_str() == provider)
		.map(|record| record.account)
		.collect::<Vec<_>>();
	if accounts.is_empty() {
		return Err(miette!("provider `{provider}` has no stored accounts"));
	}
	for account in accounts {
		auth_cli::run(data_dir.join("credentials.db"), AuthCommand::Logout {
			account: account.into_inner(),
		})
		.await?;
	}
	Ok(())
}

fn import(
	data_dir: &Path,
	path: &Path,
	override_provider: Option<&str>,
	include_disabled: bool,
	dry_run: bool,
) -> miette::Result<()> {
	let catalog = snapshot::Catalog::try_embedded().map_err(|error| miette!(error.to_string()))?;
	let plans = load_import_plan(path, override_provider, include_disabled, &catalog)?;
	if plans.is_empty() {
		println!("No importable credentials in {}.", path.display());
		return Ok(());
	}
	if dry_run {
		println!("Dry run — would import {} credential(s):", plans.len());
		for plan in &plans {
			println!(
				"  {}: {}{} from {}",
				plan.provider,
				plan.principal,
				if plan.disabled { " [disabled]" } else { "" },
				plan.source.display()
			);
		}
		return Ok(());
	}

	let credentials = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let state = AccountStateStore::open(data_dir.join("credentials.db")).into_diagnostic()?;
	let imported_at = SystemTime::now();
	for plan in plans {
		let metadata = credentials
			.import_oauth_bundle(OAuthCredentialImport {
				account_id: plan.account.clone(),
				principal_id: plan.principal.clone(),
				access_token: plan.access,
				refresh_token: plan.refresh,
				expires_at: plan.expires_at,
				imported_at,
				origin: CredentialOrigin::Persistent,
			})
			.into_diagnostic()?;
		state
			.upsert_account(&AccountRecord {
				account:               plan.account,
				principal:             plan.principal.clone(),
				provider:              plan.provider.clone(),
				routes:                plan.routes,
				enabled:               !plan.disabled,
				credential_generation: metadata.generation,
				routing:               AccountRoutingContext::default(),
			})
			.into_diagnostic()?;
		tracing::info!(
			provider = %plan.provider,
			source = %plan.source.display(),
			disabled = plan.disabled,
			"credential imported"
		);
		println!(
			"imported {}: {}{} from {}",
			plan.provider,
			plan.principal,
			if plan.disabled { " [disabled]" } else { "" },
			plan.source.display()
		);
	}
	Ok(())
}

fn load_import_plan(
	path: &Path,
	override_provider: Option<&str>,
	include_disabled: bool,
	catalog: &snapshot::Catalog,
) -> miette::Result<Vec<ImportPlan>> {
	let mut sources = if path.is_dir() {
		fs::read_dir(path)
			.into_diagnostic()?
			.filter_map(|entry| entry.ok().map(|entry| entry.path()))
			.filter(|entry| entry.is_file() && entry.extension().is_some_and(|ext| ext == "json"))
			.collect::<Vec<_>>()
	} else if path.is_file() {
		vec![path.to_path_buf()]
	} else {
		return Err(miette!("import source is neither a file nor directory: {}", path.display()));
	};
	sources.sort();
	let mut plans = Vec::with_capacity(sources.len());
	for source in sources {
		let input = match fs::read(&source) {
			Ok(input) => Zeroizing::new(input),
			Err(error) => {
				tracing::warn!(
					path = %source.display(),
					%error,
					"credential import skipped unreadable file"
				);
				eprintln!("skip {}: unreadable credential file: {error}", source.display());
				continue;
			},
		};
		let record: CliProxyCredential = match serde_json::from_slice(&input) {
			Ok(record) => record,
			Err(error) => {
				tracing::warn!(
					path = %source.display(),
					%error,
					"credential import skipped malformed JSON"
				);
				eprintln!("skip {}: unreadable JSON: {error}", source.display());
				continue;
			},
		};
		if record.disabled && !include_disabled {
			tracing::warn!(
				path = %source.display(),
				"credential import skipped disabled record"
			);
			eprintln!(
				"skip {}: credential marked disabled (use --include-disabled to import anyway)",
				source.display()
			);
			continue;
		}
		let Some(provider) = resolve_cli_proxy_provider(&record, &source, override_provider) else {
			tracing::warn!(
				path = %source.display(),
				"credential import skipped unresolved provider"
			);
			eprintln!(
				"skip {}: cannot determine OMP provider from type={}",
				source.display(),
				record.kind.as_deref().unwrap_or("?")
			);
			continue;
		};
		let (Some(access), Some(refresh)) = (record.access_token, record.refresh_token) else {
			tracing::warn!(
				path = %source.display(),
				"credential import skipped incomplete token pair"
			);
			eprintln!("skip {}: missing access_token or refresh_token", source.display());
			continue;
		};
		let Some(expired) = record.expired else {
			tracing::warn!(
				path = %source.display(),
				"credential import skipped missing expiration"
			);
			eprintln!("skip {}: missing expired timestamp", source.display());
			continue;
		};
		let expires_at = match expired.parse::<jiff::Timestamp>() {
			Ok(timestamp) => SystemTime::from(timestamp),
			Err(error) => {
				tracing::warn!(
					path = %source.display(),
					%error,
					"credential import skipped invalid expiration"
				);
				eprintln!("skip {}: cannot parse expired={expired}: {error}", source.display());
				continue;
			},
		};
		let identity = record
			.email
			.as_deref()
			.filter(|identity| !identity.is_empty())
			.or_else(|| {
				record
					.account_id
					.as_deref()
					.filter(|identity| !identity.is_empty())
			})
			.unwrap_or("imported");
		let principal = PrincipalId::from(identity);
		let account = AccountId::from(format!("{provider}:{principal}"));
		let routes = catalog
			.routes()
			.iter()
			.filter(|route| route.provider == provider)
			.map(|route| route.id.clone())
			.collect::<BTreeSet<_>>();
		if routes.is_empty() {
			tracing::warn!(
				path = %source.display(),
				%provider,
				"credential import skipped unknown provider"
			);
			eprintln!("skip {}: unknown credential provider `{provider}`", source.display());
			continue;
		}
		plans.push(ImportPlan {
			source,
			provider,
			account,
			principal,
			access: SecretString::from(access),
			refresh: SecretString::from(refresh),
			expires_at,
			disabled: record.disabled,
			routes,
		});
	}
	Ok(plans)
}

fn resolve_cli_proxy_provider(
	record: &CliProxyCredential,
	path: &Path,
	override_provider: Option<&str>,
) -> Option<ProviderId> {
	const MAPPINGS: [(&str, &str); 5] = [
		("claude", "anthropic"),
		("codex", "openai-codex"),
		("gemini", "google-gemini-cli"),
		("antigravity", "google-antigravity"),
		("gemini-cli", "google-gemini-cli"),
	];
	if let Some(provider) = override_provider.filter(|provider| !provider.is_empty()) {
		return Some(ProviderId::from(provider));
	}
	if let Some(kind) = record.kind.as_deref() {
		let kind = kind.trim();
		if let Some((_, provider)) = MAPPINGS
			.iter()
			.find(|(candidate, _)| candidate.eq_ignore_ascii_case(kind))
		{
			return Some(ProviderId::from(*provider));
		}
	}
	let filename = path.file_stem()?.to_str()?.to_ascii_lowercase();
	MAPPINGS.iter().find_map(|(prefix, provider)| {
		(filename == *prefix
			|| filename
				.strip_prefix(prefix)
				.is_some_and(|suffix| suffix.starts_with('-')))
		.then(|| ProviderId::from(*provider))
	})
}

fn migrate(data_dir: &Path, dry_run: bool) -> miette::Result<()> {
	let store = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let count = if dry_run {
		store.list_metadata().into_diagnostic()?.len()
	} else {
		store.rotate_keys().into_diagnostic()?
	};
	println!("{} {count} credential record(s)", if dry_run { "would migrate" } else { "migrated" });
	Ok(())
}

fn status(data_dir: &Path) -> miette::Result<()> {
	let store = omp_driver::registry::open_credential_store(data_dir.join("credentials.db"))
		.into_diagnostic()?;
	let accounts = store.list_metadata().into_diagnostic()?.len();
	let token = data_dir.join("auth-broker.token").is_file();
	println!(
		"healthy: {accounts} credential(s), bearer token {}",
		if token { "ready" } else { "not generated" }
	);
	Ok(())
}

fn hex(bytes: &[u8]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(char::from(DIGITS[usize::from(byte >> 4)]));
		output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
	}
	output
}

pub(crate) fn write_owner_only(path: &Path, bytes: &[u8]) -> miette::Result<()> {
	let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		options.mode(0o600);
	}
	let mut file = options.open(&temporary).into_diagnostic()?;
	io::Write::write_all(&mut file, bytes).into_diagnostic()?;
	file.sync_all().into_diagnostic()?;
	fs::rename(&temporary, path).into_diagnostic()?;
	Ok(())
}
