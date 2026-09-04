# Spec Gaps

Every gap, ambiguity, or contradiction found in `SPEC.md`, plus any that
appeared while sweeping the 28 test files. IDs are permanent once assigned.

---

## GAP-001 — §5 Step-exhaustion order ambiguity

**SPEC.md lines:** 307–314  
**Finding:** The walk procedure lists steps 1–5 in order, but steps 1–3 reference
`D(i+1,j)` and `D(i,j+1)`, which are undefined when `i==n` or `j==m`; the
"at an exhausted side" step 4 must be checked before steps 1–3 or an
out-of-bounds access is mandatory.  
**Resolution:** Evaluate the exhaustion condition (step 4) *first*, before any
comparison of `D(i+1,j)` and `D(i,j+1)`. When `i==n`, insert remaining
`B[j..]` tokens; when `j==m`, delete remaining `A[i..]` tokens.  
**Pinning tests:** `tests/05-diff-goldens.yaml` (golden diff scripts force the
exact diff output, which is only correct with exhaustion-first evaluation),
`tests/22-ot-matrix.yaml` (all four OT cases rely on a correct diff in their
commit step).

---

## GAP-002 — §4.1 SHOULD vs. MUST for JSON serialization bytes

**SPEC.md lines:** 188–190 ("Writers SHOULD use two-space indentation…")  
**Finding:** Test 12:98–129 uses `body_text_equals` to assert the exact
serialized byte sequence of `repository.json`, effectively escalating the
SHOULD to a MUST for this implementation.  
**Resolution:** Treat the two-space indented, trailing-LF format as mandatory
for all `repository.json` writes. The canonical form is
`JSON.stringify(value, null, 2) + "\n"` with key order
`format → frontier → patches` at the top level and
`author → revision → base → message → changes` per patch, and
`type → path → edit|content` per change.  
**Pinning tests:** `tests/12-http-server.yaml:98–129`,
`tests/05-diff-goldens.yaml:63–93` (`json_equals` also constrains parsed
shape), `tests/09-merge-text.yaml` (`trees_equal`).

---

## GAP-003 — §7.6 "no differences" vs. empty→empty file block

**SPEC.md lines:** 516–555 (§7.6 diff output rules)  
**Finding:** Test 06:28 asserts that diffing `() → (binary@example.com->1)`
emits a `--- /dev/null\n+++ b/empty\n@@ -1,0 +1,0 @@\n` block for a file
whose content transitions from absent to the empty byte sequence, contradicting
§7.6's final sentence "No differences means no stdout and success." Existence
differs even though bytes are identical (both zero-length).  
**Resolution:** Emit a diff block whenever `(existence, bytes)` differ between
the two sides, including the absent→empty and empty→absent transitions. The
"no differences" rule applies only when both existence and bytes are identical.  
**Pinning tests:** `tests/06-binary-and-empty.yaml:27–29` (exact stdout
assertion for the empty-file block).

---

## GAP-004 — §4.4 single rule, two distinct error messages for edit consumption

