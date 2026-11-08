/**
 * @threadline/node-testkit: fakes for browser-node tests (plan §4 T14).
 *
 * - FakeAgent: scripted agent for gateway tests (T11, T20, T24, T34 in CI).
 * - FakeGateway: minimal gateway for node-agent tests (T12, T21, T22).
 * - startFakeCdpTarget: bundled Chromium with CDP + Reddit fixture pages for action tests (T22, T31).
 *
 * Test-only: never import from production code.
 */
export * from './fake-agent';
export * from './fake-gateway';
export * from './fake-cdp';
export * from './fixtures';
export { Recorder, TestkitTimeoutError, delay } from './wait';
