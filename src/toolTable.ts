/**
 * Single declarative tool registry — the one source of truth for the MCP tool
 * surface. Both the stdio registration (registerTools) and the HTTP gateway
 * drive off this table, and schemas/tools.v1.json is kept honest against it by
 * tests/registry-parity.test.ts. Add or change a tool here and nowhere else.
 */

import { z } from 'zod'
import * as adapter from './adapter.js'
import { clearSession, type SessionState } from './session.js'
import {
  HouseholdParamsSchema,
  PolicyParamsSchema,
  ConversionSchema,
  AssumptionsSchema,
  type BuildPlanInput,
  type PolicyParams,
} from './buildPlan.js'

export const EDUCATIONAL =
  'Educational decision-support only — not tax, legal, or financial advice. Do not prescribe securities actions.'

export function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

/** Search-strategy arms published in the versioned tool contract. */
export type ArmName = 'calculator' | 'optimizer'

/** Maps an arm to its key in schemas/tools.v1.json. */
export const ARM_JSON_KEY: Record<ArmName, string> = {
  calculator: 'calculator_arm',
  optimizer: 'optimizer_arm',
}

export interface ToolEntry {
  name: string
  description: string
  /** zod raw shape passed verbatim to server.tool and to gateway arg parsing. */
  inputShape: z.ZodRawShape
  /** Raw handler returning the response payload (pre jsonResult wrapping). */
  handler: (session: SessionState, args: Record<string, unknown>) => unknown | Promise<unknown>
  /** Exposed over the HTTP gateway transport. */
  httpExposed: boolean
  /** Arm memberships mirrored in the versioned tool contract. */
  arms: readonly ArmName[]
  /**
   * Cross-field argument check the flat zod shape cannot express (gateway only).
   * Returns an error message or null. Runs after the shape parse succeeds.
   */
  crossFieldValidate?: (args: Record<string, unknown>) => string | null
}

