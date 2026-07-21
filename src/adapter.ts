/**
 * Headless engine adapter — projection, MC, batch evaluate, optimizer, spending.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { simulatePlan, summarizeProjection, type Plan } from '@retiregolden/engine'
import { parsePlan } from '@retiregolden/engine/model/plan'
import {
  planJsonSchema,
  PLAN_SCHEMA_VERSION,
  PLAN_SCHEMA_ID,
} from '@retiregolden/engine/schema'
import { createFederalTaxCalculator } from '@retiregolden/engine/tax/federalTax'
import { runMonteCarloPaths, aggregateMonteCarlo } from '@retiregolden/engine/montecarlo/run'
import { createLognormalModel } from '@retiregolden/engine/montecarlo/marketModels'
import { optimizePlan } from '@retiregolden/engine/projection/optimizePlan'
import { solveMaxSustainableSpending } from '@retiregolden/engine/decisions/spendingSolver'
import { buildPlanFromParams, type BuildPlanInput, type PolicyParams } from './buildPlan.js'
import type { SessionState } from './session.js'

function taxCalc() {
  return createFederalTaxCalculator()
}

let cachedVersions: { mcpVersion: string | null; engineVersion: string | null } | null = null

/**
 * Resolve the running @retiregolden/mcp and @retiregolden/engine versions.
 * Never throws — any resolution failure degrades to null for that field.
 */
