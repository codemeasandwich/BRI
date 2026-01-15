Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)
    

Stayed in plan mode**Claude’s Plan**

Plan: Cover Remaining Lines in operations.js (89, 262, 311)
===========================================================

Current State
-------------

*   operations.js is at 98.2% line coverage
    
*   3 uncovered lines remain: 89, 262, 311
    

Line 89 - Empty changes array debugger
--------------------------------------

**Source code (lines 87-90):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (0 === changes2save.length) {    debugger;  // LINE 89  }   `

**Location:** update() function - called when saving a reactive object

**What triggers it:** Calling .save() on a reactive proxy when there are NO pending changes tracked.

**User scenario:**

1.  Create an object via db.add.Item({ name: "test" })
    
2.  Get it back (creates reactive proxy)
    
3.  Immediately call .save() WITHOUT modifying anything
    

**Why it's uncovered:** The reactive proxy normally only allows save() when changes exist. But the update() function has this defensive check.

**Test approach:** Call save() on a freshly retrieved object with no modifications.

Line 262 - Single-item get with query object that doesn't match
---------------------------------------------------------------

**Source code (lines 261-263):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if ("object" === where && !checkMatch(where, adb)) {    return null;  // LINE 262  }   `

**Location:** get() function - single item path (when $ID is known)

**What triggers it:** Passing an object with BOTH $ID AND additional filter properties, where the item exists but doesn't match the filter.

**Key insight:** You CANNOT pass ID as first arg and filter as second arg - that converts filter to a function. You must pass a SINGLE object with both $ID AND filter properties.

**User scenario:**

1.  Create a User: db.add.Profile({ name: "Alice", role: "admin" })
    
2.  db.get.Profile({ $ID: 'prf\_xxx', role: 'guest' })
    
3.  Returns null because Alice's role is "admin", not "guest"
    

**Test approach:**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   const user = await db.add.Profile({ name: 'Alice', role: 'admin' });  // Pass object with $ID AND non-matching filter  const result = await db.get.Profile({ $ID: user.$ID, role: 'guest' });  expect(result).toBeNull();   `

Line 311 - Group get with query object filter (DEAD CODE ANALYSIS)
------------------------------------------------------------------

**Source code (lines 310-312):**

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   if (whereIsQueryObj) {    return isMatch(where, item);  // LINE 311  }   `

**Location:** get() function - group path filter (line 306-314)

**Analysis:** This code is **unreachable** because:

1.  } else if (!where.txnId && !Array.isArray(where)) { const matchThis = where; where = (source) => checkMatch(matchThis, source);}
    
2.  Later at line 276, whereIsQueryObj checks: where && (where + "").startsWith('\[object')
    
3.  But by this point, where is a **function**, and function.toString() returns the function source code (e.g., "(source) => checkMatch(matchThis, source)"), NOT "\[object Object\]".
    
4.  Therefore whereIsQueryObj is always false for query objects, and line 311 never executes.
    

**Resolution options:**

1.  **Remove dead code** - Delete lines 310-312 since they're unreachable
    
2.  **Fix the logic** - If the intent was to use isMatch, save whereIsQueryObj BEFORE where is reassigned at line 205
    

**Recommendation:** Remove the dead code (Option 1) since checkMatch at line 205 already handles object filtering.

Test File Location
------------------

Add tests to: tests/e2e/final-coverage.test.js (where other coverage tests exist)

Implementation
--------------

### Test 1: Line 89 - save() with no changes

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 89: save() with no pending changes', async () => {    const item = await wrapper.create('emptychange', { title: 'test' });    const fetched = await wrapper.get('emptychange', item.$ID);    // Save without making any changes - triggers empty changes array path    await fetched.save();  });   `

### Test 2: Line 262 - single get with $ID object and non-matching filter

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   test('line 262: get with $ID object and non-matching filter returns null', async () => {    const user = await wrapper.create('filtermatch', { name: 'Alice', role: 'admin' });    // Pass object with BOTH $ID AND filter that doesn't match    const result = await wrapper.get('filtermatch', { $ID: user.$ID, role: 'guest' });    expect(result).toBeNull();  });   `

### Line 311 - DEAD CODE (remove it)

Lines 310-312 are unreachable because query objects get converted to functions at line 205 before whereIsQueryObj is checked at line 276. The fix is to delete this dead code:

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   // REMOVE these lines from operations.js:  if (whereIsQueryObj) {    return isMatch(where, item);  }   `

Verification
------------

1.  Run npm run test:coverage
    
2.  Confirm lines 89, 262 are now covered
    
3.  Confirm line 311 no longer appears (after removal)
    
4.  Target: operations.js at 100% line coverage
    

Files to Modify
---------------

1.  [tests/e2e/final-coverage.test.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/tests/e2e/final-coverage.test.js) - add 2 new test cases
    
2.  [engine/operations.js](vscode-webview://0rq3uhmao9b42jf8aandgr2mftd2q7qiaa4dml0kfcj71b70qdt3/engine/operations.js) - remove dead code (lines 310-312)