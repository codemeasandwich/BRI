/**
 * @file JsonSuperSet — extended JSON serialization with typed tags (Date,
 *       Error, Map, Set, RegExp, cycles).
 */

/**
 * Encode a plain object or array into JSS tagged key/value form before JSON serialization.
 * @param {object|Array} obj - Root value to encode
 * @returns {object|Array} Encoded structure using `<!tag>` key suffixes for typed leaves
 */
function encode(obj) {
  const tagLookup = {
    '[object RegExp]': 'R',
    '[object Date]': 'D',
    '[object Error]': 'E',
    '[object Undefined]': 'U',
    '[object Map]': 'M',
    '[object Set]': 'S',
  };
  const visited = new WeakMap();

  /**
   * Recursive encoder — emits typed tuples or nested plain structures for one subtree.
   * @param {*} value - Current node to encode
   * @param {string} currentPath - Path segment string used for circular-reference bookkeeping
   * @returns {Array|string|number|boolean|null|Object} Internal encode tuple / intermediate structure: typed leaf `[tag, payload]` (`tag` one of `R/D/E/U/M/S`), cycle marker `['P', path]`, heterogeneously tagged arrays `[ '[types]', vals ]`, or plain nested POJO/array shells with `''` marks for JSON-safe scalars.
   */
  function encodeValue(value, currentPath) {
    // Recursive calls always pass the path segment (`key` or childPath); encode()
    // never invokes this with only one argument, so omitting optional path
    // normalization keeps the bytecode free of unreachable default-arg branches.
    const type = typeof value;
    const tag = tagLookup[Object.prototype.toString.call(value)];

    if (tag !== undefined) {
      if ('D' === tag) return [tag, value.valueOf()];
      if ('E' === tag) return [tag, [value.name, value.message, value.stack]];
      if ('R' === tag) return [tag, value.toString()];
      if ('U' === tag) return [tag, null];
      if ('S' === tag) return [tag, Array.from(value)];
      /* Remaining builtin tag among Map/Set is Map — Set returned above */
      return [tag, Object.fromEntries(value)];
    } else if (type === 'object' && value !== null) {
      if (visited.has(value)) {
        return ['P', visited.get(value)];
      }
      visited.set(value, currentPath);
      const isArray = Array.isArray(value);
      const keys = isArray ? Array.from(Array(value.length).keys()) : Object.keys(value);
      const result = isArray ? [] : {};
      const typesFound = [];

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const childPath = currentPath ? `${currentPath}/${key}` : `${key}`;
        const [t, v] = encodeValue(value[key], childPath);
        if (isArray) {
          typesFound.push(t);
          result.push(v);
        } else if (value[key] !== undefined) {
          result[key + (t ? `<!${t}>` : '')] = v;
        }
      }

      visited.delete(value);
      if (isArray && typesFound.find((t) => !!t)) {
        return [`[${typesFound.join()}]`, result];
      }
      return ['', result];
    } else {
      return ['', value];
    }
  }

  let keys = [];
  let result = {};

  if (Array.isArray(obj)) {
    keys = Array.from(Array(obj.length).keys());
    result = [];
  } else {
    keys = Object.keys(obj);
    result = {};
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (obj[key] !== undefined) {
      const [t, v] = encodeValue(obj[key], key);
      result[key + (t ? `<!${t}>` : '')] = v;
    }
  }
  return result;
}

/**
 * Serialize an object to JSS extended JSON text.
 * @param {object|Array} obj - Root value
 * @returns {string} JSON string of encoded form
 */
function stringify(obj) {
  return JSON.stringify(encode(obj));
}

/**
 * Parse JSS extended JSON text back into JavaScript values.
 * @param {string} encoded - JSON text produced by {@link stringify}
 * @returns {object|Array|string|number|boolean|null} Root after decoding — always plain JS data plus restored builtins (Date/RegExp/Map/Set/Error), cycle repairs applied afterward via pointer replay (never leaves JSON-only wrappers at the root).
 */
function parse(encoded) {
  return decode(JSON.parse(encoded));
}

/**
 * Detect whether the decoded object shape represents a homogeneous numeric-key array.
 * @param {object} obj - Parsed plain object before array coercion
 * @returns {boolean} True when every own key is numeric after stripping tags
 */
function checkIfArray(obj) {
  return Object.keys(obj).every(key => {
    const numericKey = key.replace(/<!.*>/, '');
    return !isNaN(numericKey);
  });
}

