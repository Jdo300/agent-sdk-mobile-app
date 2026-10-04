export interface RuntimeHealthInput {
  configuredModel: string | null;
  runtimeModel: string | null;
  configuredTools: readonly string[];
  runtimeTools: readonly string[] | null;
}

export interface RuntimeHealthResult {
  warnings: string[];
  missingTools: string[];
  modelMismatch: boolean;
}

export function assessRuntimeHealth(input: RuntimeHealthInput): RuntimeHealthResult {
  const configured = [...new Set(input.configuredTools)].sort();
  const runtime = input.runtimeTools === null ? null : new Set(input.runtimeTools);
  const missingTools = runtime === null ? [] : configured.filter((name) => !runtime.has(name));
  const modelMismatch =
    Boolean(input.configuredModel) &&
    Boolean(input.runtimeModel) &&
    input.configuredModel !== input.runtimeModel;

  const warnings: string[] = [];
  if (modelMismatch) {
    warnings.push(
      `The live runtime resolved to ${input.runtimeModel}, but this conversation is configured for ${input.configuredModel}. Tool/model capabilities may not match the selected model.`,
    );
  }
  if (configured.length > 0 && runtime !== null && runtime.size === 0) {
    warnings.push(
      `This agent has ${configured.length} configured tool${configured.length === 1 ? "" : "s"}, but the live runtime loaded none. Tool calls will not execute until the runtime is repaired.`,
    );
  } else if (missingTools.length > 0) {
    const preview = missingTools.slice(0, 3).join(", ");
    warnings.push(
      `The live runtime is missing ${missingTools.length} configured tool${missingTools.length === 1 ? "" : "s"}: ${preview}${missingTools.length > 3 ? "…" : ""}`,
    );
  }

  return { warnings, missingTools, modelMismatch };
}
