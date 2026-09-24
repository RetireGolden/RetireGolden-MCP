/**
 * Wiring for the three engine-published figures (packet B2-P1): the adapter must
 * READ them from the engine, not recompute them. A recomputation would give the
 * same number on real plans (that is what the parity tests prove), so value
 * checks alone cannot catch local arithmetic creeping back. Here the engine
 * functions are wrapped: the summary's two fields are replaced by sentinels, and
 * the comparison is observed and, per test, made to return a sentinel or to
 * throw. Only an adapter that reads the engine's values reports the sentinels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const SENTINEL_TAXES = 123_456.78
const SENTINEL_TRADITIONAL = 87_654.32

vi.mock('@retiregolden/engine', async (importOriginal) => {
  const engine = await importOriginal<typeof import('@retiregolden/engine')>()
  return {
    ...engine,
    summarizeProjection: (...args: Parameters<typeof engine.summarizeProjection>) => {
      const summary = engine.summarizeProjection(...args)
      return {
        ...summary,
        lifetimeTaxesAndPenalties: SENTINEL_TAXES,
        endingByCategory: { ...summary.endingByCategory, traditional: SENTINEL_TRADITIONAL },
      }
    },
  }
})

vi.mock('@retiregolden/engine/scenarios/comparison', async (importOriginal) => {
  const comparison = await importOriginal<typeof import('@retiregolden/engine/scenarios/comparison')>()
  return { ...comparison, compareScenarioPlans: vi.fn(comparison.compareScenarioPlans) }
})

const { compareScenarioPlans } = await import('@retiregolden/engine/scenarios/comparison')
const { createSession } = await import('../src/session.js')
const adapter = await import('../src/adapter.js')
const { buildPlanFromParams } = await import('../src/buildPlan.js')
const { builtOk, mfjHousehold, mfjPolicy } = await import('./fixtures.js')

const compareMock = vi.mocked(compareScenarioPlans)

function session() {
  const s = createSession(2026)
  expect(adapter.setPlanFromBuild(s, { household: mfjHousehold, policy: mfjPolicy, startYear: 2026 }).ok).toBe(true)
  return s
}

function planDocument(state?: string) {
  const household = state === undefined ? mfjHousehold : { ...mfjHousehold, state }
  return JSON.parse(JSON.stringify(builtOk(buildPlanFromParams({ household, policy: mfjPolicy })).plan))
}

afterEach(() => {
  compareMock.mockClear()
})

describe('batch_evaluate reads its objectives from the engine summary', () => {
  it('reports the summary lifetimeTaxesAndPenalties for cumulative_tax', () => {
    const batch = adapter.batchEvaluate(session(), [mfjPolicy], 'cumulative_tax')
    expect(batch.ok && batch.results[0]!.objective).toBe(SENTINEL_TAXES)
  })

  it('reports the summary endingByCategory.traditional for ending_trad', () => {
    const batch = adapter.batchEvaluate(session(), [mfjPolicy], 'ending_trad')
    expect(batch.ok && batch.results[0]!.objective).toBe(SENTINEL_TRADITIONAL)
  })
})

describe('compare_scenarios reads its delta from the engine comparison', () => {
  it("calls the engine comparison once, with both plans, the start year and the adapter's own tax stack", () => {
    const s = session()
    const a = planDocument()
    const b = planDocument('CA')
    const cmp = adapter.compareScenarios(s, a, b)
    expect(cmp.ok).toBe(true)
    expect(compareMock).toHaveBeenCalledTimes(1)
    const [baseline, proposal, options] = compareMock.mock.calls[0]!
    expect(baseline).toEqual(a)
    expect(proposal).toEqual(b)
    expect(options.startYear).toBe(s.startYear)
    // The very function the adapter prices its own projections with, so each
    // side is priced with its own plan's stack and never with one shared one.
    expect(options.taxCalculatorForPlan).toBe(adapter.taxCalc)
    const returned = compareMock.mock.results[0]!.value as ReturnType<typeof compareScenarioPlans>
    expect(cmp.ok && cmp.deltaEndingAfterTaxEstate).toBe(returned.headline.endingAfterTaxEstate.delta)
  })

  it('reports whatever delta the engine comparison publishes', () => {
    // Only the field the adapter reads; a delta no subtraction of the reported
    // summaries could produce.
    compareMock.mockImplementationOnce(
      () =>
        ({ headline: { endingAfterTaxEstate: { baseline: 1, proposal: 2, delta: -42.5 } } }) as unknown as ReturnType<
          typeof compareScenarioPlans
        >,
    )
    const cmp = adapter.compareScenarios(session(), planDocument(), planDocument('CA'))
    expect(cmp.ok && cmp.deltaEndingAfterTaxEstate).toBe(-42.5)
  })

  it('returns COMPARISON_FAILED in the ok:false envelope when the engine refuses the comparison', () => {
    compareMock.mockImplementationOnce(() => {
      throw new Error('compareScenarioPlans: headline.endingAfterTaxEstate is not finite')
    })
    const cmp = adapter.compareScenarios(session(), planDocument(), planDocument('CA'))
    expect(cmp).toEqual({
      ok: false,
      error: 'COMPARISON_FAILED',
      message: 'compareScenarioPlans: headline.endingAfterTaxEstate is not finite',
    })
  })
})
