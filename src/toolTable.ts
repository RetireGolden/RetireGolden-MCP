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

/**
 * A plan fragment (account/income object) passed through update_plan verbatim.
 * Kept structurally loose — it targets the engine-plan shape, which the engine's
 * parsePlan (not this zod) is the authority on, so the whole mutated plan is
 * validated there before commit. But the boundary still rejects two things a bare
 * record would wave through: an ARRAY (`z.record` treats an array as an object of
 * numeric keys, so `account: []` would pass here and only fail later as a
 * confusing INVALID_PLAN) and prototype-pollution keys. The adapter re-checks the
 * latter too, defending programmatic callers that bypass this schema.
 */
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype']
// Reject pollution keys at the KEY level. (zod v4 already silently drops a
// '__proto__' key during record parse, so it can never pollute — but it passes
// 'constructor' / 'prototype' through as ordinary keys, so refine them out here
// for a clear boundary error rather than a downstream parsePlan failure.) The
// adapter's dangerousKeyIn re-checks all three for programmatic callers that
// bypass this schema.
const fragmentKey = z
  .string()
  .refine((k) => !PROTO_KEYS.includes(k), { message: 'unsafe key (__proto__/constructor/prototype)' })
const PlanFragment = z
  .record(fragmentKey, z.unknown())
  .refine((v) => !Array.isArray(v), { message: 'must be a plain object, not an array' })

/** Named domain operations for update_plan (see adapter.UpdatePlanOp). */
const UpdatePlanOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_account'), account: PlanFragment }),
  z.object({ op: z.literal('replace_account'), id: z.string().min(1), account: PlanFragment }),
  z.object({ op: z.literal('remove_account'), id: z.string().min(1) }),
  z.object({ op: z.literal('add_income'), income: PlanFragment }),
  z.object({ op: z.literal('replace_income'), id: z.string().min(1), income: PlanFragment }),
  z.object({ op: z.literal('remove_income'), id: z.string().min(1) }),
  z.object({ op: z.literal('set_assumption'), field: z.string().min(1), value: z.unknown() }),
  z.object({ op: z.literal('set_expense'), field: z.string().min(1), value: z.unknown() }),
])

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

/**
 * Whether a tool can reach anything the caller put in the session.
 *
 * `'none'` means the handler is a pure function of the package's own static
 * data and ignores session state entirely, so it stays answerable under any
 * host policy. Everything else is `'session'`. This is the only data
 * distinction this package can honestly own: it has no library, no GUI, and no
 * user account, so richer classes (plan access, library access, writes) belong
 * to the host that has them.
 */
export type ToolDataScope = 'none' | 'session'

