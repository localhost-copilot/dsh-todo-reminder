import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

const pending = [{ content: 'Review code', status: 'in_progress' }, { content: 'Verify fix', status: 'pending' }]
const message = (kind, text = 'input') => ({
  role: 'user', id: `${kind}-${text}`, source: { kind }, content: [{ type: 'text', text }],
})

async function harness(config = {}, history = []) {
  const listeners = new Map()
  const sessions = new WeakMap()
  let definition
  let context
  const ctx = {
    sessionProjections: {
      async register(unit) {
        definition = unit
        return {
          stateOf(session) {
            if (!sessions.has(session)) {
              sessions.set(session, session.events.reduce(unit.apply, unit.init()))
            }
            return sessions.get(session)
          },
        }
      },
    },
    systemPrompt: { context(value) { context = value } },
    on(event, listener) { listeners.set(event, listener) },
  }
  await apply(ctx, config)
  const agent = { session: { events: [...history] } }
  const controller = new AbortController()
  function append(type, data) {
    const event = { type, data }
    agent.session.events.push(event)
    if (sessions.has(agent.session)) {
      sessions.set(agent.session, definition.apply(sessions.get(agent.session), event))
    }
  }
  async function admit({ visible = true, messages = [], decision, commit = true } = {}) {
    const assemblyContext = { agent, toolSet: { view: () => new Map(visible ? [['todo_write', {}]] : []) } }
    context?.text(assemblyContext)
    await listeners.get('system-prompt/assemble')({}, assemblyContext, async () => ({}))
    const result = await listeners.get('agent/pre-step')({ agent, signal: controller.signal }, async () =>
      decision ?? { kind: 'enter', messages })
    if (commit && result.kind === 'enter') {
      for (const msg of result.messages) append('user/message', msg)
    }
    return result
  }
  function assistant(blocks = [{ type: 'tool-call', name: 'read' }]) {
    append('assistant/message', { message: { content: blocks } })
  }
  return { agent, append, admit, assistant, controller, context: () => context, definition: () => definition }
}

function reminders(decision) {
  return decision.messages.filter(msg => msg.source.kind === 'todo-reminder')
}

test('periodic reminders continue beyond the first thresholds and do not duplicate without another response', async () => {
  const h = await harness({ staleAfterSteps: 2, repeatEverySteps: 3 })
  h.append('todo/write', { todos: pending })
  const fired = []
  for (let step = 1; step <= 12; step++) {
    h.assistant()
    const result = await h.admit()
    if (reminders(result).length) fired.push(step)
    assert.equal(reminders(await h.admit()).length, 0)
  }
  assert.deepEqual(fired, [3, 6, 9, 12])
})

test('a rejected all-complete write neither erases the committed list nor resets its clock', async () => {
  const h = await harness({ staleAfterSteps: 2, repeatEverySteps: 2 })
  h.append('todo/write', { todos: pending })
  h.assistant()
  await h.admit()
  h.assistant([{ type: 'tool-call', name: 'todo_write' }])
  h.append('tool/call', { name: 'todo_write', arguments: { todos: [{ content: 'bad', status: 'completed' }] } })
  h.append('tool/result', { message: { isError: true } })
  const [reminder] = reminders(await h.admit())
  assert.match(reminder.content[0].text, /Review code/)
  assert.match(reminder.content[0].text, /2 assistant steps/)
})

test('parallel calls count once, reasoning-only responses and failed attempts do not count', async () => {
  const h = await harness({ staleAfterSteps: 2, repeatEverySteps: 2 })
  h.append('todo/write', { todos: pending })
  h.assistant(Array.from({ length: 20 }, () => ({ type: 'tool-call', name: 'read' })))
  for (let i = 0; i < 20; i++) h.append('tool/result', { message: {} })
  h.assistant([{ type: 'reasoning', text: 'Thinking' }])
  h.assistant([])
  h.append('assistant/attempt', { message: { content: [{ type: 'text', text: 'Failed stream' }] } })
  assert.equal(reminders(await h.admit()).length, 0)
  h.assistant()
  assert.equal(reminders(await h.admit()).length, 1)
})

