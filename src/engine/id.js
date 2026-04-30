/**
 * ID generation utilities
 */

/**
 * Create ID generator functions bound to a store
 * @param {Object} store - Storage adapter
 * @returns {Object} - { genid, makeid, idIsFree }
 */
export function createIdGenerator(store) {
  /**
   * Generate a unique ID for a type
   * @param {string} type - Short type code (e.g., "USER")
   * @returns {Promise<string>} - Unique ID (e.g., "USER_abc1234")
   */
  function genid(type) {
    let uid = makeid();
    const $ID = `${type}_${uid}`;
    return idIsFree($ID).then((isFree) => (isFree ? $ID : genid(type)));
  }

  /**
   * Generate a random 7-character Crockford base32 ID
   * @param {number} length - Length of ID (default 7)
   * @returns {string} - Random ID
   */
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

  /**
   * Check if an ID is available
   * @param {string} $ID - ID to check
   * @returns {Promise<boolean>} - True if ID is free
   */
  function idIsFree($ID) {
    return store.get($ID).then((x) => !x);
  }

  return { genid, makeid, idIsFree };
}
