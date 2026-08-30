import { describe, expect, test } from "bun:test";
import { summarizeToolInput } from "./toolText";

describe("human-readable tool summaries", () => {
  test("prefers an explicit description over a raw Bash command", () => {
    expect(summarizeToolInput({ command: "find /var/log -type f | head", description: "Find recent gateway log files" }, "Bash"))
      .toBe("Find recent gateway log files");
  });

  test("turns common shell operations into readable intent when description is absent", () => {
    expect(summarizeToolInput({ command: "git status --short --branch" }, "Bash")).toBe("Check repository status");
    expect(summarizeToolInput({ command: "npm run lint -- --max-warnings=0" }, "Bash")).toBe("Run lint checks");
  });

  test("uses file and search context for non-shell tools", () => {
    expect(summarizeToolInput({ file_path: "/home/rgadmin/app/voice_gateway.py" }, "Read")).toBe("Read voice_gateway.py");
    expect(summarizeToolInput({ query: "transcription progress" }, "Search")).toBe("Search for “transcription progress”");
  });

  test("falls back to a readable tool name instead of raw JSON", () => {
    expect(summarizeToolInput({ opaque: { nested: true } }, "custom_tool_name")).toBe("Custom tool name");
  });
  test("does not scan an arbitrarily large shell payload just to label the card", () => {
    const huge = `git status --short --branch\n${"x".repeat(250_000)}`;
    expect(summarizeToolInput({ command: huge }, "Bash")).toBe("Check repository status");
  });

});
