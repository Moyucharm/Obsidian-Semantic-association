/**
 * Unified exports for the embeddings module.
 */

export type { EmbeddingProvider } from "./provider";
export { RemoteProvider, normalizeRemoteBaseUrl } from "./remote-provider";
export type { RemoteProviderConfig } from "./remote-provider";
export { EmbeddingService } from "./embedding-service";
