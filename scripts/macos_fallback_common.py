"""Shared, bounded GitHub protocol for native macOS verification candidates."""

import base64
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request


class VerificationError(Exception):
    """A request or observation cannot establish the verification contract."""


class APIError(VerificationError):
    """An API request failed without exposing credentials or response bodies."""

    def __init__(self, status=None, retry_after=None, rate_limited=False):
        self.status = status
        self.transient = rate_limited or status is None or status == 429 or status >= 500
        self.retry_after = retry_after
        super().__init__(f"GitHub API unavailable (HTTP {status or 'network'})")


SHA = re.compile(r"[0-9a-f]{40}\Z")
PACKAGE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,127}\Z")
GATES = {"rust": "Rust workspace and acceptance proofs", "lint_macos": "Lint workspace (macOS)"}
FIELDS = {
    "version", "repository", "repository_id", "parent_run_id", "parent_attempt",
    "parent_job_id", "parent_job", "objective", "event", "source_sha", "tree_sha",
    "pr_number", "head_sha", "base_sha", "worker_sha", "nonce", "generation",
    "pool", "hosted_run_id", "coverage", "packages", "doc_packages", "actor",
    "triggering_actor",
}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("duplicate JSON key")
        result[key] = value
    return result


def parse_json(raw):
    """Parse a bounded JSON object, refusing duplicate keys and nonfinite numbers."""
    if len(raw) > 16384:
        raise VerificationError("JSON exceeds verification budget")
    try:
        value = json.loads(raw, object_pairs_hook=_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, UnicodeError) as error:
        raise VerificationError("invalid verification JSON") from error
    if not isinstance(value, dict):
        raise VerificationError("verification JSON must be an object")
    return value


def validate_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise VerificationError("invalid immutable commit/tree identity")
    return value


def validate_request(request):
    """Validate the exact version-one envelope before any execution or cancellation."""
    if not isinstance(request, dict) or set(request) != FIELDS or request["version"] != 1:
        raise VerificationError("unsupported request schema")
    if type(request["version"]) is not int:
        raise VerificationError("invalid schema version")
    if not isinstance(request["repository"], str) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", request["repository"]
    ) or ".." in request["repository"]:
        raise VerificationError("invalid repository")
    for field in ("repository_id", "parent_run_id", "parent_attempt", "parent_job_id"):
        if type(request[field]) is not int or request[field] <= 0:
            raise VerificationError("invalid parent identity")
    for field in ("pr_number", "hosted_run_id"):
        if type(request[field]) is not int or request[field] < 0:
            raise VerificationError("invalid source/candidate identity")
    objective = request["objective"]
    if not isinstance(objective, str) or objective not in GATES or request["parent_job"] != objective:
        raise VerificationError("invalid verification objective")
    for field in ("source_sha", "tree_sha", "worker_sha"):
        validate_sha(request[field])
    if request["event"] == "pull_request":
        if not request["pr_number"]:
            raise VerificationError("missing pull request")
        validate_sha(request["head_sha"])
        validate_sha(request["base_sha"])
    elif request["event"] in ("push", "merge_group"):
        if request["pr_number"] or request["head_sha"] not in ("", request["source_sha"]):
            raise VerificationError("invalid non-PR source")
        if request["base_sha"]:
            validate_sha(request["base_sha"])
    else:
        raise VerificationError("event is not eligible for dispatch")
    if not isinstance(request["nonce"], str) or not re.fullmatch(r"[0-9a-f]{32}", request["nonce"]):
        raise VerificationError("invalid nonce")
    if type(request["generation"]) is not int:
        raise VerificationError("invalid candidate generation")
    if request["pool"] == "hosted":
        if request["generation"] != 0 or request["hosted_run_id"] != 0:
            raise VerificationError("invalid hosted generation")
    elif request["pool"] == "self-hosted":
        # Self-hosted can be a direct dispatch (generation 0, no hosted run)
        # when hosted runners are unavailable, or a fallback (generation 1)
        # after a hosted run fails.
        if request["generation"] == 0:
            if request["hosted_run_id"] != 0:
                raise VerificationError("invalid self-hosted direct dispatch")
        elif request["generation"] == 1:
            if request["hosted_run_id"] <= 0:
                raise VerificationError("invalid fallback generation")
        else:
            raise VerificationError("invalid self-hosted generation")
    else:
        raise VerificationError("invalid runner pool")
    if request["coverage"] not in ("full", "subset", "none"):
        raise VerificationError("invalid coverage")
    for field in ("packages", "doc_packages"):
        values = request[field]
        if not isinstance(values, list) or len(values) > 256:
            raise VerificationError("invalid package selection")
        if any(not isinstance(v, str) or not PACKAGE.fullmatch(v) for v in values):
            raise VerificationError("invalid package name")
        if len(set(values)) != len(values):
            raise VerificationError("duplicate package selection")
    if request["coverage"] != "subset" and (request["packages"] or request["doc_packages"]):
        raise VerificationError("packages require subset coverage")
    for field in ("actor", "triggering_actor"):
        if not isinstance(request[field], str) or not re.fullmatch(r"[A-Za-z0-9_\[\]-]{1,100}", request[field]):
            raise VerificationError("invalid actor")
    return request


