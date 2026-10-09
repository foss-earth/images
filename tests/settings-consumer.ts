import { createImageResourceParameters, IMAGE_RESOURCE_SECTION_TITLES } from "@foss-earth/images/settings";
import { createSettingsRegistry, type DerivedDefault, type DeviceContext } from "@foss-earth/ui/settings";

// The tiled owner supplies this policy in a concrete Earth composition. This
// minimal consumer instead demonstrates an explicit host memory policy.
const keptGpuDefault = (context: DeviceContext): DerivedDefault<number> => { void context; return { value: 0, derivedFrom: "this host retains no unused sources" }; };
const settings = createSettingsRegistry({ storage: null });
settings.register(createImageResourceParameters({ keptGpuDefault }));
settings.setDeviceContext({ maxTextureSize: 8192 });
export const savedBytes = settings.get<number>("scene.panorama.savedMiB") * 1024 * 1024;
export const sections = IMAGE_RESOURCE_SECTION_TITLES;
