import { pipeline } from "@xenova/transformers";
import type { Env } from "../config.js";

// Ticket 3.6 (D64): the RAG chat's query-time embedding runs the exact same
// weights the workers' embedder (3.5, D63) uses for documents —
// EMBEDDING_QUERY_MODEL defaults to transformers.js's ONNX port of
// sentence-transformers/all-MiniLM-L6-v2 (the workers' EMBEDDING_MODEL) —
// via transformers.js in-process, so both sides land in the same 384-dim
// cosine space without a second service or a cross-language RPC call.
// $0/self-hosted (CLAUDE.md invariant 6): the model downloads once from the
// HF hub and is cached on disk, same as pyannote's gated model.

export type Embedder = {
  embed: (text: string) => Promise<number[]>;
};

// Loaded lazily and cached at module scope: the first chat request in a
// process pays the model-load latency, every request after is warm. A
// second pipeline() call for an already-loaded model is cheap, but there's
// no reason to pay even that twice per process.
let extractorPromise: ReturnType<typeof pipeline<"feature-extraction">> | null = null;

function getExtractor(model: string) {
  extractorPromise ??= pipeline("feature-extraction", model);
  return extractorPromise;
}

export function createEmbedder(env: Env): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const extractor = await getExtractor(env.EMBEDDING_QUERY_MODEL);
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(output.data as Float32Array);
    },
  };
}
