# Snap TypeScript implementation — execution plan

## 0. How to use this document

This plan is written to be executed in a **fresh session with no prior context**.
It is self-contained: every research finding, pinned string, trap, decision, and
gate needed to execute is recorded here. Read this file completely before
touching code.

Companion documents created during execution: `docs/SPEC-GAPS.md`,
`docs/DECISIONS.md`, `docs/MESSAGES.md`, `docs/TEST-DEFECTS.md`,
`docs/COVERAGE.md`, `docs/ARCHITECTURE.md`, `docs/AGENT-LOG.md`.

### 0.1 Orchestrator vs. sub-agent model

**You (the agent reading this) are the Orchestrator.** Your context window is a
scarce resource. Guard it by delegating every unit of implementation and
research work to **sub-agents**, each running in its own isolated context window.

Rules for the Orchestrator:

1. **Never implement code yourself.** Write, review, or commit only as a last
   resort when a sub-agent fails catastrophically and the fix is trivial (one
   line). Otherwise re-task a sub-agent.
2. **Launch independent sub-agents in a single parallel batch.** Any two agents
   whose inputs do not depend on each other's outputs must be launched in the
   same message so they run concurrently.
3. **Keep sub-agent prompts self-contained.** Each prompt must include: the
   task, all required context (file paths, spec line ranges, pinned strings from
   §7, interface signatures), the exact acceptance criterion, and what structured
   output to return. Do not rely on the sub-agent inheriting any state from this
   session.
