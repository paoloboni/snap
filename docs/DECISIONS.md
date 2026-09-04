# Decisions

All spec ambiguities with their chosen resolutions. Entries D1–D9 carry over
from PLAN.md §5. New entries discovered during the Phase 1 cartography sweep
are DEC-010 onward.

---

## DEC-001 — Tooling stack

**Topic:** Build, lint, format, and test tooling  
**Spec ref:** None (implementation choice)  
**Ambiguity:** SPEC.md does not mandate a tooling stack for the TypeScript
implementation.  
**Decision (D1):** ESLint + typescript-eslint (type-aware) + Prettier +
`node:test`. New devDependencies and a `package-lock.json` update are approved.  
**Rationale:** ESLint type-aware rules catch logic errors that tsc alone misses
(e.g., `no-floating-promises`). Prettier eliminates formatting debates.
`node:test` is built into Node 22 with no install cost.

---

## DEC-002 — YAML test wording policy

**Topic:** Error message wording in YAML acceptance tests  
**Spec ref:** SPEC.md §11  
**Ambiguity:** SPEC.md fixes behavior but is largely silent on exact wording.
Language-neutral tests must not bake in one implementation's phrasing.  
**Decision (D2):** New YAML tests assert exact bytes only where SPEC fixes
behavior; where SPEC is silent on wording, use loose patterns
(`^snap: .+\n$`) so the suite stays language-neutral. Our exact wording is
pinned in `ts/test/` instead.  
**Rationale:** Keeps the shared suite open to Rust and Scala implementations
with different phrasing while giving the TypeScript implementation byte-exact
contract tests.

---

## DEC-003 — Performance approach

**Topic:** Algorithmic performance targets  
**Spec ref:** None (implementation quality)  
**Ambiguity:** SPEC.md does not mandate time complexity.  
**Decision (D3):** Good asymptotics plus a local benchmark gate with recorded
budgets (`ts/bench/`, outside the acceptance suite).  
**Rationale:** Snap's acceptance suite is correctness-focused. Performance
budgets belong in a separate gate so they do not inflate YAML test times.

---

## DEC-004 — Derived documents location

**Topic:** Documentation file placement  
**Spec ref:** None  
**Ambiguity:** Not specified.  
**Decision (D4):** Derived documents live in `docs/`.  
**Rationale:** Keeps the project root clean; mirrors the structure already
present in `AGENTS.md`.

---

## DEC-005 — Adversarial loop limit

**Topic:** How many REJECT rounds before arbitration  
**Spec ref:** None  
**Ambiguity:** Not specified.  
**Decision (D5):** Adversarial loop: 3 REJECT rounds maximum, then the
integrator arbitrates and records the ruling in `docs/DECISIONS.md`.  
**Rationale:** Prevents infinite loops while giving builders enough iterations
to address real issues.

---

## DEC-006 — Test defect policy

**Topic:** What to do when a test contradicts SPEC.md  
**Spec ref:** AGENTS.md §Sources of truth  
**Ambiguity:** Tests/ is the canonical suite per AGENTS.md, but SPEC.md is the
behavioral contract. When they conflict, which wins?  
**Decision (D6):** Document in `docs/TEST-DEFECTS.md` → implement to satisfy
the existing test → escalate to the user. Never silently edit `tests/` or
`SPEC.md`.  
**Rationale:** Preserves the shared harness while making conflicts visible for
human resolution.

---

## DEC-007 — Commit authorship

**Topic:** Who may create commits  
**Spec ref:** None  
**Ambiguity:** Not specified.  
**Decision (D7):** Only the integrator commits; subagents submit structured
commit proposals.  
**Rationale:** Prevents history corruption from parallel agents committing to
the same branch.

---

## DEC-008 — Commit granularity and conventions

**Topic:** Commit size and format  
**Spec ref:** None  
**Ambiguity:** Not specified.  
**Decision (D8):** Fine-grained bisectable commits (~60–100), Conventional
Commits v1.0.0. See PLAN.md §13 for full format.  
**Rationale:** Bisectability requires each commit to compile and pass tests.
Conventional Commits enables automated changelog generation.

---

## DEC-009 — Scaffold import commit

