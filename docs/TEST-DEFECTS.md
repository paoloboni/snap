# Test Defects

Cases where a YAML test appears to contradict or extend `SPEC.md` beyond what
is stated. All entries are dispositioned per D6: implement to satisfy the
existing test, document the discrepancy, and escalate to the user.

---

## DEF-001 — Test 12:98–129 escalates SHOULD to MUST

**Test file:** `tests/12-http-server.yaml`  
**Step range:** lines 98–129 (`body_text_equals` assertion)  
**SPEC.md ref:** SPEC.md:188–190 ("Writers SHOULD use two-space indentation
and a trailing LF")  
**Description:** §4.1 states that the parsed typed value — not its serialized
bytes — is authoritative, and that two-space indentation is a SHOULD, not a
MUST. However, test 12 uses `body_text_equals` to assert the *exact* byte
sequence returned by the HTTP server for `repository.json`, including specific
indentation, newline placement, and key order. This effectively makes the SHOULD
a MUST for any implementation that must pass the shared suite.  
**Disposition:** COMPLY — implement the two-space indented, trailing-LF,
deterministic key-order serializer as the canonical form. Document the
escalation in `docs/DECISIONS.md` as DEC-011.  
**Impact:** All `repository.json` writes must use a single canonical serializer.
No ad-hoc serialization paths allowed.

---

## DEF-002 — Test 06:28 contradicts §7.6's "no differences" rule

**Test file:** `tests/06-binary-and-empty.yaml`  
**Step range:** line 28 (`stdout_equals` on `diff` output including empty-file block)  
**SPEC.md ref:** SPEC.md:554–555 ("No differences means no stdout and success.")  
**Description:** §7.6 says "No differences means no stdout and success." When
an empty file is created (absent → empty bytes), the token counts on both sides
are zero. By a strict reading of "no differences in bytes," this case produces
no stdout. However, test 06 asserts that `diff` emits a block:
```
--- /dev/null
+++ b/empty
@@ -1,0 +1,0 @@
```
for this absent→empty transition. The file's *existence* changed even though
its byte content is the same (zero bytes on both sides).  
**Disposition:** COMPLY — treat `(existence, bytes)` as the unit of comparison,
not bytes alone. A change in existence always produces a diff block. Document
in `docs/DECISIONS.md` as DEC-012.  
**Impact:** The diff loop must check both existence and content, not just
content equality. An absent-to-empty transition emits a text block with
`@@ -1,0 +1,0 @@`.

---

## DEF-003 — Test 03 interpolation trap (apparent JSON malformation)

**Test file:** `tests/03-configuration.yaml`  
**Step range:** line 70 (`write_file` with `text: '{"contributor":{"id":"global@example.com"}}}}'`)  
**SPEC.md ref:** SPEC.md:663–680 (§8 configuration JSON format)  
**Description:** The YAML source at line 70 shows
`'{"contributor":{"id":"global@example.com"}}}}'` — four closing braces,
which looks malformed. If taken at face value, this would mean the test writes
invalid JSON, expects `commit` to succeed using the global config, and inverts
the precedence logic. However, the YAML harness processes template interpolation
before writing file content, and the `}}}}` is the harness's escaped form of
`}}` (two closing braces), making the actual file content
`{"contributor":{"id":"global@example.com"}}` — valid JSON with the expected
structure.  
**Disposition:** COMPLY — implement standard JSON parsing. The test is correct;
the apparent malformation is a YAML source artefact. Document so implementers
do not misread the test source and accidentally implement a bug to match a
misreading. See GAP-005.  
**Impact:** No behavioral change required. The test exercises the
local-missing-global-valid fallback path in §8.

---

## DEF-004 — Test 23 requires `delete of absent path: f` (byte-exact pattern)

**Test file:** `tests/23-strict-validation-matrix.yaml`  
**Step range:** lines 273–303 (the delete-of-absent-path case)  
**SPEC.md ref:** SPEC.md:248–251 (§4.3 "A delete requires the path to be
present [in the base].")  
**Description:** §4.3 says a delete requires the path to be present in the
patch's exact base tree but does not specify the error message. Test 23 pins
the exact pattern `^snap: delete of absent path: f\n$`. This is listed in
PLAN.md §7.1 as a byte-exact error. The path `f` is the specific path in the
test; the general form is `snap: delete of absent path: <path>`.  
**Disposition:** COMPLY — implement the exact message format
`snap: delete of absent path: <path>` where `<path>` is the tracked path.
This is effectively a byte-exact requirement derived from the test.  
**Impact:** The validation error for a delete-of-absent-path must embed the
specific path name.