4. **Sub-agents return structured results, not prose.** Define the exact return
   format in the prompt (e.g., "return a JSON object with keys `status`,
   `files_written`, `ledger_rows`, `commit_proposal`"). Reject and re-run
   any sub-agent that returns narrative only.
5. **Gate advancement is your job.** After receiving sub-agent results, run the
   gate commands yourself (or delegate to a single gate-checking sub-agent) and
   only advance to the next phase when all gate criteria pass.
6. **Record every sub-agent result in `docs/AGENT-LOG.md`** with: agent role,
   phase, launch time, status (RUNNING / DONE / FAILED), returned structured
   output summary, and any re-runs.
7. **Interfaces are frozen after Phase 0.** No sub-agent may change an exported
   signature without the Orchestrator issuing a breaking-commit proposal first.

### 0.2 Sub-agent prompt template

Every sub-agent launch must include these sections in its prompt:

```
ROLE: <role name from §11>
PHASE: <phase number and name>
CONTEXT FILES (read these before starting):
  - SPEC.md (sections: <list exact section numbers relevant to this task>)
  - docs/PLAN.md §§ <list sections relevant to this task>
  - <any frozen interface files>
TASK: <precise description>
ACCEPTANCE CRITERION: <exact gate commands that must pass, or structured
  verdict format for review agents>
DO NOT: <list of out-of-scope actions — e.g., "do not change tests/",
  "do not read implementation code", "do not alter exported signatures">
RETURN FORMAT:
  {
    "status": "DONE" | "BLOCKED" | "FAILED",
    "files_written": ["<path>", ...],
    "ledger_rows": [{ "id": "GAP-nnn", ... }],
    "commit_proposal": { "message": "...", "files": [...] },
    "objections": [{ "id": "ADV-nnn", "spec_ref": "SPEC.md:NNN", "finding": "..." }],
    "verdict": "ACCEPT" | "REJECT"
  }
```

### 0.3 Parallel launch map (summary)

The following table shows which roles can be launched in parallel within each
phase. Detailed per-phase instructions follow in §15.

| Phase | Parallel batch(es) | Sequential dependency |
| --- | --- | --- |
| 0 | Scaffold commit, then: ESLint/Prettier setup ∥ tsconfig tightening ∥ CI workflow ∥ module skeletons ∥ errors catalogue | Frozen interfaces must land before Phase 1 |
| 1 | Spec Cartographer ∥ Derivation Agent (full 28-test sweep) | Auditor runs after Cartographer; Decisions after Derivation |
| 2 | Core Builder A ∥ Core Builder B | Both wait for Phase 1 ACCEPT |
| 2 adversary | Algebra Adversary ∥ Diff Adversary | Launch immediately after builders return |
| 3 | Repo Builder C ∥ Replay Builder D | Both wait for Phase 2 ACCEPT |
| 3 adversary | Validation Adversary ∥ Convergence Adversary | Launch immediately after builders return |
| 4 | FS Builder E ∥ Commands Builder H | Both wait for Phase 3 ACCEPT |
| 4 adversary | Safety Adversary ∥ Integration Adversary | Launch immediately after builders return |
| 5 | Net Builder G ∥ CLI Builder F | Both wait for Phase 4 ACCEPT |
| 5 adversary | Protocol Adversary ∥ Grammar Adversary | Launch immediately after builders return |
| 6 | Test-Gap Hunter ∥ Property/Fuzz Agent ∥ Quality/Perf Agent | All wait for Phase 5 ACCEPT |
| 6 adversary | Harness Conformance Reviewer ∥ Fuzz Adversary ∥ Perf Adversary | Launch immediately after Phase 6 builders return |
| 7 | Reciprocal cross-module auditors (4 pairs) | All wait for Phase 6 ACCEPT; ledger spot-check is sequential last step |

## 1. Objective

Deliver a complete, high-quality TypeScript implementation of Snap that passes
the language-neutral acceptance suite, with documented spec gaps, expanded test
coverage, enforced code quality, sound algorithmic performance, and a curated
Git history.

## 2. Environment and commands

| Fact | Value |
| --- | --- |
| Project root | `/Users/paolo/Downloads/snap` |
| Implementation dir | `ts/` (entry `ts/src/main.ts`, executable `ts/snap` → tsx) |
| Node / npm | v22.20.0 / 11.6.1 (network available) |
| Git | Zero commits at plan time; everything untracked |
| Acceptance suite | `./verify --lang ts` (also `--list`, `--filter TEXT`, `--verbose`, `--keep-failed`, `--summary PATH`) |
| Harness self-check | `cd test-harness && npm run check && npm test` |
| Type-check | `cd ts && npm run build` (`tsc --noEmit`) |
| CI workflow | `.github/workflows/ci.yml` (see §14) |

Note: `AGENTS.md` references `./capstones/snap/verify`; in this checkout the
path is `./verify`.

## 3. Starting state

`ts/src/main.ts` is a two-line stub. This is a **greenfield build** of the
entire system: vector-clock versions, canonical token diff, OT, deterministic
replay with five conflict-winner rules, strict repository validation,
filesystem materialization, read-only HTTP server/client, dual plain/terminal
presentation, and ten CLI surfaces. All 28 acceptance tests currently fail.

## 4. Non-negotiable ground rules

1. **`SPEC.md` is never modified.** Gaps go in `docs/SPEC-GAPS.md`.
2. **Public behavior must be demonstrated in `tests/`** (language-neutral YAML).
   Unit tests supplement, never replace (`AGENTS.md`).
3. **The YAML harness stays implementation-neutral**: never import
   implementation code into it, never add shell setup steps, extend tagged
   unions additively so format-1 cases keep their meaning.
4. **Scope discipline**: no branches, tags, staging, checkout, push, auth,
   object storage, or unresolved-conflict machinery. Complexity goes into
   determinism, validation, and exact tests.
5. **Production code uses Node built-ins only**; tsx, TypeScript, typings,
   lint, and format tooling are devDependencies.
6. **Question everything** — see §6.
7. **Every gap produces a test** — see §10.

## 5. Decisions already made (do not relitigate)

| # | Decision |
| --- | --- |
| D1 | Tooling: ESLint + typescript-eslint (type-aware) + Prettier + `node:test`. New devDeps and a `package-lock.json` update are approved. |
| D2 | New YAML tests assert exact bytes only where SPEC fixes behavior; where SPEC is silent on wording, use loose patterns (`^snap: .+\n$`) so the suite stays language-neutral. Our exact wording is pinned in `ts/test/` instead. |
| D3 | Performance: good asymptotics plus a local benchmark gate with recorded budgets (`ts/bench/`, outside the acceptance suite). |
| D4 | Derived documents live in `docs/`. |
| D5 | Adversarial loop: 3 REJECT rounds, then the integrator arbitrates and records the ruling. |
| D6 | Test defect policy: document in `docs/TEST-DEFECTS.md` → implement to satisfy the existing test → escalate to the user. Never silently edit `tests/` or `SPEC.md`. |
| D7 | Only the integrator commits; subagents submit structured commit proposals. |
| D8 | Fine-grained bisectable commits (~60–100), Conventional Commits v1.0.0. |
| D9 | History begins with a single verbatim scaffold-import commit. |

## 6. Verification-first principle

**Nothing is taken on faith — not the tests, not the spec, not another agent's
output.**

### 6.1 Independent Derivation track

A **Derivation Agent**, forbidden from reading the implementation,
reconstructs each test's expected output from `SPEC.md` alone (integration
order from §3.4, diff scripts from §5's recurrence, transforms from §6.3's
table, winners from §6.4's ordered rules) and returns `CONFIRMED`,
`AMBIGUOUS`, or `CONTRADICTS`.

Already completed in the planning session — **all CONFIRMED**. Reproduce these
before trusting any implementation.

| Test | Derivation | Result |
| --- | --- | --- |
| 22 `dd` | order seed→bob→alice; `P=[r1,d2,r2]`, `Q=[r1,d1,r3]` → `P'=[r1,d1,r2]` | `0\n3\n4\n` ✓ |
| 22 `split` | `P=[i[A],r1,d2,r2,i[TAIL]]`, `Q=[r2,d1,i[B],r2]` → `P'=[i[A],r1,d1,r3,i[TAIL]]` | `A\n0\nB\n3\n4\nTAIL\n` ✓ |
| 22 `rd` | `P=[r5,i[A]]`, `Q=[r1,d1,r3]` → `P'=[r4,i[A]]` | `0\n2\n3\n4\nA\n` ✓ |
| 22 `survive` | Q-insert priority emits `retain 1` before P's delete | `0\nB\n2\n3\n4\n` ✓ |
| 18 | Snap order seed→c→b→a, two sequential transforms | `B\nA\nend\n` ✓ |
| 11 A/B | `bob` always integrates before `alice` (`[0,1] < [1,0]`); the warning names the **removed current** path | ✓ |
| 05 | §5 tie rule at `D(1,0)=1 <= D(0,1)=3` → `delete 1` | `[d1, r2, i["a"]]` ✓ |
| 10 | `put-wins` / `later-put-wins` / `delete-wins` / silent-identical | ✓ |

### 6.2 Traps and spec defects found (carry into `docs/SPEC-GAPS.md`)

1. **Test 03 interpolation trap.**
   `'{"contributor":{"id":"global@example.com"}}}}'` looks malformed but the
   harness collapses `}}}}` → `}}`, making it **valid JSON**. Misreading this
   inverts §8's precedence rule.
2. **Test 12:98–129 escalates SHOULD to MUST.** `body_text_equals` pins the
   exact serialized bytes although §4.1 says writers *SHOULD* use two-space
   indentation and declares the parsed value authoritative.
3. **Test 06:28 contradicts §7.6.** A 0-token→0-token file emits
   `--- /dev/null\n+++ b/empty\n@@ -1,0 +1,0 @@\n`, yet §7.6 says "No
   differences means no stdout". Correct rule: emit a block whenever
   `(existence, bytes)` differ.
4. **§5 step ordering is ambiguous.** Step 4 ("at an exhausted side") must be
   evaluated *before* steps 1–3, because `D(i+1,j)` is undefined at `i==n`.
5. **Substring adjacency traps** (verified by reading tests 15 and 23):
   - `missing a@x` must appear literally → `snap: missing patch: a@x`
     **fails**; `snap: missing a@x revision 1` passes.
   - `^snap: .+message is empty\n$` requires a non-empty prefix →
     `snap: message is empty` **fails**; `snap: patch message is empty`
     passes. Same for `changes is empty`, `insert is empty`,
     `must have one operation`, `positive safe integer`,
     `unknown field: extra`, `consumes beyond old content`.
   - Wording is fixed as `path is invalid` (not "invalid path") and
     `canonical base64` (not "invalid base64").
6. **One rule, two mandatory messages.** Test 15 requires
   `does not consume old content` (under-consumption) while test 23 requires
   `consumes beyond old content` (over-consumption). §4.4 states a single rule.

### 6.3 Anti-groupthink rules

1. An adversary that only re-runs the builder's tests is rejected; it must
   contribute **new** failing cases or a counterexample.
2. Every objection cites a `SPEC.md:line` range or a reproducible command.
   Unsupported objections are void.
3. No agent resolves a spec ambiguity alone; resolutions land in
   `docs/DECISIONS.md` with adversary sign-off.
4. **Reciprocal audit** in Phase 7: each adversary re-audits a module it did
   not build.
5. Derivation Agents never read implementation code.

## 7. Pinned-behavior inventory (contract tests, Phase 0)

Encode all of the following as executable contract tests before writing
feature code.

### 7.1 Byte-exact stderr lines

```text
snap: working tree is clean                                       (04)
snap: working tree is dirty                                       (07, 20)
snap: target tree is already current                              (07; SPEC §7.7)
snap: unsupported working tree entry: <path>                      (08, 20)
snap: not a Snap repository                                       (14)
snap: invalid command or arguments                                (14, 24, 28)
snap: invalid port: 65536                                         (14)
snap: unknown version: (a@x->2)                                   (19)
snap: contributor.id is required; configure it locally or globally (19; SPEC §8)
snap: invalid commit message                                      (25)
snap: repository has unknown field: unknown                       (23)
snap: delete of absent path: f                                    (23)
snap: SNAP_COLOR must be auto, always, or never                   (28; SPEC §7.11)
```

### 7.2 Anchored single-line regexes (tests 23, 24, 25, 26, 27)

`^snap: .*canonical.*\n$` · `^snap: .+positive safe integer\n$` ·
`^snap: unreachable patch: .+\n$` · `^snap: .+message is empty\n$` ·
`^snap: .+changes is empty\n$` · `^snap: .+unknown field: extra\n$` ·
`^snap: .+must have one operation\n$` · `^snap: .+insert is empty\n$` ·
`^snap: .+consumes beyond old content\n$` · `^snap: usage: snap diff .+\n$` ·
`^snap: duplicate JSON key .+\n$` · `^snap: invalid contributor id: .+\n$` ·
`^snap: invalid version: .+\n$` · `^snap: .+\n$`

Regexes are compiled with the `m` flag only, so `.` never matches LF: every
anchored pattern requires a single-line detail.

### 7.3 Required substrings (tests 02, 03, 13, 15, 16, 19)

`repository already exists` · `cannot initialize inside repository` ·
`invalid JSON` · `invalid contributor id` · `usage: snap diff` ·
`unknown version` · `HTTP 302` · `duplicate JSON key` · `missing a@x` ·
`path is invalid` · `canonical base64` · `does not consume old content` ·
`tree paths conflict` · `cyclic or incomplete patch history` ·
`no-op change` · `adjacent insert` · `patch collision: a@x revision 1`

### 7.4 Warning lines

`warning: auto-resolved <path>: <reason>` on **stderr**, sorted by path then
reason, containing only pairs newly present in the joined replay. Reasons:
`delete-wins`, `later-create-wins`, `later-put-wins`, `namespace-wins`,
`put-wins`.

### 7.5 Other pinned facts

1. **`--version` prints `snap 1.0.0`** exactly (28:54). `ts/package.json`
   currently says `0.1.0` — reconcile.
2. **`repository.json` bytes**: `JSON.stringify(v, null, 2) + "\n"`; key order
   `format, frontier, patches` / `author, revision, base, message, changes` /
   `type, path, edit`. Tests 09, 17, 18, 21 additionally require byte equality
   of independently merged repositories via `trees_equal`.
3. **No leftover temp file** after success *or* failure (`tree_equals`
   enumerates `.snap/` exhaustively in 01 and 26).
4. **Two CLI error families**: `snap: invalid command or arguments` for every
   command, but `snap: usage: snap diff <...>` for `diff`. Not in SPEC.
5. **Error precedence** (pinned by tests, silent in SPEC): invalid message ▸
   clean tree (25) · unsupported entry ▸ dirty tree (20) · unknown/invalid
   version ▸ missing contributor.id (14, 19) · `diff` old operand before new
   (19) · grammar before any filesystem effect (24,
   `path_not_exists: --unknown`).
6. **Version error taxonomy**: `invalid version:` = syntax;
   `unknown version:` = not materializable.
7. **Diff hunk headers** keep start line `1` with a zero count for an absent
   side: `@@ -1,0 +1,2 @@`.
8. **HTTP**: raw exact request-target match including query
   (`?query=not-exact` → 404) · exactly **one** GET per remote-consuming
   command, including `diff --repo` · redirects are an error naming the status
   · `--serve` prints exactly one line ever, on stdout, always plain, and
   exits 0 on SIGTERM and SIGINT.
9. **`snap config`** must not validate a pre-existing malformed local config
   (25 step 1), yet an invalid local `contributor.id` must error rather than
   fall back to global (25 step 3). Unknown fields are dropped on write.
10. A `text` change over a non-text authored base is rejected at
    **validation** time (27 case 7), not resolved as `put-wins`.
11. Repository JSON `frontier` must be rejected when not canonically sorted,
    with a message containing `canonical` (23).
12. Repository validation runs even when the command would print nothing
    (26 cases 3 and 4).
13. `init` creates missing parent directories recursively and detects an
    **ancestor** repository when the operand is `.` (02).
14. Expected errors exit **1**; unexpected internal failures exit **2**;
    success exits 0.

## 8. Harness capabilities and limits

Steps: `mkdir`, `remove`, `fifo`, `write_file` (`text` xor `base64`),
`copy_tree`, `symlink`, `run`, `start`, `stop`, `start_http`, `stop_http`,
`http_request`, `assert`.

Process assertions: `exit_code` (exactly one required per `run`/`stop`),
`stdout_equals|contains|matches`, `stderr_equals|contains|matches`.

HTTP assertions: `status`, `header_equals`, `body_text_equals`,
`body_base64_equals`, `body_json_equals`.

State assertions: `tree_equals` (no `ignore`, ignores file contents),
`file_text_equals`, `file_base64_equals`, `json_equals`, `path_exists`,
`path_not_exists`, `trees_equal` (compares bytes, supports `ignore`),
`http_requests_equal`.

Sandbox env is built from scratch: `PATH` (inherited),
`HOME=<sandbox>/home`, `TMPDIR=<sandbox>/tmp`, `NO_COLOR=1`, `LANG=C`,
`LC_ALL=C`, `NO_PROXY=127.0.0.1,localhost`. **No `TERM`, `USER`, `PWD`, or
`COLUMNS`.** `<sandbox>/home` and `<sandbox>/tmp` are real directories inside
the sandbox. Steps run sequentially and **fail fast**. Output is capped at
16 MiB per stream and decoded as strict UTF-8. `stdin` is written then closed.

**Cannot be expressed in YAML → must be covered in `ts/test/`:** TTY detection
(stdio is always pipes) · file permissions and EACCES · stdout↔stderr
interleaving · signals other than SIGTERM/SIGINT · nonzero-agnostic exit
assertions · binary stdin · timing, concurrency, and races · HTTPS · request
headers or bodies the candidate sends · HTTP fault injection (delay, hang,
abrupt close) · hard links, sockets, device nodes · duplicate keys in our own
output.

## 9. Architecture

```text
ts/src/
  main.ts                 entry: dispatch → exit 0/1/2, top-level error mapping
  errors.ts               SnapError + the single message catalogue
  build-info.ts           SNAP_VERSION = "1.0.0"
  cli/grammar.ts          strict positional argv → discriminated Command union
  cli/dispatch.ts         routing
  present/mode.ts         SNAP_COLOR / NO_COLOR / per-stream TTY auto
  present/sgr.ts          S(n, text)
  present/render.ts       plain ↔ terminal renderers per output family
  core/version.ts         parse/format/4-way compare/join/snapOrder
  core/contributor.ts     ASCII email-shaped ID validation
  core/path.ts            tracked-path validation, UTF-8 byte order, prefix ops
  core/tokens.ts          text detection, LF tokenization, canonicality
  core/diff.ts            §5 diff — reference DP oracle + Hirschberg fast path
  core/edit.ts            edit-script validation + application
  core/ot.ts              §6.3 transform
  core/tree.ts            immutable path→bytes map + prefix index
  repo/json.ts            duplicate-key-rejecting parser + canonical serializer
  repo/model.ts           Repository/Patch/Change typed values
  repo/validate.ts        §4.5 ordered check pipeline
  repo/replay.ts          §6.1/6.2/6.4 replay, heap ordering, warning set
  repo/store.ts           discovery walk, atomic same-dir temp replace
  repo/config.ts          §8 local-over-global resolution
  fsys/materialize.ts     install exact target path/byte map
  fsys/worktree.ts        scan, unsupported entries, status classification
  net/server.ts           --serve snapshot server
  net/client.ts           single validated GET
  commands/*.ts           one file per command
ts/test/                  unit + property + YAML-inexpressible coverage
ts/bench/                 benchmark scripts with recorded budgets
```

### Performance design

- Token interning (integer ids, not string compares).
- §5 reference `D(i,j)` walker kept permanently as a differential oracle beside
  a linear-space Hirschberg implementation preserving delete-on-tie.
- Replay via binary heap keyed `(snapOrder(result), author, revision)` with
  dependency counters — `O(P log P · k)` instead of naive `O(P³)`.
- Memoized base-tree materialization so each patch's exact base is built once.
- Tree = `Map` for point lookups plus a sorted key array giving
  `O(log n + k)` descendant queries for §6.2's namespace rule; ancestor check
  is `O(depth)`.

### Quality configuration

- **tsconfig additions**: `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
  `noImplicitReturns`, `useUnknownInCatchVariables` (on top of existing
  `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`).
- **ESLint (type-aware)**: `no-floating-promises`, `strict-boolean-expressions`,
  `switch-exhaustiveness-check`, `no-unnecessary-condition`, `no-explicit-any`,
  `consistent-type-imports`, `explicit-module-boundary-types`.

## 10. Coverage governance — "every gap gets a test"

This is a **hard gate**, not an aspiration.

### 10.1 The Coverage Ledger (`docs/COVERAGE.md`)

Every finding gets a row, appended the moment it is found.

| Field | Meaning |
| --- | --- |
| `ID` | `GAP-nnn` (spec) · `DEF-nnn` (test defect) · `ADV-nnn` (adversary finding) · `FUZZ-nnn` (property/fuzz) · `BUG-nnn` (implementation defect) · `PERF-nnn` |
| `Source` | Which agent and round found it |
| `Spec ref` | `SPEC.md:line-range`, or `NONE (silent)` |
| `Finding` | One sentence |
| `Resolution` | Behavior chosen, linked to `docs/DECISIONS.md` |
| `Locking test(s)` | **Mandatory.** `tests/NN-*.yaml:step` and/or `ts/test/*.test.ts:name` |
| `Status` | `OPEN` → `TESTED` → `CLOSED` |

### 10.2 Enforced rules

1. **No ACCEPT with an open finding.** An adversary may not issue `ACCEPT`
   while any ledger row from its work unit lacks a locking test. This is the
   primary defense against adversary findings evaporating into prose.
2. **Adversary output is structured, not narrative.** Each adversary returns
   (a) numbered objections with citations, (b) the new tests it wrote, and
   (c) ledger rows to append. A prose-only review is rejected and re-run.
3. **Test placement policy.**
   - Behavior observable through the CLI, filesystem, or HTTP →
     **`tests/*.yaml`** (per `AGENTS.md`).
   - Behavior listed in §8 as YAML-inexpressible, or internal invariants
     (algorithm equivalence, property laws, complexity) → **`ts/test/`**.
   - Chosen error wording where SPEC is silent → `ts/test/` for exact bytes,
     `tests/` with a loose pattern (D2).
4. **Every bug fix ships with the test that would have caught it**, referenced
   in the commit footer.
5. **Phase exit requires zero `OPEN` rows.**
6. **Phase 7 audits the ledger itself**: every row is checked to have a test
   that genuinely fails when the behavior is reverted (mutation spot-check).

## 11. Agent roster and adversarial protocol

**Loop**: Builder implements plus self-tests plus rationale → Adversary
independently re-reads SPEC and the relevant YAML, writes **new** failing tests
first, files numbered cited objections, appends ledger rows, and verdicts
`ACCEPT` or `REJECT` → Builder fixes → repeat. After 3 `REJECT` rounds the
integrator arbitrates and records the ruling in `docs/DECISIONS.md`.

**Definition of done per unit**: `tsc --noEmit` clean · `eslint` clean ·
`prettier --check` clean · `ts/test/` green · relevant
`./verify --lang ts --filter <n>` green · Derivation verdict `CONFIRMED` or
`AMBIGUOUS`-resolved · **zero OPEN ledger rows** · adversary `ACCEPT` ·
commit proposal submitted.

| Role | Responsibility | Adversary |
| --- | --- | --- |
| Derivation Agent | implementation-blind re-derivation of all tests | builders' failures cross-check it |
| Spec Cartographer | `SPEC-GAPS`, `DECISIONS`, `MESSAGES`, `TEST-DEFECTS`, `COVERAGE` | Spec Auditor |
| Core Builder A | version, contributor, path | Algebra Adversary |
| Core Builder B | tokens, diff, edit, OT | Diff Adversary |
| Repo Builder C | json, model, validate | Validation Adversary |
| Replay Builder D | tree, replay, warnings | Convergence Adversary |
| FS Builder E | materialize, worktree | Safety Adversary |
| CLI Builder F | grammar, dispatch, presentation | Grammar Adversary |
| Net Builder G | server, client | Protocol Adversary |
| Commands Builder H | eight commands, exit codes | Integration Adversary |
| Test-Gap Hunter | new YAML cases per SPEC section | Harness Conformance Reviewer |
| Property/Fuzz Agent | causal-graph generator, differential oracles | Fuzz Adversary |
| Quality/Perf Agent | lint config, complexity, benchmarks | Perf Adversary |

The **Orchestrator** (you) owns the frozen interfaces, arbitrates deadlocks,
runs the full-suite gate, and authors every commit. Sub-agents submit structured
commit proposals; they never commit directly.

### 11.1 Sub-agent context budgets

To minimize context waste, each sub-agent should receive only the sections it
needs. Use the following table to scope prompts:

| Role | Required reading |
| --- | --- |
| Derivation Agent | SPEC.md in full; `tests/` YAML for the 28 tests; §6.1, §6.3 |
| Spec Cartographer | SPEC.md in full; `tests/` YAML in full; §6.2, §7 in full; §10 |
| Spec Auditor | SPEC.md in full; `docs/SPEC-GAPS.md`; `docs/MESSAGES.md` |
| Core Builder A | SPEC.md §3.2–3.5; frozen interfaces from Phase 0; §7.5 rules 1,7 |
| Core Builder B | SPEC.md §5–6.3; §6.2 trap 4; §7.5 rule 8; §12 diff/OT items |
| Algebra Adversary | SPEC.md §3.2–3.5; Core Builder A output files |
| Diff Adversary | SPEC.md §5–6.3; Core Builder B output files |
| Repo Builder C | SPEC.md §4.1–4.5; §7.5 rules 2,10,11,12; frozen interfaces |
| Replay Builder D | SPEC.md §6.1–6.4; §7.4; §7.5 rules 2,5; frozen interfaces |
| FS Builder E | SPEC.md §7.1–7.3; §7.5 rules 3,13; frozen interfaces |
| Commands Builder H | SPEC.md §7–8; §7.5 rules 4–6,9,14; all YAML test files |
| Net Builder G | SPEC.md §7.9–7.10; §7.5 rule 8; §8 HTTP assertions; tests 12/13 YAML |
| CLI Builder F | SPEC.md §7.11; §7.5 rule 1; §8 "YAML-inexpressible"; test 28 YAML |
| Test-Gap Hunter | §12 in full; `tests/` YAML in full; §8 harness capabilities; D2 |
| Property/Fuzz Agent | SPEC.md §5–6.4; §12 "YAML-inexpressible" block; §9 perf design |
| Quality/Perf Agent | §9 quality config + perf design; D3; `ts/bench/` |
| Reciprocal Auditors | SPEC.md sections for the modules under audit; the module's source files |
| Ledger Spot-Check Agent | `docs/COVERAGE.md`; the locking test files; all implementation source |

## 12. Test-gap backlog (Phase 6 input, extend as found)

**Versions and IDs**: revision exactly `9007199254740991`; join overflow on
commit; 254-byte versus 255-byte contributor IDs; all four comparison outcomes
including concurrency preserved.

**Diff**: `\ No newline at end of file` on the **deleted** side; binary→text
and text→binary transitions; identical bytes with changed existence;
multi-block ordering interleaving binary lines and text blocks.

**OT**: three concurrent inserts at one cursor; partial-overlap delete/delete
with count splitting; a delete spanning a concurrent insert; trailing insert on
both sides.

**Path rules**: §6.4 rule 1 (`C == T`) for binary; rule 3 (`B` present, `C`
absent) explicitly; one patch producing several different winners across paths.

**Namespace**: three-level collision (`a` versus `a/b/c`); collision combined
with a simultaneous delete of the blocker; duplicate-warning collapse.

**Validation**: unknown field at every nesting level; non-integer `format`;
`format: 2`; `patches` unsorted by revision; forbidden control character in a
message; message exactly 4096 versus 4097 bytes; `put` of identical bytes;
adjacent retain/retain and delete/delete.

**CLI and presentation**: `SNAP_COLOR=""`; `NO_COLOR` present with
`SNAP_COLOR=always`; `--serve` with `-1`, `+8765`, `65535`, non-numeric, and
empty; `--serve` default port.

**Failure safety**: merge with an invalid remote **and** a dirty local tree
(precedence the current suite leaves open — escalate the resolution);
`diff --repo` leaving the local repository untouched.

**Config**: `$HOME` pointing at a nonexistent path; local config present but an
empty object; global valid while local absent.

**YAML-inexpressible → `ts/test/`**: `auto` TTY selection for stdout and
stderr **independently** (explicitly mandated by SPEC §11 because the harness
has no PTY) · Hirschberg↔reference diff equivalence · import-permutation
property tests (frontier, patch set, warnings, tree bytes) ·
complexity and benchmark budgets.

## 13. Commit conventions — Conventional Commits v1.0.0

Specification: <https://www.conventionalcommits.org/en/v1.0.0/>

Format:

```text
<type>[(scope)][!]: <description>

[body]

[footers]
```

- **Types**: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
  `chore`, `ci`, `style`.
- **Scopes** mirror module directories: `core`, `repo`, `fsys`, `cli`,
  `present`, `net`, `commands`, `errors`, `tests`, `harness`, `docs`, `bench`,
  `deps`.
- Description: imperative, lowercase, no trailing period.
- Body: one blank line after the description; explains **why**, cites
  `SPEC.md` line ranges, and states complexity or tradeoffs.
- Footers: one blank line after the body; git-trailer form `Token: value`,
  tokens hyphenated. Allowed: `Spec:`, `Decision:`, `Closes-Gap:`, `Defect:`,
  `Coverage:`, `Verified-By:`, `Perf:`, `Refs:`.
- **Breaking changes**: `!` before the colon **and** a
  `BREAKING CHANGE: <description>` footer. Used for any post-Phase-0 change to
  a frozen interface, so interface churn is visible in history.

Example:

```text
feat(core): transform text edits through aggregate context edits

Implements SPEC.md §6.3's six-row transform table. The `Q insert` row is
evaluated before all others so concurrent inserts at one cursor appear in
canonical integration order; deletions consume base tokens only, so
concurrently inserted text survives (SPEC.md:388-392).

Counts are split rather than requiring aligned operations, keeping the
transform O(|P| + |Q|) with no script rewriting.

Derived and confirmed against all four cases in tests/22-ot-matrix.yaml
before implementation.

Spec: SPEC.md §6.3 (376-396)
Decision: docs/DECISIONS.md#ot-insert-priority
Coverage: COVERAGE.md ADV-014, ADV-015
Verified-By: Diff Adversary (round 2, ACCEPT)
```

History rules: **linear, no merge commits, no fixup noise.** Every commit
compiles and its tests pass (`tsc --noEmit`, `eslint`, `prettier --check`,
`node:test` green) — verified by the integrator before committing, so
`git bisect` is meaningful end to end. Docs commits resolving a gap land
**before** the code that depends on them. Annotated tags at phase boundaries:
`phase-0-foundation` … `phase-7-hardening`.

**Commit 1**: `chore: import Snap capstone scaffold` — `SPEC.md`, `tests/`,
`test-harness/`, `run`, `run_tests`, `verify`, `README.md`, `AGENTS.md`,
`.agents/`, untouched `ts/`, plus `.gitignore` (`node_modules/`, `.DS_Store`).
Verbatim, so every later diff is purely our work.

**Commit 2**:
`docs(plan): record execution plan for the Snap TypeScript implementation` —
this file.

## 14. Continuous integration

Every push must **prove** on a clean machine that the acceptance suite and all
quality checks pass. CI is added in Phase 0, before feature work, so it fails
loudly from the first commit and turns green as phases complete.

### 14.1 Governing rule — no divergence between local and CI

CI runs the **identical commands** used as local gates (§11 "Definition of
done"). There are no CI-only checks and no local-only checks. Every gate
command is an npm script so both paths invoke one definition:

`ts/package.json` scripts: `build` (`tsc --noEmit`), `lint` (`eslint .`),
`lint:fix`, `format` (`prettier --write .`), `format:check`
(`prettier --check .`), `test` (`tsx --test test/**/*.test.ts`), `bench`.

### 14.2 Workflow — `.github/workflows/ci.yml`

Triggers: `push` (all branches and tags) and `pull_request`. A `concurrency`
group keyed on the ref cancels superseded runs. `fail-fast: false` so one
failing job never hides another. Node pinned to **22.x** to match the
development environment, with `actions/setup-node` npm caching keyed on both
lockfiles.

| Job | Runs | Proves |
| --- | --- | --- |
| `implementation` | in `ts/`: `npm ci`, `npm run build`, `npm run lint`, `npm run format:check`, `npm test` | Strict type-check, lint, formatting, and the unit/property suite — including the YAML-inexpressible coverage from §8 (TTY-auto selection, diff↔oracle equivalence, permutation convergence) |
| `harness` | in `test-harness/`: `npm ci`, `npm run check`, `npm test` | The harness itself still type-checks and passes its own tests after any change we make to `tests/` (required by `AGENTS.md`) |
| `acceptance` | at root: `./verify --lang ts --summary acceptance-summary.txt` | The full language-neutral suite against a freshly installed workspace |
| `commit-lint` | validates the pushed commit range against Conventional Commits v1.0.0 (§13) | History quality is enforced mechanically, not by memory |

`acceptance` uploads `acceptance-summary.txt` (and, on failure,
`--keep-failed` sandbox paths captured in the log) as a build artifact so a
failure is diagnosable without re-running locally.

### 14.3 Platform matrix

`acceptance` runs on **`ubuntu-latest` (required)** and **`macos-latest`**.
The harness's `fifo` and `symlink` operations are POSIX-only, and
`tests/26-portability-and-failure-safety.yaml` exists precisely to police
byte-level portability, so proving both platforms is in scope. `implementation`
and `harness` run on `ubuntu-latest` only, since they are platform-neutral.

### 14.4 Constraints to respect

- The workflow must not depend on network services beyond the npm registry;
  Snap itself uses no API key or external service.
- `verify`/`run_tests` install locked dependencies on first use, so CI must not
  pre-empt them in a way that diverges from a fresh clone.
- The harness binds only `127.0.0.1` on OS-selected ports; no runner network
  configuration is required.
- Harness exit codes are meaningful: `0` pass, `1` test failure, `2` harness
  error. CI must surface `2` distinctly (a harness error is not a test
  failure).

## 15. Phases and gates

> **Orchestrator**: for each phase, follow the sub-agent dispatch instructions
> exactly. Do not proceed to the next phase until the current phase gate passes.
> Run gate commands yourself after collecting all sub-agent results; do not
> delegate the gate decision.

### Phase 0 — Foundation

**Goal**: Commits 1–2 · ESLint, Prettier, npm scripts · tsconfig tightening ·
`.github/workflows/ci.yml` per §14 · module skeletons with **frozen exported
signatures** · `errors.ts` catalogue · §7's pinned behavior as executable
contract tests · `docs/COVERAGE.md` initialized.

**Step 0-A — Scaffold commit (sequential, Orchestrator)**

Author Commit 1 (`chore: import Snap capstone scaffold`) directly; it is
verbatim and requires no sub-agent.

**Step 0-B — Parallel foundation batch (launch all 5 simultaneously)**

Launch the following sub-agents in a single parallel batch:

| Sub-agent | Task | Key context |
| --- | --- | --- |
| Tooling Agent | Add ESLint (type-aware) + Prettier + npm scripts to `ts/package.json` and `ts/.eslintrc.json`/`ts/.prettierrc`; run `npm ci` to verify | §9 "Quality configuration", §14.1 npm scripts list |
| tsconfig Agent | Tighten `ts/tsconfig.json` with the exact flags listed in §9 | §9 "Quality configuration" |
| CI Agent | Write `.github/workflows/ci.yml` per §14 (all 4 jobs, matrix, artifact upload, exit-code distinction) | §14 in full |
| Skeleton Agent | Create all module skeletons under `ts/src/` with exported signatures only (no implementation bodies); initialize `docs/COVERAGE.md` | §9 architecture tree, §10.1 ledger schema |
| Errors Agent | Implement `errors.ts` (SnapError + full message catalogue) and `build-info.ts` (SNAP_VERSION = "1.0.0"); write contract tests for every §7 string | §7.1, §7.2, §7.3, §7.4, §7.5 in full |

Each sub-agent returns `{ status, files_written, commit_proposal }`. Collect all
five results before running the gate.

**Step 0-C — Contract tests sub-agent (depends on Errors Agent result)**

Once the Errors Agent returns, launch a **Contract Tests Agent**:
- Write `ts/test/contract/` tests that pin every §7 byte-exact stderr line,
  every regex, every required substring, and the §7.5 "other pinned facts".
- Return `{ status, files_written, test_names[] }`.

**Gate 0**: type, lint, and format clean; `./verify --lang ts --list` works;
suite runs and fails cleanly (28 failures, no crashes); CI workflow present
with `implementation`, `harness`, `commit-lint` green and `acceptance` failing
only on unimplemented behavior. Tag `phase-0-foundation`.

---

### Phase 1 — Spec cartography

**Goal**: `SPEC-GAPS.md`, `MESSAGES.md`, `DECISIONS.md`, `TEST-DEFECTS.md`,
`ARCHITECTURE.md`, `AGENT-LOG.md` written; full Derivation sweep of all 28
tests; all §7 strings catalogued; zero OPEN ledger rows.

**Step 1-A — Parallel cartography batch (launch both simultaneously)**

| Sub-agent | Task | Key context | Do not |
| --- | --- | --- | --- |
| Spec Cartographer | Produce `docs/SPEC-GAPS.md`, `docs/MESSAGES.md`, `docs/DECISIONS.md`, `docs/TEST-DEFECTS.md`, `docs/ARCHITECTURE.md`. Each gap must cite SPEC.md line range, state pinning test, and propose resolution. | §6.2 traps list, §7 in full, all of SPEC.md | Modify SPEC.md or `tests/` |
| Derivation Agent | Re-derive expected output for all 28 tests from SPEC.md alone (no implementation code). Return per-test verdict `CONFIRMED` / `AMBIGUOUS` / `CONTRADICTS` with derivation trace. | §6.1 derivation table, §6.3 anti-groupthink rules | Read any file under `ts/src/` |

**Step 1-B — Auditor (depends on Cartographer result)**

Launch **Spec Auditor** after receiving the Cartographer's structured output:
- Cross-check every gap in `SPEC-GAPS.md` against SPEC.md directly.
- Return `{ verdict: "ACCEPT"|"REJECT", objections: [...] }`.
- If REJECT, re-run Cartographer with objections as input. Maximum 3 rounds
  (D5), then Orchestrator arbitrates and records in `DECISIONS.md`.

**Step 1-C — Decisions synthesis (depends on both 1-A results)**

Launch **Decisions Agent** after Derivation Agent and Auditor both return:
- Finalize `DECISIONS.md` entries for every `AMBIGUOUS` derivation verdict.
- Append initial rows to `COVERAGE.md` for every gap in `SPEC-GAPS.md`.
- Return `{ files_written, ledger_rows[] }`.

**Gate 1**: Auditor `ACCEPT`; every §7 string catalogued; all 28 tests carry a
derivation verdict; zero OPEN ledger rows.

---

### Phase 2 — Pure core

**Goal**: `core/version.ts`, `core/contributor.ts`, `core/path.ts` (Builder A)
and `core/tokens.ts`, `core/diff.ts`, `core/edit.ts`, `core/ot.ts` (Builder B),
both with full tests.

**Step 2-A — Parallel build batch (launch both simultaneously)**

| Sub-agent | Task | Key context | Adversary |
| --- | --- | --- | --- |
| Core Builder A | Implement version, contributor, path modules; write unit + property tests for join laws, 4-way comparison, all four snapOrder outcomes, path validation | SPEC.md §3.2, §3.3, §3.5; frozen signatures from Phase 0 | Algebra Adversary |
| Core Builder B | Implement tokens, diff (reference DP + Hirschberg), edit validation/application, OT with Q-insert priority; write differential oracle tests | SPEC.md §5, §6.3; §6.2 traps; §12 diff/OT test-gap backlog | Diff Adversary |

**Step 2-B — Parallel adversary batch (launch both immediately after 2-A)**

| Sub-agent | Targets | Task |
| --- | --- | --- |
| Algebra Adversary | Core Builder A output | Read SPEC.md §3.2–3.5; write ≥1 new failing test first; file cited objections; return structured verdict |
| Diff Adversary | Core Builder B output | Read SPEC.md §5–6.3; write ≥1 new failing test first; file cited objections; return structured verdict |

If either adversary returns REJECT, re-run the corresponding builder with the
objections as input. Repeat up to 3 rounds. After 3 REJECTs, Orchestrator
arbitrates (D5).

**Gate 2**: property tests for join and order laws green; diff↔oracle
equivalence on repeated-line-heavy inputs green; OT base-token-consumption
invariant green; both adversaries `ACCEPT`; zero OPEN ledger rows.

---

### Phase 3 — Repository and replay

**Goal**: `repo/json.ts`, `repo/model.ts`, `repo/validate.ts` (Builder C) and
`core/tree.ts`, `repo/replay.ts` with heap and namespace rule (Builder D).

**Step 3-A — Parallel build batch (launch both simultaneously)**

| Sub-agent | Task | Key context |
| --- | --- | --- |
| Repo Builder C | Implement duplicate-key-rejecting parser, canonical serializer, ordered validation pipeline; write tests covering every §12 validation backlog item | SPEC.md §4.1–4.5, §7.1–7.5 validation strings, tests 15/23/26/27 YAML |
| Replay Builder D | Implement immutable tree + sorted key array, binary-heap replay with memoized bases, namespace rule, five winner rules, warning set | SPEC.md §6.1–6.4, §7.4 warning format, §7.5 rule 2 byte-exact serializer, tests 10/11/18/21 YAML |

**Step 3-B — Parallel adversary batch (launch both immediately after 3-A)**

| Sub-agent | Targets |
| --- | --- |
| Validation Adversary | Repo Builder C — must write new failing tests for unknown fields at every nesting level, non-integer format, format:2, unsorted patches, control chars in message, and the two message-length boundary cases |
| Convergence Adversary | Replay Builder D — must write new failing permutation test and verify all five winner rules produce the same tree regardless of integration order |

**Gate 3**: tests 15, 16, 23, 26, 27 green; permutation and association
convergence property test green; both adversaries `ACCEPT`; zero OPEN rows.

---

### Phase 4 — Filesystem and commands

**Goal**: `fsys/materialize.ts`, `fsys/worktree.ts` (Builder E) and all eight
commands (Builder H), with correct exit codes and §10 mutation ordering.

**Step 4-A — Parallel build batch (launch both simultaneously)**

| Sub-agent | Task | Key context |
| --- | --- | --- |
| FS Builder E | Implement worktree scan (unsupported entries, status classification), materialization with file↔dir transitions, atomic same-dir temp replace; no leftover temp files | SPEC.md §7.1–7.3, §9 fsys/ layout, tests 01/08/20 YAML, §7.5 rules 3 and 13 |
| Commands Builder H | Implement all eight commands (`init`, `config`, `add`, `diff`, `commit`, `log`, `merge`, `status`); wire exit codes 0/1/2; enforce error-precedence table in `DECISIONS.md` | SPEC.md §7–8, §7.5 rules 4–6, 9, 14; tests 01–11 and 17–25 YAML |

**Step 4-B — Parallel adversary batch (launch both immediately after 4-A)**

| Sub-agent | Targets |
| --- | --- |
| Safety Adversary | FS Builder E — must write ≥1 test for file↔directory transition and ≥1 for leftover-temp-file absence after failure |
| Integration Adversary | Commands Builder H — must write ≥1 new failing test per command covering a precedence edge case not in the current suite |

**Gate 4**: tests 01–11, 17–22, 24, 25 green; both adversaries `ACCEPT`; zero
OPEN rows.

---

### Phase 5 — HTTP and presentation

**Goal**: `net/server.ts`, `net/client.ts` (Builder G) and `cli/grammar.ts`,
`cli/dispatch.ts`, `present/` (Builder F), completing the full 28/28 suite.

**Step 5-A — Parallel build batch (launch both simultaneously)**

| Sub-agent | Task | Key context |
| --- | --- | --- |
| Net Builder G | Implement snapshot server (raw exact request-target match, 404/405, single-line stdout, SIGTERM/SIGINT exit 0) and single-validated-GET client (one GET per command, redirect → error); write HTTP tests | SPEC.md §7.5 rule 8; tests 12/13 YAML; §8 HTTP assertions |
| CLI Builder F | Implement strict positional argv grammar, dispatch, plain/terminal renderers; SNAP_COLOR / NO_COLOR / per-stream TTY auto; write TTY-auto unit tests for stdout and stderr independently | SPEC.md §7.11, §7.5 rules 1 and 4; tests 28 YAML; §8 "YAML-inexpressible" list |

**Step 5-B — Parallel adversary batch (launch both immediately after 5-A)**

| Sub-agent | Targets |
| --- | --- |
| Protocol Adversary | Net Builder G — must write ≥1 test for exact query-string 404, ≥1 for --serve stdout one-line invariant |
| Grammar Adversary | CLI Builder F — must write ≥1 test for every §12 CLI/presentation backlog item (SNAP_COLOR="", NO_COLOR + always, port edge cases) |

**Gate 5**: tests 12, 13, 28 green; TTY-auto unit tests for stdout and stderr
independently green; **full suite 28/28**; both adversaries `ACCEPT`; zero
OPEN rows.

---

### Phase 6 — Test-gap expansion

**Goal**: new `tests/29-*.yaml` onward, closing every §12 backlog item and
every ledger row still needing a public test.

**Step 6-A — Parallel gap-closing batch (launch all 3 simultaneously)**

| Sub-agent | Task | Key context |
| --- | --- | --- |
| Test-Gap Hunter | Write new `tests/29-*.yaml` onward per §12 backlog and any OPEN ledger rows; format-1 additive; use loose patterns per D2; run `cd test-harness && npm run check && npm test` to verify each new file | §12 in full; D2; §8 harness capabilities |
| Property/Fuzz Agent | Implement `ts/test/` causal-graph generator and differential oracles (import-permutation convergence, Hirschberg↔reference equivalence) | §12 "YAML-inexpressible" block; §9 performance design |
| Quality/Perf Agent | Wire lint complexity rules; write `ts/bench/` scripts with recorded budgets; run benchmarks and record baseline numbers | §9 quality config and performance design; D3 |

**Step 6-B — Parallel adversary batch (launch all 3 immediately after 6-A)**

| Sub-agent | Targets |
| --- | --- |
| Harness Conformance Reviewer | Test-Gap Hunter output — verify each new YAML file passes the harness check, is additive (no format-1 breakage), and covers the claimed backlog item |
| Fuzz Adversary | Property/Fuzz Agent output — independently verify convergence property by running with at least 3 different permutation seeds; cite any divergence |
| Perf Adversary | Quality/Perf Agent output — run benchmarks independently; flag any budget that is not reproducibly within 2× of the recorded baseline |

**Gate 6**: `cd test-harness && npm run check && npm test` green; all new
cases pass; all three reviewers `ACCEPT`; zero OPEN ledger rows.

---

### Phase 7 — Adversarial hardening

**Goal**: fuzz campaign · benchmark budgets · reciprocal cross-module audit ·
ledger mutation spot-check · final sweep · history review.

**Step 7-A — Parallel reciprocal audit batch (launch all 4 simultaneously)**

Each pair audits a module the pair did not build (§6.3 rule 4):

| Sub-agent | Audits | Returns |
| --- | --- | --- |
| Reciprocal Auditor 1 | `core/diff.ts` + `core/ot.ts` (built by B) | Cited objections or ACCEPT |
| Reciprocal Auditor 2 | `repo/replay.ts` + `core/tree.ts` (built by D) | Cited objections or ACCEPT |
| Reciprocal Auditor 3 | `fsys/materialize.ts` + `fsys/worktree.ts` (built by E) | Cited objections or ACCEPT |
| Reciprocal Auditor 4 | `net/server.ts` + `net/client.ts` (built by G) | Cited objections or ACCEPT |

**Step 7-B — Fuzz and history (launch both simultaneously, after 7-A returns)**

| Sub-agent | Task |
| --- | --- |
| Scaled Fuzz Agent | Run the causal-graph fuzz campaign at 10× scale; report any new divergences; append FUZZ-nnn ledger rows |
| History Auditor | Run `git log --oneline` and `git bisect` against a seeded regression; verify every commit compiles and tests pass; report any non-bisectable commit |

**Step 7-C — Ledger spot-check (sequential, after 7-B)**

Launch a single **Ledger Spot-Check Agent**:
- For every `CLOSED` ledger row, revert the implementation behavior (mutation),
  verify the locking test fails, then restore. Sample ≥20% of rows.
- Return `{ rows_checked, rows_failed[], status }`.

**Step 7-D — Final sweep (sequential, after 7-C passes)**

Launch a single **Final Sweep Agent**:
- Run `tsc --noEmit`, `eslint .`, `prettier --check .`, `npm test`,
  `./verify --lang ts`, `cd test-harness && npm run check && npm test`.
- Fix any issue found (trivial only; non-trivial issues go back to the
  responsible builder sub-agent).
- Return `{ status, issues_fixed[] }`.

**Gate 7**: `./verify --lang ts` fully green · harness checks green ·
benchmarks within budget · docs consistent with implementation · ledger fully
`CLOSED` · **CI green on every job across both platforms**. Tag
`phase-7-hardening`.

## 16. Deliverables

1. Complete `ts/` implementation passing the full acceptance suite.
2. Curated bisectable Git history (~60–100 Conventional Commits v1.0.0, with
   phase tags).
3. `docs/`: `PLAN.md`, `SPEC-GAPS.md`, `DECISIONS.md`, `MESSAGES.md`,
   `TEST-DEFECTS.md`, `COVERAGE.md`, `ARCHITECTURE.md`, `AGENT-LOG.md`.
4. New `tests/29+*.yaml` cases closing coverage gaps.
5. `ts/test/` unit and property tests, including the SPEC-mandated TTY-auto
   tests.
6. `ts/bench/` with recorded budgets.
7. ESLint, Prettier, and strict tsconfig wired into npm scripts.
8. `.github/workflows/ci.yml` proving type-check, lint, format, unit/property
   tests, harness self-check, the full acceptance suite on Linux and macOS,
   and Conventional Commits compliance on every push.

## 17. Risks

| Risk | Mitigation |
| --- | --- |
| Message adjacency traps cause late failures | All §7 constraints become contract tests in Phase 0 |
| Byte-exact `repository.json` diverges across code paths | Single canonical serializer; `trees_equal` regressions in Phase 3 |
| Hirschberg diverges from §5's tie rule | Reference DP retained permanently as a differential oracle |
| Error-precedence guesses conflict across commands | Central precedence table in `DECISIONS.md`, enforced by the Integration Adversary |
| A test genuinely contradicts SPEC | Derivation Agent detects it; document → comply → escalate (D6) |
| Agents converge on a shared wrong reading | Implementation-blind derivation; new-tests-first adversaries; Phase 7 reciprocal audit |
| Adversary findings lost as prose | Structured adversary output; ledger rows mandatory; no ACCEPT with an OPEN row |
| Interface drift among parallel subagents | Interfaces frozen in Phase 0; only the Orchestrator changes them, via a `!` breaking commit |
| Non-bisectable history | Orchestrator gates every commit; Phase 7 seeded-regression bisect check |
| `npm ci` breakage from new devDeps | Verified immediately in Phase 0 via `./verify --lang ts --list`, then continuously by the CI `implementation` job |
| Local pass but CI fail (env drift) | CI runs the identical npm-script gate commands (§14.1); Node pinned to 22.x; `acceptance` runs from a clean checkout |
| Platform-specific byte or filesystem behavior | `acceptance` matrix covers `ubuntu-latest` and `macos-latest` (§14.3) |
| Sub-agent returns narrative instead of structured output | Prompt template (§0.2) mandates JSON return format; Orchestrator rejects and re-runs on non-conforming output |
| Sub-agent exceeds its scope and modifies frozen interfaces | Prompt template `DO NOT` clause explicitly forbids signature changes; Orchestrator validates output before accepting |
| Parallel sub-agents produce conflicting edits to shared files | `docs/` files and `tests/` are write-once per phase; only the Orchestrator merges and commits |
| A harness error misread as a test failure in CI | CI distinguishes harness exit code `2` from test failure `1` (§14.4) |
