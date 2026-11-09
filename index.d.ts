import type { Context } from '@deepseek-ai/cordis'

export declare const name: 'todo-reminder'
export declare const inject: string[]

export interface Config {
  /** Non-reasoning assistant steps without a successful todo update before reminding. Default: 10. */
  staleAfterSteps?: number
  /** Minimum assistant steps between delivered reminders. Also applies to the first reminder. Default: 10. */
  repeatEverySteps?: number
  /** Include a bounded current-list snapshot through DSH's durable runtime context. Default: true. */
  restoreContext?: boolean
}

/** Requires the DSH session-projection and system-prompt services and the existing todo_write tool. */
export declare function apply(ctx: Context, config?: Config): Promise<void>
