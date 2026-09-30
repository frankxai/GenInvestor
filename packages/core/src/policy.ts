// TypeScript twin of engine/src/investor_engine/policy.py. Both load the same
// contract file (packages/contracts/policy/policy.json) and both must pass every
// case in it, so the gate cannot drift between languages.

export type Verdict = "allow" | "human_gate" | "blocked";

export interface PolicyTable {
  version: number;
  ceiling: string;
  modes: string[];
  allowedByMode: Record<string, string[]>;
  hardBlocked: string[];
  humanGate: string[];
  cases: PolicyCase[];
}

export interface ActionInput {
  action_type: string;
  mode?: string;
  uses_real_funds?: boolean;
  touches_wallet?: boolean;
  touches_banking?: boolean;
  requires_secret?: boolean;
  amount?: number | null;
  cap?: number | null;
}

export interface PolicyCase {
  id: string;
  action: ActionInput;
  expect: Verdict;
  why: string;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
  requiredGate: "stop" | "human" | null;
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

function capInvalid(a: ActionInput): boolean {
  const amount = a.amount ?? null;
  const cap = a.cap ?? null;
  if (amount === null && cap === null) return false;
  if (amount === null || cap === null) return true;
  return amount > cap;
}

export function evaluate(table: PolicyTable, action: ActionInput): Decision {
  const mode = action.mode ?? table.ceiling;
  if (mode === "L5_REAL_AUTONOMY_EXCLUDED") {
    return { verdict: "blocked", reason: "Real autonomous capital movement is excluded.", requiredGate: "stop" };
  }
  if (mode === "L4_SANDBOX_WALLET_FUTURE") {
    return { verdict: "blocked", reason: "Sandbox wallet mode is reserved for future gated work.", requiredGate: "stop" };
  }
  if (table.hardBlocked.includes(action.action_type)) {
    return { verdict: "blocked", reason: `Action is hard-blocked: ${action.action_type}`, requiredGate: "stop" };
  }
  if (action.requires_secret) {
    return { verdict: "blocked", reason: "Secrets and wallet recovery material cannot enter the engine.", requiredGate: "stop" };
  }
  if (
    action.uses_real_funds ||
    action.touches_wallet ||
    action.touches_banking ||
    table.humanGate.includes(action.action_type)
  ) {
    return {
      verdict: "human_gate",
      reason: "Live-money, wallet, banking, or custody-adjacent action requires human control.",
      requiredGate: "human",
    };
  }
  if (capInvalid(action)) {
    return { verdict: "human_gate", reason: "Missing or invalid cap fails closed.", requiredGate: "human" };
  }
  if ((table.allowedByMode[mode] ?? []).includes(action.action_type)) {
    return { verdict: "allow", reason: "Action is inside the current autonomy mode.", requiredGate: null };
  }
  return {
    verdict: "human_gate",
    reason: `Action is outside current autonomy mode: ${action.action_type}`,
    requiredGate: "human",
  };
}

// Entry-point guard: refuses any mode above the ceiling, then requires an allow.
export function require(table: PolicyTable, actionType: string, rest: Omit<ActionInput, "action_type"> = {}): Decision {
  const action: ActionInput = { action_type: actionType, ...rest };
  const mode = action.mode ?? table.ceiling;
  if (table.modes.indexOf(mode) > table.modes.indexOf(table.ceiling)) {
    throw new PolicyViolation(`[blocked] ${actionType}: mode ${mode} is above the engine ceiling ${table.ceiling}`);
  }
  const decision = evaluate(table, action);
  if (decision.verdict !== "allow") {
    throw new PolicyViolation(`[${decision.verdict}] ${actionType}: ${decision.reason}`);
  }
  return decision;
}
