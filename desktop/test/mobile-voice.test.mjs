import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceReleaseAction } from '../lib/mobile-voice.mjs'

test('only a deliberate release inside the bottom target discards the draft', () => {
  const target = {left: 120, right: 270, top: 650, bottom: 710}
  const from = {x: 311, y: 430}
  assert.equal(voiceReleaseAction(from, from, target), 'draft')
  assert.equal(voiceReleaseAction(from, {x: 370, y: 430}, target), 'draft')
  assert.equal(voiceReleaseAction(from, {x: 150, y: 690}, target), 'cancel')
  assert.equal(voiceReleaseAction(from, {x: 150, y: 640}, target), 'draft')
  assert.equal(voiceReleaseAction({x: 250, y: 695}, {x: 245, y: 690}, target), 'draft')
})
