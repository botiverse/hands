#!/usr/bin/env node
// Scope the post-migration foreign-key check to what a deploy actually changed.
//
//   migration-fk-scope.mjs tables <migrations_dir> <file.sql>...
//     Prints the tables the given migration files write (CREATE/ALTER/INSERT/
//     REPLACE/UPDATE/DELETE/DROP), space-separated. Exits non-zero if a file is
//     missing or a name is not a plain identifier, so the caller cannot mistake
//     "could not tell" for "nothing to check".
//
//   migration-fk-scope.mjs referencing-sql <table>...
//     Prints one SQL query returning the tables to check: those of the given
//     tables that still exist (a migration may drop its own scratch tables), plus
//     every table whose foreign keys point at them, since a DELETE or DROP in a
//     parent can orphan rows in its children.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILE = /^[0-9]{4}_[A-Za-z0-9_]+\.sql$/;
const KEYWORDS = new Set(["OF", "ON", "SET", "OR", "INTO", "FROM", "TABLE"]);

export function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function tablesWritten(sql) {
  const re = /\b(?:CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)[`"\]]?/gi;
  const out = new Set();
  // A trigger's "AFTER UPDATE OF col ON t" matches as UPDATE OF; keywords are not tables.
  for (const m of stripComments(sql).matchAll(re)) if (!KEYWORDS.has(m[1].toUpperCase())) out.add(m[1]);
  // ALTER TABLE x RENAME TO y: the new name holds the rows afterwards.
  for (const m of stripComments(sql).matchAll(/\bRENAME\s+TO\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) out.add(m[1]);
  return [...out].sort();
}

export function referencingSql(tables) {
  for (const t of tables) if (!IDENT.test(t)) throw new Error(`not a plain identifier: ${t}`);
  const list = tables.map((t) => `'${t}'`).join(", ");
  return `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${list}) `
    + `UNION SELECT m.name AS name FROM sqlite_master m, pragma_foreign_key_list(m.name) f `
    + `WHERE m.type = 'table' AND f."table" IN (${list}) ORDER BY name;`;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "tables") {
    const [dir, ...files] = rest;
    if (!dir) throw new Error("usage: tables <migrations_dir> <file.sql>...");
    const all = new Set();
    for (const f of files) {
      if (!FILE.test(f)) throw new Error(`not a migration file name: ${f}`);
      for (const t of tablesWritten(readFileSync(join(dir, f), "utf8"))) all.add(t);
    }
    for (const t of all) if (!IDENT.test(t)) throw new Error(`not a plain identifier: ${t}`);
    process.stdout.write([...all].sort().join(" "));
    return;
  }
  if (mode === "referencing-sql") {
    if (rest.length === 0) throw new Error("usage: referencing-sql <table>...");
    process.stdout.write(referencingSql(rest));
    return;
  }
  throw new Error("usage: migration-fk-scope.mjs tables|referencing-sql ...");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
