/**
 * Schema Validation - Mongoose-like schema validation for BRI
 *
 * Supports type checking, required fields, enums, get/set transformers,
 * nested objects, and array item validation.
 */

// Helper function to check type
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
        default:
            return false;
    }
};

/**
 * Validate a POJO against a schema definition
 * @param {Object} schemaObj - Schema definition
 * @param {Object} pojoObj - Plain object to validate
 * @returns {string|null} - Error message or null if valid
 */
export default function validate(schemaObj, pojoObj){
    for (const key in schemaObj) {
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
                return `${key} should be of type ${schemaField.type === 'email' ? 'Email'
                                                                                : schemaField.type === 'ref'
                                                                  ? 'Reference' : schemaField.type.name}.`;
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
