// test/validation.test.js — pure logic, no mocking needed.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail, isValidPassword, isValidProfileName, MIN_PASSWORD_LENGTH } from '../core/validation.js';

test('isValidEmail', async (t) => {
  await t.test('normal email is valid', () => {
    assert.equal(isValidEmail('user@example.com'), true);
  });

  await t.test('missing @ is invalid', () => {
    assert.equal(isValidEmail('userexample.com'), false);
  });

  await t.test('missing domain is invalid', () => {
    assert.equal(isValidEmail('user@'), false);
  });

  await t.test('missing TLD is invalid', () => {
    assert.equal(isValidEmail('user@example'), false);
  });

  await t.test('whitespace-only is invalid', () => {
    assert.equal(isValidEmail('   '), false);
  });

  await t.test('non-string input is invalid', () => {
    assert.equal(isValidEmail(undefined), false);
    assert.equal(isValidEmail(null), false);
  });
});

test('isValidPassword', async (t) => {
  await t.test(`password at exactly ${MIN_PASSWORD_LENGTH} chars is valid`, () => {
    assert.equal(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH)), true);
  });

  await t.test('password one under the minimum is invalid', () => {
    assert.equal(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)), false);
  });

  await t.test('empty string is invalid', () => {
    assert.equal(isValidPassword(''), false);
  });

  await t.test('non-string input is invalid', () => {
    assert.equal(isValidPassword(undefined), false);
  });
});

test('isValidProfileName', async (t) => {
  await t.test('normal name is valid', () => {
    assert.equal(isValidProfileName('Deep Work'), true);
  });

  await t.test('empty string is invalid', () => {
    assert.equal(isValidProfileName(''), false);
  });

  await t.test('whitespace-only is invalid', () => {
    assert.equal(isValidProfileName('   '), false);
  });

  await t.test('name over 40 chars is invalid', () => {
    assert.equal(isValidProfileName('a'.repeat(41)), false);
  });

  await t.test('name at exactly 40 chars is valid', () => {
    assert.equal(isValidProfileName('a'.repeat(40)), true);
  });

  await t.test('non-string input is invalid', () => {
    assert.equal(isValidProfileName(undefined), false);
  });
});
