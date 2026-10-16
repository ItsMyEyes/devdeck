import { Box3, Group, Vector3 } from 'three'
import { deskShape, chairShape } from '@/features/agent-workspace/furniture'
export const furnitureAssets = {
  desk: 'desk',
  chair: 'chairDesk',
  sofa: 'loungeSofa',
  coffeeTable: 'tableCoffee',
  cabinet: 'kitchenCabinet',
  coffee: 'kitchenCoffeeMachine',
  fridge: 'kitchenFridgeSmall',
  bookshelf: 'bookcaseClosed',
  plant: 'pottedPlant',
  lamp: 'lampRoundFloor',
} as const
export type FurnitureAsset = keyof typeof furnitureAssets
export const furnitureAnchors = {
  desk: {
    top: deskShape.top,
    keyboard: [0, deskShape.keyboardY, deskShape.keyboardZ],
    seatZ: deskShape.seatZ,
  },
  chair: {
    sourceHeight: 0.6076,
    sourceSeat: 0.2335,
    targetSeat: chairShape.seatHeight + 0.07,
    rotation: Math.PI,
  },
  sofa: { sourceHeight: 0.46, sourceSeat: 0.23, targetSeat: 0.48 },
}
export const assetUrl = (file: string) =>
  `${import.meta.env.BASE_URL}office-assets/${file}`
export function normalizeFurniture(
  source: Group,
  size: [number, number, number],
) {
  const model = source.clone(true)
  const bounds = new Box3().setFromObject(model)
  const extent = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const scale = new Vector3(
    size[0] / extent.x,
    size[1] / extent.y,
    size[2] / extent.z,
  )
  const root = new Group()
  root.scale.copy(scale)
  model.position.add(new Vector3(-center.x, -bounds.min.y, -center.z))
  root.add(model)
  return root
}
