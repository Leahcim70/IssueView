'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fetchIssues, parseRemote } = require('../src/github');
const root = path.join(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const english = read('l10n/bundle.l10n.json');
const german = read('l10n/bundle.l10n.de.json');
const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

test('English and German cover runtime strings and preserve placeholders', () => {
  assert.deepEqual(Object.keys(german).sort(), Object.keys(english).sort());
  for (const [key, value] of Object.entries(german)) {
    assert.ok(value.trim(), key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
  for (const file of ['src/extension.js', 'src/github.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:vscode\.l10n\.t|\bt)\("((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse('"' + match[1] + '"');
      assert.ok(Object.hasOwn(english, key), file + ': ' + key);
    }
  }
});

test('manifest contributions resolve in both languages with IssueView branding', () => {
  const manifest = read('package.json');
  assert.equal(manifest.name, 'issueview');
  assert.equal(manifest.displayName, 'IssueView');
  assert.equal(manifest.l10n, './l10n');
  const en = read('package.nls.json'), de = read('package.nls.de.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  for (const match of JSON.stringify(manifest).matchAll(/%([^%]+)%/g)) {
    assert.ok(en[match[1]], match[1]); assert.ok(de[match[1]], match[1]);
  }
});

test('GitHub errors are translated with the actual HTTP status', async () => {
  const translate = (message, ...args) => (german[message] || message).replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
  const repo = parseRemote('https://github.com/owner/repo');
  for (const [status, expected] of [[401, /Anmeldung/], [404, /Zugriffsberechtigung/], [503, /GitHub-Anfrage fehlgeschlagen \(HTTP 503\)/]]) {
    await assert.rejects(fetchIssues(repo, 'open', 1, 'test-token', new AbortController().signal,
      async () => new Response('{}', { status }), translate), expected);
  }
});
