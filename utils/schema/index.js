/**
 * @file Schema Validation - Mongoose-like schema validation for BRI
 *
 * Supports type checking, required fields, enums, get/set transformers,
 * nested objects, array item validation, and vector embeddings.
 *
 * Contract: validate(schema, obj) returns a descriptive error string or null.
 *           Returning a string preserves the historical, non-throwing API used
 *           by the existing validationMiddleware in engine/middleware.js.
 *
 * Type vocabulary:
 *   String, Number, Boolean, Date, Object, Array  - JS native constructors
 *   'email'                                       - regex-validated string
 *   'ref'                                         - string ID reference
 *   'vector'                                      - numeric array; needs dims
 */

/**
 * Coarse type-shape check used as the first gate in validate().
 *
 * Purpose: tell us whether the value is plausibly the declared type. Detailed
 * sub-rules (vector dims, vector finiteness, ref ID format, etc.) are applied
 * AFTER this check passes so error messages can be specific.
 *
 * @param {Function|string} type - Schema type constructor or named string type
 * @param {*} value - Field value to inspect
 * @returns {boolean} true if value is shape-compatible with type
 */
const checkType = (type, value) => {
    switch (type) {
        case String:
            return typeof value === 'string';
        case Number:
            return typeof value === 'number';
        case Boolean:
            return typeof value === 'boolean';
        case Date:
            return value instanceof Date;
        case Object:
            return typeof value === 'object' &&
                   ! Array.isArray(value) &&
                   value !== null;
        case Array:
            return Array.isArray(value);
        case 'email':
            return typeof value === 'string' && /\S+@\S+\.\S+/.test(value); // Simple email regex
        case 'ref':
            return typeof value === 'string'; // Assuming references are stored as strings (e.g., IDs)
        case 'vector':
            // A vector is a non-null, non-string array. Element-level checks
            // (numeric, finite, dim count) run separately so error messages
            // can pinpoint the actual problem.
            return Array.isArray(value);
        default:
            return false;
    }
};

/**
 * Vector field deep-validator.
 *
 * Why separate from checkType: the surrounding validate() needs to keep type
 * shape checks fast and binary-true/false. Vector validation has three failure
 * modes (dim mismatch, non-numeric element, non-finite element) and each one
 * needs a distinct, actionable error message. Keeping this here lets
 * validate() stay readable while still meeting the diagnostic-error standard.
 *
 * @param {string} field - Field name (for error messages)
 * @param {Array} value  - Vector to validate (array shape already verified)
 * @param {Object} schemaField - Schema field declaration; must include numeric dims
 * @returns {string|null} Error message or null if valid
 */
const validateVector = (field, value, schemaField) => {
    const dims = schemaField.dims;
    if (typeof dims !== 'number' || dims <= 0) {
        return `${field} schema declares vector type but is missing positive 'dims'.`;
    }
    if (value.length !== dims) {
        return `${field} vector dimension mismatch: expected ${dims}, got ${value.length}.`;
    }
    for (let i = 0; i < value.length; i++) {
        const e = value[i];
        if (typeof e !== 'number') {
            return `${field}[${i}] must be a number; got ${typeof e}.`;
        }
        if (!Number.isFinite(e)) {
            return `${field}[${i}] must be finite; got ${e}.`;
        }
    }
    return null;
};

/**
 * Validate a POJO against a schema definition
 * @param {Object} schemaObj - Schema definition
 * @param {Object} pojoObj - Plain object to validate
 * @returns {string|null} - Error message or null if valid
 */
export default function validate(schemaObj, pojoObj){
    for (const key in schemaObj) {
        // Collection-level options ($indexes, $supersession, etc.) are not
        // per-document fields — they configure engine behavior. Skip them here
        // so the validator only inspects field declarations.
        if (key.startsWith('$')) continue;
        const schemaField = schemaObj[key];
        const pojoField = pojoObj[key];

        // Check if the field is required and missing (if `required` is not set to false)
        if (pojoField === undefined) {
            if (schemaField.required !== false) {
                return `${key} is required.`;
            }
        } else {
            // Check type
            if (!checkType(schemaField.type, pojoField)) {
                // Map named types to readable labels; constructor types use .name.
                const typeLabel = schemaField.type === 'email'  ? 'Email'
                                : schemaField.type === 'ref'    ? 'Reference'
                                : schemaField.type === 'vector' ? 'Vector (numeric array)'
                                : schemaField.type.name;
                return `${key} should be of type ${typeLabel}.`;
            }

            // Vector deep-check: element types, finiteness, and dimension count.
            // Runs only after the array shape passed checkType above.
            if (schemaField.type === 'vector') {
                const vErr = validateVector(key, pojoField, schemaField);
                if (vErr) return vErr;
            }

            // Enum check for roles
            if (schemaField.enum &&
              ! schemaField.enum.includes(pojoField)) {
                return `${key} should be one of ${schemaField.enum.join(', ')}.`;
            }

            // Get logic
            let transformedValue = pojoField; // Use a new variable for transformation
            if (schemaField.get) {
                transformedValue = schemaField.get(pojoField);
            }

            // Set logic
            if (schemaField.set) {
                transformedValue = schemaField.set(transformedValue);
            }

            // Assign the transformed value back to the original object
            pojoObj[key] = transformedValue;

            // If the field is an object, check it recursively
            if (schemaField.type === Object &&
                schemaField.properties) {
                const nestedValidation = validate(schemaField.properties, pojoField);
                if (nestedValidation) {
                    return nestedValidation; // Return error from nested validation
                }
            }

            // If the field is an array, check its items
            if (schemaField.type === Array &&
                schemaField.items) {
                if (!Array.isArray(pojoField)) {
                    return `${key} should be an array.`;
                }
                for (const item of pojoField) {
                    const itemValidation = checkType(schemaField.items, item);
                    if (!itemValidation) {
                        return `Each item in ${key} should be of type ${schemaField.items.name}.`;
                    }
                }
            }
        }
    }
    return null; // No validation errors
};

export { checkType };
