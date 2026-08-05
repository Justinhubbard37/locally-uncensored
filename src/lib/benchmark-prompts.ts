/**
 * Standardized benchmark prompts for local model testing.
 *
 * A benchmark that only times tokens hides the difference that matters. David
 * ran a 9B DeepSeek-V4-Flash-Distill against a 9B Qwen3.5, same quant, same
 * settings: 44 vs 41 tok/s, so a speed-only board would call it a tie. The real
 * gap was economy and correctness. Over eight tasks the distill spent 5480
 * tokens where the base model spent 8975 for the same answers, and on one
 * reasoning task the base model ran into its token budget with the right answer
 * still sitting in its reasoning, so it never wrote it out. So every prompt now
 * carries a check that reads the ANSWER, not the hidden reasoning, and every
 * run records how much of its output went into thinking and why it stopped.
 */

export interface BenchmarkPrompt {
  id: string
  name: string
  category: 'speed' | 'reasoning' | 'code'
  prompt: string
  /**
   * Passes when the model's answer (its visible output, not its `thinking`)
   * carries the expected result. A run that spends its whole token budget
   * reasoning and never states the answer fails here even though the reasoning
   * was right, which is exactly the failure a speed-only benchmark cannot see.
   */
  check: (answer: string) => boolean
}

/** Every integer in the text, in order of appearance. */
function numbersIn(text: string): number[] {
  return (text.match(/-?\d+/g) ?? []).map(Number)
}

/** 1 to 50 on their own lines: a truncated or lazy answer drops the ends. */
function checkSpeed(answer: string): boolean {
  const seen = new Set(numbersIn(answer))
  return seen.has(1) && seen.has(25) && seen.has(50)
}

/**
 * 17 sheep, "all but 9 run away", so 9 stay. 8 is the classic 17 minus 9 slip,
 * and a run that spent its budget thinking states no number at all. The answer
 * is right when its last number is 9, with a word fallback for models that
 * spell it out.
 */
function checkReasoning(answer: string): boolean {
  const nums = numbersIn(answer)
  if (nums.length > 0 && nums[nums.length - 1] === 9) return true
  return /\bnine\b/i.test(answer) && !/\beight\b/i.test(answer)
}

/** A function named fibonacci is the thing that was asked for. */
function checkCode(answer: string): boolean {
  return /def\s+fibonacci\s*\(/i.test(answer)
}

export const BENCHMARK_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'speed',
    name: 'Speed Test',
    category: 'speed',
    prompt: 'List the numbers from 1 to 50, each on a new line. Just the numbers, nothing else.',
    check: checkSpeed,
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    category: 'reasoning',
    prompt: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning step by step.',
    check: checkReasoning,
  },
  {
    id: 'code',
    name: 'Code Generation',
    category: 'code',
    prompt: 'Write a Python function called `fibonacci` that returns the nth Fibonacci number using dynamic programming. Include a docstring.',
    check: checkCode,
  },
]

export interface BenchmarkResult {
  modelName: string
  promptId: string
  tokensPerSec: number
  timeToFirstToken: number
  totalTime: number
  /** Whole output, thinking included, so a reasoning model and a terse one are
   *  measured on the same axis. */
  totalTokens: number
  /** Reasoning tokens (Ollama `thinking` / `<think>`). 0 for a model that does
   *  not think out loud. Undefined on runs recorded before 2.6.3. */
  thinkTokens?: number
  /** Why generation ended: 'stop' | 'length' | 'disconnect'. A 'length' run is
   *  truncated, so its token count is a floor and its answer may be cut off.
   *  Undefined on runs recorded before 2.6.3. */
  finishReason?: string
  /** Did the answer match the prompt's expected result. Undefined pre-2.6.3. */
  correct?: boolean
  timestamp: number
}
