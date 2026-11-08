/**
 * Register (or re-key) a browser node. Run it in the node-gateway service, which holds NODE_TOKEN_<NAME>, so the
 * stored hash matches the Railway variable by construction and the token never appears in argv or history:
 *
 *   railway ssh --service node-gateway --environment production
 *   cd /repo/apps/worker && printenv NODE_TOKEN_BROWSER_1 | \
 *     NODE_NAME=browser-1 WORKSPACE_SLUG=<slug> ASSIGN_UNASSIGNED=1 node_modules/.bin/tsx src/cli/register-node.ts
 *
 * `ASSIGN_UNASSIGNED=1` also puts every profile without a node on this one. Re-keying an online node does not cut
 * its current socket; the new token applies on its next connect.
 */
import { nodes, prisma } from '@threadline/db';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('pipe the token on stdin (do not paste it)');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const name = process.env.NODE_NAME;
  const workspaceSlug = process.env.WORKSPACE_SLUG;
  if (!name || !workspaceSlug) throw new Error('set NODE_NAME and WORKSPACE_SLUG; pipe the token on stdin');
  const token = await readStdin();
  const { node, assignedProfiles } = await nodes.registerInWorkspace({
    workspaceSlug,
    name,
    token,
    assignUnassignedProfiles: process.env.ASSIGN_UNASSIGNED === '1',
  });
  const verified = (await nodes.verifyToken(name, token))?.id === node.id;
  console.log(
    JSON.stringify({ node: node.name, id: node.id, status: node.status, assignedProfiles, verified }),
  );
  if (!verified) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message.split('\n')[0] : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
