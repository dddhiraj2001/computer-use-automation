import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/);
const policySchema = z.object({ callers: z.array(z.object({
  id: name,
  grants: z.array(z.object({ tenant: name, capability: name,
    version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict())
}).strict()) }).strict().superRefine((policy, context) => {
  if (new Set(policy.callers.map(caller => caller.id)).size !== policy.callers.length)
    context.addIssue({ code: "custom", message: "Duplicate caller identity" });
});

/** Local host attests caller identity; never take this identity from model/tool arguments. */
export class LocalAuthorization {
  private readonly policy: z.infer<typeof policySchema>;
  constructor(policy: unknown, private readonly callerId: string | undefined) {
    this.policy = policySchema.parse(policy);
  }
  permits(tenant: string, capability: string, version: string): boolean {
    if (!this.callerId) return false;
    return this.policy.callers.find(caller => caller.id === this.callerId)?.grants.some(grant =>
      grant.tenant === tenant && grant.capability === capability && grant.version === version) ?? false;
  }
}
