/**
 * MCP tool registration over the headless adapter.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as adapter from './adapter.js'
import type { SessionState } from './session.js'
import { clearSession } from './session.js'
import type { BuildPlanInput, PolicyParams } from './buildPlan.js'

const EDUCATIONAL =
  'Educational decision-support only — not tax, legal, or financial advice. Do not prescribe securities actions.'

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function registerTools(server: McpServer, session: SessionState): void {
  server.tool(
    'build_plan',
    `${EDUCATIONAL} Build or replace the in-memory plan from typed household/policy params or full plan JSON.`,
    {
      plan: z.unknown().optional().describe('Full RetireGolden plan JSON'),
      household: z.unknown().optional().describe('Typed household params (bench vocabulary)'),
      policy: z.unknown().optional().describe('Typed policy params'),
      conversion: z.unknown().optional(),
      startYear: z.number().int().optional(),
      conventions: z
        .object({
          lawSunsetFreezeYear: z.number().int().nullable().optional(),
          irmaaLookbackMagis: z.tuple([z.number(), z.number()]).nullable().optional(),
          withdrawalOrdering: z
            .enum(['taxable-first', 'traditional-first', 'proportional'])
            .nullable()
            .optional(),
        })
        .optional(),
    },
    async (args) => {
      const input = args as BuildPlanInput
      const result = adapter.setPlanFromBuild(session, input)
      return jsonResult(result)
    },
  )

  server.tool(
    'validate_plan',
    `${EDUCATIONAL} Validate plan JSON (or the current session plan).`,
    {
      plan: z.unknown().optional(),
    },
    async (args) => {
      const target = args.plan ?? session.plan
      if (target == null) {
        return jsonResult({ ok: false, error: 'NO_PLAN' })
      }
      return jsonResult(adapter.validatePlanJson(target))
    },
  )

  server.tool(
    'run_projection',
    `${EDUCATIONAL} Run a deterministic year-by-year projection on the session plan.`,
    {
      startYear: z.number().int().optional(),
    },
    async (args) => jsonResult(adapter.runProjection(session, args.startYear)),
  )

  server.tool(
    'run_monte_carlo',
    `${EDUCATIONAL} Run a Monte Carlo summary on the session plan.`,
    {
      pathCount: z.number().int().positive().max(5000).optional(),
      seed: z.number().int().optional(),
      startYear: z.number().int().optional(),
    },
    async (args) => jsonResult(adapter.runMonteCarlo(session, args)),
  )

  server.tool(
    'batch_evaluate',
    `${EDUCATIONAL} Evaluate many policies against the current household plan (search-friendly). Cap batches sensibly (~40 tool calls total in agent loops).`,
    {
      policies: z.array(z.unknown()).min(1).max(500),
      objective: z.enum(['after_tax_estate', 'cumulative_tax', 'ending_trad']).optional(),
    },
    async (args) =>
      jsonResult(
        adapter.batchEvaluate(
          session,
          args.policies as PolicyParams[],
          args.objective ?? 'after_tax_estate',
        ),
      ),
  )

  server.tool(
    'run_optimizer',
    `${EDUCATIONAL} Run the engine optimizer / conversion schedule search on the session plan.`,
    {},
    async () => jsonResult(await adapter.runOptimizer(session)),
  )

  server.tool(
    'solve_max_spending',
    `${EDUCATIONAL} Bisect maximum sustainable base annual spending for the session plan.`,
    {},
    async () => jsonResult(adapter.solveMaxSpending(session)),
  )

  server.tool(
    'compare_scenarios',
    `${EDUCATIONAL} Compare two plan JSON documents via projection summaries.`,
    {
      planA: z.unknown(),
      planB: z.unknown(),
      startYear: z.number().int().optional(),
    },
    async (args) =>
      jsonResult(adapter.compareScenarios(session, args.planA, args.planB, args.startYear)),
  )

  server.tool(
    'explain_modeled_result',
    `${EDUCATIONAL} Return framing, assumptions, caveats, and limitations for the current session.`,
    {},
    async () => jsonResult(adapter.explainModeledResult(session)),
  )

  server.tool(
    'get_session',
    `${EDUCATIONAL} Inspect whether a plan is loaded and list caveats/conventions.`,
    {},
    async () =>
      jsonResult({
        hasPlan: session.plan != null,
        startYear: session.startYear,
        caveats: session.caveats,
        conventions: session.conventions,
        planName: session.plan?.name ?? null,
      }),
  )

  server.tool(
    'clear_session',
    `${EDUCATIONAL} Clear the in-memory plan session.`,
    {},
    async () => {
      clearSession(session)
      return jsonResult({ ok: true })
    },
  )
}
