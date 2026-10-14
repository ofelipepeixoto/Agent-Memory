import { timingSafeCompare } from "./auth.js";

export type AccessMode = "local" | "shared";

export function validateAccessMode(mode: string | undefined, secret?: string): AccessMode {
  const selected = mode ?? "local";
  if (selected !== "local" && selected !== "shared") throw new Error("Invalid AGENTMEMORY_ACCESS_MODE");
  if (selected === "shared" && (!secret?.trim() || /^\$\{.*\}$/.test(secret))) {
    throw new Error("Shared mode requires a configured AGENTMEMORY_SECRET");
  }
  return selected;
}

export function authorizeBearer(
  headers: Record<string, unknown> | undefined,
  secret: string | undefined,
  mode: AccessMode,
): { status_code: number; body: { error: string } } | null {
  if (!secret || (mode === "shared" && (!secret.trim() || /^\$\{.*\}$/.test(secret)))) {
    return mode === "shared"
      ? { status_code: 503, body: { error: "authentication unavailable" } }
      : null;
  }
  const value = headers?.authorization ?? headers?.Authorization;
  return typeof value === "string" && timingSafeCompare(value, `Bearer ${secret}`)
    ? null
    : { status_code: 401, body: { error: "unauthorized" } };
}
