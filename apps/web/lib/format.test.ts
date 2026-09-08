import { describe, expect, it } from "vitest";
import { formatDuration, isActiveStatus } from "./format";

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

describe("formatDuration", () => {
  it("uses readable singular and plural retention units", () => {
    expect(formatDuration(1)).toBe("1 second");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(604_800)).toBe("7 days");
  });

  it("rounds values that do not align to a whole unit", () => {
    expect(formatDuration(90)).toBe("2 minutes");
  });
});
