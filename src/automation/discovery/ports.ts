import type { Capability } from "../contracts/capability.js";
import type { SurfaceAdapter } from "../replay/ports.js";
export interface ObservedControl {
  id: string; text: string; tag: string; filled: boolean;
  target: Capability["targets"][string];
}
export interface DiscoverySurface extends Pick<SurfaceAdapter, "start" | "close" | "act" | "matches" | "read" | "diagnostics" | "beginManual" | "endManual" | "drainRecoveries"> {
  observe(): Promise<ObservedControl[]>;
}
