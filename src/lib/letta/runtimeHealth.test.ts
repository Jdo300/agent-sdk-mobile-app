import { describe, expect, test } from "bun:test";

import { assessRuntimeHealth } from "./runtimeHealth";

describe("runtime health", () => {
  test("flags a provider/model fallback and vanished toolset", () => {
    const result = assessRuntimeHealth({
      configuredModel: "vllm/Qwen3.8-27B",
      runtimeModel: "openai/vllm/Qwen3.8-27B",
      configuredTools: ["Bash", "Read", "Write"],
      runtimeTools: [],
    });
    expect(result.modelMismatch).toBe(true);
    expect(result.missingTools).toEqual(["Bash", "Read", "Write"]);
    expect(result.warnings).toHaveLength(2);
  });

  test("stays quiet when runtime matches configuration", () => {
    expect(assessRuntimeHealth({
      configuredModel: "vllm/Qwen3.8-27B",
      runtimeModel: "vllm/Qwen3.8-27B",
      configuredTools: ["Bash", "Read"],
      runtimeTools: ["Read", "Bash", "ExtraRuntimeTool"],
    })).toEqual({ warnings: [], missingTools: [], modelMismatch: false });
  });

  test("does not guess when runtime tool metadata is unavailable", () => {
    const result = assessRuntimeHealth({
      configuredModel: "vllm/Qwen3.8-27B",
      runtimeModel: "vllm/Qwen3.8-27B",
      configuredTools: ["Bash"],
      runtimeTools: null,
    });
    expect(result.warnings).toEqual([]);
    expect(result.missingTools).toEqual([]);
  });
});
