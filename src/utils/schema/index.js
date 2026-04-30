/**
 * @file Schema Validation — Bri schema validator with typed-error throws.
 *
 * Validates POJOs against schema declarations. Throws `BriValidationError`
 * with a stable `.code` on any failure — see engine/errors.js for the
 * full code vocabulary (`VECTOR_DIMS_MISMATCH`, `VECTOR_INVALID_VALUE`,
 * `REF_FORMAT_INVALID`, etc.).
 *
 * Contract change (v1 vector + graph): the validator USED to return a
 * string error or null. As of the typed-error migration it THROWS instead
 * (spec §2.11). Callers that previously checked `if (validationError)`
 * must now use `try { validate(...) } catch (e) { ... }` — the
 * vectorIndexMiddleware and schema-registry wrappers were updated in the
 * same migration. Tests in tests/e2e/schema.test.js exercise the throw
 * contract.
 *
 * Type vocabulary (what callers can declare in `field.type`):
 *   String, Number, Boolean, Date, Object, Array  - JS native constructors
 *   'email'                                       - regex-validated string
 *   'ref'                                         - ID string matching the
 *                                                   Bri ID pattern; existence
 *                                                   is checked at the engine
 *                                                   middleware boundary, not
 *                                                   here (the validator has
 *                                                   no live-store access)
 *   'ref|string'                                  - polymorphic: matches the
 *                                                   ID pattern OR is any
 *                                                   non-empty string (used
 *                                                   for triple objects that
 *                                                   may be either an entity
 *                                                   reference or a literal)
 *   'predicate'                                   - string drawn from a
 *                                                   registered predicate
 *                                                   vocabulary; the exact
 *                                                   vocabulary check is the
 *                                                   schema registry's job —
 *                                                   here we just enforce
 *                                                   that the value is a
 *                                                   non-empty string
 *   'vector'                                      - numeric array; field
 *                                                   declaration must include
 *                                                   `dims: <positive int>`
 */

import {
  BriValidationError,
  VECTOR_DIMS_MISMATCH,
  VECTOR_INVALID_VALUE,
  REF_FORMAT_INVALID
} from '../../engine/errors.js';

/**
 * Bri ID pattern. Matches what `engine/id.js` actually emits:
 *   - 4 uppercase letters from `type2Short()` (engine/types.js)
 *   - underscore
 *   - 7 chars from the alphabet hardcoded in engine/id.js → makeid:
 *     `0123456789abcdefghjkmnpqrtuvwxyz` — Crockford-style lowercase
 *     base32 that skips ambiguous 'i', 'l', 'o', 's'
 *
 * Spec §2.11 documents an uppercase variant; reality is lowercase because
 * that's what the generator produces. We validate against the generator,
 * not against the prose spec — otherwise no engine-issued ID would parse.
 *
 * Used to validate `'ref'` field values at write time. Existence-of-doc
 * is a separate check happening in the engine middleware (see
 * engine/vector-middleware.js); this regex catches obvious malformed
 * input early so the engine never sees an unparseable ref.
 */
const ID_ALPHABET_REGEX_FRAGMENT = '[0-9a-hjkmnp-rtu-z]';
const ID_PATTERN = new RegExp(`^[A-Z]{4}_${ID_ALPHABET_REGEX_FRAGMENT}{7}$`);

/**
 * Coarse type-shape check used as the first gate in validate().
 *
 * Purpose: tell us whether the value is plausibly the declared type. Detailed
 * sub-rules (vector dims / finiteness, ref ID format, predicate vocab, etc.)
 * are applied AFTER this check passes so error messages can be specific.
 *
 * @param {Function|string} type - Schema type constructor or named string type
 * @param {*} value              - Field value to inspect
 * @returns {boolean} true if value is shape-compatible with type
 */
const checkType = (type, value) => {
    switch (type) {
        case String:    return typeof value === 'string';
        case Number:    return typeof value === 'number';
        case Boolean:   return typeof value === 'boolean';
        case Date:      return value instanceof Date;
        case Object:    return typeof value === 'object' && !Array.isArray(value) && value !== null;
        case Array:     return Array.isArray(value);
        case 'email':   return typeof value === 'string' && /\S+@\S+\.\S+/.test(value);
        case 'ref':     return typeof value === 'string';
        case 'ref|string': return typeof value === 'string' && value.length > 0;
        case 'predicate':  return typeof value === 'string' && value.length > 0;
        case 'vector':  return Array.isArray(value);
        default:        return false;
    }
};