export interface ToolEntry {
  name: string
  description: string
  /** zod raw shape passed verbatim to server.tool and to gateway arg parsing. */
  inputShape: z.ZodRawShape
  /** Raw handler returning the response payload (pre jsonResult wrapping). */
  handler: (session: SessionState, args: Record<string, unknown>) => unknown | Promise<unknown>
  /** Exposed over the HTTP gateway transport. */
  httpExposed: boolean
  /** Whether the handler can read session state. See ToolDataScope. */
  dataScope: ToolDataScope
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
      schemaVersion: z
        .number()
        .int()
        .optional()
        .describe(
          "Provenance only: the `schemaVersion` sibling from an export_plan response. A value differing from this build's version adds a caveat and NOTHING else — the document is still imported. Note this is your CLAIM about the document; the version the engine actually gates on is the `schemaVersion` field inside the document itself. Omit it and no caveat is emitted.",
        ),
      engineVersion: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Provenance only: the `engineVersion` sibling from an export_plan response, i.e. the @retiregolden/engine build that exported the supplied `plan`. Differing from the running engine adds a caveat (defaults and modeling semantics can move between engine versions) and NOTHING else — the document is still imported. This is the version skew that can actually occur between two builds that can exchange documents at all. Accepts null, which is what export_plan emits when it cannot resolve the installed version; null is treated as 'unknown' and warns on nothing.",
        ),
      mcpVersion: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Provenance only: the `mcpVersion` sibling from an export_plan response, accepted so a whole export can be spread straight back into build_plan (including the null export_plan emits when the version is unresolvable). Recorded, never warned on — for a full plan document the document itself is the model.',
        ),
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
        "Optional overrides for default modeling assumptions (inflation, returns, SS COLA, state, taxes, qualified ratio, dob month-day, sex). Defaults follow the engine (~2.5% inflation, SS COLA tracking inflation, and the resident state's own modeled income tax — set stateEffectiveTaxPct above 0 only to override that with a flat rate); household state is a REQUIRED input, not an assumption. Set explicit values to override; omitted fields keep the engine defaults.",
      ),
    },
    handler: (session, args) => adapter.setPlanFromBuild(session, args as unknown as BuildPlanInput),
    httpExposed: true,
    dataScope: 'session',
    arms: ['calculator', 'optimizer'],
    crossFieldValidate: (args) => {
      if (args.plan == null && (args.household == null || args.policy == null)) {
        return 'Provide either `plan` JSON or both `household` and `policy`'
      }
      // Required-state is enforced only on the typed path: when a full `plan` is
      // supplied the household is ignored, so do not demand its state. Mirrors the
      // runtime rule in buildPlanFromParams for a clean gateway-level message.
      if (args.plan == null && args.household != null) {
        const state = (args.household as { state?: unknown }).state
        if (state == null || (typeof state === 'string' && !/^[A-Za-z]{2}$/.test(state))) {
          return 'household.state is required on the typed path: provide a 2-letter state-of-residence code (e.g. "CA")'
        }
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
    dataScope: 'session',
    arms: [],
  },
  {
    name: 'run_projection',
    description: `${EDUCATIONAL} Run a deterministic projection on the session plan. Always starts at the session plan's startYear (rebuild via build_plan to change it). detail='summary' (default) returns startYear/endYear/summary/caveats only; detail='years' also returns the full per-year ledger. Taxes are federal PLUS state and local: the resident state's modeled income tax unless assumptions.stateEffectiveTaxPct overrides it with a flat rate above 0, plus any localIncomeTaxPct. This is the same stack the RetireGolden web app runs, so for a plan exported from that app these numbers match what the user sees on screen, provided you also pass the exported startYear.`,
    inputShape: {
      detail: z
        .enum(['summary', 'years'])
        .optional()
        .describe("Response detail: 'summary' (default, omits the per-year array) or 'years' (full per-year ledger)"),
    },
    handler: (session, args) =>
      adapter.runProjection(session, { detail: args.detail as 'summary' | 'years' | undefined }),
    httpExposed: true,
    dataScope: 'session',
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
    dataScope: 'session',
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
    dataScope: 'session',
    arms: ['calculator', 'optimizer'],
  },
  {
    name: 'run_optimizer',
    description: `${EDUCATIONAL} Run the engine optimizer / conversion schedule search on the session plan.`,
    inputShape: {},
    handler: (session) => adapter.runOptimizer(session),
    httpExposed: true,
    dataScope: 'session',
    arms: ['optimizer'],
  },
  {
    name: 'solve_max_spending',
    description: `${EDUCATIONAL} Bisect maximum sustainable base annual spending for the session plan.`,
    inputShape: {},
    handler: (session) => adapter.solveMaxSpending(session),
    httpExposed: false,
    dataScope: 'session',
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
    dataScope: 'session',
    arms: [],
  },
  {
    name: 'explain_modeled_result',
    description: `${EDUCATIONAL} Return framing, assumptions, caveats, and limitations for the current session.`,
    inputShape: {},
    handler: (session) => adapter.explainModeledResult(session),
    httpExposed: true,
    dataScope: 'session',
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
    dataScope: 'session',
    arms: [],
  },
  {
    name: 'export_plan',
    description: `${EDUCATIONAL} Export the current session plan as full plan JSON plus the session startYear, conventions and caveats, and the identity of the build that emitted it: schemaVersion (the engine's plan-schema version), engineVersion and mcpVersion (null if not resolvable). Round-trips via build_plan({ plan, startYear, conventions, schemaVersion, engineVersion }) — pass the exported startYear back or a non-2026 session's projection will diverge, and pass the version siblings back so a different build can warn on skew (a differing engineVersion, or a schemaVersion that disagrees with the document, is a caveat only — never a refusal). A document written against a DIFFERENT plan schema is a separate matter: the engine's validator can only read its own schema version, so such a document is rejected with an explanatory message rather than silently mis-read. Returns a clone; mutating it does not affect the live session.`,
    inputShape: {},
    handler: (session) => adapter.exportPlan(session),
    httpExposed: false,
    dataScope: 'session',
    arms: [],
  },
  {
    name: 'describe_plan_schema',
    description: `${EDUCATIONAL} Return the engine's versioned Plan JSON Schema (the source of truth for authoring a full plan document) plus its schemaVersion. Pass an optional \`path\` (dotted, e.g. 'properties.accounts.items', or JSON pointer, e.g. '/properties/accounts/items') to fetch just a subtree and keep token cost down. Read-only meta tool; also exposed as the MCP resource of the same schema. Feed a document's extracted fields into update_plan, then validate_plan.`,
    inputShape: {
      path: z
        .string()
        .optional()
        .describe(
          'Optional dotted path or JSON pointer into the schema; omit for the full document',
        ),
    },
    handler: (_session, args) => adapter.describePlanSchema({ path: args.path as string | undefined }),
    httpExposed: false,
    dataScope: 'none',
    arms: [],
  },
  {
    name: 'update_plan',
    description: `${EDUCATIONAL} Incrementally mutate the current session plan with named merge operations (add/replace/remove accounts or incomes by id; set an assumption or expense field) — for building a plan up from extracted document fragments without rebuilding each turn. Requires a seeded plan (build_plan first; NO_PLAN otherwise). The mutated plan is validated via the engine BEFORE commit: on failure the session plan is left UNCHANGED and issues are returned. Returns the updated plan summary + caveats on success.`,
    inputShape: {
      operations: z
        .array(UpdatePlanOpSchema)
        .min(1)
        .describe('Ordered list of merge operations applied atomically (all-or-nothing).'),
    },
    handler: (session, args) => adapter.updatePlan(session, args.operations as adapter.UpdatePlanOp[]),
    httpExposed: false,
    dataScope: 'session',
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
    dataScope: 'session',
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
