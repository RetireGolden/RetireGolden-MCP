import { z } from 'zod'
import type { Plan } from '@retiregolden/engine'

export const MIN_CALENDAR_YEAR = 1900
export const MAX_CALENDAR_YEAR = 2200
export const MAX_EFFECTIVE_YEARS = 120
export const CalendarYearSchema = z.number().int().min(MIN_CALENDAR_YEAR).max(MAX_CALENDAR_YEAR)
const MAX_PLAN_BYTES = 2 * 1024 * 1024
const MAX_PLAN_DEPTH = 48
const MAX_PLAN_NODES = 100_000
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_CAVEATS = 64
export const MAX_CAVEAT_CHARS = 2_048
export const MAX_UPDATE_OPERATIONS = 1_000
const COLLECTION_LIMITS: Record<string, number> = { people: 20, accounts: 500, incomes: 500, oneTimeGoals: 1_000, phases: 1_000, careEvents: 1_000, events: 1_000, operations: MAX_UPDATE_OPERATIONS }

function primitiveBytes(value: unknown): number {
  if (typeof value === 'string') return jsonStringBytes(value)
  if (value === null) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4
  return 0
}

function jsonStringBytes(value: string): number {
  let bytes = Buffer.byteLength(value, 'utf8') + 2
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x22 || code === 0x5c) bytes += 1
    else if (code <= 0x1f) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i += 1
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 3
  }
  return bytes
}

/** Inspect untrusted JSON-shaped input without first materializing its serialization. */
export function structuralBudgetIssue(value: unknown, label = 'plan'): string | null {
  const stack: Array<{ value: unknown; depth: number; key?: string; exit?: boolean }> = [{ value, depth: 0 }]
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  while (stack.length > 0) {
    const item = stack.pop()!
    if (item.exit) {
      active.delete(item.value as object)
      continue
    }
    if (++nodes > MAX_PLAN_NODES) return `${label} exceeds the structural node budget`
    if (item.depth > MAX_PLAN_DEPTH) return `${label} exceeds the nesting budget`
    bytes += primitiveBytes(item.value)
    if (bytes > MAX_PLAN_BYTES) return `${label} exceeds the ${MAX_PLAN_BYTES}-byte budget`
    if (typeof item.value !== 'object' || item.value === null) continue
    if (active.has(item.value)) return `${label} must be acyclic JSON`
    active.add(item.value)
    stack.push({ ...item, exit: true })
    if (Array.isArray(item.value)) {
      const cap = item.key ? COLLECTION_LIMITS[item.key] : undefined
      if (cap !== undefined && item.value.length > cap) return `${label}.${item.key} exceeds ${cap} entries`
      for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 })
      continue
    }
    for (const [key, child] of Object.entries(item.value)) {
      bytes += jsonStringBytes(key) + 1
      stack.push({ value: child, depth: item.depth + 1, key })
    }
  }
  return null
}

export function planEndYear(plan: Plan): number | null {
  let endYear: number | null = null
  for (const person of plan.household.people) {
    const candidate = Number(person.dob.slice(0, 4)) + person.longevity.planningAge
    if (Number.isInteger(candidate)) endYear = endYear === null ? candidate : Math.max(endYear, candidate)
  }
  return endYear
}

export function calendarSpanIssues(plan: Plan, startYear: number): string[] {
  if (!Number.isInteger(startYear) || startYear < MIN_CALENDAR_YEAR || startYear > MAX_CALENDAR_YEAR) return [`startYear must be an integer from ${MIN_CALENDAR_YEAR} through ${MAX_CALENDAR_YEAR}`]
  const endYear = planEndYear(plan)
  if (endYear === null) return []
  const issues: string[] = []
  if (endYear < startYear) issues.push(`effective endYear ${endYear} must be at least startYear ${startYear}`)
  if (endYear > MAX_CALENDAR_YEAR) issues.push(`effective endYear ${endYear} must not exceed ${MAX_CALENDAR_YEAR}`)
  if (endYear - startYear + 1 > MAX_EFFECTIVE_YEARS) issues.push(`effective plan span must not exceed ${MAX_EFFECTIVE_YEARS} years`)
  return issues
}

interface PlanBudget {
  issue: string | null
  workFactor: number
}

const committedPlanBudgets = new WeakMap<object, PlanBudget>()

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function planCollectionCount(plan: Plan): number {
  const record = plan as unknown as Record<string, unknown>
  const expenses = record.expenses as Record<string, unknown> | undefined
  const household = record.household as Record<string, unknown> | undefined
  return (
    arrayLength(household?.people) +
    arrayLength(record.accounts) +
    arrayLength(record.incomes) +
    arrayLength(expenses?.oneTimeGoals) +
    arrayLength(expenses?.phases) +
    arrayLength(expenses?.careEvents) +
    arrayLength(record.careEvents) +
    arrayLength(record.events)
  )
}

export function planWorkFactor(plan: Plan): number {
  return Math.max(1, planCollectionCount(plan) / 25)
}

/** Inspect an immutable plan once, then reuse the result on calculation paths. */
export function committedPlanBudget(plan: Plan): PlanBudget {
  const cached = committedPlanBudgets.get(plan)
  if (cached) return cached
  const result = { issue: structuralBudgetIssue(plan), workFactor: planWorkFactor(plan) }
  committedPlanBudgets.set(plan, result)
  return result
}

export function complexityIssue(horizon: number, work = 1, workFactor = 1): string | null {
  return horizon * work * workFactor > 500_000 ? 'requested work exceeds the aggregate computation budget' : null
}

export function normalizeCaveat(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim()
  return normalized.length > MAX_CAVEAT_CHARS
    ? `${normalized.slice(0, MAX_CAVEAT_CHARS - 3)}...`
    : normalized
}

export function boundedCaveats(caveats: readonly string[]): string[] {
  const normalized = caveats.map(normalizeCaveat)
  if (normalized.length <= MAX_CAVEATS) return normalized
  const retained = MAX_CAVEATS - 1
  return [
    ...normalized.slice(0, retained),
    `... (${normalized.length - retained} additional caveats omitted)`,
  ]
}

export function stringifyBoundedJson(value: unknown, spacing?: number): string {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }]
  const active = new Set<object>()
  let bytes = 0
  let nodes = 0
  while (stack.length > 0) {
    const item = stack.pop()!
    if (item.exit) {
      active.delete(item.value as object)
      continue
    }
    if (++nodes > 400_000 || item.depth > 64) throw new Error('response exceeds structural budget')
    bytes += primitiveBytes(item.value)
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('response exceeds byte budget')
    if (typeof item.value !== 'object' || item.value === null) continue
    if (active.has(item.value)) throw new Error('response must be acyclic JSON')
    active.add(item.value)
    stack.push({ ...item, exit: true })
    for (const [key, child] of Object.entries(item.value)) {
      bytes += jsonStringBytes(key) + 1
      stack.push({ value: child, depth: item.depth + 1 })
    }
  }
  const text = JSON.stringify(value, null, spacing)
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response exceeds byte budget')
  return text
}
