/**
 * @file Vector schema helpers for the per-database schema registry.
 *
 * Domain context: Bri supports one vector field per logical collection so the
 * public `.near()` query surface always has an unambiguous embedding source.
 *
 * Technical context: keeping vector-field discovery outside
 * `schema-registry.js` keeps the registry coordinator below the repository
 * source-line gate while preserving the same synchronous declaration flow.
 */

/**
 * Walk a schema definition and pick out the collection's vector field.
 *
 * @param {Object} schemaDef - Bri schema declaration object.
 * @returns {{name:string, dims:number, metric:string}|null} Vector metadata or
 *   null when the collection has no vector field.
 * @throws {Error} When more than one vector field is declared.
 */
export function findVectorField(schemaDef) {
  let found = null;
  for (const [name, decl] of Object.entries(schemaDef)) {
    if (decl && decl.type === 'vector') {
      if (found) {
        throw new Error(
          `Schema declares more than one vector field ` +
          `('${found.name}' and '${name}'). v1 supports at most one.`
        );
      }
      found = { name, dims: decl.dims, metric: decl.metric || 'cosine' };
    }
  }
  return found;
}
