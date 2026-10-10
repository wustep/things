/**
 * Preloaded into ingest child processes by the tests (`node --import`). Any request to a paid
 * service fails loudly instead of leaving the machine, so a regression in the Meshy opt-in
 * shows up as a test failure, never as a bill.
 */
const PAID_HOSTS = /(^|\.)meshy\.ai$/i;
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (PAID_HOSTS.test(url.hostname)) {
    process.stderr.write(`PAID SERVICE CALLED: ${url.hostname}\n`);
    throw new Error(`blocked request to paid service ${url.hostname}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
