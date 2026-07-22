/**
 * Public package exports for programmatic use (Pro / tests).
 */

export { createSession, clearSession, type SessionState, type ConventionKnobs } from './session.js'
export {
  buildPlanFromParams,
  type BuildPlanInput,
  type BuildPlanResult,
  type AssumptionsInput,
} from './buildPlan.js'
export * as adapter from './adapter.js'
export {
  registerTools,
  registerResources,
  EDUCATIONAL,
  jsonResult,
  type AuthorizeTool,
  type RegisterToolsOptions,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from './tools.js'
export { type ToolEntry, type ToolDataScope, TOOL_TABLE } from './toolTable.js'
// startHttpGateway is deliberately NOT exported. The gateway is a RetireBench
// cost/ops research surface, not part of the supported package API, and a
// consumer that could import it could open a listener. See src/http/gateway.ts.
export { startStdioServer } from './server.js'
