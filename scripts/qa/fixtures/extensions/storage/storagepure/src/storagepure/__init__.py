import json
import pathlib
import sys
from collections.abc import Mapping
import omp
from omp import index, mcp, packages, urls

@omp.tool(kind="hard")
async def hello() -> str:
    checks = {}

    digest = "a" * 64
    typed = (
        urls.ArtifactUrl("artifact://7"),
        urls.HistoryUrl("history://session-1"),
        urls.AgentUrl("agent://agent-1"),
    )
    parsed = tuple(urls.parse(value) for value in typed)
    checks["url_roundtrip"] = all(item.text == str(value) and item.value is value for item, value in zip(parsed, typed))
    selection = urls.parse_selector("raw:5-7")
    checks["selector"] = selection == urls.Selector(ranges=((5, 7),), raw=True)
    bare = urls.parse("src/main.py:2+3")
    checks["bare_file"] = bare.scheme is urls.Scheme.FILE and bare.resource == "src/main.py" and bare.selector.ranges == ((2, 4),)
    checks["scheme_info"] = urls.SchemeInfo(True, False, True, "files").readable and isinstance(urls.schemes(), Mapping)
    try:
        urls.parse("1bad://value")
    except urls.UrlError:
        checks["url_error"] = True
    try:
        urls.parse_selector("0")
    except urls.SelectorError:
        checks["selector_error"] = True
    try:
        await urls.read("not-installed://resource")
    except (urls.SchemeNotReadable, omp.HostDisconnected) as error:
        checks["scheme_unavailable"] = isinstance(error, (urls.SchemeNotReadable, omp.HostDisconnected))
    checks["scheme_not_readable_type"] = isinstance(urls.SchemeNotReadable("qa"), urls.UrlError)

    declaration = packages.ContentDeclaration(packages.ContentKind.SKILLS, "skills/*.md", {"title": "QA"})
    setting = packages.SettingSchema("enum", default="safe", values=("safe", "fast"))
    provenance = packages.Provenance("publisher", "qa", "1.0.0", "sha256:test", "project", "write", 1)
    tree = packages.SiteTree(pathlib.Path("/tmp/site"), "key", "project", "write", None, "lock", None)
    distribution = packages.Distribution(
        "qa-dist", "1.0.0", "qa", packages.Origin.STORE, None, digest,
        pathlib.Path("/tmp/site/qa"), (), (declaration,), (), (),
    )
    checks["package_records"] = (
        declaration.metadata["title"] == "QA" and setting.default == "safe" and
        provenance.extension_id == "qa" and tree.key == "key" and distribution.origin is packages.Origin.STORE
    )
    visible = packages.list()
    checks["package_list"] = isinstance(visible, list)
    try:
        own = packages.own()
        checks["package_own_get_of"] = packages.get(own.name) == own and packages.of(sys.modules[__name__]) == own
        checks["package_site"] = isinstance(packages.site(), packages.SiteTree)
    except packages.PackageError as error:
        checks["package_unavailable"] = type(error).__name__ in {"PackageError", "ResolutionError"}
    checks["package_errors"] = all(
        isinstance(error("qa"), packages.PackageError)
        for error in (packages.ResolutionError, packages.IntegrityError, packages.GrantError)
    )

    stdio = mcp.Stdio("python3", args=("server.py",), env={"QA": "1"})
    http = mcp.Http("https://example.test/mcp", headers={"X-QA": "1"})
    sse = mcp.Sse("https://example.test/events")
    oauth = mcp.McpAuth.oauth(scopes=("read",))
    api_key = mcp.McpAuth.api_key(name="qa-key")
    no_auth = mcp.McpAuth.none()
    mount = mcp.McpMount("qa", stdio, auth=no_auth)
    resource = mcp.McpResource("mcp://qa/resource", "resource", "text/plain")
    server = mcp.McpServer("qa", mcp.McpServerState.CONNECTED, endpoints=("read",), resources=(resource,))
    checks["mcp_records"] = (
        stdio.kind is mcp.McpTransportKind.STDIO and http.kind is mcp.McpTransportKind.HTTP and
        sse.kind is mcp.McpTransportKind.SSE and oauth.kind is mcp.McpAuthKind.OAUTH and
        api_key.kind is mcp.McpAuthKind.API_KEY and no_auth.kind is mcp.McpAuthKind.NONE and
        mount.server == server.name
    )
    try:
        await mcp.mount("not-a-mount")
    except Exception as error:
        checks["mcp_mount_precondition"] = type(error).__name__ == "SpecError"
    try:
        await mcp.unmount("Not_A_Server")
    except Exception as error:
        checks["mcp_unmount_precondition"] = type(error).__name__ == "SpecError"
    try:
        inventory = await mcp.servers()
        checks["mcp_servers"] = isinstance(inventory, tuple) and all(isinstance(item, mcp.McpServer) for item in inventory)
    except omp.HostDisconnected as error:
        checks["mcp_servers_unavailable"] = bool(str(error))

    identity = index.IdentityClaim("publisher", "qa", "fingerprint")
    attestation = index.CapabilityAttestation("cap-digest", "approved", "build", "signature")
    entry = index.CatalogEntry(identity, "qa-dist", ("1.0.0",), "QA", ("env",), attestation, None, None, 7)
    catalog_value = index.Catalog((entry,))
    simple_file = index.SimpleFile("qa.whl", "https://example.test/qa.whl", (("sha256", digest),), None, False)
    simple_value = index.SimpleProject("qa-dist", (simple_file,))
    closure_value = index.ResolvedClosure("qa", "1.0.0", "arm64", "version = 1", "signature")
    checks["index_records"] = catalog_value.get("qa") == entry and simple_value.files[0] == simple_file and closure_value.target == "arm64"

    catalog_doc = {"entries": [{
        "identity": {"publisher": "publisher", "id": "qa", "fingerprint": "fingerprint"},
        "distribution": "qa-dist", "versions": ["1.0.0"], "summary": "QA", "capabilities": ["env"],
        "attestation": {"capability_digest": "cap-digest", "outcome": "approved"}, "downloads": 7,
    }]}
    simple_doc = {"meta": {"api-version": "1.0"}, "name": "qa-dist", "files": [{
        "filename": "qa.whl", "url": "https://example.test/qa.whl", "hashes": {"sha256": digest}, "yanked": False,
    }]}
    checks["index_parse"] = (
        index.parse_catalog(catalog_doc).get("qa").downloads == 7 and
        index.parse_simple_project(simple_doc).files[0].hashes == (("sha256", digest),) and
        index.parse_closure("version = 1", extension_id="qa", version="1.0.0", target="arm64").lock == "version = 1"
    )

    async def fetcher(url, accept):
        if "catalog/" in url:
            return catalog_doc
        if "simple/" in url:
            return simple_doc
        return {"lock": "version = 1", "signature": "ok"}
    client = index.IndexClient("https://example.test", fetcher=fetcher)
    checks["index_client"] = (
        (await client.catalog()).get("qa") is not None and
        (await client.simple("qa-dist")).name == "qa-dist" and
        (await client.closure("qa", "1.0.0", "arm64")).signature == "ok"
    )
    try:
        await index.IndexClient("https://example.test").catalog()
    except index.IndexTransportError:
        checks["index_transport_error"] = True
    try:
        index.parse_catalog("[]")
    except index.IndexError:
        checks["index_error"] = True
    signed_doc = dict(catalog_doc, signature="bad")
    async def signed_fetcher(url, accept):
        return signed_doc
    try:
        await index.IndexClient("https://example.test", fetcher=signed_fetcher, verifier=lambda body, signature: False).catalog()
    except index.IndexVerificationError:
        checks["index_verification_error"] = True

    return json.dumps(checks, sort_keys=True)
