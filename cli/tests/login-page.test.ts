import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginSuccessPage } from '../src/veed/login-page.ts';

test('serves the logged-in page', async () => {
  const html = await loginSuccessPage();
  assert.match(html, /Now go/);
  assert.match(html, /class="t-serif">create</); // the serif italic is the design, not decoration
  assert.match(html, /You can now close this window/);
});

test('a missing page falls back instead of failing the login', async () => {
  assert.match(await loginSuccessPage('/nonexistent.html'), /Logged in with VEED/);
});

// The CLI login can run offline or sandboxed, so the page must fetch nothing.
test('the page needs no network', async () => {
  const html = await loginSuccessPage();
  assert.match(html, /url\(data:font\/woff2;base64,/);
  assert.equal(/<link[^>]+href=["']https?:/i.test(html), false, 'no remote stylesheets');
  assert.equal(/url\(["']?https?:/i.test(html), false, 'no remote css assets');
  assert.equal(/<(script|img)[^>]+src=["']https?:/i.test(html), false, 'no remote scripts or images');
});
