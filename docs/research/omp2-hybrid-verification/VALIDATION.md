# Research validation record

Date: 2026-11-14. Primary source baseline:
`9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`.

| Check | Executed result | Scope / limitation |
|---|---|---|
| Initial `git status --short --branch`, `git rev-parse HEAD`, `git remote -v` | Clean `omp2...origin/omp2`; baseline and origin matched chapter 01 | Initial `/workspace` was empty; clone acquired with network-enabled execution |
| Source audit | Traced actual Rust, Forge Python, upstream TypeScript PR head/base | Detailed source ranges in chapters 01–08; not native runtime certification |
| Pinned hyperlink target validation | 53 source file/range links checked against local pinned OMP2/Forge trees, no missing files or out-of-bounds ranges | Link-target check, not proof each sentence follows from its citation; prose source-index citations additionally reviewed manually |
| Relative Markdown link validation | 15 inline relative links outside code fences checked, all present | README and chapter links; reference-style source-root URLs separately inspected |
| Architecture review | Corrected struct anchors, self-referential digest ambiguity and cross-revision receipt applicability | Source-informed review; no production code exists to typecheck |
| `python3 .../experiments/evidence_keys.py` | Exit 0, 12/12 expected outcomes, repeated once with same outcomes | Canonical synthetic key model only; raw first run committed, second output kept outside repository |
| Python `ast.parse` of research script | PASS | Syntax validation without generating bytecode artifacts |
| Actual Forge source-hash reproduction | Exit 0; differing literal values, identical normalized diff hash | Exact snippet/input/hash in chapter 02; does not demonstrate whole-gate bypass |
| `just check-pkg omp-exec` | BLOCKED, exit 127, `just: command not found` | `cargo`, `rustc`, `bun` also unavailable; no native test pass claimed |
| Forge targeted `python -m pytest ...` | BLOCKED, exit 1, `No module named pytest` | Exact command in chapter 02; no suite pass claimed |
| `git diff --check` and staged equivalent | PASS | Whitespace validation; untracked artifacts staged before final scope review |
| Changed-path and staged-diff review | Only `docs/research/omp2-hybrid-verification/` artifacts | No production source, dependency, lockfile or unrelated change |

No live model, reranker, Mac memory/latency, paid API or four-arm effectiveness
benchmark was run. Procedures and blockers are provided rather than invented
measurements. Git push/PR publication are recorded by Git/GitHub, not treated as
evidence that the future verifier works.

## Publication blocker

Research branch: `research/omp2-native-hybrid-verification`, based directly on
the pinned `omp2` commit. Local research commit before this blocker record:
`dcd8285fa4efa4b9bd47d7ace0a19a172b1b2547`.

Both authorized publication routes were attempted:

```text
git push -u origin research/omp2-native-hybrid-verification
exit 128: remote: Permission to blyzer/oh-my-pi.git denied to blyzer.
HTTP 403

GitHub connected-app create_branch(repository_full_name="blyzer/oh-my-pi",
  branch_name="research/omp2-native-hybrid-verification",
  sha="9cb6fd638918de77913a3e6c8fc42f9d5b3365bc")
GitHub API 403: Resource not accessible by integration
```

At the time of those attempts, the token authenticated as `blyzer` and repository
metadata reported push rights, but actual Git object/ref writes were denied.
The completed local branch, commits, export patch and PR description were preserved.

**Resolved on retry, 2026-11-14:** connected-app branch creation succeeded, then
`git push -u origin research/omp2-native-hybrid-verification` exited 0 and
published the saved commits. The GitHub plugin created
[PR #618](https://github.com/blyzer/oh-my-pi/pull/618), targeting `omp2` at the
original inspected baseline. The PR is open and unmerged. No research needed
to be repeated and no source baseline changed. The original failures above are
retained as historical evidence, not current blockers.
