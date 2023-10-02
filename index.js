const { createClient } = require('redis');
const { createPatch } = require('rfc6902');
const JSS = require('../../utils/jss.js');
//const scribbles = require('scribbles');

/*import { createClient } from 'redis';
import { createPatch } from 'rfc6902';
import JSS from '../../utils/jss.js';
*/
//type WhereFunction = (dbEntry: object) => boolean;
let client;

const useRedisHash = false // NEEDS more work! :(

const collectionNamePattern = /^[a-z0-9]+(?<![sS])(?:S)?$/

// TODO:
// - typescipt support for schemas

//interface Path { [index: number]: string | number; }
//type Value = string | number | boolean | null | undefined | {} | any[];
const undeclared = Symbol("Empty")
const MAKE_COPY = Symbol("makeCopy")
//=====================================================
//===================================== Redis Hash Maps
//=====================================================

//++++++++++++++++++++++++++++++++++++++++++ save HASH
//++++++++++++++++++++++++++++++++++++++++++++++++++++
/*
function saveHash(redisClient, obj) {
  const flatObj = flatten(obj);
  const flatArr = flatObj.map(([path, value]) => redisClient.hset(obj.$ID, path, value))
  return Promise.all(flatArr).then(() => obj)
} // saveHash

//++++++++++++++++++++++++++++++++++++++++++ read HASH
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function readHash(redisClient, $ID, keys) {

  if (!keys) {
    return redisClient.hgetall($ID)
      .then(unflatten)
  }

  if ("string" === typeof keys) {
    keys = [keys]
  }
  if (!Array.isArray(keys)) {
    throw Error(`Bad keys input: ${JSON.stringify(keys)}`)
  }

  return Promise.all(keys.map(key => redisClient.hget($ID, key)))
    .then(unflatten)
} // END readHash

//++++++++++++++++++++++++++++++++++++++++++ unflatten
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function unflatten(data) {
  if (Object(data) !== data
    || Array.isArray(data))
    return data;
  //data = {...data}
  //delete data["."]
  const regex = /\.?([^.\[\]]+)|\[(\d+)\]/g
  const resultholder = {};

  for (var p in data) {
    let cur = resultholder
    let prop = ""
    let m;

    while (m = regex.exec(p)) {
      cur = cur[prop] || (cur[prop] = (m[2] ? [] : {}));
      prop = m[2] || m[1];
    }
    cur[prop] = data[p];
  }
  return resultholder[""] || resultholder;
}; // END unflatten

//++++++++++++++++++++++++++++++++++++++++++++ flatten
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function flatten(data) {
  const result = {};
  function recurse(cur, prop) {
    if (Object(cur) !== cur) {
      result[prop] = cur;
    } else if (Array.isArray(cur)) {
      for (var i = 0, l = cur.length; i < l; i++)
        recurse(cur[i], prop + "[" + i + "]");
      if (l == 0)
        result[prop] = [];
    } else {
      var isEmpty = true;
      for (var p in cur) {
        isEmpty = false;
        recurse(cur[p], prop ? prop + "." + p : p);
      }
      if (isEmpty && prop)
        result[prop] = {};
    }
  }
  recurse(data, "");
  return result;
} // END flatten
*/
//+++++++++++++++++++++++++++++ stripDown$ID
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function stripDown$ID(obj, first) {

  // check if the object is an array
  if (Array.isArray(obj)) {
    return obj.map(x => stripDown$ID(x));
  }
  // Check if constricted object
  if (!obj || false === obj instanceof Object) return obj;

  // Check if DB object
  if (!first && '$ID' in obj) return obj.$ID

  // Check if constricted object
  if ('[object Object]' !== obj.toString()) return obj;

  // Purse basic object
  const newObj = {}
  for (let key in obj) {
    newObj[key] = stripDown$ID(obj[key]);
  }
  return newObj;
  /*
  for (let key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (typeof obj[key] === 'object'
        && obj[key] !== null
        && '$ID' in obj[key]) {
        obj[key] = obj[key].$ID;
      } else {
        obj[key] = stripDown$ID(obj[key]);
      }
    }
  }
  return obj;
  */
}


