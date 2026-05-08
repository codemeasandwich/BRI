/**
 * BRI Database TypeScript Definitions
 *
 * Consume this package as **`bri-db`** from npm. Subpaths exposed via
 * `package.json` `exports` include **`bri-db/client`**, **`bri-db/engine`**,
 * **`bri-db/storage`**, **`bri-db/utils/jss`**, **`bri-db/utils/diff`**,
 * **`bri-db/utils/schema`**, **`bri-db/remote`**, and **`bri-db/workers`** —
 * use those specifiers for deep imports; runtime types for modules without
 * ambient declarations follow their JSDoc.
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
  /** Optional structured logger boundary for storage lifecycle events. */
  logger?: BriLoggerConfig;
}

export interface BriLogEvent {
  event: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  severity: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, any>;
  error?: unknown;
}

export interface BriLogger {
  debug?(event: BriLogEvent): void;
  info?(event: BriLogEvent): void;
  warn?(event: BriLogEvent): void;
  error?(event: BriLogEvent): void;
  stdout?: boolean;
}

export type BriLoggerConfig = false | BriLogger;

/** Local-store branch passed to {@link bri.connect} (omit remote `url` / `wsUrl`). */
export interface LocalConnectOptions {
  /** Storage backend type (default: 'inhouse') */
  storeType?: 'inhouse';
  /** Storage configuration */
  storeConfig?: StoreConfig;
  /** Structured logger or false to silence Bri runtime lifecycle output. */
  logger?: BriLoggerConfig;
}

/**
 * Remote connection branch for {@link bri.connect}. Do not combine with local
 * `storeConfig` / `storeType` — that combination throws at runtime.
 */
export interface RemoteConnectOptions {
  /** WebSocket URL; `/api/ape` is appended when absent. */
  url?: string;
  /** Synonym for `url` (normalized the same way). */
  wsUrl?: string;
  /** RPC timeout milliseconds (default 30000). */
  timeout?: number;
}

/**
 * Combined connect options (`bri.connect`): local backing vs remote (`url`|`wsUrl`).
 * Runtime rejects mixing remote URLs with local `storeConfig` / `storeType`.
 */
export type ConnectOptions = LocalConnectOptions | RemoteConnectOptions;

/**
 * Canonical SDK singleton — **default export** from the repo root entry (`bri-db`).
 */
export interface Bri {
  /** Published package version (from manifest at build/publish time). */
  readonly version: string;
  /**
   * Synchronous database handle — never `await` connection wire-up.
   * Pre-READY calls buffer until backing storage connects or remote WebSocket OPEN.
   */
  connect(options?: ConnectOptions): Database;
}

/** @public default entry — `import bri from 'bri-db'`. */
export declare const bri: Bri;

/** Wrap `Promise&lt;Database&gt;` in the same façade `bri.connect` uses for pre-READY deferral (advanced/testing). */
export function deferDatabase(waitPromise: Promise<Database>): Database;

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
  /** Public diagnostics namespace for storage identity and runtime state. */
  readonly diag: DiagnosticsNamespace;

  /**
   * Add middleware (chainable)
   * @param fn - Middleware function
   */
  use(fn: MiddlewareFunction): Database;

  // ==================== Lifecycle ====================

  /** Gracefully disconnect from storage */
  disconnect(): Promise<void>;
}

/**
 * Normalize a WS base URL to include `/api/ape` — same rule as remote handshake helpers.
 */
export function normalizedWsUrl(url: string): string;

/**
 * Resolve the remote façade after `/api/ape` WebSocket OPEN — used internally by {@link bri.connect}
 * and by tests/helpers that need OPEN before synchronous access.
 */
export function createRemoteDatabasePromise(wsUrl: string, options?: { timeout?: number }): Promise<Database>;

/**
 * Builds READY local backing (also used by `bri.connect`); returns the real Database, not a `deferDatabase` façade.
 */
export function createLocalDatabasePromise(options?: LocalConnectOptions): Promise<Database>;

