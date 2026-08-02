import { Workflow } from 'lucide-react'
import { isVideoModelType, type ModelType, } from '../../api/comfyui'
import { useWorkflowStore } from '../../stores/workflowStore'
import { Select } from './ui/Select'

interface Props {
  modelName: string
  modelType: ModelType
}

export function WorkflowFinder({
  modelName,
  modelType,
}: Props) {
  const {
    workflowTags,
    getWorkflowForModel,
    getMatchingWorkflows,
    assignToModelName,
    unassignModelName,
    unassignModelType,
  } = useWorkflowStore()

  const mode = isVideoModelType(modelType)
    ? 'video'
    : 'image'

  const matchingWorkflows = getMatchingWorkflows(
    modelName,
    mode,
  )

  const activeWorkflow = getWorkflowForModel(
    modelName,
    modelType,
  )

  const selectedWorkflow =
    activeWorkflow &&
    matchingWorkflows.some(
      (workflow) => workflow.id === activeWorkflow.id,
    )
      ? activeWorkflow
      : null

  const handleSelection = (
    workflowId: string,
  ) => {
    if (!workflowId) {
      unassignModelName(modelName)
      unassignModelType(modelType)
      return
    }

    // A specific model selection should take priority over any legacy
    // model-type-wide assignment.
    unassignModelType(modelType)
    assignToModelName(modelName, workflowId)
  }

  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        <Workflow size={12} />
        Workflow
      </label>

            {matchingWorkflows.length > 0 ? (
        <Select
          value={selectedWorkflow?.id ?? ''}
          onChange={handleSelection}
          placeholder="Auto"
          maxHeight={240}
          options={[
            {
              value: '',
              label: 'Auto',
              sublabel: 'Use the built-in workflow',
            },
            ...matchingWorkflows.map((workflow) => ({
              value: workflow.id,
              label: workflow.name,
              sublabel:
                workflow.mode === 'both'
                  ? 'Image + Video'
                  : workflow.mode === 'video'
                    ? 'Video'
                    : 'Image',
              badge: {
                label: workflow.mode.toUpperCase(),
                color:
                  'bg-violet-500/15 text-violet-300',
              },
            })),
          ]}
        />
      ) : (
        <div className="flex h-[var(--control-h-md)] w-full items-center rounded-[var(--radius-control)] border border-white/[0.08] bg-white/[0.04] px-2.5 text-sm text-gray-500">
          No tagged workflows available
        </div>
      )}

      {matchingWorkflows.length === 0 ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-gray-500">
          Assign matching tags to this model and a workflow in Tags &amp; Workflows.
        </p>
      ) : selectedWorkflow ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {(workflowTags[selectedWorkflow.id] ?? []).map(
            (tagId) => (
              <span
                key={tagId}
                className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-300"
              >
                {
                  useWorkflowStore
                    .getState()
                    .tags.find(
                      (tag) => tag.id === tagId,
                    )?.name
                }
              </span>
            ),
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-[10px] text-gray-500">
          {matchingWorkflows.length} compatible{' '}
          {matchingWorkflows.length === 1
            ? 'workflow'
            : 'workflows'}{' '}
          available
        </p>
      )}
    </div>
  )
}