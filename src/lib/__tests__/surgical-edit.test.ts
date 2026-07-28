import { describe, it, expect } from 'vitest'
import { applyUniqueEdit, countOccurrences } from '../surgical-edit'

describe('surgical-edit — countOccurrences', () => {
  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('a.b.c', '.')).toBe(2)
    expect(countOccurrences('aaaa', 'aa')).toBe(2) // non-overlapping
    expect(countOccurrences('hello', 'x')).toBe(0)
    expect(countOccurrences('anything', '')).toBe(0)
  })
})

describe('surgical-edit — applyUniqueEdit', () => {
  const file = `function greet(name) {\n  return "hi " + name\n}\n`

  it('replaces a unique match', () => {
    const r = applyUniqueEdit(file, 'return "hi " + name', 'return `hi ${name}`')
    expect(r.ok).toBe(true)
    expect(r.matches).toBe(1)
    expect(r.content).toContain('return `hi ${name}`')
    expect(r.content).not.toContain('"hi "')
  })

  it('refuses when old_string is not found', () => {
    const r = applyUniqueEdit(file, 'return "bye"', 'x')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
    expect(r.matches).toBe(0)
  })

  it('refuses an ambiguous (non-unique) match', () => {
    const dup = 'const x = 1\nconst x = 1\n'
    const r = applyUniqueEdit(dup, 'const x = 1', 'const x = 2')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_unique')
    expect(r.matches).toBe(2)
  })

  it('refuses an empty old_string', () => {
    const r = applyUniqueEdit(file, '', 'x')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('empty_old')
  })

  it('refuses a no-op (old === new)', () => {
    const r = applyUniqueEdit(file, 'greet', 'greet')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('noop')
  })

  it('inserts $ sequences literally (no capture-group interpretation)', () => {
    const r = applyUniqueEdit('price = TODO', 'TODO', '"$5.00 ($$ each)"')
    expect(r.ok).toBe(true)
    expect(r.content).toBe('price = "$5.00 ($$ each)"')
  })

  it('handles multiline old_string', () => {
    const r = applyUniqueEdit(file, '{\n  return "hi " + name\n}', '{\n  return name.toUpperCase()\n}')
    expect(r.ok).toBe(true)
    expect(r.content).toContain('name.toUpperCase()')
  })
})
