import { describe, expect, test } from "bun:test";
import type { ModelOption } from "./api";
import { compatibleEffortForModel } from "./modelSelection";

function model(efforts?: ModelOption["supportedEfforts"]): ModelOption {
  return { id: "m", handle: "vllm/test", label: "Test", ...(efforts === undefined ? {} : { supportedEfforts: efforts }) };
}

describe("model effort compatibility", () => {
  test("maps an unsupported Qwen medium tier to Ornith high", () => {
    expect(compatibleEffortForModel(model(["none", "high"]), "medium")).toBe("high");
  });

  test("preserves none when the target supports it", () => {
    expect(compatibleEffortForModel(model(["none", "high"]), "none")).toBe("none");
  });

  test("preserves an already-supported tier", () => {
    expect(compatibleEffortForModel(model(["none", "high"]), "high")).toBe("high");
  });

  test("omits effort for a target that advertises no reasoning tiers", () => {
    expect(compatibleEffortForModel(model([]), "medium")).toBeUndefined();
  });

  test("keeps legacy behavior when the catalog does not advertise tiers", () => {
    expect(compatibleEffortForModel(model(), "medium")).toBe("medium");
  });
});
