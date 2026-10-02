import { z } from "zod";

// Deliberately exclude text, labels, attributes, URLs and input values.
export const safeTagSchema = z.enum(["html", "body", "header", "nav", "main", "footer", "section", "div", "p", "h1", "h2", "h3", "form", "input", "button", "a", "select", "textarea", "table", "thead", "tbody", "tr", "th", "td", "other"]);
const coordinate = z.number().finite().min(-100000).max(100000);
export const boxSchema = z.object({ x: coordinate, y: coordinate, width: coordinate.nonnegative(), height: coordinate.nonnegative() }).strict();
export const manualActionSchema = z.object({
  tag: safeTagSchema,
  controlType: z.enum(["text", "password", "checkbox", "radio", "submit", "button", "hidden", "other", "none"]),
  box: boxSchema
}).strict();
export type ManualAction = z.infer<typeof manualActionSchema>;
export const diagnosticSchema = z.object({
  surface: z.literal("web"), sessionOpen: z.boolean(), controlCount: z.number().int().nonnegative(),
  snapshot: z.object({
    format: z.literal("structural-dom-v1"), truncated: z.boolean(),
    nodes: z.array(z.object({
      index: z.number().int().nonnegative(), parent: z.number().int().min(-1), tag: safeTagSchema,
      visible: z.boolean(), disabled: z.boolean(), box: boxSchema
    }).strict()).max(500)
  }).strict().optional()
}).strict();
export type SurfaceDiagnostic = { surface: string; sessionOpen: boolean; controlCount: number; snapshot?: z.infer<typeof diagnosticSchema>["snapshot"] };
