/**
 * @file Public **`bri-db/client`** barrel — synchronous SDK entry (**`bri`**) plus
 **`deferDatabase`** for advanced composition with custom backing promises.
 */

import bri from './bri.js';

export { bri };
export { deferDatabase } from './defer-database.js';
export default bri;
