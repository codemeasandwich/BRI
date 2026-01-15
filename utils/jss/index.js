// JsonSuperSet - Extended JSON serialization with special type support

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

  function encodeValue(value, currentPath = '') {
    const type = typeof value;
    const tag = tagLookup[Object.prototype.toString.call(value)];

    if (tag !== undefined) {
      if ('D' === tag) return [tag, value.valueOf()];
      if ('E' === tag) return [tag, [value.name, value.message, value.stack]];
      if ('R' === tag) return [tag, value.toString()];
      if ('U' === tag) return [tag, null];
      if ('S' === tag) return [tag, Array.from(value)];
      if ('M' === tag) return [tag, Object.fromEntries(value)];
      return [tag, JSON.stringify(value)];
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

function stringify(obj) {
  return JSON.stringify(encode(obj));
}

function parse(encoded) {
  return decode(JSON.parse(encoded));
}

function checkIfArray(obj) {
  return Object.keys(obj).every(key => {
    const numericKey = key.replace(/<!.*>/, '');
    return !isNaN(numericKey);
  });
}

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
        const [nam, tag] = parseKeyWithTags(key);
        const decodedValue = decodeValue.call(
          currentPath,
          nam,
          tag,
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