def request_digest(request):
    validate_request(request)
    return hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def candidate_name(request):
    return (f"macos:{request['parent_run_id']}:{request['parent_attempt']}:"
            f"{request['objective']}:{request['nonce']}:{request['generation']}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    """Minimal REST client; never forwards the job token to artifact storage."""

    def __init__(self, token=None):
        self.token = token or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if not self.token:
            raise VerificationError("missing GitHub job token")
        self.opener = urllib.request.build_opener(_NoRedirect())

    def _request(self, path, method="GET", body=None, binary=False):
        if path.startswith(("/", "http:" , "https:")) or ".." in path or "\\" in path:
            raise VerificationError("invalid API path")
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "omp-macos-verification"}
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("https://api.github.com/" + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=25) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            if binary and error.code in (301, 302, 303, 307, 308):
                url = error.headers.get("Location", "")
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme != "https" or parsed.username or parsed.password or not parsed.hostname:
                    raise VerificationError("invalid artifact redirect") from error
                # A fresh request deliberately has no Authorization header.
                try:
                    with self.opener.open(urllib.request.Request(url), timeout=25) as response:
                        raw = response.read(8 * 1024 * 1024 + 1)
                except (urllib.error.URLError, OSError) as nested:
                    raise APIError(getattr(nested, "code", None)) from nested
            else:
                retry_after = None
                try:
                    if error.headers.get("Retry-After"):
                        retry_after = max(0, int(error.headers["Retry-After"]))
                    elif error.headers.get("X-RateLimit-Remaining") == "0":
                        retry_after = max(0, int(error.headers["X-RateLimit-Reset"]) - int(time.time()))
                except (ValueError, KeyError, TypeError):
                    pass
                raise APIError(error.code, retry_after,
                               error.headers.get("X-RateLimit-Remaining") == "0") from error
        except (urllib.error.URLError, OSError) as error:
            raise APIError() from error
        if len(raw) > 8 * 1024 * 1024:
            raise VerificationError("API response exceeds budget")
        if binary:
            return raw
        if not raw:
            return None
        try:
            return json.loads(raw, object_pairs_hook=_object)
        except (ValueError, UnicodeError) as error:
            raise VerificationError("malformed GitHub API response") from error

    def get(self, path):
        for attempt in range(3):
            try:
                return self._request(path)
            except APIError as error:
                delay = error.retry_after if error.retry_after is not None else 2**attempt
                if not error.transient or attempt == 2 or delay > 60:
                    raise
                time.sleep(delay)

    def post(self, path, body=None):
        return self._request(path, "POST", body)

    def get_bytes(self, path):
        return self._request(path, binary=True)

    def paginate(self, path, key):
        result = []
        separator = "&" if "?" in path else "?"
        for page in range(1, 101):
            response = self.get(f"{path}{separator}per_page=100&page={page}")
            values = response.get(key) if isinstance(response, dict) else None
            if not isinstance(values, list):
                raise VerificationError("invalid paginated API response")
            result.extend(values)
            if len(values) < 100:
                return result
        raise VerificationError("API history exceeds bounded scan")


def resolve_worker_ref(api, repository, ref):
    if not isinstance(ref, str) or not re.fullmatch(r"ci-macos-worker-[A-Za-z0-9_.-]+", ref):
        raise VerificationError("worker ref must be a reviewed version tag")
    item = api.get(f"repos/{repository}/git/ref/tags/{ref}")["object"]
    for _ in range(4):
        if item.get("type") == "commit":
            return validate_sha(item.get("sha"))
        if item.get("type") != "tag":
            break
        item = api.get(f"repos/{repository}/git/tags/{validate_sha(item.get('sha'))}")["object"]
    raise VerificationError("invalid worker release tag")


def verify_parent_liveness(api, request, require_running=True):
    """Lightweight lease check; full source fences run at admission/publication."""
    prefix = f"repos/{request['repository']}"
    run = api.get(f"{prefix}/actions/runs/{request['parent_run_id']}")
    job = api.get(f"{prefix}/actions/jobs/{request['parent_job_id']}")
    if (run.get("run_attempt") != request["parent_attempt"]
            or job.get("run_id") != request["parent_run_id"]
            or job.get("run_attempt") != request["parent_attempt"]
            or job.get("name") != GATES[request["objective"]]):
        raise VerificationError("parent generation/job changed")
    if require_running and (run.get("status") != "in_progress" or job.get("status") != "in_progress"):
        raise VerificationError("parent admission revoked")
    return run


def verify_source_current(api, request):
    """Renew source admission without refetching immutable metadata each poll."""
    prefix = f"repos/{request['repository']}"
    if request["event"] == "pull_request":
        pull = api.get(f"{prefix}/pulls/{request['pr_number']}")
        if (pull.get("state") != "open" or pull.get("head", {}).get("sha") != request["head_sha"]
                or pull.get("head", {}).get("repo", {}).get("full_name") != request["repository"]
                or pull.get("base", {}).get("sha") != request["base_sha"]
                or pull.get("base", {}).get("ref") != "omp2"
                or pull.get("merge_commit_sha") != request["source_sha"]):
            raise VerificationError("pull request source superseded")
    else:
        branch = "omp2"
        if request["event"] == "merge_group":
            key = (request["parent_run_id"], request["parent_attempt"])
            cache = getattr(api, "_macos_parent_branches", {})
            branch = cache.get(key)
            if branch is None:
                branch = api.get(f"{prefix}/actions/runs/{request['parent_run_id']}").get("head_branch", "")
                if not branch.startswith("gh-readonly-queue/omp2/"):
                    raise VerificationError("merge group is not eligible")
                cache[key] = branch
                api._macos_parent_branches = cache
        reference = api.get(f"{prefix}/git/ref/heads/{urllib.parse.quote(branch, safe='/')}")
        if reference.get("object", {}).get("sha") != request["source_sha"]:
            raise VerificationError("event source superseded")


def verify_parent(api, request, require_running=True):
    """Independently bind candidate inputs to the current parent and source."""
    validate_request(request)
    prefix = f"repos/{request['repository']}"
    run = verify_parent_liveness(api, request, require_running)
    if (run.get("repository", {}).get("id") != request["repository_id"]
            or run.get("repository", {}).get("full_name") != request["repository"]
            or run.get("event") != request["event"]
            or run.get("path", "").split("@")[0] != ".github/workflows/ci.yml"
            or run.get("head_repository", {}).get("full_name") != request["repository"]
            or run.get("actor", {}).get("login") != request["actor"]
            or run.get("triggering_actor", {}).get("login") != request["triggering_actor"]):
        raise VerificationError("parent provenance mismatch")
    commit = api.get(f"{prefix}/git/commits/{request['source_sha']}")
    if commit.get("tree", {}).get("sha") != request["tree_sha"]:
        raise VerificationError("source tree mismatch")
    if request["event"] == "pull_request":
        pull = api.get(f"{prefix}/pulls/{request['pr_number']}")
        if (pull.get("state") != "open" or pull.get("head", {}).get("sha") != request["head_sha"]
                or pull.get("head", {}).get("repo", {}).get("full_name") != request["repository"]
                or pull.get("base", {}).get("sha") != request["base_sha"]
                or pull.get("base", {}).get("ref") != "omp2"
                or pull.get("merge_commit_sha") != request["source_sha"]
                or run.get("head_sha") != request["head_sha"]
                or [p.get("sha") for p in commit.get("parents", [])] != [request["base_sha"], request["head_sha"]]):
            raise VerificationError("pull request source is stale or mismatched")
    else:
        branch = run.get("head_branch", "")
        if request["event"] == "push" and branch != "omp2":
            raise VerificationError("push is not eligible")
        if request["event"] == "merge_group" and not branch.startswith("gh-readonly-queue/omp2/"):
            raise VerificationError("merge group is not eligible")
        if run.get("head_sha") != request["source_sha"]:
            raise VerificationError("event source mismatch")
        reference = api.get(f"{prefix}/git/ref/heads/{urllib.parse.quote(branch, safe='/')}")
        if reference.get("object", {}).get("sha") != request["source_sha"]:
            raise VerificationError("event source superseded")
    if request["pool"] == "self-hosted":
        verify_mac_configuration(api, request)


def verify_mac_configuration(api, request, relaxed=False):
    """Prove Mac policy before cancellation, without requiring cancellation yet.

    When *relaxed* is True, the parent liveness check is skipped — used when
    falling back after a hosted runner failure where the parent CI run may have
    already completed.
    """
    validate_request(request)
    if (request["repository"] != "blyzer/oh-my-pi"
            or request["actor"] != "blyzer" or request["triggering_actor"] != "blyzer"
            or os.environ.get("CI_MACOS_FALLBACK_ENABLED") != "true"
            or os.environ.get("CI_MACOS_FALLBACK_TRUST") != "repository-writers"):
        raise VerificationError("self-hosted trust not explicitly enabled")
    expected = os.environ.get("CI_MACOS_PARENT_WORKFLOW_SHA256", "")
    if os.environ.get("CI_MACOS_CONTROL_POLICY") == "source-bound":
        # Repository writers already authorize executing candidate code on the
        # Mac. Bind that authority to live GitHub observations, not a frozen
        # ci.yml hash that prevents verification of CI changes themselves.
        if not relaxed:
            run = verify_parent_liveness(api, request)
        else:
            # In relaxed mode, just check the parent exists and was authorized,
            # without requiring it to still be running.
            prefix = f"repos/{request['repository']}"
            run = api.get(f"{prefix}/actions/runs/{request['parent_run_id']}")
        if (run.get("actor", {}).get("login") != "blyzer"
                or run.get("triggering_actor", {}).get("login") != "blyzer"
                or run.get("head_repository", {}).get("full_name") != request["repository"]):
            raise VerificationError("source-bound parent is not owner-authorized")
        verify_source_current(api, request)
        return
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise VerificationError("missing reviewed parent workflow digest")
    prefix = f"repos/{request['repository']}"
    content = api.get(f"{prefix}/contents/.github/workflows/ci.yml?ref={request['source_sha']}")
    try:
        code = base64.b64decode("".join(content["content"].split()), validate=True)
    except (KeyError, ValueError, TypeError) as error:
        raise VerificationError("invalid parent workflow blob") from error
    if len(code) > 256 * 1024 or hashlib.sha256(code).hexdigest() != expected:
        raise VerificationError("parent workflow is not the reviewed release")
