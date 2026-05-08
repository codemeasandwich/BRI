**Bri Remaining Issues Report**

Canonical Bri checkout checked: `/Users/bri/SOURCE/BRI`  
Current Bri HEAD: `5399906 fix: harden wal writer close races`  
Working tree note: untracked file exists: `/Users/bri/SOURCE/BRI/todo/C2C3.md`

**1. Remote WebSocket tests fail under Node/Jest**

Status: unresolved.

The Bri remote client assumes `globalThis.WebSocket` exists, but the Bri test runner executes under Node/Jest where `WebSocket` is not globally available.

Repro command:

```bash
cd /Users/bri/SOURCE/BRI
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runTestsByPath tests/e2e/bri-connect.test.js tests/e2e/bri-deferred-surface.test.js \
  --runInBand
```

Result:

```text
Test Suites: 2 failed, 2 total
Tests:       3 failed, 16 passed, 19 total
```

Failing tests:

```text
tests/e2e/bri-connect.test.js
  bri.connect
    ✕ remote: queues _rpc until OPEN then preserves send order

tests/e2e/bri-deferred-surface.test.js
  bri deferred façade + READY export coverage
    ✕ openRemoteDatabase reaches WebSocket OPEN and disconnects cleanly
    ✕ bri.connect accepts wsUrl and keeps /api/ape when base URL already normalized
```

Failure signature:

```text
ReferenceError: WebSocket is not defined

  src/remote/index.js:164
  socket = new WebSocket(wsUrl);
```

Relevant files:

- `/Users/bri/SOURCE/BRI/src/remote/index.js:164`
- `/Users/bri/SOURCE/BRI/src/client/bri.js:77`
- `/Users/bri/SOURCE/BRI/tests/e2e/bri-connect.test.js:64`
- `/Users/bri/SOURCE/BRI/tests/e2e/bri-deferred-surface.test.js:76`
- `/Users/bri/SOURCE/BRI/tests/helpers/mock-bri-ws-rpc-server.js`

Likely root cause:

- Bri has `ws` as a devDependency, and the tests provide a mock `WebSocketServer`, but the runtime remote client does not inject/import/provide a Node-compatible `WebSocket` constructor.
- `src/remote/index.js` directly calls `new WebSocket(wsUrl)`, which works in browser-like runtimes but fails in plain Node.

Recommended fix direction:

- Add a first-party cross-runtime WebSocket constructor resolution path.
- Keep browser behavior using native `globalThis.WebSocket`.
- For Node/Jest, explicitly provide a supported constructor, probably via either:
  - an injected transport/constructor option for `createRemoteDatabasePromise`, or
  - a Node runtime adapter that imports `WebSocket` from `ws`.
- Avoid test-only globals unless Bri explicitly documents that as its public test harness contract.

Acceptance criteria:

```bash
cd /Users/bri/SOURCE/BRI
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runTestsByPath tests/e2e/bri-connect.test.js tests/e2e/bri-deferred-surface.test.js \
  --runInBand
```

Expected:

```text
Test Suites: 2 passed, 2 total
Tests:       19 passed, 19 total
```

Also run the normal suite:

```bash
npm test
```

**2. Bri full-suite validation is currently blocked by the WebSocket issue**

Status: unresolved, same root cause as issue 1.

During Notebook validation, targeted Bri persistence/WAL validation passed after the WAL fix, but the broader Bri npm test path exposed the remote WebSocket failures above.

Known passing command after WAL fix:

```bash
cd /Users/bri/SOURCE/BRI
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runTestsByPath tests/e2e/persistence.test.js \
  --runInBand
```

Result:

```text
Test Suites: 1 passed
Tests:       63 passed
```

So the WAL issue found during Notebook Phase C has been addressed, but Bri cannot be called fully clean until the remote WebSocket runtime/test mismatch is fixed.

**3. Working tree hygiene: untracked `todo/C2C3.md`**

Status: unresolved ownership question.

Current status:

```text
?? todo/C2C3.md
```

File:

```text
/Users/bri/SOURCE/BRI/todo/C2C3.md
```

I did not inspect or modify this file. It may be intentional local planning material, but the Bri coding agent should decide whether it belongs in version control, should be ignored, or should be removed.

**Summary For Bri Agent**

Primary remaining Bri blocker: remote WebSocket client is not Node/Jest compatible because `src/remote/index.js` directly uses `WebSocket` without ensuring a constructor exists in Node.

The WAL race is already fixed in commit:

```text
5399906 fix: harden wal writer close races
```

Notebook Phase C is not blocked anymore, but Bri itself still needs the WebSocket transport/runtime compatibility issue resolved before its full suite can be considered clean.