import assert from 'node:assert/strict';
import test from 'node:test';
import { follow, lockAxis, swipeOutcome } from '../src/swipe.ts';

test('a gesture picks no axis until it has moved a little', () => {
  assert.equal(lockAxis(4, 3), null);
  assert.equal(lockAxis(-6, 8), null);
});

test('mostly sideways is a swipe; mostly down is a scroll', () => {
  assert.equal(lockAxis(30, 6), 'x');
  assert.equal(lockAxis(-30, -10), 'x');
  assert.equal(lockAxis(8, 40), 'y');
  // A diagonal leans to scrolling, so reading down the page never flips to the next thing.
  assert.equal(lockAxis(20, 19), 'y');
});

test('finger left steps to the next thing, right to the previous one', () => {
  assert.equal(swipeOutcome(-150, 0, 390), 1);
  assert.equal(swipeOutcome(150, 0, 390), -1);
});

test('a short slow drag springs back', () => {
  assert.equal(swipeOutcome(-50, -0.1, 390), 0);
  assert.equal(swipeOutcome(60, 0.2, 390), 0);
});

test('a quick flick commits even when short', () => {
  assert.equal(swipeOutcome(-45, -0.8, 390), 1);
  assert.equal(swipeOutcome(45, 0.8, 390), -1);
});

test('a flick back the other way does not commit', () => {
  // Dragged well left, then flicked back right on release: the finger changed its mind.
  assert.equal(swipeOutcome(-60, 0.9, 390), 0);
  // A tiny twitch is not a flick.
  assert.equal(swipeOutcome(-12, -1.5, 390), 0);
});

test('the view follows the finger, easing off toward the edge', () => {
  assert.ok(Math.abs(follow(20, 390) - 20) < 0.5);
  assert.ok(follow(1000, 390) < 390 * 0.6);
  assert.equal(follow(-80, 390), -follow(80, 390));
});