/**
 * Vector field deep-validator.
 *
 * Throws BriValidationError with code:
 *   - VECTOR_DIMS_MISMATCH   — schema declares dims=N but value.length !== N,
 *                              or schema is missing positive dims
 *   - VECTOR_INVALID_VALUE   — non-numeric or non-finite element
 *
 * Why a separate function: validate() needs to throw distinct codes for
 * distinct failure modes so callers can react programmatically. Inlining
 * the checks would muddy the switch in validate(); extracting keeps each
 * failure mode close to its specific code.
 *
 * @param {string} field      - Field name (for error messages)
 * @param {Array} value       - Vector to validate (array shape verified by caller)
 * @param {Object} schemaField - Schema field declaration; must include dims
 * @returns {void}
 * @throws {BriValidationError} VECTOR_DIMS_MISMATCH | VECTOR_INVALID_VALUE
 */
const validateVector = (field, value, schemaField) => {
    const dims = schemaField.dims;
    if (typeof dims !== 'number' || dims <= 0) {
        throw new BriValidationError({
            code: VECTOR_DIMS_MISMATCH,
            message: `Field '${field}' declares vector type but is missing positive 'dims' (got ${JSON.stringify(dims)}). Add { type: 'vector', dims: <positive integer> } to the schema.`,
            details: { field, declaredDims: dims }
        });
    }
    if (value.length !== dims) {
        throw new BriValidationError({
            code: VECTOR_DIMS_MISMATCH,
            message: `Field '${field}' vector dimension mismatch: schema expected ${dims}, value has ${value.length}. Re-embed the value with the configured embedding model or update the schema dims to match.`,
            details: { field, expected: dims, got: value.length }
        });
    }
    for (let i = 0; i < value.length; i++) {
        const e = value[i];
        if (typeof e !== 'number') {
            throw new BriValidationError({
                code: VECTOR_INVALID_VALUE,
                message: `Field '${field}'[${i}] must be a number; got ${typeof e}. Vector elements must be finite floats.`,
                details: { field, index: i, type: typeof e }
            });
        }
        if (!Number.isFinite(e)) {
            throw new BriValidationError({
                code: VECTOR_INVALID_VALUE,
                message: `Field '${field}'[${i}] must be finite; got ${e}. NaN / Infinity break cosine similarity — re-normalize the vector before insert.`,
                details: { field, index: i, value: e }
            });
        }
    }
};

/**
 * Validate a `'ref'` field's ID format. Existence is checked at the
 * engine boundary, not here (the validator has no live-store access).
 *
 * @param {string} field - Field name (for error messages)
 * @param {string} value - Candidate ID string
 * @throws {BriValidationError} REF_FORMAT_INVALID on pattern mismatch
 */
const validateRefFormat = (field, value) => {
    if (!ID_PATTERN.test(value)) {
        throw new BriValidationError({
            code: REF_FORMAT_INVALID,
            message: `Field '${field}' is a 'ref' but value '${value}' does not match the Bri ID pattern '^[A-Z]{4}_[0-9A-HJ-NP-TV-Z]{7}$'. Refs must be document $ID strings. Generate with the engine, do not hand-write.`,
            details: { field, value }
        });
    }
};

/**
 * Validate a `'ref|string'` field. Either a Bri-ID-pattern string OR any
 * non-empty literal string. Used for polymorphic fields like triple objects
 * (subject_id refers to an entity, but object_id_or_literal can be either).
 *
 * @param {string} value - Candidate value (already type-shape-checked)
 * @returns {boolean} true if value matches the ID pattern (caller may want to know)
 */
const validateRefOrString = (value) => ID_PATTERN.test(value);

/**
 * Build a readable label for a schema type, used in 'should be of type X' errors.
 * @param {Function|string} type
 * @returns {string}
 */
