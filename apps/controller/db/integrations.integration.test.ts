import { expect, it } from "vitest";
import { bindTestDatabase } from "../test-support";
import {
  claimIntegrationDelivery,
  finishIntegrationDelivery,
  recordIntegrationDelivery,
} from "./integrations";

let database: Parameters<typeof claimIntegrationDelivery>[0];
bindTestDatabase((value) => {
  database = value;
});

it("deduplicates a GitHub delivery and claims it exactly once", async () => {
  const input = {
    provider: "github",
    deliveryId: "delivery-1",
    eventType: "ping",
    action: null,
    payload: { action: "ping" },
  };
  await expect(recordIntegrationDelivery(database, input)).resolves.toBe(true);
  await expect(recordIntegrationDelivery(database, input)).resolves.toBe(false);

  const claimed = await claimIntegrationDelivery(database, "github");
  expect(claimed?.deliveryId).toBe("delivery-1");
  expect(claimed?.status).toBe("processing");
  if (!claimed) throw new Error("delivery was not claimed");
  await expect(
    finishIntegrationDelivery(database, claimed, { status: "processed" }),
  ).resolves.toBe(true);
  await expect(claimIntegrationDelivery(database, "github")).resolves.toBeNull();
});