export function getVersions(): { mcpVersion: string | null; engineVersion: string | null } {
  if (cachedVersions) return cachedVersions
  const require = createRequire(import.meta.url)
  let mcpVersion: string | null = null
  let engineVersion: string | null = null
  try {
    mcpVersion = (require('../package.json') as { version?: string }).version ?? null
  } catch {
    mcpVersion = null
  }
  try {
    // Engine's exports map exposes ./package.json, so the subpath require normally works.
    engineVersion =
      (require('@retiregolden/engine/package.json') as { version?: string }).version ?? null
  } catch {
    try {
      // Fallback: resolve the package root from a known entry and walk up to package.json.
      let dir = path.dirname(require.resolve('@retiregolden/engine'))
      for (let i = 0; i < 8; i++) {
        const pj = path.join(dir, 'package.json')
        if (fs.existsSync(pj)) {
          const parsed = JSON.parse(fs.readFileSync(pj, 'utf8')) as {
            name?: string
            version?: string
          }
          if (parsed.name === '@retiregolden/engine') {
            engineVersion = parsed.version ?? null
            break
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      engineVersion = null
    }
  }
  cachedVersions = { mcpVersion, engineVersion }
  return cachedVersions
}

export function validatePlanJson(input: unknown) {
  return parsePlan(input)
}

export function setPlanFromBuild(session: SessionState, input: BuildPlanInput) {
  const result = buildPlanFromParams(input)
  if (!result.ok || !result.plan) {
    return result
  }
  session.plan = result.plan
  session.startYear = result.startYear
  session.caveats = [...result.caveats]
  if (input.conventions) session.conventions = { ...input.conventions }
  session.lastProjection = null
  return result
}

export function runProjection(
  session: SessionState,
  opts: { detail?: 'summary' | 'years' } = {},
) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  const result = simulatePlan(session.plan, {
    startYear: session.startYear,
    taxCalculator: taxCalc(),
  })
  const summary = summarizeProjection(session.plan, result)
  session.lastProjection = { result, summary }
  const base = {
    ok: true as const,
    startYear: result.startYear,
    endYear: result.endYear,
    summary,
    caveats: session.caveats,
  }
  if (opts.detail !== 'years') {
    // 'summary' (default): omit the per-year array; summary carries the totals.
    return base
  }
  return {
    ...base,
    years: result.years.map((y) => ({
      year: y.year,
      tax: y.tax,
      penalties: y.penalties,
      magi: y.magi,
      medicarePremiums: y.medicarePremiums,
      irmaaTier: y.irmaaTier,
      rothConversion: y.rothConversion,
      withdrawals: y.withdrawals,
      shortfall: y.shortfall,
    })),
  }
}

export function runMonteCarlo(
  session: SessionState,
  opts: { pathCount?: number; seed?: number } = {},
) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  const pathCount = opts.pathCount ?? 200
  const seed = opts.seed ?? 42
  const model = createLognormalModel({
    type: 'lognormal',
    inflationMeanPct: session.plan.assumptions.inflationPct,
    returnVolPct: 12,
  })
  const paths = runMonteCarloPaths(session.plan, {
    startYear: session.startYear,
    taxCalculator: taxCalc(),
    model,
    seed,
    pathCount,
  })
  const agg = aggregateMonteCarlo(paths)
  // Engine already computes the ending-balance distribution; surface the total
  // (investable) ending-balance percentiles as p10/p25/p50/p75/p90.
  const pctl = agg.endingInvestable.percentiles
  return {
    ok: true as const,
    pathCount,
    seed,
    successRate: agg.successRate,
    requiredFloorSuccessRate: agg.requiredFloorSuccessRate,
    percentiles: {
      p10: pctl.p10,
      p25: pctl.p25,
      p50: pctl.p50,
      p75: pctl.p75,
      p90: pctl.p90,
    },
    caveats: session.caveats,
  }
}

export function batchEvaluate(
  session: SessionState,
  policies: PolicyParams[],
  objective: 'after_tax_estate' | 'cumulative_tax' | 'ending_trad' = 'after_tax_estate',
) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan with a household first' }
  }
  const results: Array<{
    index: number
    policy: PolicyParams
    objective: number | null
    ok: boolean
    error?: string
    caveats: string[]
  }> = []

  const ssIncomeCount = session.plan.incomes.filter((inc) => inc.type === 'socialSecurity').length

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]!
    try {
      if (policy.claim_ages.length < ssIncomeCount) {
        results.push({
          index: i,
          policy,
          objective: null,
          ok: false,
          error: `claim_ages has ${policy.claim_ages.length} entries but the plan has ${ssIncomeCount} Social Security incomes`,
          caveats: session.caveats,
        })
        continue
      }
      const planJson = structuredClone(session.plan) as Plan
      const caveats = [...session.caveats]

      if (policy.ordering === 'proportional') {
        planJson.strategies.withdrawalOrder = { mode: 'proportional' }
      } else {
        planJson.strategies.withdrawalOrder = { mode: 'sequential' }
        if (policy.ordering === 'traditional-first') {
          caveats.push('traditional-first approximate')
        }
      }

      const bracket = policy.conversion_bracket
      const kYears = policy.conversion_years ?? 0
      if (bracket != null && kYears > 0) {
        planJson.strategies.rothConversion = {
          mode: 'fillToTarget',
          target: 'topOfBracket',
          targetValue: bracket * 100,
          startYear: session.startYear,
          endYear: session.startYear + kYears - 1,
        }
      } else {
        planJson.strategies.rothConversion = { mode: 'none' }
      }

      let personIdx = 0
      for (const inc of planJson.incomes) {
        if (inc.type === 'socialSecurity' && policy.claim_ages[personIdx] != null) {
          inc.claimAge = { years: policy.claim_ages[personIdx]!, months: 0 }
          personIdx++
        }
      }

      const parsed = parsePlan(planJson)
      if (!parsed.ok) {
        results.push({
          index: i,
          policy,
          objective: null,
          ok: false,
          error: parsed.issues.join('; '),
          caveats,
        })
        continue
      }

      const proj = simulatePlan(parsed.plan, {
        startYear: session.startYear,
        taxCalculator: taxCalc(),
      })
      const summary = summarizeProjection(parsed.plan, proj)
      let obj: number
      if (objective === 'cumulative_tax') {
        obj = proj.years.reduce((s, y) => s + y.tax + y.penalties, 0)
      } else if (objective === 'ending_trad') {
        const last = proj.years[proj.years.length - 1]!
        obj = Object.entries(last.balances).reduce((s: number, [id, bal]) => {
          const acct = parsed.plan.accounts.find((a: { id: string; type: string }) => a.id === id)
          return acct?.type === 'traditional' ? s + bal : s
        }, 0)
      } else {
        obj = summary.endingAfterTaxEstate
      }
      results.push({ index: i, policy, objective: obj, ok: true, caveats })
    } catch (e) {
      results.push({
        index: i,
        policy,
        objective: null,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        caveats: session.caveats,
      })
    }
  }

  return { ok: true as const, objective, results, count: results.length }
}

