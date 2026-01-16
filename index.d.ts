/**
 * BRI Database TypeScript Definitions
 */

// ==================== Configuration ====================

export interface StoreConfig {
  /** Directory for data storage (default: './data' or BRI_DATA_DIR env) */
  dataDir?: string;
  /** Maximum memory in MB for hot tier cache (required) */
  maxMemoryMB: number;
  /** Target memory utilization percentage (default: 0.8) */
  memoryTargetPercent?: number;
  /** Memory threshold to start eviction (default: 0.8) */
  evictionThreshold?: number;
  /** WAL segment size in bytes (default: 10MB) */
  walSegmentSize?: number;
  /** Fsync mode: 'batched' or 'immediate' (default: 'batched') */
  fsyncMode?: 'batched' | 'immediate';
  /** Fsync interval in milliseconds (default: 100) */
  fsyncIntervalMs?: number;
  /** Snapshot interval in milliseconds (default: 30 minutes) */
  snapshotIntervalMs?: number;
  /** Number of snapshots to retain (default: 3) */
  keepSnapshots?: number;
}

export interface CreateDBOptions {
  /** Storage backend type (default: 'inhouse') */
  storeType?: 'inhouse';
  /** Storage configuration */
  storeConfig?: StoreConfig;
}

// ==================== Entity Types ====================

export interface Entity {
  /** Unique identifier (format: type_id) */
  readonly $ID: string;
  /** Creation timestamp */
  readonly createdAt: Date;
  /** Last update timestamp */
  readonly updatedAt: Date;
  /** Any additional properties */
  [key: string]: any;
}

export interface ReactiveEntity extends Entity {
  /**
   * Save changes to the database
   * @param saveBy - User/entity ID performing the save, or options object
   */
  save(saveBy?: string | SaveOptions): Promise<ReactiveEntity>;

  /**
   * Populate referenced entities by key
   * Chainable: entity.and.author.and.comments
   */
  readonly and: PopulateProxy;

  /** Convert to plain object */
  toObject(): Record<string, any>;

  /** Convert to JSON-serializable object */
  toJSON(): Record<string, any>;

  /** Convert to JSS format (handles Date, RegExp, etc.) */
  toJSS(): Record<string, any>;
}

export interface SaveOptions {
  /** User/entity ID performing the save */
  saveBy?: string;
  /** Tag for the operation */
  tag?: string;
  /** Transaction ID */
  txnId?: string;
}

// ==================== Query Types ====================

/** Query object for filtering entities */
export type QueryObject = Record<string, any>;

/** Filter function for entities */
export type FilterFunction<T = Entity> = (item: T) => boolean;

/** Selector for get operations */
export type GetSelector = string | string[] | QueryObject | FilterFunction;

// ==================== Operation Options ====================

export interface OperationOptions {
  /** Tag for the operation */
  tag?: string;
  /** User/entity ID performing the operation */
  saveBy?: string | boolean;
  /** Transaction ID */
  txnId?: string;
}

// ==================== Result Types ====================

export interface GetResult extends Promise<ReactiveEntity | ReactiveEntity[] | null> {
  /** Populate referenced entities */
  populate(key: string | string[]): GetResult;
  /** Chainable populate proxy */
  readonly and: PopulateProxy;
}

export interface PopulateProxy {
  [key: string]: Promise<ReactiveEntity | ReactiveEntity[]>;
}

// ==================== Subscription Types ====================

export type SubscriptionCallback = (entity: Entity) => void;
export type UnsubscribeFunction = () => void;

// ==================== Transaction Types ====================

export interface TransactionStatus {
  txnId: string;
  createdAt: Date;
  actionCount: number;
  status: 'pending' | 'committed' | 'rolled_back';
}

export interface TransactionResult {
  entries: any[];
  documents: Array<[key: string, value: string]>;
  collections: Array<[setName: string, members: string[]]>;
}

export interface TransactionAction {
  type: string;
  key?: string;
  value?: any;
  [key: string]: any;
}

// ==================== Middleware Types ====================

export interface MiddlewareContext {
  /** Operation type */
  operation: 'get' | 'add' | 'set' | 'del';
  /** Collection name */
  type: string;
  /** Operation arguments */
  args: any[];
  /** Mutable options */
  opts: Record<string, any>;
  /** Database reference */
  db: Database;
  /** Result (set by handler) */
  result?: any;
}