function DB() {
  //=====================================================
  //======================================== connect 2 DB
  //=====================================================
  console.log('REDIS_HOST:', process.env.REDIS_HOST);
  console.log('REDIS_PORT:', process.env.REDIS_PORT);
  client = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    },
    retryStrategy: (times) => {
      const delay = Math.min(times * 100, 3000);
      console.error(`BRI: Connection refused. Retrying in ${delay / 1000} seconds...`);
      return delay;
    }/*,
    retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          console.error('Redis Client Error', options.error);
          console.log(`Connection refused. Retrying in ${options.total_retry_time / 1000} seconds...`);
        }
    
        // Exponential backoff with a maximum delay of 3000 ms (3 seconds)
        const delay = Math.min(options.attempt * 100, 3000);
        return delay;
      },*/
  });

  client.on('error', (err) => console.error('Redis Client Error', err));
  const ready = client.connect();

  //=====================================================
  //================================================ U ID
  //=====================================================

  //+++++++++++++++++++++++++++++++++++++++++++++ gen id
  //++++++++++++++++++++++++++++++++++++++++++++++++++++

  function genid(type) {
    let uid = makeid();
    const $ID = `${type}_${uid}`;
    return idIsFree($ID).then((isFree) => (isFree ? $ID : genid(type)));
  }
  //++++++++++++++++++++++++++++++++++++++++++++ make id
  //++++++++++++++++++++++++++++++++++++++++++++++++++++

  function makeid(length = 7) {
    let result = '';
    const characters = '0123456789abcdefghjkmnpqrtuvwxyz';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
      counter += 1;
    }
    return result;
  }

  //++++++++++++++++++++++++++++++++ check if ID is used
  //++++++++++++++++++++++++++++++++++++++++++++++++++++

  function idIsFree($ID) {
    return ready.then(() => client.get($ID).then((x) => !x));
  }

  //=====================================================
  //============================ setup subscriber connect
  //=====================================================

  const subscriber = client.duplicate();
  const ready2sub = subscriber.connect();

  const type2Short = (type) => {
    if ("string" === typeof type) {
      const start = type.slice(0, 2)
      let end = type.slice(-2)
      if (type.endsWith('S')) {
        end = type.slice(-3, -1)
      }
      return `${start}${end}`.toUpperCase()
    }
  }

  const publish = (
    oldVal,
    newVal,
    action,
    saveBy,
    tag
  ) => {

    const createdAt = new Date();

    return genid(type2Short('diff')).then(($ID) => {
      // we need to do parse/stringify as
      // 'replace' with '/updatedAt' is not deteced

      const patchs = createPatch(oldVal, newVal);

      if ('CREATE' !== action) {
        patchs.push({ op: 'test', path: '/updatedAt', value: oldVal.updatedAt });
      }
      const result = JSS.stringify({
        patchs,
        saveBy: saveBy || '',
        tag: tag || '',
        target: newVal.$ID,
        $ID,
        createdAt,
        action
      }); // END stringify
      // Create  ||  Delete
      return client.publish((newVal.$ID || oldVal.$ID).split('_')[0], result);
    });
  }; // END publish

  const wrapper = {

    //=====================================================
    //================================================= sub
    //=====================================================

    sub: (type, cb) => {
      return ready2sub.then(() => {
        const idType = type2Short(type);
        subscriber.subscribe(idType, (json) => {
          const data = JSS.parse(json);
          data.createdAt = new Date(data.createdAt);
          cb(data);
        });
        return () => subscriber.unsubscribe(idType);
      });
    }, // END sub

    //=====================================================
    //======================================== create / add
    //=====================================================

    create: (type, data, opts) => {
      let tag, saveBy;
      if (data.$ID) {
        throw new Error(`Trying to "add" an Object with ${data.$ID} to BRI`)
      }

      if (type.toLowerCase().endsWith("s")) {
        throw new Error(`Types cant end with 's'. You passed "${type}"`)
      }

      if ('object' === typeof opts) {
        tag = opts.tag || '';
        saveBy = opts.saveBy;
      }
      const shortType = type2Short(type)
      return ready
        .then(() => genid(shortType))
        .then(($ID) => {
          const percent = Object.assign({}, stripDown$ID(data));
          percent.$ID = $ID;
          percent.createdAt = new Date();
          percent.updatedAt = percent.createdAt;

          const saving = client.set($ID, JSS.stringify(percent))
            .then(() => client.sAdd(`${shortType}?`, $ID.split("_").pop()));

          if (true === saveBy) {
            saveBy = $ID;
          }
          saving.then(() => publish({}, percent, 'CREATE', saveBy, tag)); //.catch(console.error)
          // we get so we can have then "save()" fns added
          return saving.then(() => wrapper.get(type, $ID)); //.catch(console.error)
        }); // END ready
    }, // END create

    //=====================================================
    //================================== update - PRIVATE !
    //=====================================================

    update: (target, changes2save, opts) => {
      let tag, saveBy;
      //console.log(target)
      //console.log(changes2save)
      //console.log(opts)
      if ('object' === typeof opts) {
        tag = opts.tag || '';
        saveBy = opts.saveBy;
      }
      if (0 === changes2save.length) {
        // I THINK IF THERE ARE NO CHANGES
        // Save DONT return from its promuses
        debugger
      }

      return ready.then(() => (
        client.get(target.$ID)
          .then(jss => JSS.parse(jss))
      )).then(targetDb => {
        //console.log(target.$ID, targetDb)
        const diff = buildOverlayObject(changes2save, targetDb)
        // TODO: check diff is not changing the createAt or updateAt
        const percent = Object.assign({}, targetDb, diff);

        if (true === saveBy) {
          saveBy = target.$ID;
        }
        //console.log(5, percent)
        const perToSave = stripDown$ID(percent, true)
        //console.log(6, perToSave)
        const saving = client.set(target.$ID, JSS.stringify(perToSave));

        return saving.then(() => {
          publish(target, perToSave, 'UPDATE', saveBy, tag);
          return percent
        })
      }) //.catch(console.error)
    }, // END update

    //=====================================================
    //======================================== remove / del
    //=====================================================

    remove: function (type, $ID, deletedBy) {
      //console.log(type)
      //console.log($ID)
      //console.log(deletedBy)

      //debugger
      $ID = $ID &&
        $ID.$ID ||
        $ID

      if ("string" != typeof $ID
        || !$ID.includes('_')) {
        throw new Error(`"${$ID}" is not a vaild ID`);
      }

      if (!deletedBy || !deletedBy.includes('_')) {
        console.warn(`Who is deleting this?`, { type, $ID, deletedBy });
      }

      const shortType = type2Short(type)

      if ("string" == typeof $ID && $ID.split('_')[0] !== shortType) {
        throw new Error(`${$ID} is not a type of "${type}"`)
      }

      return wrapper.get(type, $ID)
        .then(item => {
          if (!item) {
            throw new Error(`"${$ID}" was not found`)
          }

          return publish(item, {}, 'DELETE', deletedBy)
            .then(() => {
              item.deletedAt = new Date()
              item.deletedBy = deletedBy
              return item.save()
            }).then(() => {
              //debugger
              return Promise.all([
                client.rename($ID, "X:" + $ID + ":X"),
                client.sRem(`${shortType}?`, $ID.split('_').pop())
              ])
            }).then(() => {
              const output = { ...item }
              delete output.deletedAt
              delete output.deletedBy
              return output
            })
        }) // END then
    },// END remove

    //=====================================================
    //================================================= get
    //=====================================================

    get: function (type, where) {

      if (2 === arguments.length
        && undefined === where) {
        throw new Error(`You are tring to pass 'undefined' to .get.${type}(...)`)
      }

      if ('string' === typeof type
        && !type.endsWith('S')// && ! $ID.includes('_')
        && !where) {
        const errMessage = `You are missing you selecter argument for ${type}`
        console.error(new Error(errMessage).stack);
        throw new Error(errMessage);
      }

      let $ID = '';
      if ('string' === typeof where) {
        if (null === type
          || where.startsWith(type2Short(type)))
          $ID = where;
        else
          throw new Error(`Type ${type} dont not match ID:${where}`);
      } else if ('object' === typeof where) {
        if (where.$ID) {
          if (where.$ID.startsWith(type2Short(type))) {
            $ID = where.$ID
          } else {
            throw new Error(`Type ${type} dont not match ID:${where.$ID}`);
          }
        } else {
          const matchThis = where;
          where = (source) => checkMatch(matchThis, source);
        }
      }

      const groupCall = (type
        && type.endsWith('S'))
        || this.groupCall;

      const populate = key => {
        const keys = 'string' === typeof key ? [key] : key;

        const processEntry = (percent) => {
          if (!percent || (groupCall && 0 === percent.length)) {
            return percent;
          }
          percent = Object.assign({}, percent);

          return Promise.all(
            keys.map((key) => {
              if (!percent[key]) {
                if (groupCall) {
                  return undefined;
                } else {
                  throw new Error(`Cannot populate non-existing key "${key}"`);
                }
              } if (Array.isArray(percent[key])) {
                return Promise.all(percent[key].map(k => wrapper.get(null, k)))
              }
              return wrapper.get(null, percent[key]);
            })
          ).then((population) => {
            return result.then((out) => {
              const copy = out[MAKE_COPY]
              population.forEach((val, index) => {
                copy[keys[index]] = val;
              })
              return copy
            })

            //return percent;
          }); // END Promise.all
        }

        const output = result.then(data => {
          if (Array.isArray(data)) {
            return Promise.all(data.map(processEntry))
          }
          return processEntry(data)
        }); // END result.then
        output.populate = populate;
        return output;
      }; // END populate

      const result = ready.then(() => {
        if ($ID.includes('_')) {
          return client.get($ID).then((x) => {
            if (!x) {
              return x;
            }
            const adb = JSS.parse(x)
            if ("object" === where
              && !checkMatch(where, adb)) {
              return null
            }
            /*
            
            Object.defineProperty(adb, 'toObject', {
              value: () => adb,
              enumerable: false, // hide this key
            });
            Object.defineProperty(adb, 'toString', {
              value: () => $ID,
              enumerable: false, // hide this key
            });
            Object.defineProperty(adb, 'valueOf', {
              value: () => $ID,
              enumerable: false, // hide this key
              configurable: false
            });
            */


            return watchForChanges({ wrapper, populate },
              Object.assign(Object.create({
                toObject: () => adb,
                toString: () => $ID
              }), adb))

          });
        } else {
          const IDsPromise = client.sMembers(`${type2Short(type)}?`)
            .then(ids => {
              const prefix = `${type2Short(type)}_`
              return ids.map(id => prefix + id)
            })
          if (type && type.endsWith('S')) {
            return IDsPromise.then($IDs =>
              Promise.all($IDs.map($ID => wrapper.get(null, $ID)))
                .then(items =>
                  items.filter(item => ('function' === typeof where ? where(item)
                    : true))
                )
            );
          } /* else if( ! where){
              return new Error("If you want to get just 1 val. You need to provide a where callback test fn")
            }*/
          else {
            return IDsPromise.then($IDs => {
              const findOne = wrapper.get.bind({ groupCall: true }, type);
              const result = findMatchingItem($IDs, where, findOne);
              return result;
            });
          }
        } // END else
      }); // END ready


      result.populate = populate;

      result.and = new Proxy({}, {
        get(target, prop) {
          return result.populate(prop)
        }
      })

      return result;
    }, // END get

    //=====================================================
    //========================================= cache / pin
    //=====================================================

    cache: function (
      key,
      val,
      expire) {

      throw new Error("still needs to be implement!")


      if ("object" === typeof val
        && !val.hasOwnProperty("$DB")
        && val.$DB) {
        // store $ID + flag that this should be read from DB
      }

      // ... to do

      // returns undefined if not set

      // db.pin["SELECT * FROM Customers;"]([{"id":1,"email":"isidro_von@hotmail.com","first":"Torrey"},{"id":2,"email":"frederique19@gmail.com","first":"Micah"}], 3000)

      // db.pin["foo"]("bar")
      // db.pin["foo"]() // "bar"
      // db.pin["foo"](undefined) // "bar" ~ Remove
      // db.pin["foo"]() // undefined

      // db.pin["foo1"](true)
      // db.pin["foo1"]() // true
      // db.pin["foo1"]([1,2,4,8])
      // db.pin["foo1"]() // [1,2,4,8]

      // db.pin["foo3"]({a:001}) // accessible until unset

      // db.pin["foo4"]({a:123},3000) // accessible only for the next 3 sec

      // db.pin["foo5"]({b:456},new Date(Date.now()+60000)) // accessible only for the next 1 min

    }, // END cache

    //=====================================================
    //======================================= replace / set
    //=====================================================

    replace: function (
      type,
      replaceWith,
      optsORtag
    ) {
      if (!replaceWith.$ID.startsWith(type2Short(type))) {
        throw new Error(`${replaceWith.$ID} is not a type of ${type} `);
      }
      replaceWith = Object.assign({}, replaceWith, { updatedAt: new Date() });

      let tag, saveBy;

      if ('object' === typeof optsORtag) {
        tag = optsORtag.tag || '';
        saveBy = optsORtag.saveBy;
      } else if ('string' === typeof optsORtag) {
        tag = optsORtag;
      }
      return wrapper.get(type, replaceWith.$ID)
        .then((target) => {
          replaceWith.createdAt = target.createdAt
          return client.set(replaceWith.$ID, JSS.stringify(replaceWith)).then(() => {
            publish(target, replaceWith, 'UPDATE', saveBy, tag);
            return replaceWith;
          });
        });
    } // END replace
  }; // END wrapper

  //+++++++++++++++++++++++++++++++++++++++++ return fns
  //++++++++++++++++++++++++++++++++++++++++++++++++++++

  const handleProxy = {
    get(target, prop) {
      //TODO: sub, add & set should not allow name's ending with "S"
      // "S" is just for "get" to indicate plural.
      if (prop instanceof Symbol || collectionNamePattern instanceof Symbol) {
        //debugger
      }
      if (!collectionNamePattern.test(prop)) {
        throw new Error(`"${prop} is not a good collection name"`)
      }
      return target.bind(target, prop);
    } // END get
  }; // END handleProxy

  return {
    sub: new Proxy(wrapper.sub, handleProxy),
    get: new Proxy(wrapper.get, handleProxy),
    add: new Proxy(wrapper.create, handleProxy),
    set: new Proxy(wrapper.replace, handleProxy),
    del: new Proxy(wrapper.remove, handleProxy),
    pin: new Proxy(wrapper.cache, handleProxy)
    // update:           wrapper.update
  }; // END return
} // END DB