**SPEC.md lines:** 263–270 ("The script MUST consume the complete old token
sequence; there is no implicit trailing retain.")  
**Finding:** §4.4 states a single "must consume complete sequence" rule, but
two tests pin *different* messages: test 15 requires `does not consume old
content` (under-consumption) and test 23 requires `consumes beyond old content`
(over-consumption). The spec gives no hint of distinct messages for the two
violation directions.  
**Resolution:** Implement two separate validations: (1) if the script ends
before all old tokens are consumed, emit a message containing
`does not consume old content`; (2) if a retain or delete operation references
more tokens than remain, emit a message containing
`consumes beyond old content`. Both are exit-1 errors.  
**Pinning tests:** `tests/15-repository-validation.yaml:97–127`
(`does not consume old content`), `tests/23-strict-validation-matrix.yaml:242–271`
(`consumes beyond old content`).

---

## GAP-005 — §8 JSON with trailing braces (the interpolation trap)

**SPEC.md lines:** 663–680 (§8 configuration)  
**Finding:** Test 03 writes the string
`'{"contributor":{"id":"global@example.com"}}}}'` to `$HOME/.snapconfig.json`
and expects commit to succeed. The four closing braces look malformed, but the
YAML harness collapses template-interpolation artefacts before writing, making
the actual file content `{"contributor":{"id":"global@example.com"}}` — valid
JSON. Misreading this would invert the local-over-global precedence test.  
**Resolution:** The file is valid JSON. Implement normal JSON parsing. The trap
is in reading the test source, not in the spec. No behavioral change required;
document so implementers do not misread the test.  
**Pinning tests:** `tests/03-configuration.yaml:69–80`.

---

## GAP-006 — §6.2 namespace-wins: warning names the *removed current* path

**SPEC.md lines:** 347–355 (§6.2 namespace conflict resolution)  
**Finding:** §6.2 says "mark every conflicting current path for removal" and
"each removed path emits `namespace-wins`", but does not explicitly state
*which* path appears in the warning pair — the incoming path being installed or
the current path being removed.  
**Resolution:** The warning pair is `(removed_current_path, namespace-wins)`.
Tests 11 and 28 confirm: when `bob` creates `a/b` (a descendant of `alice`'s
existing `a`), the warning is `warning: auto-resolved a/b: namespace-wins`
(the incoming path `a/b` is the one removed). When integration order is
reversed and `bob`'s `x/y` is incoming while `alice`'s `x` is current, the
warning is `warning: auto-resolved x: namespace-wins` (the existing `x` file
is removed). So the warning names the path that is *removed from canonical
state*, which may be either the incoming or the current path depending on
which is the ancestor.  
**Pinning tests:** `tests/11-namespace-conflicts.yaml:50–51,103–105`,
`tests/28-terminal-presentation.yaml:187–188`.

---

## GAP-007 — §3.1 contributor ID: no `->` substring

**SPEC.md lines:** 90–93 (§3.1 contributor IDs)  
**Finding:** The spec lists forbidden substrings for contributor IDs but does
not give a concrete error message for the case. Test 25 pins the exact message
pattern `^snap: invalid contributor id: .+\n$`, confirming the required prefix.  
**Resolution:** Any contributor ID violation produces a message matching
`^snap: invalid contributor id: .+\n$`. The detail portion must be nonempty.  
**Pinning tests:** `tests/25-config-version-path-boundaries.yaml:63–73`.

---

## GAP-008 — §7.1 `init` must detect *ancestor* repository, not just current-dir

**SPEC.md lines:** 55–58 (§7.1 init)  
**Finding:** §7.1 says "Initializing a target inside an existing repository is
an error" but does not specify whether the detection walks upward (ancestor
check) or only checks the immediate parent. Test 02 runs `init` from a
*child* directory of an existing repo and expects failure.  
**Resolution:** Walk from the target path to the filesystem root; if `.snap/`
is found in any ancestor, fail with a message containing
`cannot initialize inside repository`. This mirrors the repository-location
walk described at the top of §7.  
**Pinning tests:** `tests/02-init-paths.yaml:33–47`.

---

## GAP-009 — §7.5 port validation range (0–65535)

**SPEC.md lines:** 583–588 (§7.9 `--serve`)  
**Finding:** §7.9 says port defaults to `8765` and `0` asks the OS; it does
not specify the maximum legal port or the error message for out-of-range
values. Test 14 pins the exact error `snap: invalid port: 65536\n` for port
65536.  
**Resolution:** Valid ports are 0–65535 inclusive. Any value outside that range
is rejected before attempting to bind, with message
`snap: invalid port: <value>`.  
**Pinning tests:** `tests/14-cli-errors.yaml:77–84`.

---

## GAP-010 — §7.4 log message escaping (backslash, tab, LF order)

**SPEC.md lines:** 488–494 (§7.4 log)  
**Finding:** §7.4 says "backslash, tab, and LF are escaped as `\\`, `\t`, and
`\n` in that order." The phrase "in that order" is potentially ambiguous — it
could mean the escape replacements are applied sequentially (backslash first,
then tab, then LF) rather than simultaneously, which would cause a bug if LF
or tab were replaced before backslash.  
**Resolution:** Apply escaping simultaneously, or equivalently apply backslash
first then tab then LF. Since the spec says "in that order", the safe
implementation replaces `\` → `\\`, then `\t` → `\t`, then `\n` → `\n`.
Test 04 pins the exact output for a message containing both `\t` and `\\`.  
**Pinning tests:** `tests/04-commit-status-log.yaml:82–84` (log output for
message `"first\tline\nsecond\\tail"` must be
`first\tline\nsecond\\\\tail` in the log).

---

## GAP-011 — §7.11 `--serve` URL is always plain, even under `SNAP_COLOR=always`

**SPEC.md lines:** 621–623 ("The `--serve` startup URL always remains plain")  
**Finding:** §7.11 is clear that the serve URL is always plain. Test 28 runs
`--serve` under `SNAP_COLOR=always` (the test-global env) and asserts the URL
matches `^http://127\.0\.0\.1:[0-9]+/repository\.json\n$` with no ANSI codes.  
**Resolution:** The `--serve` URL line is unconditionally written in plain mode
to stdout regardless of `SNAP_COLOR`. Confirm: `config` is also silent in
terminal mode, and errors that occur before a valid presentation is selected
(e.g., invalid `SNAP_COLOR`) are also written in plain mode.  
**Pinning tests:** `tests/28-terminal-presentation.yaml:159–172`,
`tests/12-http-server.yaml:130–153`.

