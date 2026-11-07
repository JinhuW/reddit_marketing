/**
 * Node gateway entry point (`SERVICE_ROLE=gateway`, docs/plans/0001-infra-implementation.md §3.4).
 * Wave 0 stub so worker roles (T10) can import it; T11 replaces it with the authenticated WSS hub.
 */
export async function startGateway(): Promise<void> {
  throw new Error('not implemented: the node gateway ships in T11');
}
