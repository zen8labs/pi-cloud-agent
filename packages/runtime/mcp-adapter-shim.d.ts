/**
 * Ambient shim so we do not typecheck pi-mcp-adapter's TypeScript sources
 * (they are extension-loader oriented and fail under this package's strictness).
 * Runtime still loads the real package via tsx in the sandbox image.
 */
declare module "pi-mcp-adapter" {
  export function createMcpAdapter(options?: {
    config?: unknown;
    configPath?: string;
  }): (pi: unknown) => void;
}
