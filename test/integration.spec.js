import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as TodoReminder from '../index.js'

class ScriptedAdapter extends LlmAdapter {
  requests = []
  constructor(script, runtime) { super(); this.script = script; this.runtime = runtime }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    const entry = this.script.shift()
    const response = typeof entry === 'function' ? await entry(this.runtime) : entry
    assert.ok(response, 'Unexpected extra model request')
    const blocks = typeof response === 'string' ? [{ type: 'text', text: response }] : response
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const list = [{ content: 'Review implementation', status: 'in_progress' }, { content: 'Verify behavior', status: 'pending' }]

async function setup(t, script, config = {}, beforeStart = () => {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  // 0.2.1 owns native execution in Tools; 0.2.2 extracts it to a separate plugin.
  if (typeof ctx.tools.selectExecutor === 'function') {
    await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  ctx.tools.register({
    name: 'read_test', description: 'Read a fixture',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'Fixture',
  })
  const reminder = await ctx.plugin(TodoReminder, { staleAfterSteps: 2, repeatEverySteps: 2, ...config })
  const adapter = new ScriptedAdapter(script, { ctx, reminder })
  ctx.llm.registerAdapter(['test'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('todo-integration'), { provider: 'test', model: 'test' })
  await beforeStart({ ctx, agent })
  const idle = new Promise((resolve, reject) => {
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') resolve()
    })
    ctx.on('agent/error', ({ error }) => reject(error))
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review and verify' }], source: { kind: 'user' } }))
  await idle
  return { ctx, agent, adapter }
}

test('real loop records one reminder after two model responses despite parallel tool calls', { timeout: 15000 }, async t => {
  const batch = n => Array.from({ length: 5 }, (_, i) => call(`r-${n}-${i}`, 'read_test', {}))
  const { agent, adapter } = await setup(t, [
    [call('plan', 'todo_write', { todos: list })], batch(1), batch(2), 'Finished reviewing.',
  ])
  const log = agent.session.snapshotEvents()
  const reminders = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'todo-reminder')
  assert.equal(reminders.length, 1)
  assert.equal(adapter.requests.length, 4)
  assert.match(reminders[0].data.content[0].text, /2 assistant steps/)
  assert.ok(JSON.stringify(adapter.requests[3]).includes(reminders[0].data.id))
  const snapshots = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
  assert.ok(snapshots.some(event => JSON.stringify(event.data).includes('Review implementation')))
})

test('real rejected todo_write cannot hide unfinished tasks or postpone the reminder', { timeout: 15000 }, async t => {
  const duplicate = [{ content: 'same', status: 'completed' }, { content: 'same', status: 'completed' }]
  const { agent, adapter } = await setup(t, [
    [call('plan', 'todo_write', { todos: list })],
    [call('read', 'read_test', {})],
    [call('bad-plan', 'todo_write', { todos: duplicate })],
    'Waiting for review.',
  ])
  const log = agent.session.snapshotEvents()
  assert.equal(log.filter(event => event.type === 'todo/write').length, 1)
  assert.ok(log.some(event => event.type === 'tool/result' && event.data.message.isError))
  const reminder = log.find(event => event.type === 'user/message' && event.data.source.kind === 'todo-reminder')
  assert.ok(reminder)
  assert.match(reminder.data.content[0].text, /Verify behavior/)
  assert.equal(adapter.requests.length, 4)
})

test('unload and reload mid-turn preserve the real projection and register only one reminder', { timeout: 15000 }, async t => {
  const { agent } = await setup(t, [
    [call('plan', 'todo_write', { todos: list })],
    [call('read1', 'read_test', {})],
    async ({ ctx, reminder }) => {
      await reminder.dispose()
      await ctx.plugin(TodoReminder, { staleAfterSteps: 2, repeatEverySteps: 2 })
      return [call('read2', 'read_test', {})]
    },
    'Reviewed.',
  ])
  const reminders = agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'todo-reminder')
  assert.equal(reminders.length, 1)
  assert.match(reminders[0].data.content[0].text, /2 assistant steps/)
})

test('replacing a runtime snapshot restores current todos without resetting the reminder clock', { timeout: 15000 }, async t => {
  let replacementSeq
  const { agent, adapter } = await setup(t, [
    [call('plan', 'todo_write', { todos: list })],
    [call('read1', 'read_test', {})],
    [call('read2', 'read_test', {})],
    'Reviewed.',
  ], {}, ({ ctx, agent }) => {
    ctx.on('agent/pre-step', async ({ step }, next) => {
      if (step === 3) {
        const snapshot = agent.session.snapshotEvents().findLast(event =>
          event.type === 'user/message' && event.data.source.kind === 'runtime-context')
        assert.ok(snapshot)
        const summary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted context.' }] })
        replacementSeq = agent.session.append('user/message', summary, {
          surfaceOp: { op: 'replace', startSeq: snapshot.seq, endSeq: snapshot.seq },
          sourceEventSeqs: [snapshot.seq],
        }).seq
      }
      return next()
    })
  })
  const log = agent.session.snapshotEvents()
  assert.ok(log.some(event => event.seq > replacementSeq && event.type === 'user/message'
    && event.data.source.kind === 'runtime-context' && JSON.stringify(event.data).includes('Verify behavior')))
  assert.equal(log.filter(event => event.type === 'user/message' && event.data.source.kind === 'todo-reminder').length, 1)
  assert.equal(adapter.requests.length, 4)
})
