/**
 * Golden-number generator for tests/goldens.test.ts.
 *
 * The recipe that produces those literals used to live only in a gitignored
 * scratchpad file the test's header pointed at, so nobody but its author could
 * reproduce a golden — and an unreproducible golden is a number you can only
 * "fix" by copying whatever the code now returns, which is the one thing these
 * tests exist to prevent.
 *
 *     pnpm run goldens:print
 *
 * PRINTS paste-ready `expect(...)` lines. It never edits the test. Refreshing a
 * golden stays a deliberate, reviewed act: run this, read the diff against the
 * committed literals, and only then decide whether the engine bump justifies
 * moving them. A number that moves with the engine pin unchanged is a
 * regression, not a golden to adjust.
 *
 * Numbers come from `dist/`, rebuilt first, for the same reason
 * scripts/capture-protocol-baseline.mjs rebuilds: generating from a stale build
 * would freeze the pre-change behavior under a post-change source tree.
 *
 * The fixtures below are copies of the ones in tests/goldens.test.ts. They are
 * deliberately duplicated rather than imported: the test file is the frozen
 * artifact, and importing it here would run vitest's describe/it outside a
 * runner. If a fixture ever changes, change it in both places in the same
 * commit — every literal moves anyway.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Every RetireBench convention stated explicitly (see the test's header). */
const BENCH_ASSUMPTIONS = {
  inflationPct: 0,
  healthcareExtraInflationPct: 0,
  defaultReturnPct: 0,
  ssColaPct: 0,
  state: 'KY',
  stateEffectiveTaxPct: 0,
  localIncomeTaxPct: 0,
  qualifiedRatio: 0.85,
  dobMonthDay: '06-15',
  sex: 'average',
}

const singleHousehold = {
  filing: 'single',
  state: 'KY',
  persons: [{ birth_year: 1960, trad: 900_000, roth: 150_000, pia: 2800 }],
  taxable: 300_000,
  taxable_basis: 200_000,
  spending: 90_000,
  horizon: 25,
  growth: { trad: 0.05, roth: 0.05, taxable: 0.04 },
  heir_ordinary_rate: 0.24,
}
const singlePolicy = {
  claim_ages: [70],
  conversion_bracket: 0.22,
  conversion_years: 8,
  ordering: 'taxable-first',
}

const mfjHousehold = {
  filing: 'mfj',
  state: 'KY',
  persons: [
    { birth_year: 1959, trad: 1_200_000, roth: 200_000, pia: 3100, pension: 18_000 },
    { birth_year: 1962, trad: 400_000, roth: 80_000, pia: 1900 },
  ],
  taxable: 500_000,
  taxable_basis: 350_000,
  spending: 130_000,
  horizon: 30,
  growth: { trad: 0.05, roth: 0.06, taxable: 0.04 },
  pre_horizon_magi: [110_000, 115_000],
  heir_ordinary_rate: 0.22,
}
const mfjPolicy = {
  claim_ages: [70, 67],
  conversion_bracket: 0.24,
  conversion_years: 6,
  ordering: 'proportional',
}

const SUMMARY_HEAD = [
  'lifetimeTaxesAndPenalties',
  'lifetimeRothConversions',
  'endingInvestable',
  'endingNetWorth',
  'endingAfterTaxEstate',
  'endingEstateHeirTax',
  'endingEstateToCharity',
  'endingByCategory.cash',
  'endingByCategory.taxable',
  'endingByCategory.traditional',
  'endingByCategory.roth',
  'endingByCategory.hsa',
  'depletionYear',
]
const SUMMARY_TAIL = ['fiNumber', 'coastFireNumber']
const LEGACY_SUMMARY = [...SUMMARY_HEAD, 'averagePreRetirementSavingsRatePct', ...SUMMARY_TAIL]
const DEFAULTS_SUMMARY = [...SUMMARY_HEAD, ...SUMMARY_TAIL]

const FULL_YEAR = [
  'year',
  'tax',
  'penalties',
  'magi',
  'medicarePremiums',
  'irmaaTier',
  'rothConversion',
  'withdrawals.cash',
  'withdrawals.taxable',
  'withdrawals.traditional',
  'withdrawals.roth',
  'withdrawals.hsa',
  'withdrawals.total',
  'shortfall',
]

