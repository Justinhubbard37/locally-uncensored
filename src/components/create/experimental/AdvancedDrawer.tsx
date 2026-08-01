import { Drawer } from '../ui/Drawer'
import { WorkflowFinder } from '../WorkflowFinder'
import { useCreateStore } from '../../../stores/createStore'
import {
  classifyModel,
  isI2VModel,
  isT2VCapable,
} from '../../../api/comfyui'
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
  const intent = useCreateStore((state) => state.intent())

  const imageModel = useCreateStore(
    (state) => state.imageModel,
  )

  const videoModel = useCreateStore(
    (state) => state.videoModel,
  )

  const videoModels = useCreateStore(
    (state) => state.videoModelList,
  )

  // Match the model coercion used by the visible picker and generation path.
  // Animate/Extend require I2V-capable models; ordinary Video requires T2V.
  let effectiveVideoModel = videoModel

  if (videoModels.length > 0) {
    const compatibleModels =
      intent === 'animate' || intent === 'extend'
        ? videoModels.filter((model) =>
            isI2VModel(model.name),
          )
        : videoModels.filter((model) =>
            isT2VCapable(model.name),
          )

    const storedModelIsCompatible =
      compatibleModels.some(
        (model) => model.name === videoModel,
      )

    if (
      compatibleModels.length > 0 &&
      !storedModelIsCompatible
    ) {
      effectiveVideoModel =
        compatibleModels[0].name
    }
  }

  const modelName =
    mode === 'image'
      ? imageModel
      : effectiveVideoModel

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