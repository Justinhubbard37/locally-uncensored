import { Drawer } from '../ui/Drawer'
import { WorkflowFinder } from '../WorkflowFinder'
import { useCreateStore } from '../../../stores/createStore'
import { classifyModel } from '../../../api/comfyui'
import { ParamGroups } from './ParamGroups'

export function AdvancedDrawer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const mode = useCreateStore((state) => state.mode)
  const backend = useCreateStore((state) => state.backend)
  const imageModel = useCreateStore((state) => state.imageModel)
  const videoModel = useCreateStore((state) => state.videoModel)

  const modelName = mode === 'image' ? imageModel : videoModel
  const modelType = classifyModel(modelName)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Advanced settings"
      width={320}
    >
      <ParamGroups />

      {backend === 'local' && modelName && (
        <div className="border-t border-white/10 px-1 pb-4 pt-4">
          <WorkflowFinder
            modelName={modelName}
            modelType={modelType}
          />
        </div>
      )}
    </Drawer>
  )
}