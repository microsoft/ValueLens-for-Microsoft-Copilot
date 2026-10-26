import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCounts, EMPTY_INTERACTIONS, loadMessage, NO_INTERACTIONS } from '../src/data/loadCheck.ts'

test('an upload without an interactions file is rejected', () => {
  assert.throws(() => checkCounts({ users: 10 }), { message: NO_INTERACTIONS })
})

test('a headers-only interactions file is rejected so the current data stays', () => {
  assert.throws(() => checkCounts({ interactions: 0, users: 10 }), { message: EMPTY_INTERACTIONS })
})

test('an interactions file with rows is accepted', () => {
  assert.doesNotThrow(() => checkCounts({ interactions: 1 }))
})

test('all four files loaded', () => {
  assert.equal(
    loadMessage({ interactions: 5, users: 3, agents: 2, feedback: 1 }),
    'Loaded Copilot interactions, Organisation and licences, Agent 365 registry, Product feedback.',
  )
})

test('missing optional files are listed as not found', () => {
  assert.equal(
    loadMessage({ interactions: 5, users: 3 }),
    'Loaded Copilot interactions, Organisation and licences. Not found: Agent 365 registry, Product feedback. Related measures will be blank.',
  )
})

test('a headers-only optional file says it has 0 rows', () => {
  assert.equal(
    loadMessage({ interactions: 5, users: 0, agents: 2, feedback: 1 }),
    'Loaded Copilot interactions, Agent 365 registry, Product feedback. Organisation and licences has 0 rows. Related measures will be blank.',
  )
  assert.equal(
    loadMessage({ interactions: 5, agents: 0, feedback: 0 }),
    'Loaded Copilot interactions. Agent 365 registry, Product feedback have 0 rows. Not found: Organisation and licences. Related measures will be blank.',
  )
})