test('user input gives a grace period; completed, cleared and new-turn lists stay silent', async () => {
  const h = await harness({ staleAfterSteps: 1, repeatEverySteps: 1 })
  assert.equal(reminders(await h.admit()).length, 0)
  h.append('todo/write', { todos: pending })
  h.assistant()
  assert.equal(reminders(await h.admit({ messages: [message('user')] })).length, 0)
  assert.equal(reminders(await h.admit()).length, 0)
  h.assistant()
  assert.equal(reminders(await h.admit()).length, 1)
  for (const todos of [pending.map(todo => ({ ...todo, status: 'completed' })), []]) {
    h.append('todo/write', { todos })
    h.assistant()
    assert.equal(reminders(await h.admit()).length, 0)
  }
  h.append('todo/write', { todos: pending })
  h.append('turn/start', { turn: 2 })
  h.assistant()
  assert.equal(reminders(await h.admit()).length, 0)
})

test('replay restores cooldown, and a restored pending reminder is not duplicated', async () => {
  const config = { staleAfterSteps: 2, repeatEverySteps: 2 }
  const original = await harness(config)
  original.append('todo/write', { todos: pending })
  original.assistant()
  original.assistant()
  const first = reminders(await original.admit())[0]
  original.assistant()
  const restored = await harness(config, original.agent.session.events)
  assert.equal(reminders(await restored.admit()).length, 0)
  restored.assistant()
  const result = await restored.admit({ messages: [first], commit: false })
  assert.deepEqual(result.messages, [first])
  const second = reminders(await restored.admit())[0]
  assert.notEqual(second.id, first.id)
})

test('respects tool admission, rejection, abort and downstream messages and request-series metadata', async () => {
  const h = await harness({ staleAfterSteps: 1, repeatEverySteps: 1 })
  h.append('todo/write', { todos: pending })
  h.assistant()
  assert.equal(reminders(await h.admit({ visible: false })).length, 0)
  const rejected = { kind: 'reject' }
  assert.equal(await h.admit({ decision: rejected }), rejected)
  const note = message('other-plugin')
  const result = await h.admit({ decision: { kind: 'enter', messages: [note], startsRequestSeries: true } })
  assert.equal(result.startsRequestSeries, true)
  assert.equal(result.messages[0], note)
  assert.equal(reminders(result).length, 1)
  h.assistant()
  h.controller.abort()
  assert.equal(reminders(await h.admit()).length, 0)
})

test('runtime snapshots survive admission refresh, quote literal content and bound large lists', async () => {
  const h = await harness()
  h.append('todo/write', { todos: Array.from({ length: 25 }, () => ({
    content: '{{provider}}\n' + 'x'.repeat(500), status: 'pending',
  })) })
  await h.admit()
  const provider = h.context()
  assert.equal(provider.interpolate, false)
  const text = provider.text({ agent: h.agent })
  assert.match(text, /\{\{provider\}\}\\n/)
  assert.match(text, /5 more unfinished items/)
  assert.ok(text.length < 6000)
  await h.admit({ visible: false })
  assert.equal(provider.text({ agent: h.agent }), '')
  h.append('todo/write', { todos: [] })
  await h.admit()
  assert.equal(provider.text({ agent: h.agent }), '')
})

test('disabling runtime snapshots keeps periodic reminders active', async () => {
  const h = await harness({ restoreContext: false, staleAfterSteps: 1, repeatEverySteps: 1 })
  h.append('todo/write', { todos: pending })
  h.assistant()
  assert.equal(h.context(), undefined)
  assert.equal(reminders(await h.admit()).length, 1)
})

test('checkpoint round-trip plus suffix replay agrees with full replay', async () => {
  const h = await harness()
  const p = h.definition()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'todo/write', data: { todos: pending } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working' }] } } },
    { type: 'user/message', data: message('todo-reminder') },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read' }] } } },
  ]
  const checkpoint = p.stateSchema.parse(JSON.parse(JSON.stringify(events.slice(0, 3).reduce(p.apply, p.init()))))
  assert.deepEqual(events.slice(3).reduce(p.apply, checkpoint), events.reduce(p.apply, p.init()))
})

test('compaction replacement copies neither advance the clock nor reset the grace period', async () => {
  const h = await harness()
  const p = h.definition()
  const before = { todos: pending, stepsSinceWrite: 8, stepsSinceReminder: 5 }
  for (const event of [
    { type: 'user/message', data: message('user') },
    { type: 'user/message', data: message('todo-reminder') },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Summary' }] } } },
  ]) {
    assert.equal(p.apply(before, { ...event, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 } }), before)
  }
})

test('invalid clock settings fail before registration', async () => {
  for (const config of [{ staleAfterSteps: 0 }, { repeatEverySteps: 1.5 }, { staleAfterSteps: Infinity }, { restoreContext: 'yes' }]) {
    await assert.rejects(apply({}, config), /dsh-todo/)
  }
})
