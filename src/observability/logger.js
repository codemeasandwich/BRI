/**
 * @file Structured logger boundary for Bri runtime lifecycle events.
 *
 * Domain context: Bri is embedded by applications with their own logging and
 * test harnesses. Runtime storage, recovery, WAL, and snapshot events must be
 * observable without forcing human console output into the embedding process.
 *
 * Technical context: every runtime path emits a stable event object through the
 * four-level logger interface (`debug`, `info`, `warn`, `error`). With no custom
 * logger Bri preserves its historical standalone console messages. Passing
 * `false` or `{ stdout: false }` silences human output; passing methods captures
 * structured events for application log pipelines.
 */

/**
 * Normalize arbitrary thrown values into an Error-like value for event metadata.
 *
 * @param {unknown} err - Thrown value captured by a runtime failure path.
 * @returns {Error|unknown} Original Error when available, otherwise the input.
 */
function normalizeError(err) {
  return err instanceof Error ? err : err;
}

/**
 * Return the console method that preserves Bri's existing standalone output.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Event severity.
 * @returns {Function} Bound console method.
 */
function consoleMethodFor(level) {
  if (level === 'warn') return console.warn.bind(console);
  if (level === 'error') return console.error.bind(console);
  return console.log.bind(console);
}

/**
 * Build the event object delivered to custom loggers and default console output.
 *
 * @param {Object} init - Event fields supplied by a runtime subsystem.
 * @param {string} init.event - Stable event name/code.
 * @param {'debug'|'info'|'warn'|'error'} init.level - Severity level.
 * @param {string} init.message - Human-readable message.
 * @param {Object} [init.metadata] - Structured diagnostic metadata.
 * @param {unknown} [init.error] - Original error/cause, preserved by reference.
 * @returns {Object} Structured Bri log event.
 */
function buildEvent(init) {
  const event = {
    event: init.event,
    level: init.level,
    severity: init.level,
    message: init.message
  };
  if (init.metadata !== undefined) event.metadata = init.metadata;
  if (init.error !== undefined) event.error = normalizeError(init.error);
  return event;
}

/**
 * Deliver one event to a custom logger method, tolerating logger failures.
 *
 * @param {Object} custom - Custom logger object.
 * @param {'debug'|'info'|'warn'|'error'} level - Severity method to call.
 * @param {Object} event - Structured event payload.
 */
function deliverCustom(custom, level, event) {
  const fn = custom && typeof custom[level] === 'function' ? custom[level] : null;
  if (!fn) return;
  fn.call(custom, event);
}

/**
 * Emit the historical human-readable console shape for default Bri users.
 *
 * @param {Object} event - Structured event payload.
 */
function emitConsole(event) {
  if (event.level === 'debug') return;
  const log = consoleMethodFor(event.level);
  if (event.error !== undefined) log(event.message, event.error);
  else log(event.message);
}

/**
 * Create a Bri logger from public configuration.
 *
 * @param {false|Object|undefined} config - `false` disables logging; an object
 *   may provide `info|warn|error|debug` methods and/or `stdout`.
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 *   Stable logger boundary consumed by runtime modules.
 */
export function createBriLogger(config) {
  const disabled = config === false;
  const custom = config && typeof config === 'object' ? config : null;
  const hasCustom = !!custom && ['debug', 'info', 'warn', 'error']
    .some((level) => typeof custom[level] === 'function');
  const stdout = disabled ? false : custom?.stdout !== false && !hasCustom;

  /**
   * Emit one structured runtime event.
   *
   * @param {'debug'|'info'|'warn'|'error'} level - Severity level.
   * @param {Object} init - Event fields excluding normalized level.
   */
  function emit(level, init) {
    if (disabled) return;
    const event = buildEvent({ ...init, level });
    if (hasCustom) deliverCustom(custom, level, event);
    if (stdout) emitConsole(event);
  }

  return {
    /**
     * Emit a debug-level runtime diagnostic event.
     *
     * @param {Object} init - Event fields excluding normalized level.
     * @returns {void}
     */
    debug(init) { emit('debug', init); },

    /**
     * Emit an info-level runtime lifecycle event.
     *
     * @param {Object} init - Event fields excluding normalized level.
     * @returns {void}
     */
    info(init) { emit('info', init); },

    /**
     * Emit a warning-level runtime lifecycle event.
     *
     * @param {Object} init - Event fields excluding normalized level.
     * @returns {void}
     */
    warn(init) { emit('warn', init); },

    /**
     * Emit an error-level runtime lifecycle event.
     *
     * @param {Object} init - Event fields excluding normalized level.
     * @returns {void}
     */
    error(init) { emit('error', init); }
  };
}

/**
 * Logger constant for lower-level helpers that need a safe default before a
 * configured database exists.
 */
export const defaultBriLogger = createBriLogger();
