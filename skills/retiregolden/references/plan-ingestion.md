# Plan ingestion loop — building a plan from the user's documents

This is the highest-value flow: **you** (the AI client) read the user's real
documents — a 401(k) or brokerage statement, an IRA summary, another tool's
JSON/CSV export — and assemble a valid engine plan field-by-field. The MCP does
**not** parse documents (no OCR, no PDF handling); extraction is your job. The
MCP contributes three things: it tells you the plan format
(`describe_plan_schema`), it lets you build the plan up incrementally
(`update_plan`), and it validates on every step (`validate_plan`, and
`update_plan` internally).

## The loop

```
describe_plan_schema        # learn the plan format (once, or per-section)
        │
        ▼
build_plan { plan }         # seed a minimal but VALID plan (see below)
        │
        ▼
  ┌─────────────────────────────────────────┐
  │  extract fields from the next document   │  ← your job, not the MCP's
  │            │                             │
  │            ▼                             │
  │  update_plan { operations: [...] }       │  ← merge the fragment in;
  │            │                             │     validates before commit
  │            ▼                             │
  │  validate_plan   (optional re-check)     │
  └─────────────────────────────────────────┘
        │  repeat for each document / account
        ▼
export_plan                 # full plan JSON, ready to project or save
```

`update_plan` requires a plan already in the session — seed one first with
`build_plan` (a minimal full-plan JSON, or the typed `household`/`policy` path).
`update_plan` on an empty session returns `NO_PLAN`.

## Step 1 — learn the format

Call `describe_plan_schema` with no arguments for the whole document, or pass a
`path` to fetch just the subtree you are authoring and keep token cost down:

- `describe_plan_schema { path: "properties.accounts.items" }` — the account
  shapes (a `oneOf` over `taxable`, `traditional`, `roth`, `hsa`, `cash`,
  `pension`, `annuity`, …), including each type's **required** fields.
- `describe_plan_schema { path: "properties.incomes.items" }` — income shapes
  (`wages`, `socialSecurity`, `recurring`, `oneTime`).
- `describe_plan_schema { path: "properties.assumptions" }` — the modeling knobs.

`path` accepts either a dotted path (`properties.accounts.items`) or a JSON
pointer (`/properties/accounts/items`); array indices are numeric segments
(`properties.accounts.items.oneOf.0`). The response stamps `schemaVersion`, so
you know which plan version you are authoring against. The same schema is also
published as an MCP **resource** (`plan-schema`) for clients that prefer to load
it that way.

The schema is structural. Some rules `validate_plan`/`update_plan` enforce
cannot be expressed in JSON Schema (e.g. cross-field constraints); the schema
lists them under `x-retiregolden-unrepresentableConstraints`. Always validate —
do not trust a document just because it matches the structural shape.

## Step 2 — `update_plan` operations

`update_plan` takes an ordered `operations` array of **named domain operations**
(not raw JSON-Patch). Each operation targets an engine-plan **fragment** — the
same object shape `describe_plan_schema` documents. The batch is **atomic**: the
whole mutated plan is validated through the engine *before* anything is
committed, and if validation fails the session plan is left **unchanged** (no
half-applied merges). A later bad operation rolls back an earlier good one.

| Operation | Fields | Effect |
|---|---|---|
| `add_account` | `account` | append an account |
| `replace_account` | `id`, `account` | replace the account with that `id` |
| `remove_account` | `id` | drop the account with that `id` |
| `add_income` | `income` | append an income |
| `replace_income` | `id`, `income` | replace the income with that `id` |
| `remove_income` | `id` | drop the income with that `id` |
| `set_assumption` | `field`, `value` | set one `assumptions` field |
| `set_expense` | `field`, `value` | set one `expenses` field |

On success `update_plan` returns `appliedOperations`, a compact plan summary
(account + income ids/types, `expenseBaseAnnual`), and `caveats`. Failures come
back as successful MCP results with `ok: false`:

- `NO_PLAN` — nothing seeded; call `build_plan` first.
- `NO_OPERATIONS` — the `operations` array was empty.
- `OPERATION_FAILED` — an operation is malformed at the operation level; `issues`
  says which and why. Causes: a `replace_*` / `remove_*` referenced a **missing
  id**; a replacement fragment's own `id` **mismatched** the target id; a
  `set_assumption` / `set_expense` named an **unknown field** (a typo or
  hallucinated key — check it against `describe_plan_schema`) or omitted `value`;
  or a fragment carried an **unsafe key** (`__proto__` / `constructor` /
  `prototype`). Read `issues` and correct the specific operation.
- `INVALID_PLAN` — the operations were well-formed but the **merged plan** failed
  engine validation (`parsePlan`); `issues` lists the problems and the session
  plan is left untouched.

## Worked example — a brokerage statement → an account

Suppose the user hands you this statement text:

```
FIDELITY — Individual Brokerage — Acct ****4471
Total account value ........ $312,480.55
Cost basis (total) ......... $214,900.00
```

**1. Fetch the account subtree** so you know the taxable-account fields:

```
describe_plan_schema { "path": "properties.accounts.items" }
```

You learn a `taxable` account requires: `id`, `name`, `ownerPersonId`,
`annualReturnPct`, `type`, `balance`, `costBasis`, `annualContribution`.

**2. Map the statement to a fragment.** The statement gives you `balance` and
`costBasis`. The others you supply or default: `ownerPersonId` and
`annualReturnPct` may be `null` (owner unattributed, return falls back to the
plan default), `annualContribution` is `0` for a retiree no longer funding it.

**3. Merge it in** (assuming a plan is already seeded):

```
update_plan {
  "operations": [
    { "op": "add_account",
      "account": {
        "id": "fidelity-brokerage",
        "name": "Fidelity Individual Brokerage",
        "ownerPersonId": null,
        "annualReturnPct": null,
        "type": "taxable",
        "balance": 312480.55,
        "costBasis": 214900,
        "annualContribution": 0
      } }
  ]
}
```

`update_plan` validates the merged plan and commits it, returning the updated
summary. Repeat for the next document (the spouse's IRA → an `add_account` with
`type: "traditional"`, the pension → an `add_income` with `type: "recurring"`,
and so on).

**4. When you have added everything**, `export_plan` gives you the full plan JSON
to `run_projection` on, `compare_scenarios` with, or hand to the app.

## Asking the user for missing required fields

A statement rarely contains everything the schema requires. When a **required**
field is missing and you cannot responsibly default it, **ask the user** rather
than guess — a wrong balance or the wrong account type silently distorts every
downstream number. Safe defaults vs. must-ask:

- **Safe to default:** `id` (synthesize a stable slug), `name` (from the
  statement header), `ownerPersonId: null`, `annualReturnPct: null` (use the plan
  default), `annualContribution: 0` for a retired household.
- **Ask the user:** the account **type** when ambiguous (a "retirement account"
  could be `traditional` or `roth` — the tax treatment is completely different),
  `costBasis` when the statement omits it for a taxable account, `claimAge` for
  Social Security, and any dollar figure you are inferring rather than reading.

Batch your questions: extract everything you can, then ask once for the specific
gaps ("Is the $312k Fidelity account a Roth or a traditional IRA, or a regular
taxable brokerage?") instead of interrogating field-by-field.
