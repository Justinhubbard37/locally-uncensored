import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
import { TagPicker } from '../workflows/TagPicker'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { Segmented } from './ui/Segmented'
import { cn } from './ui/cn'

type PageTab = 'workflows' | 'models' | 'tags'
type ModelFilter = 'all' | WorkflowTagMode

const TABS: Array<{ value: PageTab; label: string }> = [
  { value: 'workflows', label: 'Workflows' },
  { value: 'models', label: 'Models' },
  { value: 'tags', label: 'Tags' },
]

const INPUT =
  'h-[var(--control-h-md)] w-full px-2.5 t-control text-gray-200 placeholder:text-gray-600 ' +
  'rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] ' +
  'outline-none focus:border-white/20 transition-colors'

/** Full-surface workflow manager, opened from the Create composer. */
export function WorkflowsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && <WorkflowsModalInner onClose={onClose} />}
    </AnimatePresence>
  )
}

function WorkflowsModalInner({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<PageTab>('workflows')

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

  const { models, fetchModels } = useModels()

  // Fill the model list from here as well, so the manager stands on its own
  // instead of depending on the Models view having refreshed first.
  useEffect(() => { fetchModels().catch(() => {}) }, [fetchModels])

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

  // Two-step delete, the same pattern the agent workflow list uses. A raw
  // window.confirm renders as an OS dialog that blocks the whole webview,
  // which is why it was taken out of the codex gate and the RAG panel.
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const armDelete = (id: string, remove: () => void) => {
    if (confirmId === id) {
      remove()
      setConfirmId(null)
      return
    }
    setConfirmId(id)
    setTimeout(() => setConfirmId((c) => (c === id ? null : c)), 3000)
  }

  const comfyModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    return models
      .filter((model) => {
        if (model.type !== 'image' && model.type !== 'video') return false
        if (model.providerName !== 'ComfyUI') return false
        if (modelFilter !== 'all' && model.type !== modelFilter) return false
        if (query && !model.name.toLowerCase().includes(query)) return false
        return true
      })
      .sort((left, right) =>
        left.type !== right.type
          ? left.type.localeCompare(right.type)
          : left.name.localeCompare(right.name),
      )
  }, [models, modelFilter, modelSearch])

  const importWorkflowJson = (rawText: string, suggestedName?: string) => {
    setImportError(null)
    setImportSuccess(null)
    try {
      const json = JSON.parse(rawText)
      if (!validateWorkflowJson(json)) {
        setImportError('Invalid workflow. Export it from ComfyUI using Save (API Format).')
        return
      }
      const name = importName.trim() || suggestedName?.trim() || 'Imported Workflow'
      const parsed = parseImportedWorkflow(name, json, 'manual')

      // Re-importing under the same name updates in place, which also keeps
      // the tags that workflow already carries.
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
      setImportSuccess(existing ? `Updated "${name}".` : `Installed "${name}".`)
    } catch (error) {
      setImportError(
        error instanceof SyntaxError
          ? 'That file does not contain valid JSON.'
          : `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      importWorkflowJson(await file.text(), file.name.replace(/\.json$/i, ''))
    } catch (error) {
      setImportError(
        `Could not read that file: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      event.target.value = ''
    }
  }

  const handleCreateTag = () => {
    if (createTag(newTagName)) setNewTagName('')
  }

  const finishRenameTag = () => {
    if (!editingTagId) return
    renameTag(editingTagId, editingTagName)
    setEditingTagId(null)
    setEditingTagName('')
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[90] bg-white dark:bg-[#141414] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Workflows and tags"
    >
      <div className="flex items-center gap-3 px-4 h-12 border-b border-white/[0.06] shrink-0">
        <Workflow size={15} className="text-lu-accent shrink-0" />
        <span className="t-title text-gray-200">Workflows &amp; tags</span>
        <div className="flex-1" />
        <Segmented
          size="sm"
          layoutId="workflows-tab"
          value={tab}
          onChange={setTab}
          options={TABS}
          ariaLabel="Workflow manager section"
        />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon={X} iconOnly onClick={onClose} title="Close" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[860px] px-5 py-5">
          {tab === 'workflows' && (
            <div className="space-y-4">
              <section className="rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] p-4">
                <div className="flex items-center gap-1.5">
                  <Upload size={13} className="text-gray-500" />
                  <span className="t-label text-gray-400">Install a workflow</span>
                </div>
                <p className="mt-1.5 t-body text-gray-500">
                  Import a ComfyUI JSON saved in API format. An editable graph export will not work.
                </p>

                <div className="mt-3 flex gap-2">
                  <div className="flex-1 min-w-0">
                    <input
                      value={importName}
                      onChange={(e) => setImportName(e.target.value)}
                      placeholder="Workflow name (optional)"
                      className={INPUT}
                    />
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileImport}
                    className="hidden"
                  />
                  <div className="shrink-0 whitespace-nowrap">
                    <Button
                      variant="secondary"
                      icon={FileJson}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose file
                    </Button>
                  </div>
                </div>

                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder={'Or paste the API JSON here: {"1":{"class_type":"KSampler",…}}'}
                  className="mt-2 h-28 w-full resize-y px-2.5 py-2 t-mono text-gray-300 placeholder:text-gray-600 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] outline-none focus:border-white/20 transition-colors scrollbar-thin"
                />
                <div className="mt-2">
                  <Button
                    variant="primary"
                    disabled={!importJson.trim()}
                    onClick={() => importWorkflowJson(importJson)}
                  >
                    Install pasted workflow
                  </Button>
                </div>

                {importError && (
                  <div className="mt-2.5 rounded-[var(--radius-control)] bg-red-500/10 border border-red-500/20 px-2.5 py-1.5 t-body text-red-300">
                    {importError}
                  </div>
                )}
                {importSuccess && (
                  <div className="mt-2.5 rounded-[var(--radius-control)] bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 t-body text-emerald-300">
                    {importSuccess}
                  </div>
                )}
              </section>

              <section>
                <div className="flex items-center gap-1.5 mb-2">
                  <Workflow size={13} className="text-gray-500" />
                  <span className="t-label text-gray-400">Installed</span>
                  <span className="t-label text-gray-600">{installedWorkflows.length}</span>
                </div>

                {installedWorkflows.length === 0 ? (
                  <div className="py-12">
                    <EmptyState
                      icon={Workflow}
                      title="No workflows installed"
                      description="Import an API-format JSON above, then tag it so a model can find it."
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {installedWorkflows.map((workflow) => (
                      <article
                        key={workflow.id}
                        className="rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] p-3.5"
                      >
                        <div className="flex gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate t-title text-gray-200">{workflow.name}</span>
                              <Chip>{workflow.mode}</Chip>
                              <Chip>{workflow.source}</Chip>
                            </div>
                            {workflow.description && (
                              <p className="mt-1 line-clamp-2 t-body text-gray-500">
                                {workflow.description}
                              </p>
                            )}
                            <div className="mt-3">
                              <p className="mb-1.5 t-label text-gray-500">Compatibility tags</p>
                              <TagPicker
                                tags={tags}
                                selectedIds={workflowTags[workflow.id] ?? []}
                                onChange={(tagIds) => setWorkflowTags(workflow.id, tagIds)}
                              />
                            </div>
                          </div>
                          <DeleteButton
                            armed={confirmId === workflow.id}
                            label="workflow"
                            onClick={() => armDelete(workflow.id, () => removeWorkflow(workflow.id))}
                          />
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === 'models' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600"
                  />
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search installed models"
                    className={cn(INPUT, 'pl-8')}
                  />
                </div>
                <Segmented
                  size="sm"
                  layoutId="workflows-model-filter"
                  value={modelFilter}
                  onChange={setModelFilter}
                  ariaLabel="Model kind"
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'image', label: 'Image' },
                    { value: 'video', label: 'Video' },
                  ]}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RefreshCw}
                  iconOnly
                  title="Refresh the model list"
                  onClick={() => void fetchModels()}
                />
              </div>

              {comfyModels.length === 0 ? (
                <div className="py-12">
                  <EmptyState
                    icon={Search}
                    title="No ComfyUI models found"
                    description="Make sure ComfyUI is running, then refresh."
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  {comfyModels.map((model) => {
                    const mode = model.type as WorkflowTagMode
                    const key = workflowModelKey(model.name, mode)
                    return (
                      <article
                        key={key}
                        className="rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] p-3.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 break-all t-title text-gray-200">
                            {model.name}
                          </span>
                          <Chip>{mode}</Chip>
                        </div>
                        <div className="mt-3">
                          <p className="mb-1.5 t-label text-gray-500">Model tags</p>
                          <TagPicker
                            tags={tags}
                            selectedIds={modelTags[key] ?? []}
                            onChange={(tagIds) => setModelTags(model.name, mode, tagIds)}
                          />
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'tags' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <input
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTag() }}
                    placeholder="New tag, for example Wan 2.2"
                    className={INPUT}
                  />
                </div>
                <div className="shrink-0 whitespace-nowrap">
                  <Button
                    variant="primary"
                    icon={Plus}
                    disabled={!newTagName.trim()}
                    onClick={handleCreateTag}
                  >
                    Create
                  </Button>
                </div>
              </div>

              {tags.length === 0 ? (
                <div className="py-12">
                  <EmptyState
                    icon={Tags}
                    title="No tags yet"
                    description="A tag on a model and on a workflow is what pairs the two."
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  {tags.map((tag) => (
                    <div
                      key={tag.id}
                      className="flex items-center gap-2 rounded-[var(--radius-panel)] bg-white/[0.03] border border-white/[0.06] px-3 py-2"
                    >
                      {editingTagId === tag.id ? (
                        <>
                          <input
                            value={editingTagName}
                            onChange={(e) => setEditingTagName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') finishRenameTag()
                              if (e.key === 'Escape') setEditingTagId(null)
                            }}
                            autoFocus
                            className={INPUT}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Check}
                            iconOnly
                            title="Save"
                            onClick={finishRenameTag}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={X}
                            iconOnly
                            title="Cancel"
                            onClick={() => setEditingTagId(null)}
                          />
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate t-body text-gray-200">
                            {tag.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Pencil}
                            iconOnly
                            title="Rename"
                            onClick={() => { setEditingTagId(tag.id); setEditingTagName(tag.name) }}
                          />
                          <DeleteButton
                            armed={confirmId === tag.id}
                            label="tag"
                            onClick={() => armDelete(tag.id, () => deleteTag(tag.id))}
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="t-label text-gray-500 rounded bg-white/[0.06] px-1.5 py-0.5">{children}</span>
  )
}

function DeleteButton({
  armed,
  label,
  onClick,
}: {
  armed: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant={armed ? 'danger' : 'ghost'}
      size="sm"
      icon={Trash2}
      iconOnly
      onClick={onClick}
      title={armed ? `Click again to remove this ${label}` : `Remove ${label}`}
    />
  )
}
