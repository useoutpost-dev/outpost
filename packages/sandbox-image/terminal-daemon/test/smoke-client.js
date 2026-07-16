'use strict';

// Manual smoke-test client for the terminal daemon. Not a unit test — it dials
// a RUNNING daemon (e.g. the built image on -p 8022:8022) and exercises the
// wire protocol end to end:
//   1. connect WITHOUT a token  -> expect 401 rejection
//   2. connect WITH the token    -> run `echo hello`, see output
//   3. drop + reconnect          -> replay must include `hello`
//   4. resize then `tput cols`   -> output reflects the new width
//
// Usage:
//   OUTPOST_TERMINAL_TOKEN=testtoken node test/smoke-client.js [ws://127.0.0.1:8022]
//
// Requires `ws` to be resolvable (run from the daemon dir after npm install,
// or via the built image's node_modules).

const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://127.0.0.1:8022';
const TOKEN = process.env.OUTPOST_TERMINAL_TOKEN || 'testtoken';

function authHeaders(token) {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Open a connection; resolves with a handle exposing collected output.
function open(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, authHeaders(token));
    let out = '';
    let replayEnded = false;
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.on('error', (err) => reject(err));
    ws.on('open', () =>
      resolve({
        ws,
        write: (s) => ws.send(Buffer.from(s), { binary: true }),
        resize: (cols, rows) => ws.send(JSON.stringify({ type: 'resize', cols, rows })),
        output: () => out,
        replayEnded: () => replayEnded,
        close: () => ws.close(),
      })
    );
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        out += data.toString('utf8');
        return;
      }
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'replay-end') replayEnded = true;
      } catch {
        /* ignore non-JSON text */
      }
    });
  });
}

async function main() {
  const results = [];

  // 1. No token -> 401.
  try {
    await open('');
    results.push('FAIL: unauthenticated connection was accepted');
  } catch (err) {
    if (/401/.test(err.message)) results.push('PASS: no-token connection rejected (401)');
    else results.push(`PASS(reject): no-token connection rejected (${err.message})`);
  }

  // 2. With token -> echo hello.
  const c1 = await open(TOKEN);
  await delay(500); // let the login shell settle
  c1.write('echo hello\n');
  await delay(800);
  if (c1.output().includes('hello')) results.push('PASS: echo hello visible over authed connection');
  else results.push(`FAIL: did not see 'hello' (got ${JSON.stringify(c1.output().slice(-120))})`);
  c1.close();
  await delay(300);

  // 3. Reconnect -> replay includes hello.
  const c2 = await open(TOKEN);
  await delay(800);
  if (!c2.replayEnded()) results.push('WARN: replay-end frame not observed');
  if (c2.output().includes('hello')) results.push('PASS: replay includes prior `hello`');
  else results.push(`FAIL: replay missing 'hello' (got ${JSON.stringify(c2.output().slice(-160))})`);

  // 4. Resize then tput cols.
  c2.resize(137, 40);
  await delay(300);
  const marker = 'COLS_MARKER';
  c2.write(`echo ${marker}=$(tput cols)\n`);
  await delay(900);
  const m = new RegExp(`${marker}=(\\d+)`).exec(c2.output());
  if (m && m[1] === '137') results.push('PASS: tput cols reflects resize (137)');
  else results.push(`FAIL: tput cols mismatch (got ${m ? m[1] : 'no match'})`);
  c2.close();

  await delay(200);
  console.log('\n=== smoke-test results ===');
  for (const r of results) console.log(r);
  const failed = results.some((r) => r.startsWith('FAIL'));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke-test crashed:', err.message);
  process.exit(2);
});
