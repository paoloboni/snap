# Architecture

Technical architecture of the Snap TypeScript implementation.

---

## Module Map

```
ts/src/
  main.ts                 Entry point: parse argv, dispatch, exit 0/1/2
  errors.ts               SnapError class + complete message catalogue
  build-info.ts           SNAP_VERSION = "1.0.0"

  cli/
    grammar.ts            Strict positional argv → discriminated Command union
    dispatch.ts           Routes Command union to command handlers

  present/
    mode.ts               SNAP_COLOR / NO_COLOR / per-stream TTY auto detection
    sgr.ts                S(n, text) ANSI SGR helper
    render.ts             Plain ↔ terminal renderers for every output family

  core/
    version.ts            Parse/format/4-way compare/join/snapOrder
    contributor.ts        ASCII email-shaped ID validation
    path.ts               Tracked-path validation, UTF-8 byte order, prefix ops
    tokens.ts             Text detection, LF tokenization, token canonicality
    diff.ts               §5 canonical diff: reference DP oracle + Hirschberg
    edit.ts               Edit-script validation and application
    ot.ts                 §6.3 transform (Q-insert priority)
    tree.ts               Immutable path→bytes map + sorted key array

  repo/
    json.ts               Duplicate-key-rejecting JSON parser + canonical serializer
    model.ts              Repository/Patch/Change typed value interfaces
    validate.ts           §4.5 ordered validation pipeline (6 checks)
    replay.ts             §6.1/6.2/6.4 replay, binary heap ordering, warning set
    store.ts              Repository discovery walk, atomic same-dir temp replace
    config.ts             §8 local-over-global ID resolution

  fsys/
    materialize.ts        Install exact target path/byte map onto filesystem
    worktree.ts           Scan working tree, detect unsupported entries, classify status

  net/
    server.ts             --serve snapshot server (127.0.0.1 only, SIGTERM/SIGINT)
    client.ts             Single validated GET for HTTP repository operands

  commands/
    init.ts               snap init [path]
    config.ts             snap config [--global] contributor.id <id>
    status.ts             snap status
    log.ts                snap log
    commit.ts             snap commit <message>
    diff.ts               snap diff [<old> <new> [--repo <repo>]]
    revert.ts             snap revert <version>
    merge.ts              snap merge <repository>
    serve.ts              snap --serve [port]

ts/test/                  Unit + property + YAML-inexpressible coverage
ts/bench/                 Benchmark scripts with recorded budgets
```

### Key Dependencies

```
main.ts
  → cli/grammar.ts        (parse argv)
  → cli/dispatch.ts       (route)
  → present/mode.ts       (select presentation)
  → errors.ts             (SnapError, exit codes)

cli/dispatch.ts
  → commands/*.ts         (one per command)
  → present/render.ts     (format output)

commands/*.ts
  → repo/store.ts         (discover & load repository)
  → repo/validate.ts      (validate before use)
  → repo/replay.ts        (materialize versions)
  → fsys/worktree.ts      (scan working tree)
  → fsys/materialize.ts   (write target tree)
  → core/diff.ts          (diff two trees)
  → core/ot.ts            (transform during replay)
  → repo/config.ts        (read contributor ID)
  → net/client.ts         (HTTP repository fetch)
  → net/server.ts         (serve snapshot)

repo/validate.ts
  → repo/json.ts          (duplicate-key-rejecting parse)
  → repo/model.ts         (typed value interfaces)
  → core/version.ts       (version validation)
  → core/contributor.ts   (ID validation)
  → core/path.ts          (path validation)
  → core/tokens.ts        (text detection)
  → core/edit.ts          (edit script validation)
  → repo/replay.ts        (deterministic replay for check 6)

repo/replay.ts
  → core/tree.ts          (immutable tree)
  → core/diff.ts          (aggregate context diff Q)
  → core/ot.ts            (transform P through Q)
  → core/edit.ts          (apply transformed edit)
```

---

## Data Flow

```
CLI invocation
  │
  ▼
main.ts
  ├─ present/mode.ts      SNAP_COLOR + NO_COLOR + TTY detection → PresentationMode
  ├─ cli/grammar.ts       argv → Command (discriminated union) | grammar error
  └─ cli/dispatch.ts
        │
        ▼
   command handler (commands/*.ts)
        │
        ├─ repo/store.ts  walk up to find .snap/ → load .snap/repository.json
        │       └─ repo/json.ts   duplicate-key-rejecting JSON.parse
        │
        ├─ repo/validate.ts  §4.5 pipeline:
        │       1. schema + types + IDs + paths + messages + changes
        │       2. patch sort, one value per dot, contiguous revisions
        │       3. base closure, revision = base[author] + 1
        │       4. acyclic causality (topological sort)
        │       5. each change vs. materialized exact base
        │       6. deterministic frontier replay
        │
        ├─ repo/config.ts  .snap/config.json → $HOME/.snapconfig.json → ID
        │
        ├─ fsys/worktree.ts  scan files → {path, status} | unsupported-entry error
        │
        ├─ core/diff.ts   diff(oldTree, newTree) → edit scripts per path
        │
        ├─ repo/replay.ts  materialize version V:
        │       ┌─ select patches where n ≤ V[c]
        │       ├─ binary heap keyed (snapOrder(result), author, revision)
        │       ├─ for each patch in heap order:
        │       │    materialize exact base B (memoized)
        │       │    for each path in patch:
        │       │      compute T = apply change to B
        │       │      rule 1: B==C → apply directly
        │       │      rule 2: C==T → no-op (identical concurrent)
        │       │      rule 3: text+text → diff(B,C)=Q, ot(P,Q) → apply
        │       │      rule 4: path-level winner rules (§6.4)
        │       │    namespace conflict resolution (§6.2)
        │       └─ return tree + warning set
        │
        ├─ fsys/materialize.ts  install target path/byte map:
        │       remove files blocking required dirs
        │       create required parent dirs
        │       write target files
        │       remove newly empty dirs
        │
        ├─ repo/store.ts (write)  atomic temp-file replace of repository.json
        │
        └─ present/render.ts  format output → stdout/stderr
                └─ present/sgr.ts  S(n, text) for terminal mode
```

