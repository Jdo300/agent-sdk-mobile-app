import { describe, expect, test } from "bun:test";
import { isSecretSlashCommand } from "./secretCommands";

describe("isSecretSlashCommand", () => {
  test("matches secret manager commands", () => {
    expect(isSecretSlashCommand("/secret")).toBe(true);
    expect(isSecretSlashCommand("  /SECRET list")).toBe(true);
    expect(isSecretSlashCommand("/secrets set API_KEY value")).toBe(true);
  });

  test("does not swallow ordinary text", () => {
    expect(isSecretSlashCommand("/secretary")).toBe(false);
    expect(isSecretSlashCommand("please use /secret later")).toBe(false);
    expect(isSecretSlashCommand("hello")).toBe(false);
  });
});
