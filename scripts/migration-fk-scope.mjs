#!/usr/bin/env node
// Scope the post-migration foreign-key check to what a deploy actually changed.
//
//   migration-fk-scope.mjs tables <migrations_dir> <file.sql>...
//     Prints the tables the given migration files write (CREATE/ALTER/INSERT/
//     REPLACE/UPDATE/DELETE/DROP), space-separated. Exits non-zero if a file is
//     missing or a name is not a plain identifier, so the caller cannot mistake
//     "could not tell" for "nothing to check".
//
//   migration-fk-scope.mjs scope <table>... < schema.json
//     Reads the JSON rows of `SELECT name, sql FROM sqlite_master WHERE type =
//     'table'` on stdin and prints the tables to check, space-separated: those of
//     the given tables that still exist, plus every table whose foreign keys point
//     at them.
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

/**
 * The tables to check, from the live schema rows `SELECT name, sql FROM sqlite_master
 * WHERE type = 'table'`: those of the given tables that still exist (a migration may
 * drop its own scratch tables), plus every table whose foreign keys point at one of
 * them, since a DELETE or DROP in a parent can orphan rows in its children.
 *
 * The references are read from each table's CREATE statement rather than from
 * pragma_foreign_key_list(): production D1 refuses that table-valued function, and
 * only plain reads of sqlite_master are known to work there.
 */
export function scopeFromSchema(tables, rows) {
  for (const t of tables) if (!IDENT.test(t)) throw new Error(`not a plain identifier: ${t}`);
  if (!Array.isArray(rows)) throw new Error("schema rows must be an array");
  // Called only when migrations wrote tables, so the schema cannot be empty; an
  // empty answer means the read did not see the database, not that nothing exists.
  if (rows.length === 0) throw new Error("schema read returned no tables");
  const wanted = new Set(tables.map((t) => t.toLowerCase()));
  const out = new Set();
  for (const row of rows) {
    if (!row || typeof row.name !== "string" || typeof row.sql !== "string") {
      throw new Error("schema row without name and sql");
    }
    if (wanted.has(row.name.toLowerCase())) out.add(row.name);
    // Not comment-stripped: stripping cannot tell a "--" inside a string literal from
    // a comment and could hide a real clause, while an extra match only widens the
    // check. SQLite needs no space after REFERENCES and accepts a single-quoted name.
    for (const m of row.sql.matchAll(/\bREFERENCES\s*(?:\/\*[\s\S]*?\*\/\s*)*[`"'[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      if (wanted.has(m[1].toLowerCase())) out.add(row.name);
    }
  }
  for (const t of out) if (!IDENT.test(t)) throw new Error(`not a plain identifier: ${t}`);
  return [...out].sort();
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "tables") {
    const [dir, ...files] = rest;
    if (!dir) throw new Error("usage: tables <migrations_dir> <file.sql>...");
    // A run that applied migrations but names none means the file list was not
    // parsed; "no files" must not read as "nothing to check".
    if (files.length === 0) throw new Error("no migration files given");
    const all = new Set();
    for (const f of files) {
      if (!FILE.test(f)) throw new Error(`not a migration file name: ${f}`);
      for (const t of tablesWritten(readFileSync(join(dir, f), "utf8"))) all.add(t);
    }
    for (const t of all) if (!IDENT.test(t)) throw new Error(`not a plain identifier: ${t}`);
    process.stdout.write([...all].sort().join(" "));
    return;
  }
  if (mode === "scope") {
    if (rest.length === 0) throw new Error("usage: scope <table>... < schema.json");
    const rows = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(scopeFromSchema(rest, rows).join(" "));
    return;
  }
  throw new Error("usage: migration-fk-scope.mjs tables|scope ...");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
