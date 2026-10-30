import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode } from './codec.mjs';

const browser = process.env.BROWSER_BIN;
const vectors = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url)));
const files = new Map([
  ['/codec.mjs', ['codec.mjs', 'text/javascript']],
  ['/r/', ['r/index.html', 'text/html']],
  ['/r/page.css', ['r/page.css', 'text/css']],
  ['/r/page.mjs', ['r/page.mjs', 'text/javascript']],
]);

// The browser uses a private pipe, a disposable profile, and an exclusive random port.
// Intercept link clicks before they reach an external destination.
test('link page workflows in a headless browser', { timeout: 30000 }, async () => {
  assert.ok(browser, 'Set BROWSER_BIN to a compatible headless browser binary');
  const profile = await mkdtemp(join(tmpdir(), 'link-page-'));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/frame') {
      response.setHeader('content-type', 'text/html');
      response.end('<iframe src="/r/#' + encodeURIComponent(url.searchParams.get('payload')) + '"></iframe>');
    } else if (url.pathname === '/old/') {
      response.setHeader('content-type', 'text/html');
      response.end(await readFile(new URL('./forward.html', import.meta.url)));
    } else if (url.pathname === '/old/forward.mjs') {
      response.setHeader('content-type', 'text/javascript');
      const template = await readFile(new URL('./forward.mjs', import.meta.url), 'utf8');
      response.end(template.replace("const newPage = '';", "const newPage = '" + origin + "/new/';"));
    } else if (url.pathname === '/new/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Hindsight</title>');
    } else if (files.has(url.pathname)) {
      const [path, type] = files.get(url.pathname);
      response.setHeader('content-type', type);
      response.end(await readFile(new URL(path, import.meta.url)));
    } else { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const process = spawn(browser, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-networking', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--user-data-dir=' + profile, '--remote-debugging-pipe', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  process.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  const blocked = [];
  let forwardedResolve;
  const forwarded = new Promise(resolve => { forwardedResolve = resolve; });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    process.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
  });
  process.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      } else if (message.method === 'Page.frameNavigated' && message.params.frame.url === origin + '/new/') {
        forwardedResolve();
      } else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        if (request.url.startsWith(origin + '/')) {
          send('Fetch.continueRequest', { requestId }, message.sessionId).catch(() => {});
        } else {
          blocked.push(request.url);
          send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
        }
      }
    }
  });
  process.on('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('Browser exited: ' + stderr));
    pending.clear();
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await command('Page.addScriptToEvaluateOnNewDocument', { source:
      'window.__launches=[]; HTMLAnchorElement.prototype.click=function(){window.__launches.push(this.href)};' });
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = expression => evaluate('new Promise((resolve,reject)=>{let n=0;const check=()=>{if(' + expression + ')resolve(true);else if(++n>200)reject(new Error("Timed out: " + location.href + " " + document.readyState));else setTimeout(check,25)};check()})');
    let navigation = 0;
    const navigate = async path => {
      const separator = path.includes('?') ? '&' : '?';
      const [pathname, hash = ''] = path.split('#');
      const url = origin + pathname + separator + 'test=' + ++navigation + (hash ? '#' + hash : '');
      const result = await command('Page.navigate', { url });
      if (result.errorText) throw new Error(result.errorText + ' blocked: ' + JSON.stringify(blocked));
      await wait('document.readyState === "complete" && location.href === ' + JSON.stringify(url));
    };
    const maximum = vectors.valid.find(vector => vector.name === 'maximum');
    const minimum = vectors.valid.find(vector => vector.name === 'minimum');
    const tampered = vectors.invalid.find(vector => vector.name === 'tampered');
    await navigate('/r/#' + maximum.payload);
    await wait('document.querySelectorAll("a").length === 2');
    assert.deepEqual(await evaluate('[document.querySelector("h1").textContent, document.querySelector(".time").textContent, ...Array.from(document.querySelectorAll("a"), a => a.href), window.__launches.length]'),
      ['A sample', 'Time: 86400 s', 'hindsight://open#' + maximum.payload,
        'https://drive.google.com/file/d/0123456789abcdefghij/view', 0]);
    assert.equal(await evaluate('document.querySelector("meta[name=referrer]").content'), 'no-referrer');
    assert.equal(await evaluate('document.querySelector("meta[http-equiv]").content'),
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
    assert.equal(await evaluate('Array.from(document.querySelectorAll("h1,a,input")).every(e => {const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility === "visible"})'), true);
    if (globalThis.process.env.PAGE_SCREENSHOT) {
      const screenshot = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(globalThis.process.env.PAGE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
    await evaluate('document.querySelectorAll("a").forEach(a => a.click())');
    assert.deepEqual(await evaluate('window.__launches'), [
      'hindsight://open#' + maximum.payload, 'https://drive.google.com/file/d/0123456789abcdefghij/view']);
    await evaluate('window.__launches = []; document.querySelector("input").click()');
    assert.equal(await evaluate('localStorage.getItem("always-open-hindsight")'), 'true');
    await navigate('/r/#' + minimum.payload);
    await wait('window.__launches.length === 1');
    assert.deepEqual(await evaluate('[document.querySelectorAll("a")[1].href, window.__launches[0], document.querySelector("input").checked]'),
      ['https://drive.google.com/drive/u/0/search?q=01234567', 'hindsight://open#' + minimum.payload, true]);
    await navigate('/r/#' + tampered.payload);
    await wait('document.body.textContent.includes("This link is not valid")');
    assert.deepEqual(await evaluate('[document.body.textContent.trim(), document.querySelectorAll("a,button,input").length, window.__launches.length]'), ['This link is not valid', 0, 0]);
    const malicious = await encode({ id: minimum.input.id, t: 1.25, title: '<script>window.pwned=1</script>\u202evisible' });
    await navigate('/r/#' + malicious);
    await wait('document.querySelector("h1") !== null');
    assert.deepEqual(await evaluate('[document.querySelector("h1").textContent, document.querySelectorAll("h1 script").length, !!window.pwned, document.querySelector(".time").textContent]'),
      ['<script>window.pwned=1</script>visible', 0, false, 'Time: 1.25 s']);
    const unsafe = vectors.invalid.find(vector => /bidi/i.test(vector.name));
    assert.ok(unsafe, 'expected a raw bidi title vector');
    await navigate('/r/#' + unsafe.payload);
    await wait('document.body.textContent.includes("This link is not valid")');
    assert.equal(await evaluate('document.querySelectorAll("a,button,input").length'), 0);
    await navigate('/frame?payload=' + maximum.payload);
    await wait('document.querySelector("iframe").contentDocument?.readyState === "complete" && document.querySelector("iframe").contentDocument?.querySelector("#content")');
    assert.deepEqual(await evaluate('[document.querySelector("iframe").contentDocument.body.textContent.trim(), document.querySelector("iframe").contentDocument.querySelectorAll("a,button,input").length, document.querySelector("iframe").contentWindow.__launches.length]'), ['', 0, 0]);
    await navigate('/r/#' + minimum.payload);
    await wait('window.__launches.length === 1');
    await evaluate('document.querySelector("input").click()');
    await navigate('/r/#' + minimum.payload);
    await wait('document.querySelector("input") !== null');
    assert.deepEqual(await evaluate('[document.querySelector("input").checked, window.__launches.length]'), [false, 0]);
    await command('Page.navigate', { url: origin + '/old/#' + maximum.payload });
    await forwarded;
    assert.equal(await evaluate('location.href'), origin + '/new/#' + maximum.payload);
    assert.deepEqual(blocked, []);
    console.log('Verified: valid links, both destinations, opt-in and opt-out, tampering, inert titles, bidi rejection, framing, and fragment forwarding.');
  } finally {
    process.kill();
    await once(process, 'exit').catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