/** Fully READY local `Database` — direct result of {@link createLocalDatabasePromise}; not the pre-READY {@link deferDatabase} façade. */
export function openLocalDatabase(options?: LocalConnectOptions): Promise<Database>;

/**
 * READY remote façade after WebSocket normalization — callers that cannot use the synchronous {@link bri.connect} buffer.
 */
export function openRemoteDatabase(
  url: string,
  options?: { timeout?: number }
): Promise<Database>;
// Vector + Graph v1 surface (spec §2)
// =====================================================================

// ---- Schema vocabulary (spec §2.1) ----------------------------------

/** Bri's schema-vocabulary string-typed field types. */
export type BriFieldTypeString =
  | 'email'
  | 'ref'
  | 'ref|string'
  | 'predicate'
  | 'vector';

/** Field declaration accepted by `db.schema(collection, schema)`. */
export interface BriFieldDecl {
  type: any | BriFieldTypeString;
  required?: boolean;
  enum?: any[];
  /** For 'ref' / 'ref|string': name of the target collection. */
  to?: string;
  /** For 'vector': required positive integer dimensionality. */
  dims?: number;
  /** For 'vector': v1 supports 'cosine' only. */
  metric?: 'cosine';
  /** For Object: nested schema. */
  properties?: Record<string, BriFieldDecl>;
  /** For Array: items type constructor. */
  items?: any;
  /** For predicate: collection name where the predicate is registered. */
  collection?: string;
  /** Pre-validation transform. */
  get?: (value: any) => any;
  /** Pre-write transform. */
  set?: (value: any) => any;
  /** Field-level cascade-scope opt-in (spec §2.8). */
  cascadeOn?: string;
}

/** Edge collection $edge block. */
export interface BriEdgeBlock {
  /** Subject-side collection (or 'A | B' polymorphic). */
  from: string;
  /** Object-side collection (or 'A | B' polymorphic; 'string' = literal). */
  to: string;
  /** Field name on the edge document holding the predicate value. */
  predicate?: string;
  /** Allowed predicate values, or '*' for open. v1 routes only explicit lists. */
  predicates?: string[] | '*';
  /** When true, `(from, to, predicate)` is canonicalised lexicographically. */
  symmetric?: boolean;
  /** When true, `(from, to, predicate)` is unique → upsert semantics. */
  unique?: boolean;
}

/** Schema declaration accepted by `db.schema(collection, schema)`. */
export type BriSchema = {
  [field: string]: BriFieldDecl;
} & {
  /** Compound + single-field secondary indexes. */
  $indexes?: string[][];
  /** Names the supersession backref field. Enables `.history`. */
  $supersession?: string;
  /** Names the numeric confidence field. Enables `.confidence(t)`. */
  $confidence?: string;
  /** Names the provenance ids field. Enables `.withProvenance`. */
  $provenance?: string;
  /** Marks the collection as an edge collection. */
  $edge?: BriEdgeBlock;
};

// ---- QueryBuilder (spec §2.2) ---------------------------------------

/**
 * Reactive entity returned from a chain query. Carries non-enumerable
 * ranking metadata when chain methods produce ranked results.
 */
export interface ScoredEntity extends ReactiveEntity {
  /** Cosine similarity from `.near` / `.combine`. */
  $cosine?: number;
  /** Composite score (cosine alone unless `.combine` weighted). */
  $score?: number;
  /** Substring match attribution from `.match`. */
  $matchHits?: { field: string; value: any };
  /** Provenance ids hydrated by `.withProvenance`. */
  $provenance?: string[];
}

export type BriFilterValue =
  | string | number | boolean | Date | null
  | { $ne?: any; $in?: any[]; $gte?: any; $gt?: any; $lte?: any; $lt?: any; $exists?: boolean }
  | { $or: Record<string, any>[] };

export type BriFilter =
  | Record<string, BriFilterValue>
  | ((doc: any) => boolean);

