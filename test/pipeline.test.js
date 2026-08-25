import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePosition, positionGroup } from '../lib/pipeline.js';

test('translatePosition translates known positions to Russian', () => {
  assert.equal(translatePosition('Centre-Back'), 'Центральный защитник');
  assert.equal(translatePosition('Goalkeeper'), 'Вратарь');
  assert.equal(translatePosition('Right Winger'), 'Правый вингер');
});

test('translatePosition falls back to the original value for unknown positions', () => {
  assert.equal(translatePosition('Sweeper'), 'Sweeper');
});

test('translatePosition returns em dash for empty input', () => {
  assert.equal(translatePosition(''), '—');
  assert.equal(translatePosition(null), '—');
});

test('positionGroup buckets translated positions correctly', () => {
  assert.equal(positionGroup('Вратарь'), 'GK');
  assert.equal(positionGroup('Центральный защитник'), 'DF');
  assert.equal(positionGroup('Опорный полузащитник'), 'MF');
  assert.equal(positionGroup('Нападающий'), 'FW');
});

test('positionGroup returns other for empty or unrecognized input', () => {
  assert.equal(positionGroup(''), 'other');
  assert.equal(positionGroup(null), 'other');
});
