import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceGestureAction, voiceReleaseAction } from '../lib/mobile-voice.mjs'

test('only a deliberate release inside the bottom target discards the draft', () => {
  const target = {left: 120, right: 270, top: 650, bottom: 710}
  const from = {x: 311, y: 430}
  assert.equal(voiceReleaseAction(from, from, target), 'draft')
  assert.equal(voiceReleaseAction(from, {x: 370, y: 430}, target), 'draft')
  assert.equal(voiceReleaseAction(from, {x: 150, y: 690}, target), 'cancel')
  assert.equal(voiceReleaseAction(from, {x: 150, y: 640}, target), 'draft')
  assert.equal(voiceReleaseAction({x: 250, y: 695}, {x: 245, y: 690}, target), 'draft')
})

test('WeChat slide-up gesture cancels when sliding above the bottom dock and restores draft on return', () => {
  const target = {left: 141, right: 251, top: 586, bottom: 670}
  const micOrigin = {x: 311, y: 710}
  assert.equal(voiceGestureAction(micOrigin, micOrigin, target), 'draft')
  assert.equal(voiceGestureAction(micOrigin, {x: 345, y: 706}, target), 'draft')
  // Dragging directly into the cancel orb (with touch tolerance) cancels.
  assert.equal(voiceGestureAction(micOrigin, {x: 196, y: 620}, target), 'cancel')
  assert.equal(voiceGestureAction(micOrigin, {x: 132, y: 620}, target), 'cancel')
  // Sliding straight up out of the composer bar cancels without needing to hit the center horizontally.
  assert.equal(voiceGestureAction(micOrigin, {x: 310, y: 540}, target), 'cancel')
  // Sliding back down into the bottom arc restores draft mode.
  assert.equal(voiceGestureAction(micOrigin, {x: 300, y: 705}, target), 'draft')
})

test('WeChat 3-zone gesture handles right edit wing and bottom return to draft', () => {
  const cancelTarget = {left: 0, right: 170, top: 550, bottom: 622}
  const editTarget = {left: 223, right: 393, top: 550, bottom: 622}
  const micOrigin = {x: 311, y: 710}
  assert.equal(voiceGestureAction(micOrigin, {x: 80, y: 586}, cancelTarget, { editTarget }), 'cancel')
  assert.equal(voiceGestureAction(micOrigin, {x: 310, y: 586}, cancelTarget, { editTarget }), 'edit')
  assert.equal(voiceGestureAction(micOrigin, {x: 310, y: 530}, cancelTarget, { editTarget }), 'edit')
  assert.equal(voiceGestureAction(micOrigin, {x: 70, y: 530}, cancelTarget, { editTarget }), 'cancel')
  assert.equal(voiceGestureAction(micOrigin, {x: 300, y: 705}, cancelTarget, { editTarget }), 'draft')
})