/**
 * Options forwarded to the underlying VectorIndex search.
 */
export interface BriNearOptions {
  /** null forces committed-only; a string targets a specific txn. */
  txnId?: string | null;
  /** HNSW query-time candidate-set size override (v2 §6.2). */
  efSearch?: number;
}

/**
 * Chainable query builder produced by `db.get.{collection}S` access.
 *
 * The chain is immutable per link — each method returns a new builder so
 * parallel call sites starting from the same accessor don't leak state.
 * The builder is thenable; awaiting it is equivalent to `.toArray()`.
 */
export interface QueryBuilder<T extends ReactiveEntity = ScoredEntity>
  extends PromiseLike<T[]> {
  where(filter: BriFilter): QueryBuilder<T>;
  near(vector: number[] | Float32Array, k: number,
       opts?: BriNearOptions): QueryBuilder<T>;
  match(stringFilter: Record<string, string>, k?: number): QueryBuilder<T>;
  combine(weights: { alias: number; vector: number }): QueryBuilder<T>;
  touching(seedIds: Array<string | { $ID: string }>): QueryBuilder<T>;
  confidence(threshold: number): QueryBuilder<T>;
  hydrate(fields: string[]): QueryBuilder<T>;
  limit(n: number): QueryBuilder<T>;
  /** Schema-conditional: requires `$supersession`. */
  readonly history: QueryBuilder<T>;
  /** Schema-conditional: requires `$provenance`. */
  readonly withProvenance: QueryBuilder<T>;
  /** Deferred to v2 — throws BriQueryError NOT_IMPLEMENTED_V1. */
  asOf(t: Date | number): QueryBuilder<T>;

  count(): Promise<number>;
  distinct(field: string): Promise<any[]>;
  groupBy(field: string): GroupedQueryBuilder;

  toArray(): Promise<T[]>;
  first(): Promise<T | null>;
}

export interface GroupedQueryBuilder {
  count(): Promise<Array<{ [k: string]: any; count: number }>>;
  sum(field: string): Promise<Array<{ [k: string]: any; sum: number }>>;
  having(filter: BriFilter): GroupedQueryBuilder;
  toArray(): Promise<any[]>;
}

// ---- Predicate proxy (spec §2.3 / §2.4) -----------------------------

/**
 * Callable + thenable accessor returned for `entity.{predicate}` when
 * `predicate` is a registered predicate from this collection's $edge.
 *   - call `entity.predicate(target, attrs?)` to write an edge
 *   - await `entity.predicate` to read targets
 *   - await `entity.predicate.$` to read edge documents themselves
 */
export interface PredicateAccessor<TTarget = ReactiveEntity, TEdge = ReactiveEntity>
  extends PromiseLike<TTarget[]> {
  (target: TTarget | string, attrs?: Record<string, any>): Promise<TEdge>;
  /** Awaitable: edge documents (with confidence/provenance/etc.). */
  readonly $: PromiseLike<TEdge[]>;
  limit(n: number): PromiseLike<TTarget[]>;
  /** Schema-conditional. */
  readonly history: PromiseLike<TTarget[]>;
  /** Schema-conditional. */
  readonly withProvenance: PromiseLike<TTarget[]>;
  /** Schema-conditional. */
  confidence(threshold: number): PromiseLike<TTarget[]>;
}

// ---- db.algo (spec §2.7) --------------------------------------------

export interface DegreeAlgoArgs {
  collection: string;
  via: string;
  weighted?: string;
  top?: number;
}

export interface PPRAlgoArgs {
  seeds: Array<string | ReactiveEntity>;
  via: string;
  k?: number;
  damping?: number;
  iterations?: number;
  edgeFilter?: Record<string, any>;
  edgeWeight?: (edge: any) => number;
}

export interface AlgoNamespace {
  degree(args: DegreeAlgoArgs): Promise<Array<{ entity: ReactiveEntity; degree: number }>>;
  /** Deferred to v3 — throws NOT_IMPLEMENTED until then. */
  ppr(args: PPRAlgoArgs): Promise<Array<{ entity: ReactiveEntity; score: number }>>;
}

