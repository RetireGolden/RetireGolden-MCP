/**
 * Public package exports for programmatic use (Pro / tests).
 */

export { createSession, clearSession, type SessionState, type ConventionKnobs } from './session.js'
export { buildPlanFromParams, type BuildPlanInput, type BuildPlanResult } from './buildPlan.js'
export * as adapter from './adapter.js'
export { registerTools } from './tools.js'
export { startStdioServer } from './server.js'
