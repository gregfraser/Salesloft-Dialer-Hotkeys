// Which Salesloft routes count as a contact's page.
//
// Run with:  node --test tests/test_contact_page.js
//
// The on-page buttons dial one person, so they are only drawn where one person
// is on screen. This is the route half of that decision (content.js adds a DOM
// check for the call logger popout, which can sit over any page). It is a pure
// string function precisely so the rule can be pinned here rather than only
// against the live app.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { slIsContactUrl } = require(path.join(__dirname, '..', 'extension', 'defaults.js'));

test('a contact record is a contact page', () => {
  for (const url of [
    'https://app.salesloft.com/app/people/123456789',
    'https://app.salesloft.com/app/people/123456789/emails',
    'https://app.salesloft.com/app/people/details/123456789',
    'https://app.salesloft.com/app/person/123456789',
    'https://app.salesloft.com/app/contacts/abc-123',
    'https://app.salesloft.com/app/prospects/123456789',
  ]) {
    assert.strictEqual(slIsContactUrl(url), true, url);
  }
});

test('a person reached from inside a cadence still counts', () => {
  assert.strictEqual(
    slIsContactUrl('https://app.salesloft.com/app/cadences/4321/people/123456789'),
    true
  );
});

test('the People list is not a contact page', () => {
  for (const url of [
    'https://app.salesloft.com/app/people',
    'https://app.salesloft.com/app/people/',
    'https://app.salesloft.com/app/people/list',
    'https://app.salesloft.com/app/people/search',
    'https://app.salesloft.com/app/people/import',
  ]) {
    assert.strictEqual(slIsContactUrl(url), false, url);
  }
});

test('the rest of Salesloft is not a contact page', () => {
  for (const url of [
    'https://app.salesloft.com/app/dashboard',
    'https://app.salesloft.com/app/cadences',
    'https://app.salesloft.com/app/cadences/4321',
    'https://app.salesloft.com/app/accounts/8765',
    'https://app.salesloft.com/app/analytics/calls',
    'https://app.salesloft.com/app/settings/details',
    'https://app.salesloft.com/',
  ]) {
    assert.strictEqual(slIsContactUrl(url), false, url);
  }
});

test('a query string or fragment does not change the answer', () => {
  assert.strictEqual(
    slIsContactUrl('https://app.salesloft.com/app/people/123?tab=activity'),
    true
  );
  assert.strictEqual(slIsContactUrl('https://app.salesloft.com/app/people?page=2'), false);
});

test('a fragment route reads like a path', () => {
  assert.strictEqual(slIsContactUrl('https://app.salesloft.com/app#/people/123'), true);
  assert.strictEqual(slIsContactUrl('https://app.salesloft.com/app#/people'), false);
});

test('nothing usable is not a contact page', () => {
  for (const value of [undefined, null, '', 'not a url', 'about:blank']) {
    assert.strictEqual(slIsContactUrl(value), false, String(value));
  }
});

test('case in the route does not matter', () => {
  assert.strictEqual(slIsContactUrl('https://app.salesloft.com/app/People/123'), true);
  assert.strictEqual(slIsContactUrl('https://app.salesloft.com/app/People/List'), false);
});