const db = DB();

module.exports = db;
//export default db;

//=====================================================
//=================================== watch For Changes
//=====================================================

function watchForChanges({ wrapper, populate }, rootObj) {

  const watch = (percent, path = [], changes = []) => {
    const thisProxy = new Proxy(percent, {

      //+++++++++++++++++++++++++++++++++++++++ get Property
      //++++++++++++++++++++++++++++++++++++++++++++++++++++

      get(target, name, receiver) {

        // to speed up to string
        if ("toJSON" === name) {
          return () => target
        }

        if (MAKE_COPY === name) {
          return watch({ ...target }, path, changes)
        }

        if ('save' === name) {
          /*
            return (optsORtag?:{saveBy?:string|boolean,tag?:string}|string)=>{
                let tag, saveBy;
  
                if("object" === typeof optsORtag){
                  tag = optsORtag.tag||"";
                  saveBy = optsORtag.saveBy;
                } else if ("string" === typeof optsORtag){
                  tag = optsORtag
                }
                target.updatedAt = new Date();
                const changes2save = Object.assign({updatedAt:target.updatedAt},changes)
                changes = {}
                return wrapper.update(target,changes2save,{saveBy,tag})
            }
          } else if("saveBy" === name){*/

          return (saveBy = '', tag) => {
            //console.log(changes)
            if (0 === changes.length) {
              return Promise.resolve(thisProxy);
            }
            const lastUpdatedAt = target.updatedAt
            target.updatedAt = new Date();
            // We push as target is not the proxy.. so the set fn is not called
            changes.push([["updatedAt"], target.updatedAt, lastUpdatedAt])
            const changes2save = [...changes]
            changes.length = 0;
            if ('object' === typeof saveBy) {
              saveBy = saveBy.$ID;
            } else if (true === saveBy) {
              saveBy = target.$ID;
            } else if ('string' !== typeof saveBy) {
              saveBy = '';
            }
            return wrapper.update(target, changes2save, { saveBy, tag })
              .then(moreCurrentVersionOfData => watch(moreCurrentVersionOfData, path, changes));
          }; // END (saveBy, tag)=>{}

        } else if ("and" === name) {
          return new Proxy({}, {
            get(target, prop) {
              return populate(prop)
                .then(xDB => watchForChanges({ wrapper, populate }, xDB))
            }
          })
        } else if ("$DB" === name) {
          return db
        }

        const value = target[name];
        if (isObjectOrArray(value)) {
          const path2 = Array.isArray(target) ? [...path, parseInt(name)]
            : [...path, name];
          return watch(value, path2, changes);
        } // END if isObjectOrArray
        return value;
      }, // END get

      //+++++++++++++++++++++++++++++++++++++++ set Property
      //++++++++++++++++++++++++++++++++++++++++++++++++++++

      set(target, name, value, receiver) {
        if (['$ID', 'updatedAt', 'createdAt'].includes(name)
          || target[name] === value) {
          return true
        } // END if

        if (Array.isArray(target)) {
          if ('length' === name) {
            return true
          }
          if (isNaN(parseInt(name))) {
            return delete target[name];
          }
        } // END if Array

        const path2 = Array.isArray(target) ? [...path, parseInt(name)]
          : [...path, name];
        let oldVal = target.hasOwnProperty(name) ? target[name] : undeclared

        if (Array.isArray(target[name])
          && "object" === typeof value) {
          changes.push([path2, {}, oldVal])
        } else if (Array.isArray(value)
          && "object" === typeof target[name]) {
          changes.push([path2, [], oldVal])
        }

        if (isObjectOrArray(value)
          && Object.keys(value).length) {

          if (isObjectOrArray(target)
            // && undeclared === oldVal
            && isObjectOrArray(value)) {
            changes.push([path2, Array.isArray(value) ? [] : {}, undeclared])
          }

          const entries = mapObjectOrArray(value, path2, oldVal);
          changes.push(...entries);
        } else {
          changes.push([path2, value, oldVal]);
        } // END else

        target[name] = value;

        return true;
      }, // END set

      //++++++++++++++++++++++++++++++++++++ delete Property
      //++++++++++++++++++++++++++++++++++++++++++++++++++++

      deleteProperty(target, name) {

        if (!target.hasOwnProperty(name)) {
          return true;
        }
        const path2 = Array.isArray(target) ? [...path, parseInt(name)]
          : [...path, name];

        changes.push([path2, undeclared, target[name]])
        if (Array.isArray(target)) {
          target.splice(name, 1);
        } else {
          delete target[name];
        }
        return true;
      } // END deleteProperty
    }); // END new Proxy
    return thisProxy
  } // END watch
  return watch(rootObj)
} // END watchForChanges


