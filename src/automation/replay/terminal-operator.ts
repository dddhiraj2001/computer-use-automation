import { createInterface } from "node:readline/promises";
import type { InterventionHandler } from "./ports.js";

export function operatorInstructions(reason: string): string {
  if (reason === "session_expired") return "The application logged out. In this synthetic demo, click Restore demo session in the existing browser (no password needed). Then return here and type resume. In a real application, use its approved sign-in process; never enter credentials in this terminal.";
  if (reason === "operator_required") return "A configured operator-only checkpoint needs you. For the Continue lookup test fixture, click Continue lookup in the existing browser, then type resume here. This is a test obstacle, not a real banking approval.";
  return "The automation could not verify the expected page state. Review the existing browser and complete the blocked step only if you understand it. Type abort if you are unsure; otherwise type resume after completing it.";
}

/** Local operator route: the headed browser remains open while the terminal owns resume. */
export class TerminalOperator implements InterventionHandler {
  async request(context: Parameters<InterventionHandler["request"]>[0], signal: AbortSignal): Promise<"resume" | "abort"> {
    if (!process.stdin.isTTY) return "abort";
    console.log("Human control active. Operate the existing browser window; do not open a new session.");
    console.log(`Run: ${context.runId} | Step: ${context.stepId} | Reason: ${context.reason}`);
    console.log(operatorInstructions(context.reason));
    if (context.conditionContext) console.log(context.conditionContext);
    console.log(context.phase === "discovery"
      ? "Resolve the blocked state, then resume. Discovery re-observes this session; an assisted artifact must pass separate model-free replay before saving."
      : "Complete the blocked step manually. Resume verifies its postconditions; it never repeats that action.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (!signal.aborted) {
        const remaining = context.deadlineAt === undefined ? "" : ` (${Math.max(0, Math.ceil((context.deadlineAt - Date.now()) / 1000))} seconds remaining)`;
        const answer = await terminal.question(`Type resume or abort${remaining}: `, { signal });
        if (answer.trim() === "resume") return "resume";
        if (answer.trim() === "abort") return "abort";
        console.log("Not recognized. Type resume after completing the browser task, or abort to stop. Nothing was resumed.");
      }
      return "abort";
    } catch { return "abort"; }
    finally { terminal.close(); }
  }
}
