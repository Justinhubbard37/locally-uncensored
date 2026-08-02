import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  FileJson,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { parseImportedWorkflow, validateWorkflowJson } from '../../api/workflows'
import { useModels } from '../../hooks/useModels'
import {
  useWorkflowStore,
  workflowModelKey,
  type WorkflowTagMode,
} from '../../stores/workflowStore'
import { TagPicker } from './TagPicker'

type PageTab = 'workflows' | 'models' | 'tags'
type ModelFilter = 'all' | WorkflowTagMode

const tabs: Array<{
  id: PageTab
  label: string
}> = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'models', label: 'Models' },
  { id: 'tags', label: 'Tags' },
]

export function TagsAndWorkflowsPage() {
  const [activeTab, setActiveTab] = useState<PageTab>('workflows')

  const {
    installedWorkflows,
    tags,
    workflowTags,
    modelTags,
    installWorkflow,
    removeWorkflow,
    createTag,
    renameTag,
    deleteTag,
    setWorkflowTags,
    setModelTags,
  } = useWorkflowStore()

  const {
    models,
    fetchModels,
  } = useModels()

// Populate installed ComfyUI models when this page is opened instead of
// relying on the separate Models page to perform the first refresh.
useEffect(() => {
  fetchModels().catch(() => {})
}, [fetchModels])

  const [importName, setImportName] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [newTagName, setNewTagName] = useState('')
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  const [editingTagName, setEditingTagName] = useState('')

  const [modelSearch, setModelSearch] = useState('')
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all')

  const comfyModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()

    return models
      .filter((model) => {
        if (model.type !== 'image' && model.type !== 'video') {
          return false
        }

        if (model.providerName !== 'ComfyUI') {
          return false
        }

        if (modelFilter !== 'all' && model.type !== modelFilter) {
          return false
        }

        if (query && !model.name.toLowerCase().includes(query)) {
          return false
        }

        return true
      })
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type.localeCompare(right.type)
        }

        return left.name.localeCompare(right.name)
      })
  }, [models, modelFilter, modelSearch])

  const importWorkflowJson = (
    rawText: string,
    suggestedName?: string,
  ) => {
    setImportError(null)
    setImportSuccess(null)

    try {
      const json = JSON.parse(rawText)

      if (!validateWorkflowJson(json)) {
        setImportError(
          'Invalid workflow. Export it from ComfyUI using Save (API Format).',
        )
        return
      }

      const name =
        importName.trim() ||
        suggestedName?.trim() ||
        'Imported Workflow'

      const parsed = parseImportedWorkflow(
        name,
        json,
        'manual',
      )

      // Re-importing a workflow with the same name updates it in place. Keeping
      // the existing ID also keeps any tags already assigned to that workflow.
      const existing = installedWorkflows.find(
        (workflow) =>
          workflow.source === 'manual' &&
          workflow.name.toLowerCase() === name.toLowerCase(),
      )

      installWorkflow({
        ...parsed,
        id: existing?.id ?? uuid(),
        installedAt: existing?.installedAt ?? Date.now(),
      })

      setImportName('')
      setImportJson('')
      setImportSuccess(
        existing
          ? `Updated "${name}".`
          : `Installed "${name}".`,
      )
    } catch (error) {
      setImportError(
        error instanceof SyntaxError
          ? 'The selected file does not contain valid JSON.'
          : `Import failed: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
      )
    }
  }

  const handleFileImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const suggestedName = file.name.replace(/\.json$/i, '')

      importWorkflowJson(text, suggestedName)
    } catch (error) {
      setImportError(
        `Could not read file: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      )
    } finally {
      event.target.value = ''
    }
  }

  const handleCreateTag = () => {
    const id = createTag(newTagName)

    if (id) {
      setNewTagName('')
    }
  }

  const beginRenameTag = (
    tagId: string,
    currentName: string,
  ) => {
    setEditingTagId(tagId)
    setEditingTagName(currentName)
  }

  const finishRenameTag = () => {
    if (!editingTagId) {
      return
    }

    renameTag(editingTagId, editingTagName)
    setEditingTagId(null)
    setEditingTagName('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-gray-200 px-6 py-5 dark:border-white/10">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-500/10 p-2.5 text-violet-600 dark:text-violet-300">
            <Tags size={22} />
          </div>

          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
              Tags &amp; Workflows
            </h1>

            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              Install ComfyUI workflows and match them to models using reusable tags.
            </p>
          </div>
        </div>

        <div className="mt-5 flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-white/5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white'
                  : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {activeTab === 'workflows' && (
          <div className="mx-auto max-w-5xl space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-white/10 dark:bg-white/[0.025]">
              <div className="flex items-center gap-2">
                <Upload size={17} className="text-violet-500" />
                <h2 className="font-semibold text-gray-900 dark:text-white">
                  Install workflow
                </h2>
              </div>

              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Import a ComfyUI API-format JSON file. Editable graph exports are not supported.
              </p>

              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  value={importName}
                  onChange={(event) => setImportName(event.target.value)}
                  placeholder="Workflow name (optional)"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileImport}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
                >
                  <FileJson size={16} />
                  Choose API JSON
                </button>
              </div>

              <div className="mt-3">
                <textarea
                  value={importJson}
                  onChange={(event) => setImportJson(event.target.value)}
                  placeholder='Or paste API JSON here: {"1":{"class_type":"KSampler",...}}'
                  className="h-32 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-900 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />

                <button
                  type="button"
                  disabled={!importJson.trim()}
                  onClick={() => importWorkflowJson(importJson)}
                  className="mt-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  Install pasted workflow
                </button>
              </div>

              {importError && (
                <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                  {importError}
                </div>
              )}

              {importSuccess && (
                <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  {importSuccess}
                </div>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2">
                <Workflow size={17} />
                <h2 className="font-semibold text-gray-900 dark:text-white">
                  Installed workflows
                </h2>

                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-white/5 dark:text-gray-400">
                  {installedWorkflows.length}
                </span>
              </div>

              {installedWorkflows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-white/15">
                  <Workflow
                    size={28}
                    className="mx-auto text-gray-400"
                  />

                  <p className="mt-3 text-sm text-gray-500">
                    No workflows are installed yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {installedWorkflows.map((workflow) => (
                    <article
                      key={workflow.id}
                      className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.025]"
                    >
                      <div className="flex gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate font-medium text-gray-900 dark:text-white">
                              {workflow.name}
                            </h3>

                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-white/5 dark:text-gray-400">
                              {workflow.mode}
                            </span>

                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-white/5 dark:text-gray-400">
                              {workflow.source}
                            </span>
                          </div>

                          {workflow.description && (
                            <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                              {workflow.description}
                            </p>
                          )}

                          <div className="mt-3">
                            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                              Compatibility tags
                            </p>

                            <TagPicker
                              tags={tags}
                              selectedIds={workflowTags[workflow.id] ?? []}
                              onChange={(tagIds) =>
                                setWorkflowTags(
                                  workflow.id,
                                  tagIds,
                                )
                              }
                            />
                          </div>
                        </div>

                        <button
                          type="button"
                          title="Remove workflow"
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Remove "${workflow.name}"?`,
                            )

                            if (confirmed) {
                              removeWorkflow(workflow.id)
                            }
                          }}
                          className="self-start rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-500"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'models' && (
          <div className="mx-auto max-w-5xl space-y-4">
            <div className="flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />

                <input
                  value={modelSearch}
                  onChange={(event) =>
                    setModelSearch(event.target.value)
                  }
                  placeholder="Search installed models"
                  className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
              </div>

              <div className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/5">
                {(['all', 'image', 'video'] as ModelFilter[]).map(
                  (filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setModelFilter(filter)}
                      className={`rounded-md px-3 py-1.5 text-xs capitalize transition-colors ${
                        modelFilter === filter
                          ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {filter}
                    </button>
                  ),
                )}
              </div>

              <button
                type="button"
                onClick={() => void fetchModels()}
                className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>

            {comfyModels.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-white/15">
                <p className="text-sm text-gray-500">
                  No matching ComfyUI image or video models were found.
                </p>

                <p className="mt-1 text-xs text-gray-400">
                  Make sure ComfyUI is running, then press Refresh.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {comfyModels.map((model) => {
                  const mode = model.type as WorkflowTagMode
                  const key = workflowModelKey(
                    model.name,
                    mode,
                  )

                  return (
                    <article
                      key={key}
                      className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.025]"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 flex-1 break-all font-medium text-gray-900 dark:text-white">
                          {model.name}
                        </h3>

                        <span className="rounded bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase text-gray-500 dark:bg-white/5 dark:text-gray-400">
                          {mode}
                        </span>
                      </div>

                      <div className="mt-3">
                        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">
                          Model tags
                        </p>

                        <TagPicker
                          tags={tags}
                          selectedIds={modelTags[key] ?? []}
                          onChange={(tagIds) =>
                            setModelTags(
                              model.name,
                              mode,
                              tagIds,
                            )
                          }
                        />
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'tags' && (
          <div className="mx-auto max-w-3xl">
            <div className="flex gap-2">
              <input
                value={newTagName}
                onChange={(event) =>
                  setNewTagName(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateTag()
                  }
                }}
                placeholder="New tag, for example Wan 2.2"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-white/5 dark:text-white"
              />

              <button
                type="button"
                disabled={!newTagName.trim()}
                onClick={handleCreateTag}
                className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
              >
                <Plus size={16} />
                Create tag
              </button>
            </div>

            <div className="mt-5 space-y-2">
              {tags.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-white/15">
                  <Tags
                    size={28}
                    className="mx-auto text-gray-400"
                  />

                  <p className="mt-3 text-sm text-gray-500">
                    No tags have been created.
                  </p>
                </div>
              ) : (
                tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/[0.025]"
                  >
                    {editingTagId === tag.id ? (
                      <>
                        <input
                          value={editingTagName}
                          onChange={(event) =>
                            setEditingTagName(
                              event.target.value,
                            )
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              finishRenameTag()
                            }

                            if (event.key === 'Escape') {
                              setEditingTagId(null)
                            }
                          }}
                          autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-violet-400 bg-white px-2 py-1 text-sm text-gray-900 outline-none dark:bg-white/5 dark:text-white"
                        />

                        <button
                          type="button"
                          onClick={finishRenameTag}
                          className="rounded-lg p-2 text-emerald-500 hover:bg-emerald-500/10"
                        >
                          <Check size={16} />
                        </button>

                        <button
                          type="button"
                          onClick={() => setEditingTagId(null)}
                          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5"
                        >
                          <X size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 font-medium text-gray-900 dark:text-white">
                          {tag.name}
                        </span>

                        <button
                          type="button"
                          onClick={() =>
                            beginRenameTag(
                              tag.id,
                              tag.name,
                            )
                          }
                          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-white"
                        >
                          <Pencil size={15} />
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Delete the tag "${tag.name}" from all workflows and models?`,
                            )

                            if (confirmed) {
                              deleteTag(tag.id)
                            }
                          }}
                          className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-500"
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}