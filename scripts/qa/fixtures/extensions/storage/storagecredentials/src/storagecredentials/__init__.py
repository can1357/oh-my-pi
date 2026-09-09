import json
import omp
from omp import creds, secrets

@omp.tool(kind="hard")
async def hello() -> str:
    checks = {}
    obfuscate = secrets.SecretRule("qa-secret-7391", secrets.SecretKind.LITERAL, secrets.SecretMode.OBFUSCATE, "QA")
    redact = secrets.SecretRule("qa-redact-7391", secrets.SecretKind.LITERAL, secrets.SecretMode.REDACT, "", "<redacted>")
    try:
        secrets.declare(obfuscate)
        secrets.declare(redact)
        masked = secrets.mask("before qa-secret-7391 after")
        redacted = secrets.mask("before qa-redact-7391 after")
        checks["secret_obfuscation"] = "qa-secret-7391" not in masked and secrets.is_masked(masked)
        checks["secret_redaction"] = "qa-redact-7391" not in redacted and "<redacted>" in redacted
    except Exception as error:
        checks["secret_declare_unavailable"] = type(error).__name__ == "NotWiredError" and bool(str(error))
        try:
            secrets.mask("qa-secret-7391")
        except Exception as mask_error:
            checks["secret_mask_unavailable"] = type(mask_error).__name__ == "NotWiredError" and bool(str(mask_error))
    checks["secret_token"] = secrets.is_masked("before $$QA_ABCDEFGHIJKL$$ after")
    checks["secret_plain"] = not secrets.is_masked("ordinary text")

    secret = creds.Secret(b"token")
    credential = creds.Credential(creds.CredentialKind.API_KEY, secret, identity="qa")
    metadata = creds.CredentialMeta(1, "qa-provider", "qa", creds.CredentialKind.API_KEY)
    token = creds.ScopedToken("scoped", 123)
    usage_report = creds.UsageReport(())
    checks["credential_records"] = (
        credential.kind is creds.CredentialKind.API_KEY and metadata.id == 1 and
        token.expires_at_ms == 123 and usage_report.windows == () and creds.UsageScope.ALL.value == "all"
    )

    outcomes = {}
    async def settle(name, awaitable):
        try:
            value = await awaitable
            outcomes[name] = {"status": "ok", "type": type(value).__name__}
        except Exception as error:
            outcomes[name] = {"status": "error", "type": type(error).__name__, "message": str(error)}

    await settle("list", creds.list(provider="undeclared"))
    await settle("store", creds.store(credential, provider="undeclared"))
    await settle("refresh", creds.refresh(provider="undeclared"))
    await settle("clear", creds.clear(provider="undeclared"))
    await settle("disable", creds.disable(1, "qa"))
    await settle("enable", creds.enable(1))
    await settle("report_block", creds.report_block(until_ms=123, provider="undeclared"))
    await settle("usage", creds.usage(scope=creds.UsageScope.ALL, provider="undeclared"))
    await settle("mint_scoped", creds.mint_scoped("qa", provider="undeclared"))
    await settle("import_oauth", creds.import_oauth(refresh_token=secret, provider="undeclared"))
    await settle("reveal", creds.reveal(provider="undeclared"))
    checks["credential_calls_settle"] = set(outcomes) == {
        "list", "store", "refresh", "clear", "disable", "enable", "report_block", "usage", "mint_scoped", "import_oauth", "reveal"
    }
    checks["credential_precondition"] = all(
        row["status"] == "error" and row["type"] not in {"AssertionError", "TypeError"}
        for row in outcomes.values()
    )
    checks["credential_errors_typed"] = all(row["message"] for row in outcomes.values())
    return json.dumps({"checks": checks, "outcomes": outcomes}, sort_keys=True)