//=====================================================
//=============================================== Utils
//=====================================================

//++++++++++++++++++++++++++++++++++++++++ check Match
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function checkMatch(subset, source) {
  const objKeys1 = Object.keys(subset);

  for (var key of objKeys1) {
    const value1 = subset[key];
    const value2 = source[key];
    if ('object' === typeof value1
      && 'object' === typeof value2) {
      if (!checkMatch(value1, value2))
        return false;
    } else if (value1 !== value2) {
      return false;
    }
  }
  return true;
} // END checkMatch

//+++++++++++++++++++++++++++++++ get Property By Path
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function getPropertyByPath(obj, path) {
  return path.reduce((acc, key) => acc && acc[key], obj);
} // getPropertyByPath

//++++++++++++++++++++++++++++++++ map Object Or Array
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function mapObjectOrArray(objOrArray, path, oldRef) {
  return Object.entries(objOrArray)
    .reduce((entries, [prop, val], i, a) => {
      const propPath = [...path, Array.isArray(objOrArray) ? +prop : prop];
      return entries.concat(isObjectOrArray(val) ?
        mapObjectOrArray(val, propPath, oldRef.hasOwnProperty(prop) ? oldRef[prop] : undeclared)
        : [[propPath, val, oldRef]]);
    }, []);
} // END mapObjectOrArray

