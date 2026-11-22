import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceReleaseAction } from '../lib/mobile-voice.mjs'

test('voice gesture only cancels or previews beyond intentional drag thresholds', () => {
  assert.equal(voiceReleaseAction(-44, 0), 'draft')
  assert.equal(voiceReleaseAction(-45, 0), 'cancel')
  assert.equal(voiceReleaseAction(0, -73), 'cancel')
  assert.equal(voiceReleaseAction(60, -100), 'preview')
  assert.equal(voiceReleaseAction(42, 3), 'draft')
  assert.equal(voiceReleaseAction(43, 3), 'preview')
})