const labelFor = (type) =>
    type === 'email'      ? 'Email'
  : type === 'ref'        ? 'Reference'
  : type === 'ref|string' ? 'Reference or string'
  : type === 'predicate'  ? 'Predicate'
  : type === 'vector'     ? 'Vector (numeric array)'
  : type && type.name      ? type.name
  : String(type);

/**
 * Validate a POJO against a schema definition.
 *
 * Returns nothing on success; throws on failure. Side-effect: applies any
 * declared `set` / `get` transforms in place on the validated object (this
 * is preserved from the legacy contract — middleware relies on it).
 *
 * @param {Object} schemaObj - Schema definition
 * @param {Object} pojoObj   - Plain object to validate
 * @returns {void}
 * @throws {BriValidationError} on any field that fails validation
 */
export default function validate(schemaObj, pojoObj){
    for (const key in schemaObj) {
        // Collection-level options ($indexes, $supersession, etc.) configure
        // engine behavior — they are not per-document fields.
        if (key.startsWith('$')) continue;
        const schemaField = schemaObj[key];
        const pojoField = pojoObj[key];

        if (pojoField === undefined) {
            if (schemaField.required !== false) {
                throw new BriValidationError({
                    code: 'FIELD_REQUIRED',
                    message: `Field '${key}' is required.`,
                    details: { field: key }
                });
            }
            continue;
        }

        if (!checkType(schemaField.type, pojoField)) {
            throw new BriValidationError({
                code: 'FIELD_TYPE_MISMATCH',
                message: `Field '${key}' should be of type ${labelFor(schemaField.type)}; got ${typeof pojoField}.`,
                details: { field: key, expectedType: labelFor(schemaField.type), got: typeof pojoField }
            });
        }

        // Vector deep-check after array shape passes checkType.
        if (schemaField.type === 'vector') {
            validateVector(key, pojoField, schemaField);
        }

        // Ref ID-format check. Existence is the engine's responsibility.
        if (schemaField.type === 'ref') {
            validateRefFormat(key, pojoField);
        }

        // Polymorphic ref|string: if it looks like an ID, it must match the
        // pattern; if not, any non-empty string is fine. The intent is to
        // accept entity refs while not forcing literals to look like IDs.
        if (schemaField.type === 'ref|string') {
            // If the value happens to start with the four-uppercase prefix it
            // was probably meant to be a ref — reject malformed refs eagerly
            // so a typo doesn't quietly become a literal.
            if (/^[A-Z]{4}_/.test(pojoField) && !validateRefOrString(pojoField)) {
                throw new BriValidationError({
                    code: REF_FORMAT_INVALID,
                    message: `Field '${key}' looks like a ref ('${pojoField}') but does not match the Bri ID pattern. Either fix the ref or pass a literal that does not start with four uppercase letters + underscore.`,
                    details: { field: key, value: pojoField }
                });
            }
        }

        // Enum check.
        if (schemaField.enum && !schemaField.enum.includes(pojoField)) {
            throw new BriValidationError({
                code: 'FIELD_ENUM_MISMATCH',
                message: `Field '${key}' should be one of [${schemaField.enum.join(', ')}]; got '${pojoField}'.`,
                details: { field: key, allowed: schemaField.enum, got: pojoField }
            });
        }

        // Get + set transforms run after validation (preserve legacy behavior).
        let transformedValue = pojoField;
        if (schemaField.get) transformedValue = schemaField.get(pojoField);
        if (schemaField.set) transformedValue = schemaField.set(transformedValue);
        pojoObj[key] = transformedValue;

        // Recurse into nested objects.
        if (schemaField.type === Object && schemaField.properties) {
            validate(schemaField.properties, pojoField);
        }

        // Validate array items if `items` declares a constructor type.
        if (schemaField.type === Array && schemaField.items) {
            for (const item of pojoField) {
                if (!checkType(schemaField.items, item)) {
                    throw new BriValidationError({
                        code: 'FIELD_ARRAY_ITEM_MISMATCH',
                        message: `Each item in '${key}' should be of type ${labelFor(schemaField.items)}; got ${typeof item}.`,
                        details: { field: key, expectedItemType: labelFor(schemaField.items), got: typeof item }
                    });
                }
            }
        }
    }
};

export { checkType };
