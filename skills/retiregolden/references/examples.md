# build_plan examples

Every rate below is a **fraction** (`0.05` = 5%). `pia` is **monthly** dollars at FRA; `pension`/`spending`/balances are **annual/absolute** dollars; `claim_ages` are whole years. See the units table in `SKILL.md`.

`persons[]` order is load-bearing: `policy.claim_ages[i]` pairs with `persons[i]`.

---

## 1. Single filer (engine defaults)

No `assumptions` block → the engine's real-world defaults (~2.5% inflation, SS COLA tracking inflation, +3% healthcare inflation, 0% state/local tax, June-15 dob, `qualifiedRatio` 0.85). `state` is **required**. Add an `assumptions` block to model a specific inflation/return/COLA regime or a real state income-tax rate.

```json
{
  "household": {
    "filing": "single",
    "state": "OH",
    "persons": [
      { "birth_year": 1958, "trad": 800000, "roth": 120000, "pia": 2800 }
    ],
    "taxable": 300000,
    "taxable_basis": 180000,
    "spending": 65000,
    "horizon": 30,
    "growth": { "trad": 0.05, "roth": 0.05, "taxable": 0.05 },
    "heir_ordinary_rate": 0.24
  },
  "policy": {
    "claim_ages": [70],
    "conversion_bracket": 0.24,
    "conversion_years": 5,
    "ordering": "taxable-first"
  }
}
```

`conversion_bracket: 0.24` + `conversion_years: 5` runs fill-to-top-of-24%-bracket Roth conversions for 5 years from `startYear`. Omit both (or set `conversion_bracket: null`) for no conversions.

---

## 2. MFJ with pension + explicit assumptions overrides

A real couple in Ohio. The `assumptions` block pins a specific inflation/COLA/return regime and the real Ohio state + local income-tax rates (the engine models state tax at 0% until you set `stateEffectiveTaxPct`) — **state these assumptions in your answer**.

```json
{
  "household": {
    "filing": "mfj",
    "state": "OH",
    "persons": [
      { "birth_year": 1959, "trad": 900000, "roth": 150000, "pia": 3000, "pension": 24000 },
      { "birth_year": 1961, "trad": 300000, "roth": 50000, "pia": 1800 }
    ],
    "taxable": 400000,
    "taxable_basis": 250000,
    "spending": 90000,
    "horizon": 30,
    "growth": { "trad": 0.05, "roth": 0.05, "taxable": 0.05 },
    "heir_ordinary_rate": 0.24
  },
  "policy": {
    "claim_ages": [70, 67],
    "conversion_bracket": 0.24,
    "conversion_years": 6,
    "ordering": "taxable-first"
  },
  "assumptions": {
    "inflationPct": 3,
    "ssColaPct": 2.5,
    "state": "OH",
    "stateEffectiveTaxPct": 3.5,
    "localIncomeTaxPct": 2,
    "defaultReturnPct": 5,
    "healthcareExtraInflationPct": 1.5,
    "qualifiedRatio": 0.9,
    "dobMonthDay": "03-15",
    "sex": "average"
  }
}
```

- `pension: 24000` = $24k/yr ordinary-taxed pension for person 0. `pia: 3000` = $3,000/**month** at FRA.
- `claim_ages: [70, 67]` — person 0 claims at 70, person 1 at 67.
- **Watch the unit split:** household `growth.*` and `conversion_bracket` are **fractions** (`0.05`, `0.24`), but the `assumptions.*Pct` fields are **percents** (`inflationPct: 3` means 3%, not 300%). `qualifiedRatio` is a fraction (`0.9`). Assumptions fields are optional; each omitted field falls back to the engine default (`household.state` itself is required).
- **`growth.*` is NOMINAL** (headline) return, not inflation-adjusted — it is written straight into the engine's nominal `annualReturnPct`. With the default ~2.5% inflation, a `growth.trad: 0.05` models ~2.5% real. Use the nominal figure you'd quote (e.g. 5%), not a real one.

---

## 3. batch_evaluate — claim-age × conversion-bracket sweep

First `build_plan` a household (above), then sweep policies against it in **one** `batch_evaluate` call. Keep the list **<= 40 policies**; here 3 claim ages × 3 brackets = 9.

```json
{
  "policies": [
    { "claim_ages": [67, 67], "conversion_bracket": 0.12, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [67, 67], "conversion_bracket": 0.22, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [67, 67], "conversion_bracket": 0.24, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 67], "conversion_bracket": 0.12, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 67], "conversion_bracket": 0.22, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 67], "conversion_bracket": 0.24, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 70], "conversion_bracket": 0.12, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 70], "conversion_bracket": 0.22, "conversion_years": 6, "ordering": "taxable-first" },
    { "claim_ages": [70, 70], "conversion_bracket": 0.24, "conversion_years": 6, "ordering": "taxable-first" }
  ],
  "objective": "after_tax_estate"
}
```

`objective` is one of `after_tax_estate` (default), `cumulative_tax`, or `ending_trad`. The result is `{ ok: true, objective, results[], count }`; each `results[i]` has `{ index, policy, objective, ok, caveats }` (and `error` when `ok: false`). Rank the winner by the `objective` value and **surface `caveats`** (e.g. `traditional-first` is approximate).
