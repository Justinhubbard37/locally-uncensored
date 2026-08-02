import type { WorkflowTag } from '../../types/workflows'

interface Props {
  tags: WorkflowTag[]
  selectedIds: string[]
  onChange: (tagIds: string[]) => void
  emptyLabel?: string
}

export function TagPicker({
  tags,
  selectedIds,
  onChange,
  emptyLabel = 'Create a tag first',
}: Props) {
  const selected = new Set(selectedIds)

  const toggleTag = (tagId: string) => {
    if (selected.has(tagId)) {
      onChange(selectedIds.filter((id) => id !== tagId))
      return
    }

    onChange([...selectedIds, tagId])
  }

  if (tags.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-500">
        {emptyLabel}
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const active = selected.has(tag.id)

        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => toggleTag(tag.id)}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              active
                ? 'border-violet-500/50 bg-violet-500/20 text-violet-700 dark:text-violet-200'
                : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-800 dark:border-white/10 dark:bg-white/5 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white'
            }`}
          >
            {tag.name}
          </button>
        )
      })}
    </div>
  )
}