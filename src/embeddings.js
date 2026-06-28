/**
 * Cosine similarity between two equal-length numeric arrays.
 * Returns a value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find the top-N most similar entries to a query embedding.
 * @param {number[]} queryEmbedding
 * @param {object[]} allEntries
 * @param {{ threshold?: number, topN?: number, excludeId?: string }} opts
 */
export function findSimilar(queryEmbedding, allEntries, {
  threshold = 0.38,
  topN      = 5,
  excludeId = null
} = {}) {
  return allEntries
    .filter(e => e.id !== excludeId && Array.isArray(e.embedding) && e.embedding.length > 0)
    .map(e => ({ ...e, similarity: cosineSimilarity(queryEmbedding, e.embedding) }))
    .filter(e => e.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}