/**
 * One entry per `describe` block in tests/goldens.test.ts. `summary`, `first`
 * and `last` list exactly the fields that block asserts, in its order, so the
 * printed lines can be compared to the committed ones line for line.
 */
const SETS = [
  {
    title: 'golden numbers — SINGLE fixture [legacy bench conventions via explicit assumptions]',
    household: singleHousehold,
    policy: singlePolicy,
    assumptions: BENCH_ASSUMPTIONS,
    summary: LEGACY_SUMMARY,
    first: FULL_YEAR,
    last: [
      'year',
      'tax',
      'penalties',
      'magi',
      'medicarePremiums',
      'irmaaTier',
      'rothConversion',
      'withdrawals.roth',
      'withdrawals.total',
      'shortfall',
    ],
  },
  {
    title: 'golden numbers — MFJ fixture [legacy bench conventions via explicit assumptions]',
    household: mfjHousehold,
    policy: mfjPolicy,
    assumptions: BENCH_ASSUMPTIONS,
    summary: LEGACY_SUMMARY,
    first: FULL_YEAR,
    last: FULL_YEAR,
  },
  {
    title: 'golden numbers — SINGLE fixture [new engine defaults, no assumptions]',
    household: singleHousehold,
    policy: singlePolicy,
    summary: DEFAULTS_SUMMARY,
    first: [
      'year',
      'tax',
      'magi',
      'medicarePremiums',
      'rothConversion',
      'withdrawals.taxable',
      'withdrawals.total',
      'shortfall',
    ],
    last: [
      'year',
      'tax',
      'penalties',
      'magi',
      'medicarePremiums',
      'irmaaTier',
      'rothConversion',
      'withdrawals.roth',
      'withdrawals.total',
      'shortfall',
    ],
  },
  {
    title: 'golden numbers — MFJ fixture [new engine defaults, no assumptions]',
    household: mfjHousehold,
    policy: mfjPolicy,
    summary: DEFAULTS_SUMMARY,
    first: ['year', 'tax', 'magi', 'medicarePremiums', 'rothConversion', 'withdrawals.total'],
    last: [
      'year',
      'tax',
      'penalties',
      'magi',
      'medicarePremiums',
      'irmaaTier',
      'rothConversion',
      'withdrawals.taxable',
      'withdrawals.roth',
      'withdrawals.total',
      'shortfall',
    ],
  },
]

function pick(value, dottedPath) {
  return dottedPath.split('.').reduce((node, key) => node?.[key], value)
}

/** `expect(<subject>.<path>).toBe(<literal>)`, or `.toBeNull()` for null. */
function expectLine(subject, dottedPath, value) {
  const target = `expect(${subject}.${dottedPath})`
  if (value === null) return `    ${target}.toBeNull()`
  // A non-zero value this small is float residue from the solver, not a
  // modeled amount. tests/goldens.test.ts asserts toBeCloseTo(0, 6) there
  // rather than freezing a bit pattern; flag it instead of printing a literal
  // that would tighten the assertion on paste.
  const residual =
    typeof value === 'number' && value !== 0 && Math.abs(value) < 1e-6
      ? '  // residual — the test asserts toBeCloseTo(0, 6) here, keep it that way'
      : ''
  return `    ${target}.toBe(${String(value)})${residual}`
}

function requireOk(result, label) {
  if (!result?.ok) throw new Error(`${label} did not return ok:true`)
  return result
}

/**
 * The recipe the test's header documents, unchanged:
 *   createSession() -> setPlanFromBuild(startYear 2026) -> runProjection('years')
 *   -> runMonteCarlo(300, seed 7) -> batchEvaluate([policy, no-conversion policy],
 *   'after_tax_estate'), with totalTax / totalConversions summed over years[].
 */
