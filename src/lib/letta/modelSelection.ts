import type { ModelOption, ReasoningEffort } from "./api";

const EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Carry the user's reasoning intent across model families without sending an
 * effort tier the target model does not support. Remote/App-Server catalogs
 * expose the valid tiers per handle.
 */
export function compatibleEffortForModel(
  model: ModelOption,
  currentEffort: string | null,
): ReasoningEffort | undefined {
  const supported = model.supportedEfforts;
  const current = EFFORT_ORDER.includes(currentEffort as ReasoningEffort)
    ? (currentEffort as ReasoningEffort)
    : undefined;

  // Cloud/unknown catalogs may not advertise per-model tiers. Preserve the
  // current value and let the backend validate it, matching prior behavior.
  if (supported === undefined) return current;
  if (supported.length === 0) return undefined;
  if (current && supported.includes(current)) return current;

  // Preserve thinking on/off intent first. A model such as Ornith exposes only
  // none/high, so an older Qwen medium conversation should map to high, not
  // silently disable reasoning or submit the invalid medium tier.
  if (current === "none" && supported.includes("none")) return "none";
  const enabled = supported.filter((effort) => effort !== "none");
  if (current && current !== "none" && enabled.length > 0) {
    const currentIndex = EFFORT_ORDER.indexOf(current);
    return enabled.reduce((best, candidate) => {
      const bestDistance = Math.abs(EFFORT_ORDER.indexOf(best) - currentIndex);
      const candidateDistance = Math.abs(EFFORT_ORDER.indexOf(candidate) - currentIndex);
      return candidateDistance < bestDistance ? candidate : best;
    });
  }

  return supported[0];
}