/**
 * Decode JSS intermediate representation (plain object tree) into JavaScript values.
 * @param {object|Array} data - Parsed JSON object tree
 * @returns {object|Array|string|number|boolean|null} Root payload — object graph or array reconstructed from JSS tags; primitives only appear when the encoded payload truly rooted at a primitive (unusual for `encode`, common after recursive descent inside objects).
 */
function decode(data) {
  const result = checkIfArray(data) ? [] : {};
  const pointers2Res = [];
  const tagLookup = {
    R: (s) => new RegExp(s),
    D: (n) => new Date(n),
    P: function (sourceToPointAt, replaceAtThisPlace) {
      pointers2Res.push([sourceToPointAt, replaceAtThisPlace + '']);
      return sourceToPointAt;
    },
    E: ([name, message, stack]) => {
      let err;
      try {
        err = new global[name](message);
        if (err instanceof Error) err.stack = stack;
        else throw {};
      } catch (e) {
        err = new Error(message);
        err.name = name;
        err.stack = stack;
      }
      return err;
    },
    U: () => undefined,
    S: (a) => new Set(a),
    M: (o) => new Map(Object.entries(o))
  };
  const visited = new Map();

  /**
   * Decode one keyed entry — restores typed leaves and walks nested objects.
   * @param {string} name - Logical property name (without tag suffix)
   * @param {string|undefined} tag - Type tag from key suffix or tuple metadata
   * @param {*} val - Raw JSON subtree for this property
   * @returns {string|number|boolean|null|undefined|Date|RegExp|Error|Map|Set|Array|Object} Value represented by this `(name, tag, val)` triple after delegating to `tagLookup`, tuple-expanding heterogeneous arrays, or recursively decoding nested POJO fragments (cycles deferred until pointer fix-up).
   */
  function decodeValue(name, tag, val) {
    // `this` is the current path context (e.g., "documents/POST_1")
    const currentPath = this ? `${this}/${name}` : name;

    if (tag in tagLookup) {
      return tagLookup[tag](val, currentPath);
    } else if (Array.isArray(val)) {
      if (tag && tag.startsWith('[')) {
        const typeTags = tag.slice(1, -1).split(',');
        const result = [];
        for (let i = 0; i < val.length; i++) {
          const decodedValue = decodeValue.call(
            currentPath,
            i,
            typeTags[i],
            val[i]
          );
          result.push(decodedValue);
        }
        return result;
      } else {
        const result = [];
        for (let i = 0; i < val.length; i++) {
          const decodedValue = decodeValue.call(currentPath, i, '', val[i]);
          result.push(decodedValue);
        }
        return result;
      }
    } else if ('object' === typeof val && val !== null) {
      if (visited.has(val)) {
        return visited.get(val);
      }
      visited.set(val, {});
      const result = {};
      for (const key in val) {
        const [nam, tagFromKey] = parseKeyWithTags(key);
        const decodedValue = decodeValue.call(
          currentPath,
          nam,
          tagFromKey,
          val[key]
        );
        result[nam] = decodedValue;
      }
      visited.set(val, result);
      return result;
    } else {
      return val;
    }
  }

  /**
   * Split a serialized object key into base name and optional `<!tag>` suffix.
   * @param {string} key - Raw object key possibly ending with `<!tag>`
   * @returns {[string, string|undefined]} Base key and tag when present
   */
  function parseKeyWithTags(key) {
    const match = key.match(/(.+)(<!(.+)>)/);
    if (match) {
      return [match[1], match[3]];
    } else {
      return [key, undefined];
    }
  }

  for (const key in data) {
    const [name, tag] = parseKeyWithTags(key);
    result[name] = decodeValue.call('', name, tag, data[key]);
  }
  pointers2Res.forEach(changeAttributeReference.bind(null, result));
  return result;
}

/**
 * Resolve pointer placeholders after the main decode pass — wires cyclic graphs.
 * @param {object} obj - Root decoded object
 * @param {[string, string]} tuple - `[refPath, attrPath]` JSON-pointer-like paths
 * @returns {object} Same root object with attribute rewired to reference target
 */
function changeAttributeReference(obj, [refPath, attrPath]) {
  const refKeys = refPath.split('/');
  const attrKeys = attrPath.split('/');
  let ref = obj;
  let attr = obj;

  for (let i = 0; i < refKeys.length - 1; i++) {
    ref = ref[refKeys[i]];
  }
  for (let i = 0; i < attrKeys.length - 1; i++) {
    attr = attr[attrKeys[i]];
  }
  attr[attrKeys[attrKeys.length - 1]] = ref[refKeys[refKeys.length - 1]];
  return obj;
}

export default { parse, stringify, encode, decode };