function runFixture({ createSession, adapter }, household, policy, assumptions) {
  const session = createSession()
  const build = requireOk(
    adapter.setPlanFromBuild(session, {
      household,
      policy,
      startYear: 2026,
      ...(assumptions ? { assumptions } : {}),
    }),
    'setPlanFromBuild',
  )
  // detail:'years' is REQUIRED — the default 'summary' omits the per-year ledger.
  const proj = requireOk(adapter.runProjection(session, { detail: 'years' }), 'runProjection')
  if (!('years' in proj)) throw new Error('projection missing years')
  const mc = requireOk(adapter.runMonteCarlo(session, { pathCount: 300, seed: 7 }), 'runMonteCarlo')
  const batch = requireOk(
    adapter.batchEvaluate(
      session,
      [policy, { ...policy, conversion_bracket: null, conversion_years: 0 }],
      'after_tax_estate',
    ),
    'batchEvaluate',
  )
  const years = proj.years
  return {
    build,
    proj,
    years,
    firstYear: years[0],
    lastYear: years[years.length - 1],
    totalTax: years.reduce((sum, year) => sum + year.tax, 0),
    totalConversions: years.reduce((sum, year) => sum + year.rothConversion, 0),
    mc,
    batch,
  }
}

function printSet(modules, set) {
  const g = runFixture(modules, set.household, set.policy, set.assumptions)
  const lines = []
  lines.push(`describe('${set.title}', () => {`)
  lines.push('')
  lines.push("  it('projection window', () => {")
  lines.push(`    expect(g.proj.startYear).toBe(${g.proj.startYear})`)
  lines.push(`    expect(g.proj.endYear).toBe(${g.proj.endYear})`)
  lines.push(`    expect(g.years).toHaveLength(${g.years.length})`)
  lines.push('  })')
  lines.push('')
  lines.push("  it('projection summary headline numbers', () => {")
  for (const field of set.summary) lines.push(expectLine('s!', field, pick(g.proj.summary, field)))
  lines.push('  })')
  lines.push('')
  lines.push("  it('first projection year', () => {")
  for (const field of set.first) lines.push(expectLine('y', field, pick(g.firstYear, field)))
  lines.push('  })')
  lines.push('')
  lines.push("  it('last projection year', () => {")
  for (const field of set.last) lines.push(expectLine('y', field, pick(g.lastYear, field)))
  lines.push('  })')
  lines.push('')
  lines.push("  it('totalTax and totalConversions', () => {")
  lines.push(`    expect(g.totalTax).toBe(${g.totalTax})`)
  lines.push(`    expect(g.totalConversions).toBe(${g.totalConversions})`)
  lines.push('  })')
  lines.push('')
  lines.push("  it('monte carlo (pathCount 300, seed 7)', () => {")
  lines.push(`    expect(g.mc.successRate).toBe(${g.mc.successRate})`)
  lines.push(`    expect(g.mc.requiredFloorSuccessRate).toBe(${g.mc.requiredFloorSuccessRate})`)
  lines.push('  })')
  lines.push('')
  lines.push("  it('batch objectives (base policy, then no-conversion policy)', () => {")
  lines.push('    expect(g.batch.results.map((r) => r.objective)).toEqual([')
  lines.push(`      ${g.batch.results.map((r) => String(r.objective)).join(', ')},`)
  lines.push('    ])')
  lines.push('  })')
  lines.push('})')
  console.log(lines.join('\n'))
  console.log('')
}

async function main() {
  // Same rule as the protocol baseline: never generate from a stale build.
  await execFile('pnpm', ['run', 'build'], {
    cwd: PACKAGE_ROOT,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  const [sessionModule, adapter] = await Promise.all([
    import(pathToFileURL(resolve(PACKAGE_ROOT, 'dist/session.js')).href),
    import(pathToFileURL(resolve(PACKAGE_ROOT, 'dist/adapter.js')).href),
  ])
  const modules = { createSession: sessionModule.createSession, adapter }
  console.log('// Generated by scripts/gen-goldens.mjs — paste into tests/goldens.test.ts')
  console.log('// deliberately, never to make a red test green. Some blocks in the test')
  console.log('// use a looser matcher (toBeCloseTo) or add non-numeric assertions; those')
  console.log('// lines are not reproduced here.')
  console.log('')
  for (const set of SETS) printSet(modules, set)
}

await main()