export async function runOptimizer(session: SessionState) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  try {
    const result = await optimizePlan(session.plan, {
      startYear: session.startYear,
      taxCalculator: taxCalc(),
    })
    return {
      ok: true as const,
      schedule: result.schedule,
      tournament: {
        winnerSource: result.tournament.winnerSource,
        winnerLabel: result.tournament.winnerLabel,
        policyId: result.tournament.policyId,
        winnerConversions: result.tournament.winnerConversions,
      },
      caveats: session.caveats,
    }
  } catch (e) {
    return {
      ok: false as const,
      error: 'OPTIMIZER_FAILED',
      message: e instanceof Error ? e.message : String(e),
      caveats: session.caveats,
    }
  }
}

export function solveMaxSpending(session: SessionState) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  try {
    const simulateOptions = {
      startYear: session.startYear,
      taxCalculator: taxCalc(),
    }
    const baselineResult = simulatePlan(session.plan, simulateOptions)
    const baselineSummary = summarizeProjection(session.plan, baselineResult)
    const ctx = {
      plan: session.plan,
      baselineResult,
      baselineSummary,
      simulateOptions,
    }
    const result = solveMaxSustainableSpending(ctx, {})
    return {
      ok: true as const,
      maxBaseAnnual: result.maxBaseAnnual,
      spendingSlackDollars: result.spendingSlackDollars,
      converged: result.converged,
      limitingConstraint: result.limitingConstraint,
      caveats: session.caveats,
    }
  } catch (e) {
    return {
      ok: false as const,
      error: 'SPENDING_SOLVER_FAILED',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

export function exportPlan(session: SessionState) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  // Return a CLONE of the parsed Plan — programmatic consumers (e.g. Pro importing
  // these adapter helpers) must not be able to mutate the live session plan in place.
  // startYear + conventions are surfaced so the exported document round-trips faithfully
  // via build_plan({ plan, startYear, conventions }); without startYear the re-imported
  // projection would default to 2026 and diverge from any non-2026 session.
  return {
    ok: true as const,
    plan: structuredClone(session.plan),
    startYear: session.startYear,
    conventions: session.conventions,
    caveats: session.caveats,
  }
}

export function explainModeledResult(session: SessionState) {
  const { mcpVersion, engineVersion } = getVersions()
  return {
    ok: true as const,
    mcpVersion,
    engineVersion,
    framing:
      'Educational decision-support only — not tax, legal, or financial advice. Results are modeled under stated assumptions.',
    objective: 'User-selected or tool-default objective; tools do not prescribe securities actions.',
    assumptions: session.plan?.assumptions ?? null,
    conventions: session.conventions,
    caveats: session.caveats,
    hasPlan: session.plan != null,
    lastProjectionSummary:
      session.lastProjection &&
      typeof session.lastProjection === 'object' &&
      'summary' in session.lastProjection
        ? (session.lastProjection as { summary: unknown }).summary
        : null,
    limitations: [
      'Engine may use a single IRMAA lookback MAGI scalar.',
      'traditional-first withdrawal ordering is approximate under sequential drain.',
      'Law-sunset freeze is best-effort pending engine knobs.',
    ],
  }
}

export function compareScenarios(
  session: SessionState,
  planA: unknown,
  planB: unknown,
  startYear?: number,
) {
  const a = parsePlan(planA)
  const b = parsePlan(planB)
  if (!a.ok) return { ok: false as const, error: 'INVALID_PLAN_A', issues: a.issues }
  if (!b.ok) return { ok: false as const, error: 'INVALID_PLAN_B', issues: b.issues }
  const year = startYear ?? session.startYear
  const ra = simulatePlan(a.plan, { startYear: year, taxCalculator: taxCalc() })
  const rb = simulatePlan(b.plan, { startYear: year, taxCalculator: taxCalc() })
  const sa = summarizeProjection(a.plan, ra)
  const sb = summarizeProjection(b.plan, rb)
  return {
    ok: true as const,
    a: sa,
    b: sb,
    deltaEndingAfterTaxEstate: sb.endingAfterTaxEstate - sa.endingAfterTaxEstate,
  }
}

/**
 * Resolve a dotted-path or JSON-pointer segment list into the schema tree.
 * A leading '/' selects JSON-pointer semantics (with ~1/~0 unescaping); anything
 * else is treated as a dotted path. Numeric segments index into arrays (e.g. the
 * `oneOf` discriminated-union branches on `accounts.items`). Returns the located
 * node, or the UNRESOLVED sentinel when a segment does not exist.
 */
const UNRESOLVED = Symbol('unresolved')

function resolveSchemaPath(root: unknown, schemaPath: string): unknown | typeof UNRESOLVED {
  const trimmed = schemaPath.trim()
  if (trimmed === '' || trimmed === '/' || trimmed === '.') return root
  const segments = trimmed.startsWith('/')
    ? trimmed
        .slice(1)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    : trimmed.split('.').filter((s) => s.length > 0)

  let node: unknown = root
  for (const seg of segments) {
    if (Array.isArray(node)) {
      // Require an explicit decimal index. Number('') is 0, so without this a
      // JSON pointer with an empty segment (e.g. a trailing slash) would silently
      // resolve to element 0 instead of failing.
      if (!/^\d+$/.test(seg)) return UNRESOLVED
      const idx = Number(seg)
      if (idx >= node.length) return UNRESOLVED
      node = node[idx]
    } else if (node != null && typeof node === 'object') {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) return UNRESOLVED
      node = (node as Record<string, unknown>)[seg]
    } else {
      return UNRESOLVED
    }
  }
  return node
}

