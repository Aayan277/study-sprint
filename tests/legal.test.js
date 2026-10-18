// The contact line shared by the app and the privacy/terms pages (js/legal.js). Run with: node --test tests/legal.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactHTML, legalLinksHTML } from '../js/legal.js';

const URL_ = 'https://github.com/aayan277/study-sprint';

test('no address set: points to the project page and asks for no personal details', () => {
  const html = contactHTML({ contactEmail: '', projectUrl: URL_ });
  assert.match(html, /open an issue on the <a href="https:\/\/github\.com\/aayan277\/study-sprint"/);
  assert.match(html, /please don’t post personal details there/);
  assert.doesNotMatch(html, /mailto:/);
});

test('a valid address becomes a mailto link', () => {
  const html = contactHTML({ contactEmail: ' hello@example.com ', projectUrl: URL_ });
  assert.equal(html, '<a href="mailto:hello@example.com">hello@example.com</a>');
});

test('a hostile value is never put in the page as markup', () => {
  const html = contactHTML({ contactEmail: 'a"<b>@x.y', projectUrl: URL_ });
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /mailto:/);
  assert.match(html, /project page/);
});

test('the default argument reads SITE from sync-config.js', () => {
  assert.equal(typeof contactHTML(), 'string');
});

test('legal links point to both pages', () => {
  const html = legalLinksHTML();
  assert.match(html, /href="terms\.html"/);
  assert.match(html, /href="privacy\.html"/);
});
