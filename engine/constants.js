/**
 * @file Engine constants and symbols
 */

// Collection names: alphanumeric identifier starting with a lowercase letter
// or digit, optionally containing uppercase letters in the interior, never
// ending in lowercase 's' (reserved to disambiguate from group form),
// optionally suffixed with capital 'S' for the group accessor.
//
// Accepted: user, userS, memoryArtifact, memoryArtifactS, kgEntity, 123abc.
// Rejected: User, users, memoryArtifacts, _user, foo-bar.
//
// History: was /^[a-z0-9]+(?<![sS])(?:S)?$/ — restricted to all-lowercase
// alphanumerics. Relaxed to allow camelCase interior characters so multi-word
// domain collections from the Vector + Graph spec (memoryArtifact, kgTriple,
// lexicalEdge) pass without breaking existing leading-digit names like
// '123abc' that earlier tests rely on.
export const collectionNamePattern = /^[a-z0-9][a-zA-Z0-9]*(?<![sS])S?$/;

export const undeclared = Symbol("Empty");
export const MAKE_COPY = Symbol("makeCopy");