// ---- db.cascade (spec §2.8) -----------------------------------------

export interface CascadeResult {
  deleted: number;
  byCollection: Record<string, number>;
}

export interface CascadeByFieldArgs {
  collections: string[];
  filter: Record<string, any>;
  opts?: { atomic?: boolean; txnId?: string | null };
}

/**
 * Indexed by scope name: `db.cascade.session(id)`, `db.cascade.tenant(id)`, etc.
 * Each scope must be opted in by at least one schema's `cascadeOn` flag.
 */
export interface CascadeNamespace {
  byField(args: CascadeByFieldArgs): Promise<CascadeResult>;
  [scope: string]: ((id: string, opts?: { atomic?: boolean; txnId?: string | null })
                    => Promise<CascadeResult>) | any;
}

// ---- db.diag --------------------------------------------------------------

export interface CollectionIdentityDiagnostic {
  collection: string;
  storageIdentity: string;
  prefix: string;
  unique: boolean;
  conflicts: string[];
}

export interface DiagnosticsNamespace {
  collectionIdentities(collections?: string[]): CollectionIdentityDiagnostic[];
}

// ---- db.schema (spec §2.1) ------------------------------------------

export interface SchemaNamespace {
  declareEdge(collectionName: string, options: BriEdgeBlock & {
    predicates?: string[] | '*';
  }): void;
}

// ---- Error class hierarchy (spec §2.11) -----------------------------

export type BriErrorCode =
  | 'VECTOR_DIMS_MISMATCH'
  | 'VECTOR_INVALID_VALUE'
  | 'VECTOR_QUERY_DIMS_MISMATCH'
  | 'VECTOR_FIELD_NOT_DECLARED'
  | 'REF_NOT_FOUND'
  | 'REF_FORMAT_INVALID'
  | 'EDGE_ENDPOINT_INVALID'
  | 'PREDICATE_NOT_REGISTERED'
  | 'CHAIN_CROSSES_COLLECTION'
  | 'RESERVED_NAME_COLLISION'
  | 'COLLECTION_IDENTITY_COLLISION'
  | 'CASCADE_SCOPE_UNKNOWN'
  | 'INDEX_FIELD_NOT_DECLARED'
  | 'WAL_INDEX_REPLAY_FAILED'
  | 'NOT_IMPLEMENTED_V1';

export interface BriErrorInit {
  message: string;
  code: BriErrorCode | string;
  details?: Record<string, any>;
}

export class BriError extends Error {
  code: string;
  details?: Record<string, any>;
  constructor(init: BriErrorInit);
}
export class BriValidationError extends BriError {}
export class BriQueryError extends BriError {}
export class BriProxyError extends BriError {}
export class BriSchemaError extends BriError {}
export class BriRecoveryError extends BriError {}

// ---- Database augmentation (spec §2 surface on the main interface) --
// The augmentation lives via interface merging on the Database
// declaration above (TypeScript merges `interface Database` clauses in
// the same module). The members below extend it.

export interface Database {
  /**
   * Spec §2.1 — declare a schema for a collection. Required to enable
   * vector / graph / cascade / chain features. Existing collections
   * without a schema continue to work via the legacy callable forms.
   */
  schema(collection: string, schema: BriSchema): void;
  /** Spec §2.7 graph algorithms namespace. */
  readonly algo: AlgoNamespace;
  /** Spec §2.8 cancellation cascade namespace. */
  readonly cascade: CascadeNamespace;
}

export default bri;

declare module 'bri-db/workers/vector-worker-env.js' {
  /**
   * Returns whether `process.env.BRI_VECTOR_WORKER` requests eager worker warm-up for
   * `warmVectorWorkerFromEnv` — see parsing rules in runtime JSDoc.
   */
  export function isVectorWorkerWarmRequestedFromEnv(): boolean;
}
