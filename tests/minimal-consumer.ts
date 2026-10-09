import { createImageSessionBroker, type ImageAsset, type RepresentationHooks } from "@foss-earth/images";

// A consumer registers its own spatial format; images has no catalogue dependency.
export function useImage(asset: ImageAsset, hooks: RepresentationHooks) {
  const broker = createImageSessionBroker({ pools: { sourceGpu: 100, encoded: 100, decoded: 100, uploadOutstanding: 100, overlap: 20 }, requests: 1, decodes: 1 });
  const scope = broker.scope();
  const representation = asset.representations.find(record => record.projection === hooks.projection);
  if (representation) scope.reserve("decoded", hooks.estimate(representation, { maxTextureSide: 2048 }).decoded, asset.id);
  return () => broker.dispose();
}
