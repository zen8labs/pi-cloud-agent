import { describe, expect, it } from "vitest";
import { createVcsProvider, vcsProviderNames } from "./index";

describe("provider registry", () => {
  it("lists the alternatives when asked for one that does not exist", () => {
    expect(() => createVcsProvider("perforce", "")).toThrow(
      /Unknown VCS provider "perforce".*azure-devops, github/s,
    );
  });

  it("lists the providers it can build", () => {
    expect(vcsProviderNames()).toEqual(["azure-devops", "github"]);
  });
});
