import { z } from "zod";
import { capabilitySchema, actionKindSchema, riskSchema, targetSchema, type Capability } from "../contracts/capability.js";
import { isDeepStrictEqual } from "node:util";
import { RunError, type Step } from "./ports.js";
const route = z.string().regex(/^\/(?!\/)[^?#\\]*$/);
export const tenantProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  appFamily: z.string().min(1), appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  origin: z.string().url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  }),
  routes: z.array(route).min(1), resourcePaths: z.array(route),
  actions: z.array(actionKindSchema).min(1), maximumRisk: riskSchema,
  reviewedControls: z.array(z.object({
    target: targetSchema, actions: z.array(z.enum(["click", "type"])), minimumRisk: riskSchema
  }).strict()).max(100).default([]),
  targetOverrides: z.record(z.unknown()).default({}),
  sessionRecoverySelector: z.string().min(1).max(300).optional(),
  versionSelector: z.string().min(1).max(300).optional(),
  operatorRequiredSelectors: z.array(z.string().min(1).max(300)).max(10).default([]),
  informationalAlerts: z.array(z.string().min(1).max(200)).max(10).default([]),
  uiFailures: z.array(z.object({ selector: z.string().min(1).max(300),
    code: z.enum(["session_expired", "permission_denied", "app_error"]) }).strict()).max(10).default([])
}).strict();
export type TenantProfile = z.infer<typeof tenantProfileSchema>;
export function routeAllowed(path: string, routes: readonly string[]): boolean {
  const parts = path.split("/");
  return routes.some(route => {
    const expected = route.split("/");
    return expected.length === parts.length && expected.every((part, i) =>
      part.startsWith(":") ? /^[a-zA-Z0-9_-]+$/.test(parts[i] ?? "") : part === parts[i]);
  });
}
export function destinationAllowed(url: string, tenant: TenantProfile, capability: Capability): boolean {
  try {
    const value = new URL(url);
    return !value.username && !value.password && value.origin === tenant.origin &&
      routeAllowed(value.pathname, tenant.routes) && routeAllowed(value.pathname, capability.policy.allowedRoutes);
  } catch { return false; }
}
export function authorizeStep(step: Step, tenant: TenantProfile, capability: Capability): void {
  const rank = { read_only: 0, reversible: 1, irreversible: 2 };
  let minimumRisk = 0;
  if (step.action === "click" || step.action === "type") {
    const action = step.action;
    const target = capability.targets[step.target];
    const rules = tenant.reviewedControls.filter(rule => rule.actions.includes(action) &&
      target && sameControl(target, rule.target));
    if (!rules.length) throw new RunError("policy_denied", "Control/action has no trusted approval.");
    minimumRisk = Math.max(...rules.map(rule => rank[rule.minimumRisk]));
  }
  const effectiveRisk = Math.max(rank[step.risk], minimumRisk);
  if (!tenant.actions.includes(step.action) || !capability.policy.allowedActions.includes(step.action) ||
      effectiveRisk > rank[tenant.maximumRisk] || effectiveRisk > rank[capability.policy.maximumRisk] || effectiveRisk === rank.irreversible) {
    throw new RunError("policy_denied", "Action denied by trusted policy or requires unimplemented human approval.");
  }
}

/** Every fallback and frame must be reviewed; display prose is not control identity. */
export function sameControl(left: Capability["targets"][string], right: Capability["targets"][string]): boolean {
  return isDeepStrictEqual(left.framePath, right.framePath) && isDeepStrictEqual(left.strategies, right.strategies);
}

/** Copy trusted static descriptors, never page-derived description/robustness strings. */
export function reviewedTarget(target: Capability["targets"][string], tenant: TenantProfile): Capability["targets"][string] | undefined {
  const rule = tenant.reviewedControls.find(item => sameControl(target, item.target));
  return rule ? structuredClone(rule.target) : undefined;
}
export function specialize(capability: Capability, tenant: TenantProfile): Capability {
  if (tenant.appFamily !== capability.compatibility.appFamily || !capability.compatibility.appVersions.includes(tenant.appVersion)) {
    throw new RunError("incompatible_surface", "Tenant application version is incompatible with this capability.");
  }
  for (const name of Object.keys(tenant.targetOverrides)) {
    if (!Object.hasOwn(capability.targets, name)) throw new RunError("incompatible_surface", "Tenant override references an unknown target.");
  }
  return capabilitySchema.parse({ ...capability, targets: { ...capability.targets, ...tenant.targetOverrides } });
}
