// Preloaded only by startup.test.ts: exercise the unmodified CLI and Octokit
// without contacting GitHub or exposing a production startup-testing option.
import { setTimeout } from 'node:timers/promises';

let started = 0;
let completed = 0;
let aborted = 0;
let active = 0;
let peak = 0;
const failure = process.env.TEST_STARTUP_FAILURE;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/user') {
    await setTimeout(300, undefined, { signal: init?.signal });
    return Response.json({ login: 'tester' });
  }
  if (url.pathname === '/repositories/101') return Response.json({ full_name: 'new-owner/renamed' });
  if (!/^\/repos\/owner\/repo\d+$/.test(url.pathname)) throw new Error(`Unexpected fetch: ${url.pathname}`);
  const index = Number(url.pathname.match(/repo(\d+)$/)[1]);
  started++;
  peak = Math.max(peak, ++active);
  try {
    // A later unavailable entry answers first; no sibling is cancelled.
    const latency = failure && index === 4 ? 20 : failure && index === 1 ? 100 : 300;
    await setTimeout(latency, undefined, { signal: init?.signal });
    completed++;
    if (failure && (index === 1 || index === 4)) {
      return failure === '404' || (failure === 'mixed' && index === 4)
        ? Response.json({ message: 'Not Found' }, { status: 404 })
        : new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/101' } });
    }
    return Response.json({ full_name: url.pathname.slice('/repos/'.length) });
  } catch (err) {
    if (init?.signal?.aborted) aborted++;
    throw err;
  } finally {
    active--;
  }
};
process.on('exit', () => console.error('STARTUP_FETCH', JSON.stringify({ started, completed, aborted, active, peak })));
