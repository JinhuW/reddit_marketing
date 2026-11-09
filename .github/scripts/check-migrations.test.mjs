import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIGRATIONS_DIR, checkChanges, destructiveReasons } from './check-migrations.mjs';

test('passes statements that lose no data', () => {
  for (const sql of [
    'CREATE TABLE "A" ("id" TEXT PRIMARY KEY);',
    'DROP INDEX "BrowserNode_workspaceId_name_key";',
    'ALTER TABLE "BrowserProfile" DROP CONSTRAINT "BrowserProfile_accountId_fkey";',
    'ALTER TABLE "BrowserProfile" ALTER COLUMN "accountId" DROP NOT NULL;',
    'ALTER TABLE "A" ALTER COLUMN "n" DROP DEFAULT;',
    'ALTER TABLE "A" ADD COLUMN "b" TEXT;',
    '-- DROP TABLE "Old"; kept as a note\nSELECT 1;',
    '/* DROP COLUMN "x" */ SELECT 1;',
  ]) {
    assert.deepEqual(destructiveReasons(sql), [], sql);
  }
});

test('flags statements that can lose data', () => {
  for (const sql of [
    'DROP TABLE "Lead";',
    'ALTER TABLE "Lead" DROP COLUMN "score";',
    'ALTER TABLE "Lead" DROP "score";',
    'ALTER TABLE "Lead" RENAME COLUMN "a" TO "b";',
    'ALTER TYPE "Status" RENAME TO "Status_old";',
    'ALTER TABLE "Lead" ALTER COLUMN "score" SET DATA TYPE INTEGER;',
    'ALTER TABLE "Lead" ALTER COLUMN "score" TYPE INTEGER USING "score"::int;',
    'TRUNCATE "Lead";',
    'DELETE FROM "Lead" WHERE true;',
    'drop type "Status_old";',
  ]) {
    assert.notDeepEqual(destructiveReasons(sql), [], sql);
  }
});

test('the allow marker with a reason lets a destructive migration through', () => {
  assert.deepEqual(
    destructiveReasons('-- allow-destructive: column unused since v0.4\nDROP TABLE "Old";'),
    [],
  );
  // A marker without a reason does not count.
  assert.notDeepEqual(destructiveReasons('-- allow-destructive:\nDROP TABLE "Old";'), []);
});

test('flags edits, renames and deletions of migrations already on main', () => {
  const p = `${MIGRATIONS_DIR}20260101000000_x/migration.sql`;
  for (const status of ['M', 'D', 'R100']) {
    assert.equal(checkChanges([{ status, path: p }], () => '').length, 1, status);
  }
  assert.deepEqual(
    checkChanges([{ status: 'A', path: p }], () => 'CREATE TABLE "A" ();'),
    [],
  );
  assert.deepEqual(
    checkChanges([{ status: 'M', path: 'apps/web/x.sql' }], () => ''),
    [],
  );
});

test('every migration already on main passes', () => {
  const root = join(import.meta.dirname, '..', '..', MIGRATIONS_DIR);
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sql = readFileSync(join(root, dir.name, 'migration.sql'), 'utf8');
    assert.deepEqual(destructiveReasons(sql), [], dir.name);
  }
});
