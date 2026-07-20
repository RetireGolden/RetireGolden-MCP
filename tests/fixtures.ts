/**
 * Shared household/policy fixtures for the adapter, buildPlan, and gateway tests.
 * Not a test file (no *.test.ts suffix), so vitest does not execute it directly.
 */

import type { HouseholdParams, PolicyParams } from '../src/buildPlan.js'

export const singleHousehold: HouseholdParams = {
  filing: 'single',
  state: 'KY',
  persons: [{ birth_year: 1960, trad: 800_000, roth: 100_000, pia: 2500, fra_years: 67 }],
  taxable: 200_000,
  taxable_basis: 150_000,
  spending: 60_000,
  horizon: 10,
  growth: { trad: 0.05, roth: 0.05, taxable: 0.04 },
  pre_horizon_magi: [50_000, 52_000],
  heir_ordinary_rate: 0.24,
}

export const singlePolicy: PolicyParams = {
  claim_ages: [67],
  conversion_bracket: 0.22,
  conversion_years: 3,
  ordering: 'taxable-first',
}

/** Married-filing-jointly, two people, one with a pension. */
export const mfjHousehold: HouseholdParams = {
  filing: 'mfj',
  state: 'KY',
  persons: [
    { birth_year: 1958, trad: 900_000, roth: 150_000, pia: 2800, pension: 24_000, fra_years: 67 },
    { birth_year: 1960, trad: 400_000, roth: 80_000, pia: 1900, fra_years: 67 },
  ],
  taxable: 300_000,
  taxable_basis: 200_000,
  spending: 90_000,
  horizon: 15,
  growth: { trad: 0.05, roth: 0.05, taxable: 0.04 },
  pre_horizon_magi: [80_000, 82_000],
  heir_ordinary_rate: 0.24,
}

export const mfjPolicy: PolicyParams = {
  claim_ages: [70, 67],
  conversion_bracket: 0.22,
  conversion_years: 4,
  ordering: 'taxable-first',
}
