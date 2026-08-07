import { describe, expect, it } from "vitest";
import { isActiveStatus } from "./format";

describe("isActiveStatus", () => {
  it("keeps queued and provisioning turns active for progress surfaces", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("provisioning")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
  });

  it("does not mark terminal turns active", () => {
    expect(isActiveStatus("succeeded")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});
