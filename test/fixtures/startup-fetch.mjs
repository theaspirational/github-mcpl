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
  if (!/^\/repos\/owner\/repo\d+$/.test(url.pathname)) throw new Error(`Unexpected fetch: ${url.pathname}`);
  const index = Number(url.pathname.match(/repo(\d+)$/)[1]);
  started++;
  peak = Math.max(peak, ++active);
  try {
    // The later failure arrives first. Earlier entries must still determine
    // the diagnostic, and later in-flight requests must be cancelled.
    const latency = failure && index === 4 ? 20 : failure && index === 1 ? 100 : 300;
    await setTimeout(latency, undefined, { signal: init?.signal });
    completed++;
    if (failure && (index === 1 || index === 4)) {
      return failure === '404'
        ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json({ full_name: `Owner/repo${index}` });
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