export const TOOL_TABLE: readonly ToolEntry[] = [
  {
    name: 'build_plan',
    description: `${EDUCATIONAL} Build or replace the in-memory plan from typed household/policy params or full plan JSON.`,
    inputShape: {
      plan: z.unknown().optional().describe('Full RetireGolden plan JSON (validated by the engine)'),
      household: HouseholdParamsSchema.optional().describe(
        'Typed household params: filing, REQUIRED 2-letter state, persons[] (retired — a non-zero wage is a hard error), taxable/basis, spending, horizon, growth rates, IRMAA lookback MAGIs, heir rate',
      ),
      policy: PolicyParamsSchema.optional().describe(
        'Typed policy params: claim_ages[], optional conversion_bracket/conversion_years, withdrawal ordering',
      ),
      conversion: ConversionSchema.optional().describe(
        'Optional manual Roth conversion schedule (overrides bracket-fill conversions)',
      ),
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
      assumptions: AssumptionsSchema.optional().describe(
        "Optional overrides for default modeling assumptions (inflation, returns, SS COLA, state, taxes, qualified ratio, dob month-day, sex). Defaults now follow the engine (~2.5% inflation, SS COLA tracking inflation, 0% state/local tax); household state is a REQUIRED input, not an assumption. Set explicit values to override; omitted fields keep the engine defaults.",
      ),
    },
    handler: (session, args) => adapter.setPlanFromBuild(session, args as unknown as BuildPlanInput),
    httpExposed: true,
    arms: ['calculator', 'optimizer'],
    crossFieldValidate: (args) => {
      if (args.plan == null && (args.household == null || args.policy == null)) {
        return 'Provide either `plan` JSON or both `household` and `policy`'
      }
      return null
    },
  },
  {
    name: 'validate_plan',
    description: `${EDUCATIONAL} Validate plan JSON (or the current session plan).`,
    inputShape: {
      plan: z.unknown().optional(),
    },
    handler: (session, args) => {
      const target = args.plan ?? session.plan
      if (target == null) {
        return { ok: false, error: 'NO_PLAN' }
      }
      return adapter.validatePlanJson(target)
    },
    httpExposed: false,
    arms: [],
  },
  {
    name: 'run_projection',
    description: `${EDUCATIONAL} Run a deterministic projection on the session plan. Always starts at the session plan's startYear (rebuild via build_plan to change it). detail='summary' (default) returns startYear/endYear/summary/caveats only; detail='years' also returns the full per-year ledger.`,
    inputShape: {
      detail: z
        .enum(['summary', 'years'])
        .optional()
        .describe("Response detail: 'summary' (default, omits the per-year array) or 'years' (full per-year ledger)"),
    },
    handler: (session, args) =>
      adapter.runProjection(session, { detail: args.detail as 'summary' | 'years' | undefined }),
    httpExposed: true,
    arms: ['calculator', 'optimizer'],
  },
  {
    name: 'run_monte_carlo',
    description: `${EDUCATIONAL} Run a Monte Carlo summary on the session plan. Always starts at the session plan's startYear (rebuild via build_plan to change it).`,
    inputShape: {
      pathCount: z.number().int().positive().max(5000).optional(),
      seed: z.number().int().optional(),
    },
    handler: (session, args) =>
      adapter.runMonteCarlo(session, args as { pathCount?: number; seed?: number }),
    httpExposed: false,
    arms: [],
  },
  {
    name: 'batch_evaluate',
    description: `${EDUCATIONAL} Evaluate many policies against the current household plan (search-friendly). Cap batches sensibly (~40 tool calls total in agent loops).`,
    inputShape: {
      policies: z
        .array(PolicyParamsSchema)
        .min(1)
        .max(500)
        .describe('Typed policy params to sweep: claim_ages[], conversion_bracket/years, ordering'),
      objective: z.enum(['after_tax_estate', 'cumulative_tax', 'ending_trad']).optional(),
    },
    handler: (session, args) =>
      adapter.batchEvaluate(
        session,
        args.policies as PolicyParams[],
        (args.objective as 'after_tax_estate' | 'cumulative_tax' | 'ending_trad' | undefined) ??
          'after_tax_estate',
      ),
    httpExposed: true,
    arms: ['calculator', 'optimizer'],
  },
  {
    name: 'run_optimizer',
    description: `${EDUCATIONAL} Run the engine optimizer / conversion schedule search on the session plan.`,
    inputShape: {},
    handler: (session) => adapter.runOptimizer(session),
    httpExposed: true,
    arms: ['optimizer'],
  },
  {
    name: 'solve_max_spending',
    description: `${EDUCATIONAL} Bisect maximum sustainable base annual spending for the session plan.`,
    inputShape: {},
    handler: (session) => adapter.solveMaxSpending(session),
    httpExposed: false,
    arms: ['optimizer'],
  },
  {
    name: 'compare_scenarios',
    description: `${EDUCATIONAL} Compare two plan JSON documents via projection summaries.`,
    inputShape: {
      planA: z.unknown(),
      planB: z.unknown(),
      startYear: z.number().int().optional(),
    },
    handler: (session, args) =>
      adapter.compareScenarios(session, args.planA, args.planB, args.startYear as number | undefined),
    httpExposed: false,
    arms: [],
  },
  {
    name: 'explain_modeled_result',
    description: `${EDUCATIONAL} Return framing, assumptions, caveats, and limitations for the current session.`,
    inputShape: {},
    handler: (session) => adapter.explainModeledResult(session),
    httpExposed: true,
    arms: [],
  },
  {
    name: 'get_session',
    description: `${EDUCATIONAL} Inspect whether a plan is loaded and list caveats/conventions plus mcp/engine versions.`,
    inputShape: {},
    handler: (session) => {
      const { mcpVersion, engineVersion } = adapter.getVersions()
      return {
        hasPlan: session.plan != null,
        startYear: session.startYear,
        caveats: session.caveats,
        conventions: session.conventions,
        planName: session.plan?.name ?? null,
        mcpVersion,
        engineVersion,
      }
    },
    httpExposed: false,
    arms: [],
  },
  {
    name: 'export_plan',
    description: `${EDUCATIONAL} Export the current session plan as full plan JSON plus the session startYear and conventions. Round-trips via build_plan({ plan, startYear, conventions }) — pass the exported startYear back or a non-2026 session's projection will diverge. Returns a clone; mutating it does not affect the live session.`,
    inputShape: {},
    handler: (session) => adapter.exportPlan(session),
    httpExposed: false,
    arms: [],
  },
  {
    name: 'clear_session',
    description: `${EDUCATIONAL} Clear the in-memory plan session.`,
    inputShape: {},
    handler: (session) => {
      clearSession(session)
      return { ok: true }
    },
    httpExposed: false,
    arms: [],
  },
]

const TOOL_BY_NAME = new Map(TOOL_TABLE.map((t) => [t.name, t]))

/** Look up a tool entry by name. */
export function getTool(name: string): ToolEntry | undefined {
  return TOOL_BY_NAME.get(name)
}

function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/**
 * Validate gateway arguments against the tool's own zod shape (plus any
 * cross-field rule). Returns an error message, or null when valid.
 */
export function validateToolArgs(entry: ToolEntry, args: Record<string, unknown>): string | null {
  const parsed = z.object(entry.inputShape).safeParse(args)
  if (!parsed.success) return zodIssues(parsed.error)
  if (entry.crossFieldValidate) return entry.crossFieldValidate(args)
  return null
}