/**
 * Serve the engine's versioned Plan JSON Schema (the source of truth for what a
 * plan document contains), optionally sliced to a subtree so a caller can fetch
 * just the part it is authoring against and keep token cost down. The engine
 * owns the schema; this only reads and slices it.
 */
export function describePlanSchema(opts: { path?: string } = {}) {
  const base = {
    ok: true as const,
    schemaVersion: PLAN_SCHEMA_VERSION,
    schemaId: PLAN_SCHEMA_ID,
  }
  // Clone what we hand back: planJsonSchema (and its subtrees) is the engine's
  // shared, process-lifetime constant, and it also backs the plan-schema MCP
  // resource. A programmatic caller that mutated a direct reference would corrupt
  // every later response — so this read-only API returns a copy, as exportPlan
  // does for session-owned data.
  if (opts.path == null || opts.path.trim() === '') {
    return { ...base, path: null, schema: structuredClone(planJsonSchema) }
  }
  const node = resolveSchemaPath(planJsonSchema, opts.path)
  if (node === UNRESOLVED) {
    return {
      ok: false as const,
      error: 'PATH_NOT_FOUND',
      path: opts.path,
      schemaVersion: PLAN_SCHEMA_VERSION,
      schemaId: PLAN_SCHEMA_ID,
      message: `No schema node at '${opts.path}'. Use a dotted path (e.g. 'properties.accounts.items') or JSON pointer (e.g. '/properties/accounts/items').`,
    }
  }
  return { ...base, path: opts.path, schema: structuredClone(node) }
}

/**
 * Keys that pollute an object's prototype when written by name. update_plan
 * fragments and set-field ops carry caller-supplied keys straight from tool
 * input, so reject these at the boundary rather than risk prototype pollution.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function dangerousKeyIn(obj: Record<string, unknown>): string | null {
  for (const k of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(k)) return k
  }
  return null
}

/**
 * Valid `set_assumption` / `set_expense` field names, derived from the engine's
 * own Plan JSON Schema (the source of truth — not a hand-maintained list). An
 * unknown field name (a typo like `inflatonPct`, or a hallucinated key) would
 * otherwise be assigned, silently stripped by parsePlan, and reported as an
 * applied operation while the modeled value never changed — a silent-wrong-result
 * trap. Rejecting unknown fields also excludes the prototype-pollution keys.
 */
function schemaSectionKeys(section: 'assumptions' | 'expenses'): ReadonlySet<string> {
  const props = (planJsonSchema as { properties?: Record<string, unknown> }).properties?.[section] as
    | { properties?: Record<string, unknown> }
    | undefined
  return new Set(Object.keys(props?.properties ?? {}))
}
const ASSUMPTION_FIELDS = schemaSectionKeys('assumptions')
const EXPENSE_FIELDS = schemaSectionKeys('expenses')

