import type { Config } from "../config";
import { IntegrationRegistry } from "./registry";
import { HttpCallbackReportSink, RestWebhookIngressAdapter } from "./rest-webhook";

export function createWebhookRegistry(config: Config): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  const token = config.webhook.bearerToken;
  if (!token) return registry;
  registry.registerAdapter(new RestWebhookIngressAdapter(token));
  registry.registerSink(new HttpCallbackReportSink());
  return registry;
}