**Topic:** Initial repository commit content  
**Spec ref:** None  
**Ambiguity:** Not specified.  
**Decision (D9):** History begins with a single verbatim scaffold-import
commit (`chore: import Snap capstone scaffold`) containing only the provided
files, untouched.  
**Rationale:** Every later diff is purely implementation work, making the delta
readable and reviewable.

---

## DEC-010 — §5 step evaluation order: exhaustion before comparison

**Topic:** Walk procedure exhaustion check  
**Spec ref:** SPEC.md:307–314  
**Ambiguity:** SPEC.md §5 lists steps 1–5 in order but steps 1–3 attempt to
compare `D(i+1,j)` and `D(i,j+1)`, which are undefined when `i==n` or `j==m`.
The "at an exhausted side" step 4 is listed last but logically must be first.  
**Decision:** Evaluate exhaustion (step 4) first, before any comparison. When
`i==n`, emit inserts for remaining `B[j..]`; when `j==m`, emit deletes for
remaining `A[i..]`. Renumber internally if desired but match SPEC semantics.  
**Rationale:** Any other evaluation order causes an out-of-bounds access on
non-trivial inputs. All five OT test cases confirm this is the only correct
order. See GAP-001.

---

## DEC-011 — §4.1 SHOULD serialization is MUST for this implementation

**Topic:** `repository.json` byte format  
**Spec ref:** SPEC.md:188–190  
**Ambiguity:** §4.1 says writers SHOULD use two-space indentation with a
trailing LF. Test 12:98–129 pins the exact bytes via `body_text_equals`.  
**Decision:** The canonical serialization is `JSON.stringify(value, null, 2) +
"\n"` with deterministic key order:
- Top-level: `format`, `frontier`, `patches`
- Per patch: `author`, `revision`, `base`, `message`, `changes`
- Per change: `type`, `path`, then `edit` (text) or `content` (put)  

**Rationale:** Test 12's `body_text_equals` assertion makes the SHOULD
effectively a MUST for this implementation. Deterministic key order is required
for cross-language byte comparison and test reproducibility. See GAP-002.

---

## DEC-012 — §7.6 "no differences" applies to bytes+existence, not bytes alone

**Topic:** Diff output for absent→empty and empty→absent transitions  
**Spec ref:** SPEC.md:516–555  
**Ambiguity:** §7.6 says "No differences means no stdout and success." An
absent file and an empty file have the same byte count (0) but differ in
existence. Test 06:28 asserts a diff block is emitted.  
**Decision:** Emit a diff block whenever `(existence, bytes)` differ. The "no
differences" rule means both existence AND bytes are the same on both sides.  
**Rationale:** An absent file and an empty file are semantically distinct in
any filesystem. The test confirms this. See GAP-003.

---

## DEC-013 — §4.4 two distinct edit consumption error messages

**Topic:** Edit script validation errors for under/over-consumption  
**Spec ref:** SPEC.md:265–270  
**Ambiguity:** §4.4 gives one rule ("consume the complete old token sequence")
but tests 15 and 23 pin two different error substrings.  
**Decision:** Under-consumption (script ends before all old tokens are consumed)
→ message containing `does not consume old content`. Over-consumption (retain
or delete references more tokens than remain) → message containing
`consumes beyond old content`. See GAP-004.  
**Rationale:** The two failure modes are distinct and actionable; separate
messages aid debugging. Tests are unambiguous.

---

## DEC-014 — §7.11 terminal warning and error format

**Topic:** ANSI rendering of warnings and errors  
**Spec ref:** SPEC.md:650–653  
**Ambiguity:** §7.11 says a plain warning `warning: <detail>` becomes
`S(33,"⚠") + " " + S(33,"<detail>") + LF`. Test 28:187–188 confirms that in
terminal mode the warning omits the `warning: ` prefix—only `<detail>` is
wrapped in the SGR sequence.  
**Decision:** Terminal warning format: `ESC[33m⚠ESC[0m ESC[33m<detail>ESC[0m\n`
where `<detail>` is `auto-resolved <path>: <reason>` (without `warning: `
prefix). Plain format retains `warning: auto-resolved <path>: <reason>\n`.  
**Rationale:** Test 28 pins the exact ANSI bytes. The `warning: ` prefix is
the plain label, not semantic content; the symbol plays that role in terminal
mode.

---

## DEC-015 — Error precedence table