---

## Key Algorithmic Choices

### Canonical diff (§5) — Hirschberg + reference DP oracle

The spec defines a specific recurrence (`D(i,j)`) with a deletion-on-tie
rule at step 2. The reference implementation keeps the full `O(n·m)` DP table
permanently as a differential oracle. A linear-space Hirschberg implementation
runs alongside it for large inputs. Both must produce identical scripts; the
oracle is used in `ts/test/` to verify equivalence. This eliminates the risk
of Hirschberg subtly diverging on tied cases.

Delete-on-tie: at step 2, `delete 1` is chosen when
`D(i+1,j) ≤ D(i,j+1)` (strict ≤, not <). This must be preserved through any
optimization.

### OT transform (§6.3)

The six-row table is processed with a priority queue of `(Q insert, P insert,
min-retain/delete)` decisions. The "Q insert" row has absolute priority: any
Q insert that appears while processing emits a `retain(length)` in the
transformed P output, regardless of what P's next operation is. This ensures
concurrent inserts at one cursor appear in canonical integration order.

Count splitting is used rather than script normalization: when a retain/delete
spans a boundary, split the minimum and continue from both sides.

### Replay ordering — binary heap

Patches are ordered by `(snapOrder(result), author, revision)` (§6.1 rules
1–3). A binary heap (min-heap) keyed on this triple gives `O(log P)` extraction
per patch, and dependency tracking via per-patch "unresolved base count"
counters. A patch moves into the heap when its counter reaches zero (all base
patches already integrated). Overall complexity: `O(P log P · k)` where `k` is
the average number of changed paths per patch, versus naive `O(P³)`.

### Memoized base-tree materialization

Each patch's exact base tree is built by replaying the patches selected by
`n ≤ base[c]`. Because many patches share bases, memoization avoids
re-materializing the same sub-history repeatedly. The memoization key is the
base version (vector clock). Memory cost is bounded by the number of distinct
base versions, which equals the number of patches.

### Token interning

Text tokens are interned to integer IDs on first encounter. All diff and OT
operations work on integer arrays, eliminating repeated string allocations and
comparisons. Intern tables are scoped per materialization context to avoid
unbounded growth.

### Tree representation — Map + sorted key array

`core/tree.ts` maintains an immutable `Map<path, bytes>` for O(1) point
lookups plus a sorted `string[]` for the path order. Descendant queries
for the namespace conflict rule (§6.2) use binary search on the sorted array
to find the range of paths with a given prefix: `O(log n + k)` where `k` is
the number of matching paths. Ancestor checks walk the path's segments upward:
`O(depth)`.

---

## Error Handling

### Exit codes

| Code | Meaning | Source |
|---|---|---|
| 0 | Success | SPEC §10 |
| 1 | Expected error (invalid input, validation failure, precondition not met) | SPEC §10 |
| 2 | Unexpected internal failure (bug, assertion, unhandled exception) | SPEC §10 |

### SnapError

`errors.ts` defines `SnapError extends Error` with a `message` string (the
`snap: <detail>` line without the newline) and no additional fields. Throwing
a `SnapError` causes `main.ts` to print the message to stderr and exit 1.
Any other thrown value causes exit 2.

### Error precedence (DEC-015)

Pre-condition checks are evaluated in this order (highest priority first):

1. Grammar / argument parsing
2. `SNAP_COLOR` validation
3. Unsupported working tree entry
4. Working tree dirty
5. Invalid version syntax
6. Unknown version (not materializable)
7. Missing contributor.id
8. Working tree clean (for commit)
9. Invalid message (for commit)
10. Repository validation (local then remote)

### Validation-before-mutation (§10)

For `merge` and `revert`: all parsing, validation, replay, dirty-tree checks,
and target-tree construction complete before any file is written. Validation
failures cause no filesystem mutation.

For `commit`: the working tree is already in the desired state; only
`repository.json` needs to be updated. The atomic temp-file rename is the sole
mutation.

---

## Performance Design

From PLAN.md §9:

| Component | Strategy |
|---|---|
| Token comparison | Integer IDs (intern on first use), not string equality |
| Diff algorithm | Hirschberg (linear space) with DP oracle for equivalence testing |
| Replay ordering | Binary heap, `O(P log P · k)` |
| Base materialization | Memoized by version, built at most once per unique base |
| Tree namespace queries | Sorted key array, binary-search prefix range, `O(log n + k)` |
| Ancestor check | Walk path segments, `O(depth)` |

Benchmark gate: `ts/bench/` scripts with recorded budgets, enforced in CI via
the `Quality/Perf Agent` gate (Phase 6).
