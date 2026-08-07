import { describe, expect, it } from "vitest";
import { configFrom } from "./config";

const baseEnv = {
  DATABASE_URL: "postgres://localhost/pi-cloud-agent",
  APP_AUTH_REQUIRED: "false",
  AIGATEWAY_BASE_URL: "https://gateway.example/v1",
  AIGATEWAY_API_KEY: "model-key",
  VCS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  LLM_ENCRYPTION_KEY: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
};

describe("observability configuration", () => {
  it("parses OTLP headers without exposing them to the runtime config", () => {
    const config = configFrom({
      ...baseEnv,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer secret,x-project=agent",
    });

    expect(config.observability).toEqual({
      tracesEndpoint: "https://collector.example/v1/traces",
      tracesHeaders: { Authorization: "Bearer secret", "x-project": "agent" },
      serviceName: "pi-cloud-agent",
      exportDebugEvents: false,
    });
  });

  it("leaves export disabled without an endpoint", () => {
    expect(configFrom(baseEnv).observability.tracesEndpoint).toBe("");
  });

  it("rejects malformed OTLP headers and endpoints", () => {
    expect(() =>
      configFrom({
        ...baseEnv,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization",
      }),
    ).toThrow("comma-separated key=value pairs");

    expect(() =>
      configFrom({
        ...baseEnv,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a URL",
      }),
    ).toThrow("valid URL");
  });
});