---

## GAP-012 — §7.6 diff `--repo` cross-repository corruption check

**SPEC.md lines:** 527–529 ("For a cross-repository diff, also compare every
dot present in both repositories and fail as corrupt if its parsed patch values
differ.")  
**Finding:** §7.6 requires the corruption check for `diff --repo` but §7.8
(`merge`) also performs it implicitly through the dot-collision rule in §3.5.
Test 16 confirms `diff --repo` must detect and report dot collisions.  
**Resolution:** Both `diff --repo` and `merge` must compare shared dots before
producing output or mutating state. Error message must contain
`patch collision: <author> revision <n>`.  
**Pinning tests:** `tests/16-dot-collision.yaml:49–57,59–67`.

---

## GAP-013 — §10 mutation ordering: working-tree update before `repository.json` replace

**SPEC.md lines:** 709–718 (§10 mutation ordering)  
**Finding:** §10 specifies the exact write ordering (files first, then atomic
`repository.json` replace) but does not specify what happens to partially
written state if the working-tree update fails. The spec says "Snap reports the
failure; the user may repair the files and retry."  
**Resolution:** On working-tree write failure, Snap must report the I/O error
and exit 1 without replacing `repository.json`. A leftover temporary file is
acceptable (POSIX rename atomicity guarantees the final `repository.json` is
consistent), but implementations SHOULD clean up temporaries after success.
Test 26 verifies via `tree_equals` that no leftover temp files exist after
success; test 01 also checks the `.snap/` directory has exactly the expected
entries.  
**Pinning tests:** `tests/01-init.yaml:18–31` (`tree_equals` on `.snap/`),
`tests/26-portability-and-failure-safety.yaml:109–113`.

---

## GAP-014 — §7.3 status: `.snap/` metadata files and empty directories are not tracked

**SPEC.md lines:** 57–79 (§2 repository and working tree)  
**Finding:** §2 says "Snap tracks every regular file below the repository root
except `.snap/` and its contents." Test 25 writes a file to `.snap/untracked`
and creates empty directories, then expects `status` to show the version line
only (no tracked changes). The spec also says "empty directories are not
tracked."  
**Resolution:** The working-tree scan must exclude (a) any path whose first
segment is `.snap`, and (b) any directory (since directories are implicit). An
empty directory creates no `A` entry in `status`. A `.snap/` file creates no
tracked entry.  
**Pinning tests:** `tests/25-config-version-path-boundaries.yaml:87–98`.

---

## GAP-015 — §4.5 validation runs even for read-only commands

**SPEC.md lines:** 275–286 (§4.5 repository validation)  
**Finding:** The spec says "Before using a repository, Snap validates" but does
not enumerate which commands trigger validation. Test 26 cases 3 and 4 confirm
that `merge` and `diff --repo` against a malformed remote produce an error even
though neither command writes to the local repository.  
**Resolution:** Every command that reads a repository — including `status`,
`log`, `diff`, `merge`, and `--serve` — must validate it before producing any
output. Validation failure exits 1 without mutation.  
**Pinning tests:** `tests/26-portability-and-failure-safety.yaml:59–104`,
`tests/12-http-server.yaml:154–168`.

---

## GAP-016 — §3.2 canonical version ordering in `frontier` field

**SPEC.md lines:** 100–108 (§3.2 canonical syntax)  
**Finding:** §3.2 says CLI version strings sort contributors by unsigned UTF-8
bytes, but §4.1's repository JSON format does not explicitly require the
`frontier` array to be sorted. Test 23 (case 2) expects an error matching
`^snap: .*canonical.*\n$` when `frontier` has `b@x` before `a@x`.  
**Resolution:** The `frontier` array in `repository.json` MUST be sorted by
contributor ID in unsigned UTF-8 byte order (same rule as version string
syntax). An unsorted frontier is a validation error with a message containing
`canonical`.  
**Pinning tests:** `tests/23-strict-validation-matrix.yaml:26–40`.

---

## GAP-017 — Error precedence table (silent in SPEC)

**SPEC.md lines:** None — entirely implicit  
**Finding:** SPEC is silent on the order in which pre-condition checks should
be evaluated when multiple errors could apply simultaneously. The tests pin
several precedence orderings:
- invalid message ▸ clean tree (test 25 last step)
- unsupported entry ▸ dirty tree (test 20)
- unknown/invalid version ▸ missing contributor.id (tests 14, 19)
- `diff` old operand error before new operand (test 19)
- grammar errors before any filesystem effect (test 24, `path_not_exists`)

**Resolution:** See `docs/DECISIONS.md` DEC-008 for the full precedence table.  
**Pinning tests:** `tests/25-config-version-path-boundaries.yaml:124–130`,
`tests/20-dirty-merge.yaml:54–68`, `tests/14-cli-errors.yaml:67–75`,
`tests/19-version-boundaries.yaml`, `tests/24-cli-grammar-matrix.yaml:36`.

---

## GAP-018 — §7.5 `diff` has its own error family

**SPEC.md lines:** 516–555 (§7.6 diff)  
**Finding:** SPEC §7.6 does not specify a distinct error format for `diff`
grammar errors. Tests 14 and 24 pin that `diff` grammar errors produce
`snap: usage: snap diff ...` rather than `snap: invalid command or arguments`.  
**Resolution:** `diff` grammar errors (wrong number of args, misplaced `--repo`,
etc.) emit `snap: usage: snap diff <old> <new> [--repo <repository>]` (or
equivalent usage line). All other commands use `snap: invalid command or
arguments`.  
**Pinning tests:** `tests/14-cli-errors.yaml:46–65`,
`tests/24-cli-grammar-matrix.yaml:23–30`.

---

## GAP-019 — §4.2 text-change-over-non-text base is a validation error

**SPEC.md lines:** 248–251 (§4.3 change variants)  
**Finding:** §4.3 says "A text or put creation requires the path to be absent
in the patch's exact base tree. An edit, replacement, or delete requires it to
be present." It does not explicitly say that a `text` change whose base content
is non-text (binary) is a validation error rather than resolved as `put-wins`.
Test 27 case 7 (`text over binary`) expects validation to fail.  
**Resolution:** A `text` change applied to a base path that contains non-text
(binary) bytes is rejected at validation time (§4.5 check 5) with an error.
This is not resolved as `put-wins` during replay.  
**Pinning tests:** `tests/27-history-canonicality.yaml:116–133`.

---

## GAP-020 — §1.1 invariant 8: `.snap/` is never tracked

**SPEC.md lines:** 47–48 (invariant 8)  
**Finding:** Invariant 8 states `.snap/` metadata is never part of the tracked
tree, but §4.3 does not explicitly say that a change whose path begins with
`.snap` is invalid. Test 15 case 3 puts a change with path `.snap/secret` and
expects a `path is invalid` error during validation.  
**Resolution:** Any path beginning with `.snap` (i.e., whose first segment
equals `.snap`) fails tracked-path validation with a message containing
`path is invalid`.  
**Pinning tests:** `tests/15-repository-validation.yaml:49–72`.

---

## GAP-021 — Substring-adjacency wording constraints

**SPEC.md lines:** §4 (lines 163–285), §7 (lines 444–660)  
**Finding:** SPEC.md mandates error exits but not exact message wording for most
validation errors. Tests 15 and 23 use anchored regex patterns
(`^snap: .+<keyword>\n$`) and required-substring assertions that constrain
message wording precisely. Several natural phrasings fail these patterns:

(a) `^snap: .+message is empty\n$` requires a nonempty prefix between `snap: `
and `message is empty` — so `"snap: message is empty"` fails but
`"snap: patch message is empty"` passes.

(b) The same nonempty-prefix requirement applies to the following keywords:
`changes is empty`, `insert is empty`, `must have one operation`,
`positive safe integer`, `unknown field: extra`, `consumes beyond old content`.

(c) §7.3 requires `path is invalid` as a substring (not `invalid path` or
`path invalid`).

(d) §7.3 requires `canonical base64` as a substring (not `invalid base64`).

(e) §7.3 requires `missing a@x` to appear literally so that
`"snap: missing a@x revision 1"` passes, but `"snap: missing patch: a@x"`
fails because the literal substring `missing a@x` is absent.

**Resolution:** Use the PLAN.md §7.1–§7.3 pinned messages exactly as
implemented in `ts/src/errors.ts`. Every error message for these cases must
satisfy both the anchored outer pattern and the required inner substring.  
**Pinning tests:** `tests/15-repository-validation.yaml`,
`tests/23-strict-validation-matrix.yaml`  
**Status:** OPEN (will be CLOSED after contract tests are added)
