import { describe, expect, test } from "bun:test";

import { emptyChat } from "./model";
import { demoTurn, patch, playScript, upsertItem } from "./mockSession";

describe("snapshot helpers", () => {
  test("upsertItem appends new items and replaces by id", () => {
    const a = upsertItem(emptyChat, { kind: "user", id: "u1", text: "hi" });
    expect(a.transcript).toHaveLength(1);
    const b = upsertItem(a, { kind: "user", id: "u1", text: "edited" });
    expect(b.transcript).toHaveLength(1);
    expect(b.transcript[0]).toMatchObject({ text: "edited" });
    expect(emptyChat.transcript).toHaveLength(0);
  });

  test("patch replaces top-level fields immutably", () => {
    const next = patch(emptyChat, { run: "running" });
    expect(next.run).toBe("running");
    expect(emptyChat.run).toBe("idle");
  });
});

describe("demo turn script", () => {
  test("plays through every chat state the UI must handle", async () => {
    const phases: string[] = [];
    const approvals: number[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      const total = demoTurn.length;
      playScript(
        demoTurn.map((step) => ({ ...step, after: 1 })),
        (snapshot) => {
          phases.push(snapshot.run);
          approvals.push(snapshot.approvals.length);
          count++;
          if (count === total + 1) resolve();
        },
      );
    });
    expect(phases).toContain("running");
    expect(phases).toContain("awaiting_approval");
    expect(phases[phases.length - 1]).toBe("idle");
    expect(Math.max(...approvals)).toBe(1);
  });

  test("stop function cancels pending steps", async () => {
    let emissions = 0;
    const stop = playScript(demoTurn, () => {
      emissions++;
    });
    stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(emissions).toBe(1); // only the initial empty snapshot
  });
});
