/**
 * @file Typed error classes for the Bri vector + graph surface.
 *
 * Every error thrown by the schema-aware engine paths uses a typed subclass
 * of BriError carrying a stable string `code`. This lets:
 *   - tests assert against `.code` instead of regexing message strings
 *   - downstream consumers (Ashlyn, etc.) catch by type AND switch on code
 *   - external observability scrape one shape across the whole codebase
 *
 * The 14 error codes come from spec §2.11 of `todo/Vector.md`. They are
 * frozen constants — adding a code is a minor (additive) change, renaming
 * one is a breaking change.
 *
 * Error class topology:
 *   BriError                 — base; carries { message, code, details }
 *   ├─ BriValidationError    — schema validation failures at the data boundary
 *   ├─ BriQueryError         — read-side failures (.near on non-vector field, etc.)
 *   ├─ BriProxyError         — entity-proxy access failures (unknown predicate, etc.)
 *   ├─ BriSchemaError        — schema declaration / load-time failures
 *   └─ BriRecoveryError      — WAL replay or snapshot recovery failures
 *
 * Why subclasses (not a single class with code switching): the type is a
 * coarse first filter — `catch (e if e instanceof BriValidationError)` —
 * and the code is the fine filter inside. Two-axis filtering matches
 * usage at the call site.
 *
 * @see Spec §2.11 for the binding error code list.
 */

/**
 * Frozen vocabulary of error codes. Re-exported by name from this module so
 * callers can `import { VECTOR_DIMS_MISMATCH } from '...'` rather than typing
 * the string literal at every catch site.
 */
export const ERROR_CODES = Object.freeze({
  // Validation (BriValidationError)
  VECTOR_DIMS_MISMATCH:        'VECTOR_DIMS_MISMATCH',
  VECTOR_INVALID_VALUE:        'VECTOR_INVALID_VALUE',
  REF_NOT_FOUND:               'REF_NOT_FOUND',
  REF_FORMAT_INVALID:          'REF_FORMAT_INVALID',
  EDGE_ENDPOINT_INVALID:       'EDGE_ENDPOINT_INVALID',
  // Query (BriQueryError)
  VECTOR_QUERY_DIMS_MISMATCH:  'VECTOR_QUERY_DIMS_MISMATCH',
  VECTOR_FIELD_NOT_DECLARED:   'VECTOR_FIELD_NOT_DECLARED',
  NOT_IMPLEMENTED_V1:          'NOT_IMPLEMENTED_V1',
  // Proxy (BriProxyError)
  PREDICATE_NOT_REGISTERED:    'PREDICATE_NOT_REGISTERED',
  CHAIN_CROSSES_COLLECTION:    'CHAIN_CROSSES_COLLECTION',
  // Schema (BriSchemaError)
  RESERVED_NAME_COLLISION:     'RESERVED_NAME_COLLISION',
  CASCADE_SCOPE_UNKNOWN:       'CASCADE_SCOPE_UNKNOWN',
  INDEX_FIELD_NOT_DECLARED:    'INDEX_FIELD_NOT_DECLARED',
  // Recovery (BriRecoveryError)
  WAL_INDEX_REPLAY_FAILED:     'WAL_INDEX_REPLAY_FAILED'
});

// Pull individual codes onto the module exports so call sites can do
// `import { VECTOR_DIMS_MISMATCH } from 'engine/errors.js'`. Keeping
// ERROR_CODES around lets diagnostic tooling enumerate the full set.
export const VECTOR_DIMS_MISMATCH       = ERROR_CODES.VECTOR_DIMS_MISMATCH;
export const VECTOR_INVALID_VALUE       = ERROR_CODES.VECTOR_INVALID_VALUE;
export const VECTOR_QUERY_DIMS_MISMATCH = ERROR_CODES.VECTOR_QUERY_DIMS_MISMATCH;
export const VECTOR_FIELD_NOT_DECLARED  = ERROR_CODES.VECTOR_FIELD_NOT_DECLARED;
export const REF_NOT_FOUND              = ERROR_CODES.REF_NOT_FOUND;
export const REF_FORMAT_INVALID         = ERROR_CODES.REF_FORMAT_INVALID;
export const EDGE_ENDPOINT_INVALID      = ERROR_CODES.EDGE_ENDPOINT_INVALID;
export const PREDICATE_NOT_REGISTERED   = ERROR_CODES.PREDICATE_NOT_REGISTERED;
export const CHAIN_CROSSES_COLLECTION   = ERROR_CODES.CHAIN_CROSSES_COLLECTION;
export const RESERVED_NAME_COLLISION    = ERROR_CODES.RESERVED_NAME_COLLISION;
export const CASCADE_SCOPE_UNKNOWN      = ERROR_CODES.CASCADE_SCOPE_UNKNOWN;
export const INDEX_FIELD_NOT_DECLARED   = ERROR_CODES.INDEX_FIELD_NOT_DECLARED;
export const WAL_INDEX_REPLAY_FAILED    = ERROR_CODES.WAL_INDEX_REPLAY_FAILED;
export const NOT_IMPLEMENTED_V1         = ERROR_CODES.NOT_IMPLEMENTED_V1;

/**
 * Base class for all typed Bri errors.
 *
 * Carries:
 *   - `message`: a human-readable, diagnostic, three-part error string
 *     ("what failed / why / how to prevent" per CLAUDE.md error standard)
 *   - `code`:    a stable, programmatic identifier (one of ERROR_CODES)
 *   - `details`: optional object with structured context (field names,
 *                values that triggered the error, etc.) — never includes
 *                secrets or PII; redact before stuffing in here
 *
 * Subclasses do NOT override the constructor signature — pass everything
 * through `{ message, code, details }`.
 *
 * @class BriError
 * @extends Error
 */
export class BriError extends Error {
  /**
   * @param {Object} init
   * @param {string} init.message   - Diagnostic message (what / why / how)
   * @param {string} init.code      - One of ERROR_CODES values
   * @param {Object} [init.details] - Structured context (no secrets / PII)
   */
  constructor({ message, code, details }) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Schema-validation failures at the data boundary (write-time). */
export class BriValidationError extends BriError {}

/** Read-side failures: .near on non-vector field, query dims mismatch, etc. */
export class BriQueryError extends BriError {}

/** Entity-proxy access failures: unknown predicate, chain crosses collection. */
export class BriProxyError extends BriError {}

/** Schema declaration / load-time failures: reserved-name collision, etc. */
export class BriSchemaError extends BriError {}

/** WAL replay or snapshot recovery failures. */
export class BriRecoveryError extends BriError {}
