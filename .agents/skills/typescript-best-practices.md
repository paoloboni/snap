TypeScript Best Practices

Guide AI agents in writing high-quality TypeScript code. This skill provides coding standards, architecture patterns, and tools for analysis and scaffolding.

When to Use This Skill

Use this skill when:

Generating new TypeScript code

Reviewing TypeScript files for quality issues

Creating new modules, services, or components

Refactoring JavaScript to TypeScript

Answering questions about TypeScript patterns or types

Designing APIs or interfaces

Do NOT use this skill when:

Working with pure JavaScript (no TypeScript)

Debugging runtime errors (use debugging tools)

Framework-specific patterns (React, Vue, etc. - use framework skills)

Core Principles

1. Type Safety First

Maximize compile-time error detection:

// Prefer unknown over any for unknown types
function processInput(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "number") return String(data);
  throw new Error("Unsupported type");
}

// Explicit return types for public APIs
export function calculateTotal(items: ReadonlyArray&#x3C;Item>): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// Use const assertions for literal types
const CONFIG = {
  mode: "production",
  version: 1,
} as const;

2. Immutability by Default

Prevent accidental mutations:

// Use readonly for object properties
interface User {
  readonly id: string;
  readonly email: string;
  name: string; // Only mutable if intentional
}

// Use ReadonlyArray for collections
function processItems(items: ReadonlyArray&#x3C;Item>): ReadonlyArray&#x3C;Result> {
  return items.map(transform);
}

// Prefer spreading over mutation
function updateUser(user: User, name: string): User {
  return { ...user, name };
}

3. Error Handling with Types

Use the type system for error handling:

// Result type for recoverable errors
type Result&#x3C;T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

// Typed error classes
class ValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly code: string
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// Function with Result return type
function parseConfig(input: string): Result&#x3C;Config, ValidationError> {
  try {
    const data = JSON.parse(input);
    if (!isValidConfig(data)) {
      return {
        success: false,
        error: new ValidationError("Invalid config", "root", "INVALID_FORMAT"),
      };
    }
    return { success: true, value: data };
  } catch {
    return {
      success: false,
      error: new ValidationError("Parse failed", "root", "PARSE_ERROR"),
    };
  }
}

4. Code Organization

Structure code for maintainability:

// One concept per file
// user.ts - User type and related utilities
export interface User {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
}

export function createUser(email: string): User {
  return {
    id: crypto.randomUUID(),
    email,
    createdAt: new Date(),
  };
}

// Explicit exports (no barrel file wildcards)
// index.ts
export { User, createUser } from "./user.ts";
export { validateEmail } from "./validation.ts";

Quick Reference

Category

Prefer

Avoid

Unknown types

unknown

any

Collections

ReadonlyArray&#x3C;T>

T[] for inputs

Objects

Readonly&#x3C;T>

Mutable by default

Null checks

Optional chaining ?.

!= null

Type narrowing

Type guards

as assertions

Return types

Explicit on exports

Inferred on exports

Enums

String literal unions

Numeric enums

Imports

Named imports

Default imports

Errors

Result types

Throwing for flow control

Loops

for...of, .map()

for...in on arrays

Code Generation Guidelines

When generating TypeScript code, follow these patterns:

Module Structure

/**
 * Module description
 * @module module-name
 */

// === Types ===
export interface ModuleOptions {
  readonly setting: string;
}

export interface ModuleResult {
  readonly data: unknown;
}

// === Constants ===
const DEFAULT_OPTIONS: ModuleOptions = {
  setting: "default",
};

// === Implementation ===
export function processData(
  input: unknown,
  options: Partial&#x3C;ModuleOptions> = {}
): ModuleResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // Implementation
  return { data: input };
}

Function Design

<pre class="language-typ