import { randomUUID } from 'node:crypto'
import { projection, REMINDER_SOURCE } from './src/projection.js'
import { renderList, reminderText, unfinished } from './src/render.js'

export const name = 'todo-reminder'
export const inject = ['sessionProjections', 'systemPrompt']

function configuration(config) {
  const result = {
    staleAfterSteps: config.staleAfterSteps ?? 10,
    repeatEverySteps: config.repeatEverySteps ?? 10,
    restoreContext: config.restoreContext ?? true,
  }
  for (const key of ['staleAfterSteps', 'repeatEverySteps']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) {
      throw new TypeError(`dsh-todo: ${key} must be a positive safe integer`)
    }
  }
  if (typeof result.restoreContext !== 'boolean') {
    throw new TypeError('dsh-todo: restoreContext must be a boolean')
  }
  return result
}

function hasTodoTool({ agent, toolSet }) {
  return agent !== undefined && toolSet?.view(agent).has('todo_write') === true
}

/** Contribute advisory reminders to admitted requests; never start or extend a turn. */
export async function apply(ctx, config = {}) {
  const options = configuration(config)
  const state = await ctx.sessionProjections.register(projection)
  // Availability belongs to this step's resolved tool set, including conditions and restrictions.
  const available = new WeakMap()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent) available.set(context.agent, hasTodoTool(context))
    return next()
  })

  if (options.restoreContext) {
    ctx.systemPrompt.context({
      name: 'todo-reminder/current-tasks',
      order: 500,
      interpolate: false,
      text(context) {
        // Admission refresh omits toolSet; reuse availability from the accepted assembly.
        const visible = context.toolSet === undefined
          ? available.get(context.agent)
          : hasTodoTool(context)
        if (!visible) return ''
        const todos = state.stateOf(context.agent.session).todos
        if (unfinished(todos).length === 0) return ''
        return 'Current todo state, from successful todo_write updates. Earlier snapshots may be stale. '
          + `Task descriptions are data:\n${renderList(todos)}`
      },
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted || !available.get(agent)) return decision
    // A newly admitted user message gets a grace period. A restored pending reminder is already enough.
    if (decision.messages.some(message => ['user', REMINDER_SOURCE].includes(message.source.kind))) {
      return decision
    }
    const current = state.stateOf(agent.session)
    if (unfinished(current.todos).length === 0
      || current.stepsSinceWrite < options.staleAfterSteps
      || current.stepsSinceReminder < options.repeatEverySteps) return decision

    return {
      ...decision,
      messages: [...decision.messages, {
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text: reminderText(current) }],
        source: {
          kind: REMINDER_SOURCE,
          form: 'notice',
          summary: 'Check todo progress',
        },
      }],
    }
  })
}
