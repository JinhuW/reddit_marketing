// CI: fail when prisma/schema.prisma has changes with no migration.
// The only allowed difference is raw-SQL objects Prisma cannot model (the pgvector HNSW index).
import { execFileSync } from 'node:child_process';

const ALLOWED = [/^-- DropIndex$/, /^DROP INDEX "ContextItem_embedding_hnsw";$/];
const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) throw new Error('SHADOW_DATABASE_URL is required');
const sql = execFileSync(
  'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-migrations',
    'prisma/migrations',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--shadow-database-url',
    shadow,
    '--script',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const unexpected = sql
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !ALLOWED.some((re) => re.test(l)));
if (unexpected.length && !(unexpected.length === 1 && unexpected[0] === '-- This is an empty migration.')) {
  console.error('Schema and migrations differ. Run `pnpm db:migrate` and commit the migration:\n');
  console.error(sql);
  process.exit(1);
}
console.log('Migrations match schema.');