export type MiddlewareFunction = (
  ctx: MiddlewareContext,
  next: () => Promise<void>
) => Promise<void>;

export interface MiddlewareManager {
  /** Add middleware to the chain */
  use(fn: MiddlewareFunction): void;
  /** Remove middleware from the chain */
  remove(fn: MiddlewareFunction): void;
  /** Clear all middleware */
  clear(): void;
  /** Number of registered middleware */
  readonly count: number;
}

// ==================== Database Interface ====================

/**
 * Collection accessor proxy for CRUD operations
 * Usage: db.get.users(), db.add.user(data)
 */
export interface CollectionProxy<TResult> {
  [collectionName: string]: (...args: any[]) => TResult;
}

export interface GetProxy {
  /**
   * Get single entity: db.get.user('usr_123') or db.get.user({ name: 'John' })
   * Get all entities: db.get.userS() or db.get.userS({ active: true })
   */
  [collectionName: string]: (
    where?: GetSelector,
    opts?: OperationOptions
  ) => GetResult;
}

export interface AddProxy {
  /**
   * Create new entity: db.add.user({ name: 'John' })
   * Collection name must NOT end with 'S'
   */
  [collectionName: string]: (
    data: Record<string, any>,
    opts?: OperationOptions
  ) => Promise<ReactiveEntity>;
}

export interface SetProxy {
  /**
   * Replace entity: db.set.user({ $ID: 'usr_123', name: 'Jane' })
   * Entity must have $ID
   */
  [collectionName: string]: (
    data: Entity,
    opts?: OperationOptions
  ) => Promise<ReactiveEntity>;
}

export interface DelProxy {
  /**
   * Soft-delete entity: db.del.user('usr_123', 'usr_456')
   * Returns deleted entity without deletedAt/deletedBy
   */
  [collectionName: string]: (
    $ID: string | Entity,
    deletedBy: string
  ) => Promise<Entity>;
}

export interface SubProxy {
  /**
   * Subscribe to changes: db.sub.user(callback)
   * Returns unsubscribe function
   */
  [collectionName: string]: (
    callback: SubscriptionCallback
  ) => Promise<UnsubscribeFunction>;
}

export interface PinProxy {
  /**
   * Cache a value (not yet implemented)
   */
  [collectionName: string]: (
    key: string,
    value: any,
    expire?: number
  ) => Promise<void>;
}

export interface Database {
  // ==================== CRUD Operations ====================

  /** Get entities from database */
  readonly get: GetProxy;

  /** Add new entity to database */
  readonly add: AddProxy;

  /** Replace/update entity in database */
  readonly set: SetProxy;

  /** Soft-delete entity from database */
  readonly del: DelProxy;

  /** Subscribe to entity changes */
  readonly sub: SubProxy;

  /** Cache values (not implemented) */
  readonly pin: PinProxy;

  // ==================== Transaction API ====================

  /** Active transaction ID (null if no active transaction) */
  _activeTxnId: string | null;

  /**
   * Start recording a transaction
   * @returns Transaction ID
   */
  rec(): string;

  /**
   * Commit/finalize a transaction
   * @param txnId - Transaction ID (uses active if not provided)
   */
  fin(txnId?: string): Promise<TransactionResult>;

  /**
   * Cancel/rollback a transaction
   * @param txnId - Transaction ID (uses active if not provided)
   */
  nop(txnId?: string): Promise<void>;

  /**
   * Undo last action in transaction
   * @param txnId - Transaction ID (uses active if not provided)
   */
  pop(txnId?: string): Promise<TransactionAction | null>;

  /**
   * Get transaction status
   * @param txnId - Transaction ID (uses active if not provided)
   */
  txnStatus(txnId?: string): TransactionStatus;

  // ==================== Middleware API ====================

  /** Middleware manager */
  readonly middleware: MiddlewareManager;

  /**
   * Add middleware (chainable)
   * @param fn - Middleware function
   */
  use(fn: MiddlewareFunction): Database;

  // ==================== Lifecycle ====================

  /** Gracefully disconnect from storage */
  disconnect(): Promise<void>;
}

// ==================== Main Functions ====================

/**
 * Create a new BRI database instance
 * @param options - Database options
 */
export function createDB(options?: CreateDBOptions): Promise<Database>;

/**
 * Get or create default database instance (singleton)
 * @param options - Options used if creating new instance
 */
export function getDB(options?: CreateDBOptions): Promise<Database>;

export default createDB;
