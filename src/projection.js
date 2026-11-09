import { z } from 'zod'

export const REMINDER_SOURCE = 'todo-reminder'

const todoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

const stateSchema = z.object({
  todos: z.array(todoSchema).nullable(),
  stepsSinceWrite: z.number().int().nonnegative(),
  stepsSinceReminder: z.number().int().nonnegative(),
})

function initialState() {
  return { todos: null, stepsSinceWrite: 0, stepsSinceReminder: 0 }
}

/** Replay only committed events; attempted or rejected tool inputs have no effect. */
function reduce(state, event) {
  // Compaction/replacement copies are context operations, not new model steps or user input.
  if ((event.type === 'assistant/message' || event.type === 'user/message')
    && typeof event.surfaceOp === 'object') return state
  switch (event.type) {
    case 'turn/start':
      return initialState()
    case 'todo/write':
      return { ...state, todos: event.data.todos, stepsSinceWrite: 0 }
    case 'assistant/message': {
      const blocks = event.data.message.content
      // Reasoning-only and empty responses do not advance the reminder clock.
      if (!blocks.some(block => block.type !== 'reasoning')) return state
      return {
        ...state,
        stepsSinceWrite: state.stepsSinceWrite + 1,
        stepsSinceReminder: state.stepsSinceReminder + 1,
      }
    }
    case 'user/message':
      if (event.data.source.kind === 'user') {
        return { ...state, stepsSinceWrite: 0, stepsSinceReminder: 0 }
      }
      if (event.data.source.kind === REMINDER_SOURCE) {
        return { ...state, stepsSinceReminder: 0 }
      }
      return state
    default:
      return state
  }
}

/** Host-only, checkpointable derived state; the todo tool remains the sole writer. */
export const projection = {
  key: 'localhost-copilot/todo-reminder',
  stateVersion: 1,
  stateSchema,
  init: initialState,
  apply: reduce,
}
