import { expect, test } from "bun:test";
import { opLabel, opTone } from "./ops.ts";

test("operation tones", () => {
  expect(opTone("copy")).toBe("primary");
  expect(opTone("move")).toBe("warning");
  expect(opTone("sync_metadata")).toBe("tertiary");
});

test("operation labels", () => {
  expect(opLabel("sync_metadata")).toBe("Sync metadata");
});