/**
 * Named domain operations for update_plan. They target engine-plan FRAGMENTS
 * (what document extraction produces) rather than the typed household vocabulary,
 * and are deliberately small and explicit — add/replace/remove by id, or set a
 * single assumptions/expenses field — so there is no deep-merge magic where
 * silent data loss lives.
 */
export type UpdatePlanOp =
  | { op: 'add_account'; account: Record<string, unknown> }
  | { op: 'replace_account'; id: string; account: Record<string, unknown> }
  | { op: 'remove_account'; id: string }
  | { op: 'add_income'; income: Record<string, unknown> }
  | { op: 'replace_income'; id: string; income: Record<string, unknown> }
  | { op: 'remove_income'; id: string }
  | { op: 'set_assumption'; field: string; value: unknown }
  | { op: 'set_expense'; field: string; value: unknown }

type MutablePlan = {
  accounts: Array<{ id?: unknown }>
  incomes: Array<{ id?: unknown }>
  assumptions: Record<string, unknown>
  expenses: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Coerce a replacement fragment's `id` to the operation's target id. A fragment
 * whose own `id` names a DIFFERENT entry would silently delete `op.id` and
 * introduce another — contradicting "replace by id" — so reject that; an omitted
 * id is filled in. Returns the id-pinned fragment, or an error string.
 */
function pinReplacementId(
  fragment: Record<string, unknown>,
  targetId: string,
  where: string,
): { id?: unknown } | string {
  const fragId = fragment.id
  if (fragId != null && fragId !== targetId) {
    return `${where}: fragment id '${String(fragId)}' does not match target id '${targetId}' (replace is by id)`
  }
  return { ...fragment, id: targetId } as { id?: unknown }
}

/** Apply one operation to a working plan clone. Returns an error string or null. */
function applyUpdateOp(plan: MutablePlan, op: UpdatePlanOp, index: number): string | null {
  const where = `operation[${index}] ${op.op}`
  switch (op.op) {
    case 'add_account': {
      const bad = dangerousKeyIn(op.account)
      if (bad) return `${where}: unsafe key '${bad}' in account fragment`
      plan.accounts.push(op.account as { id?: unknown })
      return null
    }
    case 'replace_account': {
      const bad = dangerousKeyIn(op.account)
      if (bad) return `${where}: unsafe key '${bad}' in account fragment`
      const i = plan.accounts.findIndex((a) => a.id === op.id)
      if (i === -1) return `${where}: no account with id '${op.id}'`
      const pinned = pinReplacementId(op.account, op.id, where)
      if (typeof pinned === 'string') return pinned
      plan.accounts[i] = pinned
      return null
    }
    case 'remove_account': {
      const before = plan.accounts.length
      plan.accounts = plan.accounts.filter((a) => a.id !== op.id)
      if (plan.accounts.length === before) return `${where}: no account with id '${op.id}'`
      return null
    }
    case 'add_income': {
      const bad = dangerousKeyIn(op.income)
      if (bad) return `${where}: unsafe key '${bad}' in income fragment`
      plan.incomes.push(op.income as { id?: unknown })
      return null
    }
    case 'replace_income': {
      const bad = dangerousKeyIn(op.income)
      if (bad) return `${where}: unsafe key '${bad}' in income fragment`
      const i = plan.incomes.findIndex((inc) => inc.id === op.id)
      if (i === -1) return `${where}: no income with id '${op.id}'`
      const pinned = pinReplacementId(op.income, op.id, where)
      if (typeof pinned === 'string') return pinned
      plan.incomes[i] = pinned
      return null
    }
    case 'remove_income': {
      const before = plan.incomes.length
      plan.incomes = plan.incomes.filter((inc) => inc.id !== op.id)
      if (plan.incomes.length === before) return `${where}: no income with id '${op.id}'`
      return null
    }
    case 'set_assumption':
      if (!ASSUMPTION_FIELDS.has(op.field)) {
        return `${where}: unknown assumption field '${op.field}' (see describe_plan_schema properties.assumptions)`
      }
      // z.unknown() accepts an omitted key, so a set op with no `value` would
      // otherwise assign undefined and surface later as INVALID_PLAN. Require the
      // key explicitly (null is a valid supplied value; absent is not).
      if (!('value' in op)) return `${where}: 'value' is required`
      plan.assumptions[op.field] = op.value
      return null
    case 'set_expense':
      if (!EXPENSE_FIELDS.has(op.field)) {
        return `${where}: unknown expense field '${op.field}' (see describe_plan_schema properties.expenses)`
      }
      if (!('value' in op)) return `${where}: 'value' is required`
      plan.expenses[op.field] = op.value
      return null
    default: {
      // Exhaustiveness guard: an unknown op shape reaches here only if the zod
      // union and this switch drift apart.
      const _never: never = op
      return `unknown operation: ${JSON.stringify(_never)}`
    }
  }
}

/** Compact, low-token summary of a plan for update_plan/round-trip responses. */
function planSummary(plan: Plan) {
  return {
    name: plan.name,
    accounts: plan.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    incomes: plan.incomes.map((inc) => ({ id: inc.id, type: inc.type })),
    expenseBaseAnnual: plan.expenses.baseAnnual,
  }
}

/**
 * Incrementally mutate the current session plan with merge semantics, so
 * multi-document ingestion does not rebuild from scratch each turn. The mutated
 * plan is validated through the engine's parsePlan BEFORE it is committed: on any
 * failure the session plan is left UNCHANGED (never half-applied) and the issues
 * are returned. Requires a seeded plan (build_plan first) — NO_PLAN otherwise.
 */
export function updatePlan(session: SessionState, ops: UpdatePlanOp[]) {
  if (!session.plan) {
    return {
      ok: false as const,
      error: 'NO_PLAN',
      message: 'Call build_plan first to seed a plan before update_plan',
    }
  }
  // Guard the empty batch in the exported adapter (the MCP tool schema already
  // requires min 1, but a programmatic caller can pass []). Without this an empty
  // batch would reparse/commit the unchanged plan, drop the cached projection,
  // and report success with zero operations applied.
  if (ops.length === 0) {
    return {
      ok: false as const,
      error: 'NO_OPERATIONS',
      message: 'Provide at least one operation',
    }
  }
  // Work on a clone: nothing touches the live session until validation passes.
  const working = structuredClone(session.plan) as unknown as MutablePlan
  for (let i = 0; i < ops.length; i++) {
    const err = applyUpdateOp(working, ops[i]!, i)
    if (err) {
      return { ok: false as const, error: 'OPERATION_FAILED', issues: [err] }
    }
  }

  // Stamp the modification time as part of the atomic commit, so an exported
  // document reflects when the merge happened (consumers order / invalidate on
  // updatedAtIso). Set on the clone before validation: on failure the clone is
  // discarded and the live plan's timestamp is left untouched.
  working.updatedAtIso = new Date().toISOString()

  const parsed = parsePlan(working)
  if (!parsed.ok) {
    // Leave session.plan untouched — the merge is all-or-nothing.
    return { ok: false as const, error: 'INVALID_PLAN', issues: parsed.issues }
  }

  // Commit. Stale projection is dropped; record a caveat so a reader knows the
  // plan moved and any prior projection/optimizer result no longer applies. The
  // message is stable (no per-call operation count) so repeated update_plan calls
  // cannot accumulate unbounded near-duplicate caveats.
  session.plan = parsed.plan
  session.lastProjection = null
  const caveat = 'Plan mutated via update_plan; re-run run_projection to refresh results.'
  if (!session.caveats.includes(caveat)) session.caveats.push(caveat)

  // If the caller set recentAnnualMagi directly, a previously-seeded
  // irmaaLookbackMagis convention would clobber it on the documented
  // export_plan -> build_plan round-trip (applyConventions reseeds
  // recentAnnualMagi from the convention). Drop the now-superseded convention so
  // the explicit value round-trips faithfully.
  const setRecentMagi = ops.some((o) => o.op === 'set_assumption' && o.field === 'recentAnnualMagi')
  if (setRecentMagi && session.conventions.irmaaLookbackMagis != null) {
    session.conventions = { ...session.conventions, irmaaLookbackMagis: null }
    const magiCaveat =
      'update_plan set recentAnnualMagi directly; cleared the prior irmaaLookbackMagis convention so the value survives export_plan/build_plan round-trip.'
    if (!session.caveats.includes(magiCaveat)) session.caveats.push(magiCaveat)
  }

  return {
    ok: true as const,
    appliedOperations: ops.length,
    plan: planSummary(parsed.plan),
    caveats: session.caveats,
  }
}
