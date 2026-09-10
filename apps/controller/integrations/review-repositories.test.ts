import { describe, expect, it } from "vitest";
import { usableReviewRepository } from "./review-repositories";

describe("manual GitHub repository authorization", () => {
  it("accepts only the requested repository from a usable App installation", () => {
    const repositories = [
      { installationId: "1", repo: "acme/allowed", autoReview: false, problem: null },
      {
        installationId: "1",
        repo: "acme/missing-permissions",
        autoReview: false,
        problem: "Grant Contents read and Pull requests write access in GitHub.",
      },
    ];

    expect(usableReviewRepository(repositories, "acme/allowed")?.installationId).toBe("1");
    expect(usableReviewRepository(repositories, "acme/missing-permissions")).toBeNull();
    expect(usableReviewRepository(repositories, "acme/not-installed")).toBeNull();
  });
});
