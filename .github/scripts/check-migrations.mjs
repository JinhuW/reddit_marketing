#!/usr/bin/env node
// Every commit to main deploys and runs `migrate:deploy` unattended, so CI stops two kinds of migration before they
// reach production (docs/RELEASING.md "Database migrations"):
//   1. A new migration that can lose data (drops a table/column/type, renames, changes a column type, truncates or
//      deletes rows) unless the file says why with a line `-- allow-destructive: <reason>`. Take a backup first
//      (docs/RUNBOOK-railway.md §5).
//   2. An edit, rename or deletion of a migration that is already on main: it has run in production.
//
// Usage: node .github/scripts/check-migrations.mjs <base-commit>   (compares <base-commit>..HEAD)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = 'packages/db/prisma/migrations/';

// Statements that can lose data. DROP INDEX, DROP CONSTRAINT, DROP DEFAULT and DROP NOT NULL lose none and pass.
const DESTRUCTIVE = [
  [
    /\bDROP\s+(TABLE|SCHEMA|TYPE|VIEW|MATERIALIZED\s+VIEW|EXTENSION)\b/i,
    'drops a table, schema, type, view or extension',
  ],
  [/\bDROP\s+COLUMN\b/i, 'drops a column'],
  [/\bALTER\s+TABLE\b[^;]*?\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|INDEX\b)"?\w/i, 'drops a column'],
  [/\bRENAME\b/i, 'renames a table, column, type or value'],
  [/\bALTER\s+COLUMN\b[^;]*?\b(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bTRUNCATE\b/i, 'truncates a table'],
  [/\bDELETE\s+FROM\b/i, 'deletes rows'],
];

const ALLOW = /^[ \t]*--[ \t]*allow-destructive:[ \t]*\S/im;

/** Strips `--` line comments and block comments, so a commented-out statement does not count. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Reasons why this migration can lose data; empty when it cannot or when it carries the allow marker. */
export function destructiveReasons(sql) {
  if (ALLOW.test(sql)) return [];
  const code = stripComments(sql);
  const reasons = new Set();
  for (const [pattern, reason] of DESTRUCTIVE) if (pattern.test(code)) reasons.add(reason);
  return [...reasons];
}

/**
 * Problems for one `git diff --name-status` result. `changes` is [{ status, path }] with status A, M, D or R…;
 * `read(path)` returns the file's text at HEAD.
 */
export function checkChanges(changes, read) {
  const problems = [];
  for (const { status, path } of changes) {
    if (!path.startsWith(MIGRATIONS_DIR) || !path.endsWith('.sql')) continue;
    if (status === 'A') {
      const reasons = destructiveReasons(read(path));
      if (reasons.length) {
        problems.push(
          `${path}: ${reasons.join('; ')}. Back up first, then add a line "-- allow-destructive: <reason>" to the file.`,
        );
      }
    } else {
      problems.push(
        `${path}: a migration that is already on main was ${status.startsWith('R') ? 'renamed' : status === 'D' ? 'deleted' : 'edited'}. It has run in production; add a new migration instead.`,
      );
    }
  }
  return problems;
}

function gitChanges(base) {
  const out = execFileSync(
    'git',
    ['diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', MIGRATIONS_DIR],
    {
      encoding: 'utf8',
    },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    });
}

/** True when `ref` names a commit in this clone (a force push can leave the push's `before` unreachable). */
function isCommit(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  const usable = base && !/^0+$/.test(base) && isCommit(base);
  if (!usable) console.log(`No usable base commit (${base || 'none'}); comparing with HEAD~1.`);
  const range = usable ? base : 'HEAD~1';
  const changes = gitChanges(range);
  const problems = checkChanges(changes, (p) => readFileSync(p, 'utf8'));
  for (const p of problems) console.log(`::error file=${p.split(':')[0]}::${p}`);
  const added = changes.filter((c) => c.status === 'A' && c.path.endsWith('.sql')).length;
  console.log(`${added} new migration file(s) since ${range}; ${problems.length} problem(s).`);
  process.exit(problems.length ? 1 : 0);
}
