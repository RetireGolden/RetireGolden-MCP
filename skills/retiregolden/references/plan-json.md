# Full engine-plan JSON

The `plan` argument to `build_plan` accepts a complete engine plan document at any plan-schema version it has ever shipped (the engine migrates older documents forward before validating; `describe_plan_schema` reports the current version), bypassing the typed `household`/`policy` path entirely. Use it when you need fields the typed path does not expose (allocations, HSA, annuities, care events, per-account estate beneficiaries, etc.) — or to model something the typed path refuses, such as wages/pre-retirement earnings.

The engine validates with `parsePlan`; on failure `build_plan` returns `ok: false` with `issues[]`. **Engine rates are percents here** (`annualReturnPct: 5`, `inflationPct: 3`, `heirTaxRatePct: 24`) — this is the internal model, unlike the typed path's fractions.

The example below is minimal and round-trips through `build_plan`. It is the `plan` document out of a real `export_plan` response — the MFJ household from `examples.md` §2, built through the typed path with that example's `assumptions` overrides and then exported — so every field is one the current engine writes and reads. It is the `plan` field ALONE: the response also carries `startYear`, `conventions`, `caveats`, and the `schemaVersion` / `engineVersion` / `mcpVersion` siblings, and those are not shown here. Pass them back alongside the plan when you round-trip (`build_plan({ plan, startYear, conventions, schemaVersion, engineVersion })`); dropping `startYear` re-runs a non-2026 session from the default year and its projection will diverge. A document written against an older plan-schema version is migrated forward on import and accepted with a caveat naming both versions — re-export it afterwards to persist the upgrade.

## Section notes

- **top-level ids/timestamps** — `schemaVersion` is the version the document was written against (`5` here, which is what a freshly exported document carries); `id`, `name`, `origin`, and the two ISO timestamps identify the document.
- **household** — filing status, state of residence, and the `people[]` (each with `dob`, `sex`, `retirementAge`, and a `longevity.planningAge` horizon endpoint).
- **accounts** — a discriminated union by `type` (`traditional`/`roth`/`taxable`/`hsa`/`cash`/…); balances, `annualReturnPct`, and per-type fields like the taxable account's `costBasis` and `qualifiedRatio`.
- **incomes** — a union by `type`: `socialSecurity` (with `piaMonthly` and `claimAge`), `recurring` (pensions/other, with `taxTreatment`), `wages`, and `oneTime`. Both `recurring` and `oneTime` carry a required `inflationAdjusted` boolean: `true` means the amount is in today's dollars and grows to the year it pays; `false` means it is that year's dollars, taken as written. Documents from before plan-schema v5 had no election on `oneTime` and migrate in as `false`, which preserves what they already projected; when you author a new one-time amount in today's dollars, set it `true`. (One-time spending goals carry no such election — their `amount` is always today's dollars and always grown to the goal year — so `true` gives a one-time income that same reading; there is no goal-side field to mirror.)
- **expenses** — `baseAnnual` spending plus phases, one-time goals, and the `healthcare` premium/Medicare block.
- **strategies** — `withdrawalOrder`, `rothConversion` (here `fillToTarget` at top of the 24% bracket for 2026–2031), `qcdAnnual`, and `retirementActions` (an explicit per-year action list, empty here).
- **assumptions** — economic knobs: inflation, SS COLA, state/local tax, `historicalAnnualMagiByYear` (exact IRMAA lookback tax years; `recentAnnualMagi` is the scalar fallback), heir tax rate, safe-withdrawal rate. The values below come from the `examples.md` §2 overrides; a document you author supplies your own (the typed path fills unset fields from the engine defaults).
- **scenarios** — named `patch` overlays for comparison; empty here.

## Example

```json
{
  "schemaVersion": 5,
  "id": "id-2",
  "name": "mcp-session",
  "origin": "user",
  "createdAtIso": "2026-01-01T00:00:00.000Z",
  "updatedAtIso": "2026-01-01T00:00:00.000Z",
  "household": {
    "filingStatus": "marriedFilingJointly",
    "hasQualifyingDependent": false,
    "state": "OH",
    "stateMoves": [],
    "capitalLossCarryforward": 0,
    "people": [
      {
        "id": "person-0",
        "name": "P0",
        "dob": "1959-03-15",
        "sex": "average",
        "retirementAge": 66,
        "longevity": { "planningAge": 96, "source": "manual" }
      },
      {
        "id": "person-1",
        "name": "P1",
        "dob": "1961-03-15",
        "sex": "average",
        "retirementAge": 64,
        "longevity": { "planningAge": 94, "source": "manual" }
      }
    ]
  },
  "accounts": [
    { "id": "id-3", "name": "Trad0", "ownerPersonId": "person-0", "annualReturnPct": 5, "type": "traditional", "kind": "ira", "balance": 900000, "annualContribution": 0 },
    { "id": "id-4", "name": "Roth0", "ownerPersonId": "person-0", "annualReturnPct": 5, "type": "roth", "kind": "ira", "balance": 150000, "annualContribution": 0 },
    { "id": "id-5", "name": "Trad1", "ownerPersonId": "person-1", "annualReturnPct": 5, "type": "traditional", "kind": "ira", "balance": 300000, "annualContribution": 0 },
    { "id": "id-6", "name": "Roth1", "ownerPersonId": "person-1", "annualReturnPct": 5, "type": "roth", "kind": "ira", "balance": 50000, "annualContribution": 0 },
    { "id": "id-7", "name": "Brokerage", "ownerPersonId": null, "annualReturnPct": 5, "type": "taxable", "balance": 400000, "costBasis": 250000, "interestYieldPct": 0, "dividendYieldPct": 0, "qualifiedRatio": 0.9, "reinvestDividends": true, "annualContribution": 0 }
  ],
  "insurance": [],
  "careEvents": [],
  "incomes": [
    { "type": "recurring", "id": "id-8", "label": "Pension0", "annualAmount": 24000, "startYear": null, "endYear": null, "inflationAdjusted": false, "taxTreatment": "ordinary" },
    { "type": "socialSecurity", "id": "id-9", "personId": "person-0", "piaMonthly": 3000, "earnings": null, "claimAge": { "years": 70, "months": 0 } },
    { "type": "socialSecurity", "id": "id-10", "personId": "person-1", "piaMonthly": 1800, "earnings": null, "claimAge": { "years": 67, "months": 0 } }
  ],
  "expenses": {
    "baseAnnual": 90000,
    "phases": [],
    "oneTimeGoals": [],
    "healthcare": {
      "pre65MonthlyPremiumPerPerson": 0,
      "applyAcaCredit": false,
      "medicareExtrasMonthlyPerPerson": 0
    }
  },
  "strategies": {
    "withdrawalOrder": { "mode": "sequential" },
    "rothConversion": { "mode": "fillToTarget", "target": "topOfBracket", "targetValue": 24, "startYear": 2026, "endYear": 2031 },
    "qcdAnnual": 0,
    "retirementActions": []
  },
  "assumptions": {
    "inflationPct": 3,
    "healthcareExtraInflationPct": 1.5,
    "defaultReturnPct": 5,
    "ssCola": { "mode": "fixed", "annualPct": 2.5 },
    "ssHaircut": null,
    "stateEffectiveTaxPct": 3.5,
    "localIncomeTaxPct": 2,
    "recentAnnualMagi": 0,
    "historicalAnnualMagiByYear": { "2024": 0, "2025": 0 },
    "heirTaxRatePct": 24,
    "safeWithdrawalRatePct": 4
  },
  "scenarios": []
}
```
