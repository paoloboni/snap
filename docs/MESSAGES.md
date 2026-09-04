# Error and Warning Messages

All user-visible messages produced by `snap`. Categories follow PLAN.md §7:

- **§7.1 Byte-exact** — the complete stderr line is fixed to the exact bytes shown
- **§7.2 Anchored-regex** — the line matches the anchored pattern (`.` never matches LF)
- **§7.3 Required-substring** — the stderr output contains the substring
- **§7.4 Warning** — printed to stderr by `merge` when new auto-resolutions occur

---

## §7.1 Byte-exact stderr lines

| Message (exact bytes + `\n`) | Test(s) | Notes |
|---|---|---|
| `snap: working tree is clean` | 04:89–96 | Emitted by `commit` when tree matches current frontier |
| `snap: working tree is dirty` | 07:84–89, 20:33–41 | Emitted by `merge` and `revert` when working tree has uncommitted changes |
| `snap: target tree is already current` | 07:71–78 | Emitted by `revert` when the target version's tree equals the current tree (SPEC §7.7) |
| `snap: unsupported working tree entry: <path>` | 08:23–27, 08:43–49, 20:62–68 | `<path>` is the repo-relative path; `status`, `commit`, and `diff` all emit this |
| `snap: not a Snap repository` | 14:13–21 | Emitted when no `.snap/repository.json` is found walking up to root |
| `snap: invalid command or arguments` | 14:22–30, 24 (many) | Grammar error for every command except `diff` |
| `snap: invalid port: 65536` | 14:77–84 | Port out of 0–65535 range; `65536` is the pinned example |
| `snap: unknown version: (a@x->2)` | 14:68–75, 19:57–63 | Version is syntactically valid but not materializable |
| `snap: contributor.id is required; configure it locally or globally` | 19:81–87 | Emitted by `commit` and `revert` when no ID is configured (SPEC §8) |
| `snap: invalid commit message` | 25:124–130 | Empty string (`""`) is the pinned example; SPEC §7.5 also rejects >4096 bytes |
| `snap: repository has unknown field: unknown` | 23:18–24 | Unknown top-level field in `repository.json`; field name is embedded |
| `snap: delete of absent path: f` | 23:296–303 | Delete change whose path does not exist in the patch's base tree |
| `snap: SNAP_COLOR must be auto, always, or never` | 28:111–116 | SPEC §7.11 — emitted before command execution; always plain |

---

## §7.2 Anchored single-line regexes

All patterns compiled with no flags (`.` does not match LF). The line includes the trailing `\n`.

| Pattern | Test(s) | Notes |
|---|---|---|
| `^snap: .*canonical.*\n$` | 23:35–40 | Frontier not sorted in canonical UTF-8 order |
| `^snap: .+positive safe integer\n$` | 23:60–64, 23:206–214 | Fractional or zero/negative revision, or zero count in edit operation |
| `^snap: unreachable patch: .+\n$` | 23:82–88 | Patch not reachable from any frontier version |
| `^snap: .+message is empty\n$` | 23:107–112 | Patch `message` field is empty string; prefix before `message is empty` is required |
| `^snap: .+changes is empty\n$` | 23:130–136 | Patch `changes` array is empty; prefix required |
| `^snap: .+unknown field: extra\n$` | 23:154–162 | Unknown field in change object; field name is `extra`; prefix required |
| `^snap: .+must have one operation\n$` | 23:182–188 | Edit operation object has multiple keys; prefix required |
| `^snap: .+insert is empty\n$` | 23:232–240 | `insert` array is empty; prefix required |
| `^snap: .+consumes beyond old content\n$` | 23:264–271 | Edit consumes more tokens than available; prefix required |
| `^snap: usage: snap diff .+\n$` | 14:50–55, 24:22–29 | `diff` grammar error (distinct from other commands) |
| `^snap: duplicate JSON key .+\n$` | 15:14–24, 25:34–38 | Duplicate key in JSON input; key name in detail |
| `^snap: invalid contributor id: .+\n$` | 25:55–57, 25:63–69 | Bad contributor ID; detail nonempty; NOT "invalid id:" |
| `^snap: invalid version: .+\n$` | 19:41–47, 25:76–81 | Syntactically invalid version string; NOT "invalid version " without colon |
| `^snap: .+\n$` | 27 (all), 12:166–168, 26:75–77 | Generic fallback for error lines not pinned to exact wording |

---

## §7.3 Required substrings

The stderr output must *contain* the substring; surrounding text is unconstrained.