**Topic:** Order of pre-condition checks when multiple errors could fire  
**Spec ref:** None (SPEC is silent)  
**Ambiguity:** Many commands have multiple preconditions. The order in which
they are checked determines which error is reported when several apply.  
**Decision:** The following precedence ordering is pinned by tests:

| Priority (highest first) | Condition | Commands | Test |
|---|---|---|---|
| 1 | Grammar / argument parsing error | All | 24 |
| 2 | `SNAP_COLOR` invalid | All | 28 |
| 3 | Unsupported working tree entry | commit, status, diff, merge | 20 |
| 4 | Working tree dirty | merge, revert | 20 |
| 5 | Invalid version syntax | diff, revert | 19 |
| 6 | Unknown version | diff, revert | 14 |
| 7 | Missing contributor.id | commit, revert | 19 |
| 8 | Working tree clean | commit | 04, 25 |
| 9 | Invalid message | commit | 25 |
| 10 | Repository validation | All that read a repo | 15, 23 |

For `diff --repo` / `merge`: local repository is validated first, then remote.
The `diff` old operand is validated before the new operand.

**Rationale:** Test evidence is unambiguous for these orderings. Where tests do
not constrain the order, choose the most natural parse→validate→execute flow.

---

## DEC-016 — §6.2 namespace-wins warning names the removed path

**Topic:** Which path appears in a `namespace-wins` warning  
**Spec ref:** SPEC.md:347–355  
**Ambiguity:** §6.2 says "each removed path emits `namespace-wins`" but does
not clarify whether the warning names the removed path or the incoming path.  
**Decision:** The warning pair is `(removed_path, namespace-wins)` where
`removed_path` is whichever path is evicted from canonical state — this may be
either the incoming path (if it is a descendant of an existing file) or the
existing path (if it is an ancestor of an incoming file). See GAP-006.  
**Rationale:** Tests 11 and 28 confirm both directions. In test 11 part 1,
`a/b` (incoming descendant of existing `a`) is removed → warning names `a/b`.
In test 11 part 2, `x` (existing ancestor of incoming `x/y`) is removed →
warning names `x`.

---

## DEC-017 — §7.1 init detects ancestor repositories

**Topic:** Scope of "inside an existing repository" check for `init`  
**Spec ref:** SPEC.md:55–58, 443  
**Ambiguity:** §7.1 says "Initializing a target inside an existing repository
is an error" without specifying how far up to walk.  
**Decision:** Walk from the proposed `init` target path upward to the
filesystem root; if `.snap/repository.json` is found in any ancestor, fail
with `cannot initialize inside repository`. This mirrors the repository-location
walk described at the top of §7. See GAP-008.  
**Rationale:** Test 02 runs `init` from a child directory of an existing repo
and confirms the error. Consistency with the repository-discovery walk is the
natural choice.

---

## DEC-018 — §4.5 text-change-over-binary-base is a validation error

**Topic:** Handling of `text` change applied to a binary base path  
**Spec ref:** SPEC.md:248–251, 275–286  
**Ambiguity:** §6.4 rule 6 describes `put-wins` for the case "P is text and C
is non-text", but this is a *replay rule*. Whether validation should reject
such a patch before replay is not stated.  
**Decision:** A `text` change whose base path contains non-text content is
rejected during §4.5 validation (check 5), not deferred to replay. This aligns
with the invariant that every change is validated against its exact base. See
GAP-019.  
**Rationale:** Test 27 case 7 confirms this is a validation failure. The
`put-wins` rule in §6.4 applies to *concurrent* edits during merge, not to a
single patch whose author should have known the base was binary.

---

## DEC-019 — `diff` uses `/dev/null` for absent sides, start line always 1

**Topic:** Hunk header format for absent files  
**Spec ref:** SPEC.md:532–546  
**Ambiguity:** §7.6 says "For an absent side, use `/dev/null` in its header"
but does not specify what line number to use in the `@@` hunk header when the
count is 0.  
**Decision:** The hunk header start line is always `1`. A zero count uses
`@@ -1,0 +1,2 @@` format (start=1, count=0 for the absent side). See
PLAN.md §7.5 rule 7.  
**Rationale:** PLAN.md §7.5 rule 7 pins this. Test 06:27–29 confirms
`@@ -1,0 +1,0 @@` for empty→absent transitions.
