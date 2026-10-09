/**
 * Wiring for `run_monte_carlo`'s defaults: with no arguments the adapter hands
 * the engine the app's headline options (`headlineMonteCarloOptions`), and each
 * argument a caller gives replaces only its own default.
 *
 * The engine calls are wrapped, not replaced: `createMarketModel` records the
 * model configuration it is given, and `runMonteCarloPaths` records its options
 * and, for the full-count cases, runs two paths instead of 1,000, so the
 * headline count is checked where it is handed to the engine without paying for
 * a 1,000-path run. That the headline options draw the app's markets is the
 * parity suite's job (tests/browserParity.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@retiregolden/engine/montecarlo/run', async (importOriginal) => {
  const run = await importOriginal<typeof import('@retiregolden/engine/montecarlo/run')>()
  return { ...run, runMonteCarloPaths: vi.fn(run.runMonteCarloPaths) }
})

vi.mock('@retiregolden/engine/montecarlo/marketModels', async (importOriginal) => {
  const models = await importOriginal<typeof import('@retiregolden/engine/montecarlo/marketModels')>()
  return { ...models, createMarketModel: vi.fn(models.createMarketModel) }
})

const run = await import('@retiregolden/engine/montecarlo/run')
const models = await import('@retiregolden/engine/montecarlo/marketModels')
const { headlineMonteCarloOptions, HEADLINE_MONTE_CARLO_PATH_COUNT } = await import(
  '@retiregolden/engine/montecarlo/headline'
)
const { DEFAULT_MONTE_CARLO_SEED } = await import('@retiregolden/engine/montecarlo/rng')
const adapter = await import('../src/adapter.js')
const { mfjSession } = await import('./helpers/session.js')

const pathsMock = vi.mocked(run.runMonteCarloPaths)
const modelMock = vi.mocked(models.createMarketModel)
const { runMonteCarloPaths: realPaths } = await vi.importActual<typeof import('@retiregolden/engine/montecarlo/run')>(
  '@retiregolden/engine/montecarlo/run',
)

/** Run two paths of whatever the adapter asked for, keeping its request on record. */
function shortenNextRun() {
  pathsMock.mockImplementationOnce((plan, opts) => realPaths(plan, { ...opts, pathCount: 2 }))
}

afterEach(() => {
  pathsMock.mockClear()
  modelMock.mockClear()
})

describe('run_monte_carlo defaults to the headline options', () => {
  it('hands the engine the headline options when no argument is given, and echoes them', () => {
    const session = mfjSession()
    shortenNextRun()
    const mc = adapter.runMonteCarlo(session)
    expect(mc.ok).toBe(true)
    if (!mc.ok) return
    const headline = headlineMonteCarloOptions(session.plan!, session.startYear)
    expect(pathsMock).toHaveBeenCalledTimes(1)
    const [, options] = pathsMock.mock.calls[0]!
    expect(options.startYear).toBe(headline.startYear)
    expect(options.pathCount).toBe(HEADLINE_MONTE_CARLO_PATH_COUNT)
    expect(options.seed).toBe(DEFAULT_MONTE_CARLO_SEED)
    expect(options.stochasticLongevity).toBeUndefined()
    expect(options.ltcShock).toBeUndefined()
    expect(modelMock).toHaveBeenCalledTimes(1)
    expect(modelMock.mock.calls[0]![0]).toStrictEqual(headline.model)
    // The model handed to the paths is the one built from that configuration.
    expect(options.model).toBe(modelMock.mock.results[0]!.value)
    expect({ pathCount: mc.pathCount, seed: mc.seed, returnVolPct: mc.returnVolPct }).toEqual({
      pathCount: 1000,
      seed: 6_221_293,
      returnVolPct: 12,
    })
  })

  it('keeps the headline count and model when only the seed is given', () => {
    const session = mfjSession()
    shortenNextRun()
    const mc = adapter.runMonteCarlo(session, { seed: 7 })
    expect(mc.ok && mc.seed).toBe(7)
    expect(mc.ok && mc.pathCount).toBe(HEADLINE_MONTE_CARLO_PATH_COUNT)
    const [, options] = pathsMock.mock.calls[0]!
    expect(options.seed).toBe(7)
    expect(options.pathCount).toBe(HEADLINE_MONTE_CARLO_PATH_COUNT)
    expect(modelMock.mock.calls[0]![0]).toStrictEqual(headlineMonteCarloOptions(session.plan!, session.startYear).model)
  })

  it('keeps the headline seed and model when only the path count is given', () => {
    const session = mfjSession()
    const mc = adapter.runMonteCarlo(session, { pathCount: 3 })
    expect(mc.ok && mc.pathCount).toBe(3)
    expect(mc.ok && mc.seed).toBe(DEFAULT_MONTE_CARLO_SEED)
    const [, options] = pathsMock.mock.calls[0]!
    expect(options.pathCount).toBe(3)
    expect(options.seed).toBe(DEFAULT_MONTE_CARLO_SEED)
    expect(modelMock.mock.calls[0]![0]).toStrictEqual(headlineMonteCarloOptions(session.plan!, session.startYear).model)
  })

  it("rebuilds the plan's model at a given volatility, keeping the other defaults", () => {
    const session = mfjSession()
    const mc = adapter.runMonteCarlo(session, { pathCount: 3, returnVolPct: 20 })
    expect(mc.ok && mc.returnVolPct).toBe(20)
    expect(modelMock.mock.calls[0]![0]).toStrictEqual(models.buildLognormalModelConfigForPlan(session.plan!, 20))
    expect(pathsMock.mock.calls[0]![1].seed).toBe(DEFAULT_MONTE_CARLO_SEED)
  })

  it('states the defaults it applies', () => {
    expect(adapter.MC_DEFAULT_PATH_COUNT).toBe(HEADLINE_MONTE_CARLO_PATH_COUNT)
    expect(adapter.MC_DEFAULT_SEED).toBe(DEFAULT_MONTE_CARLO_SEED)
    expect(adapter.MC_DEFAULT_RETURN_VOL_PCT).toBe(12)
  })
})