| Substring | Test(s) | Notes |
|---|---|---|
| `repository already exists` | 02:29–32 | `init` on an already-initialized directory |
| `cannot initialize inside repository` | 02:41–44 | `init` when an ancestor already has `.snap/` |
| `invalid JSON` | 03:65–67, 13:87–90 | Malformed JSON in config file or HTTP response body |
| `invalid contributor id` | 03:87–90 | Also matches §7.2 regex; appears here for the `config` command validation path |
| `usage: snap diff` | 14:50–55, 14:62–65 | Must be present; full usage line constrained by §7.2 regex |
| `unknown version` | 14:72–75 | `revert` with a version that does not exist in the local repo |
| `HTTP 302` | 13:95–100 | Redirect response from HTTP remote; status code must appear in message |
| `duplicate JSON key` | 15:14–24 | Also matches §7.2 regex; appears here for `status` against bad `repository.json` |
| `missing a@x` | 15:43–48 | Patch base references contributor `a@x` at a revision not present; exact contributor shown |
| `path is invalid` | 15:68–72 | NOT "invalid path" — ordering required; appears for `.snap/` prefix and other invalid paths |
| `canonical base64` | 15:91–96 | NOT "invalid base64"; `put` content fails RFC 4648 standard-padded check |
| `does not consume old content` | 15:122–127 | Edit under-consumes old tokens (§4.4); under-consumption direction |
| `tree paths conflict` | 15:149–154 | Single patch creates both `a` and `a/b` (prefix violation) |
| `cyclic or incomplete patch history` | 15:181–185 | Circular patch dependency detected during topological sort |
| `no-op change` | 15:211–216 | Change does not alter path existence or bytes (§4.3) |
| `adjacent insert` | 15:237–242 | Two consecutive `insert` operations in an edit script (§4.4) |
| `patch collision: a@x revision 1` | 16:55–58, 16:64–67 | Same dot with structurally different patch values (§3.5) |

---

## §7.4 Warning lines

Printed to **stderr** by `merge` only. One line per newly-appearing warning pair.

Format: `warning: auto-resolved <path>: <reason>`

In **terminal mode** (`SNAP_COLOR=always`): `S(33,"⚠") + " " + S(33,"auto-resolved <path>: <reason>") + LF`

| Reason token | Meaning | Test(s) |
|---|---|---|
| `delete-wins` | Incoming delete or earlier concurrent delete defeats concurrent edit (§6.4 rules 2, 3) | 10:92–95 |
| `later-create-wins` | Canonically later concurrent create defeats earlier concurrent create (§6.4 rule 4) | 17:54–56, 28:187–188 |
| `later-put-wins` | Incoming atomic `put` defeats concurrent text or other content (§6.4 rule 5) | 10:92–95 |
| `namespace-wins` | Path-namespace conflict resolved by removing blocking path (§6.2) | 11:50–51, 11:103–105 |
| `put-wins` | Existing non-text (`put`) content defeats incoming text edit (§6.4 rule 6) | 10:92–95 |

**Sort order:** Warning pairs are sorted by path, then by reason. Merge prints
only pairs that are *newly present* in the joined replay (absent from the
pre-merge local replay).

---

## §7.5 Other message constraints (pinned but not error messages per se)

| Fact | Source | Test(s) |
|---|---|---|
| `snap --version` prints `snap 1.0.0` exactly in plain mode | PLAN.md §7.5 rule 1 | 28:51–55 (terminal), 14:5–11 (plain, semver regex) |
| Revert message is `revert to <version>` (with exact canonical version string) | SPEC §7.7 | 07:64–69 |
| `snap init` prints `()` in plain mode; in terminal mode prints `S(32,"✓") + " " + S(1,"Initialized repository") + " " + S(36,"()") + LF` | SPEC §7.1, §7.11 | 28:8–11 |
| `snap: contributor.id is required; configure it locally or globally` is byte-exact including the semicolon | SPEC §8 | 19:81–87 |
| `snap: SNAP_COLOR must be auto, always, or never` is plain regardless of `SNAP_COLOR` value | SPEC §7.11 | 28:111–116 |

---

## Wording constraints summary (trap list)

The following wordings are **required** (not alternatives):

- `path is invalid` — NOT `invalid path`
- `canonical base64` — NOT `invalid base64`
- `does not consume old content` — under-consumption (NOT `incomplete edit`)
- `consumes beyond old content` — over-consumption (NOT `edit overflow`)
- `invalid contributor id:` — NOT `invalid id:` or `bad contributor id`
- `invalid version:` — NOT `unknown version:` (those are different error families)
- `patch collision: <author> revision <n>` — exact form required
- `missing <id>` — must appear in the error, e.g. `missing a@x`
- `message is empty` — must have a nonempty prefix (e.g. `patch message is empty`)
- `changes is empty` — must have a nonempty prefix
- `insert is empty` — must have a nonempty prefix
- `must have one operation` — must have a nonempty prefix
- `consumes beyond old content` — must have a nonempty prefix
- `unknown field: <name>` — must have a nonempty prefix