//+++++++++++++++++++++++++++++++++ is Object Or Array
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function isObjectOrArray(value) {
  return 'object' === typeof value
    && value !== null
    && !(value instanceof Date)
    && !(value instanceof Error)
    && !(value instanceof Set)
    && !(value instanceof Map);
} // END isObjectOrArray

//+++++++++++++++++++++++++++++++ build Overlay Object
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function buildOverlayObject(changes, source) {
  const result = {};
  //console.log("changes", changes)
  //console.log("source", source)
  for (const [path, value] of changes) {
    //console.log(1)
    let obj = result;
    //console.log(2)

    let walkwithsource = source
    //console.log(3)

    for (let count = 0;
      count < path.length - 1;
      count++) {
      //console.log(4,walkwithsource)

      walkwithsource = walkwithsource && walkwithsource[path[count]];
      //console.log(5,walkwithsource)

      if (!obj[path[count]]) {
        const isArray = "number" === typeof path[count + 1]
        if (walkwithsource) {
          //console.log(`isArray=${isArray} | walkwithsource=${typeof walkwithsource}`)
          //console.log(6,walkwithsource)

          obj[path[count]] = isArray ? [...walkwithsource] : { ...walkwithsource };
          //console.log(7)

        } else {
          obj[path[count]] = isArray ? [] : {};
        }
      } // END if
      obj = obj[path[count]];

    } // END for

    if (undeclared === value) {
      if (Array.isArray(obj)) {
        obj.splice(path[path.length - 1], 1);
      } else {
        delete obj[path[path.length - 1]]
      }
    } else {
      obj[path[path.length - 1]] = value;
    }
  } // END for

  return result;
} // END buildOverlayObject

//++++++++++++++++++++++++++++++++++++++++ starts With
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function startsWith(smallArr, bigArr) {
  for (let index = 0; index < smallArr.length; index++) {
    if (smallArr[index] !== bigArr[index]) {
      return false;
    }
  } // END for
  return true;
} // END startsWith

//+++++++++++++++++++++++++++++++++ find Matching Item
//++++++++++++++++++++++++++++++++++++++++++++++++++++

function findMatchingItem(ids, testFn, findOne) {
  let index = 1;

  const loadNrunFn = (item) => {
    let dataPromise = null;
    if (index < ids.length) {
      const $ID = ids[index];
      index++;
      dataPromise = findOne($ID, index);
    }

    const result = testFn(item);
    if (result) {
      return item;
    }
    return dataPromise ? dataPromise.then(loadNrunFn) : null;
  }; // END loadNrunFn

  if (ids.length) {
    return findOne(ids[0], 0).then(loadNrunFn);
  }
  return Promise.resolve(null);
} // END findMatchingItem

