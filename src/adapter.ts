/**
 * Headless engine adapter — projection, MC, batch evaluate, optimizer, spending.
 */

import { simulatePlan, summarizeProjection, type Plan } from '@retiregolden/engine'
import { parsePlan } from '@retiregolden/engine/model/plan'
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

export function runProjection(session: SessionState, startYear?: number) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  const year = startYear ?? session.startYear
  const result = simulatePlan(session.plan, {
    startYear: year,
    taxCalculator: taxCalc(),
  })
  const summary = summarizeProjection(session.plan, result)
  session.lastProjection = { result, summary }
  return {
    ok: true as const,
    startYear: result.startYear,
    endYear: result.endYear,
    summary,
    caveats: session.caveats,
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
  opts: { pathCount?: number; seed?: number; startYear?: number } = {},
) {
  if (!session.plan) {
    return { ok: false as const, error: 'NO_PLAN', message: 'Call build_plan first' }
  }
  const pathCount = opts.pathCount ?? 200
  const seed = opts.seed ?? 42
  const startYear = opts.startYear ?? session.startYear
  const model = createLognormalModel({
    type: 'lognormal',
    inflationMeanPct: session.plan.assumptions.inflationPct,
    returnVolPct: 12,
  })
  const paths = runMonteCarloPaths(session.plan, {
    startYear,
    taxCalculator: taxCalc(),
    model,
    seed,
    pathCount,
  })
  const agg = aggregateMonteCarlo(paths)
  return {
    ok: true as const,
    pathCount,
    seed,
    successRate: agg.successRate,
    requiredFloorSuccessRate: agg.requiredFloorSuccessRate,
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

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]!
    try {
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

export function explainModeledResult(session: SessionState) {
  return {
    ok: true as const,
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
