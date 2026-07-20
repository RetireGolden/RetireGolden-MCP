# Full engine-plan JSON

The `plan` argument to `build_plan` accepts a complete engine plan document (schema v1), bypassing the typed `household`/`policy` path and its bench conventions. Use it when you need fields the typed path does not expose (allocations, HSA, annuities, care events, per-account estate beneficiaries, etc.).

The engine validates with `parsePlan`; on failure `build_plan` returns `ok: false` with `issues[]`. **Engine rates are percents here** (`annualReturnPct: 5`, `inflationPct: 0`, `heirTaxRatePct: 24`) — this is the internal model, unlike the typed path's fractions.

The example below is minimal but parseable (it round-trips through `parsePlan`), and mirrors the MFJ household in `examples.md` under bench conventions.

## Section notes

- **top-level ids/timestamps** — `schemaVersion` must be `1`; `id`, `name`, `origin`, and the two ISO timestamps identify the document.
- **household** — filing status, state of residence, and the `people[]` (each with `dob`, `sex`, `retirementAge`, and a `longevity.planningAge` horizon endpoint).
- **accounts** — a discriminated union by `type` (`traditional`/`roth`/`taxable`/`hsa`/`cash`/…); balances, `annualReturnPct`, and per-type fields like the taxable account's `costBasis` and `qualifiedRatio`.
- **incomes** — a union by `type`: `socialSecurity` (with `piaMonthly` and `claimAge`), `recurring` (pensions/other, with `taxTreatment`), `wages`, and `oneTime`.
- **expenses** — `baseAnnual` spending plus phases, one-time goals, and the `healthcare` premium/Medicare block.
- **strategies** — `withdrawalOrder`, `rothConversion` (here `fillToTarget` at top of the 24% bracket for 2026–2030), and `qcdAnnual`.
- **assumptions** — economic knobs: inflation, SS COLA, state/local tax, `recentAnnualMagi` (IRMAA lookback), heir tax rate, safe-withdrawal rate. Bench conventions set the growth-neutral zeros shown here.
- **scenarios** — named `patch` overlays for comparison; empty here.

## Example

```json
{
  "schemaVersion": 1,
  "id": "id-2",
  "name": "mcp-session",
  "origin": "user",
  "createdAtIso": "2026-01-01T00:00:00.000Z",
  "updatedAtIso": "2026-01-01T00:00:00.000Z",
  "household": {
    "filingStatus": "marriedFilingJointly",
    "hasQualifyingDependent": false,
    "state": "KY",
    "stateMoves": [],
    "capitalLossCarryforward": 0,
    "people": [
      {
        "id": "person-0",
        "name": "P0",
        "dob": "1959-06-15",
        "sex": "average",
        "retirementAge": 66,
        "longevity": { "planningAge": 96, "source": "manual" }
      },
      {
        "id": "person-1",
        "name": "P1",
        "dob": "1961-06-15",
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
    { "id": "id-7", "name": "Brokerage", "ownerPersonId": null, "annualReturnPct": 5, "type": "taxable", "balance": 400000, "costBasis": 250000, "interestYieldPct": 0, "dividendYieldPct": 0, "qualifiedRatio": 0.85, "reinvestDividends": true, "annualContribution": 0 }
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
    "rothConversion": { "mode": "fillToTarget", "target": "topOfBracket", "targetValue": 24, "startYear": 2026, "endYear": 2030 },
    "qcdAnnual": 0
  },
  "assumptions": {
    "inflationPct": 0,
    "healthcareExtraInflationPct": 0,
    "defaultReturnPct": 0,
    "ssCola": { "mode": "fixed", "annualPct": 0 },
    "ssHaircut": null,
    "stateEffectiveTaxPct": 0,
    "localIncomeTaxPct": 0,
    "recentAnnualMagi": 0,
    "heirTaxRatePct": 24,
    "safeWithdrawalRatePct": 4
  },
  "scenarios": []
}
```
