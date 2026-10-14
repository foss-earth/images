# @foss-earth/images

Shared image loading for FOSS Earth, a browser globe app built with TypeScript, React and Babylon.js. The package provides image contracts, JPEG and PNG header checks, exact byte arithmetic, shared memory reservations and session queues, retained image sources, and persistent media storage keyed by revision.

The host creates one `createImageSessionBroker` and passes it to every image representation. The broker tracks aggregate encoded, decoded, source GPU and outstanding upload bytes. Replacement overlap counts toward the source GPU limit. A broker creates no renderer and requests no frames.

## Entry points

| Entry | What it provides |
| --- | --- |
| `@foss-earth/images` | Pure contracts, header checks, byte arithmetic, pools and session broker, source cache, media store logic, colour helpers, vectors and resampling. |
| `@foss-earth/images/browser` | The IndexedDB adapter (`openIndexedDbBackend`), the common file service, transfer and decode helpers, and RGBA readback. |
| `@foss-earth/images/node` | JPEG and PNG codecs, orientation and colour normalization, linear-light helpers. See [bounded Node decoding](docs/node-codecs.md). |
| `@foss-earth/images/shaders` | Shader source shared by image representations. |
| `@foss-earth/images/settings` | Parameter specs and the resource forecast. Types come from [`@foss-earth/ui/settings`](https://github.com/foss-earth/ui). |

The root entry is pure. `createMediaStore` takes its open port explicitly.

Representation records share `ImageRepresentationRecord`. Its `role` is `preview` or `immersion` for a sphere (`ImageRepresentation`, inside a `panorama-image` asset), or `image` for a flat photograph's single representation (inside a `rectangle-image` asset, `RectangleImageAsset`). `checkImageRepresentationBase` accepts only the sphere roles unless its caller names others, so sphere validators keep their checks. The flat representation's fields and validator belong to [rectangle-image](https://github.com/foss-earth/rectangle-image). Pure source sampling, file enumeration, validation and estimates come from the representation packages through `RepresentationHooks`. Spatial preparation and the representation catalogue stay in those packages. This package adds no projection support, and JPEG and PNG are the only codecs. Limits are real bytes and counts, supplied by the host's settings registry.

## Source cache

```ts
createImageSourceCache({ broker, keptGpuBytes, gpuBytes, retainable? });
```

`acquire(key, { signal?, priority?, overlap?, estimatedGpuBytes?, load })` shares one asynchronous factory and scope per key. The factory receives `(scope, { priority, overlap })` and returns a resource with idempotent `dispose()` and `settleReplacement()`.

- The cache measures GPU bytes through the supplied accessor and keeps zero-reference sources in LRU order within the kept budget. A host can mark progressive resources as not retainable.
- `evictUnused(bytes, overlap?)` makes room before a known allocation without discarding held sources.
- When settings change, update the broker and call `setKeptGpuBytes`. Idle sources yield to both the kept limit and a lowered total GPU limit.
- Invalidating the broker cancels loads and disposes all cached resources.
- Each pending consumer cancels independently. When the last pending consumer cancels, the unfinished factory is cancelled, and a late resource is disposed. The first factory's priority governs its queued work.
- A successful acquire returns `{ resource, release(), settleReplacement() }`. Detach from the acquire signal and release the hold explicitly. `settleReplacement()` stays valid after release while the source is cached, so an outgoing preview can end later. Eviction releases its overlap charge itself.
- `imageSourceKey` builds the identity, revision and representation prefix. Hosts append resolved file URLs and allocation variants such as atlas layout.

`loadWholeImage(load, ports)` (from `./browser`) runs that lifecycle for a representation with one file: it reserves the estimated source GPU bytes, reads, decodes and uploads through the supplied `WholeImagePorts`, holds the native input until the upload settles, and disposes a late texture from a stale scope. The representation supplies its file, estimate and upload adapter.

Whole-image loads return `settleReplacement()`. The host calls it after the atomic visibility swap and disposal of the outgoing source. Being ready is not enough to release the replacement-overlap charge. Representation loaders keep their scope until `dispose()`.

## Reservations

`Reservation.retain()` keeps a charge after its owner releases it, until every returned hold ends. Active readers, decoders that can't be aborted and pending cache writes use this. Foreign decode inputs without a retain port get a separate encoded charge until decoding finishes.

GPU upload and staging adapters must reserve directly through the supplied `broker.pools` and release only on completion or context loss, so cancelling a scope can't free submitted work early. `ResourcePools.subscribeAvailable` coalesces releases, shrinking allocations, overlap settlement and raised limits into one microtask. Listeners should not throw; they wake the host's existing frame. Unsubscribe on disposal.

`ResourceCapacityError.pool` tells a capacity refusal from invalid media. `ImageDecodeFailure` marks an actual decoder rejection.

## File service and decoding

`createImageFileService` takes the broker, limits, priority, fetch, decode and optional saved files.

- `obtain(file, declaredBytes, scope, onChunk?, priority?)` fetches and checks an image.
- `decode(body, file, scope, priority?)` decodes it.
- Priority defaults to the host's default. Cached reads use the exact admitted byte count and a serial storage queue, independent of network concurrency.
- Valid bytes survive a decode-capacity refusal. Invalid headers or a real decoder failure make the service forget that file. Cache persistence keeps the original encoded input and charges its byte snapshot until `settled()`.

The factory returns a `HeaderInferredImageFileService`, which adds `obtainInferred({ url, width, height, mimeType? }, declaredBytes, scope, onChunk?, priority?)`. It uses the same bounded saved-file read, network queue and persistence as `obtain` and returns `{ file, header, body }`. The MIME type comes from the JPEG or PNG signature. Both dimensions are required. A missing or generic served content type allows inference. A contradictory served or supplied MIME, wrong dimensions, or a non-identity EXIF orientation is rejected before decode. URL suffixes never pick a format. `declaredBytes = 0` means the encoded size is unknown; the response cap and growing-stream admission still apply. Strict `obtain` still requires its MIME. `checkImageHeader` exposes the pure checks for a parsed header, and `imageHeaderError` the typed form of the string checks.

`decodeImageFile` returns a `HeldDecodedImage` with `retain(): () => void`. Take that hold before an operation such as `createImageBitmap` cropping that may keep reading the bitmap after cancellation, and end it only after the native work and any late-output cleanup finish. `close()` is an idempotent request. The bitmap and its decoded reservation stay live until every hold ends, and a closing resource rejects new holds. The final release tries to close the bitmap before releasing the charge, even if the disposer throws. A decoder without `retain` (allowed for older supplied decoders) gives no such lifetime guarantee, so consumers must either fall back or require it. A native decode that returns dimensions different from the header is rejected, and its bitmap is closed.

### Errors

- `ImageHttpStatusError` carries `url`, `status` and an optional cleanup `cause`. HTTP 204 means no image; other unsuccessful statuses are reported before the body is read. The transfer awaits response-body cancellation before ending its charge. Scope cancellation takes precedence over a stale status. This package doesn't decide what 404 or 204 mean for a map tile, or handle transparent pixels, retries or provider policy.
- `ImageDimensionMismatch` and `imageDimensionMismatch(error)` classify a dimension mismatch, with frozen `actual`, `expected` and `observation: 'header' | 'decoded'`. The classifier follows `Error.cause` and `AggregateError.errors` (cycle-safe), never message strings. MIME, orientation, corrupt data, HTTP and other native decode failures are not classified as dimension mismatches. A cached file whose header mismatches is forgotten and refetched, so a typed final error describes the fetched bytes.

## RGBA readback

`readbackDecodedImage({ broker, scope, image, priority, label, createSurface })` reads pixels from a `HeldDecodedImage` through the decode queue. The image must have the native input hold; a decoder without it is rejected before any allocation.

Before calling `createSurface(width, height)`, it admits a `4 × width × height` canvas and a separate RGBA output of the same size. With the bitmap's own charge that is 12 bytes per pixel at peak: 786,432 bytes for 256 × 256, 3,145,728 for 512 × 512.

- A supplied `RgbaReadbackSurface` implements `read(bitmap)`, returning one fresh, exact-size `Uint8ClampedArray` or a promise, and an idempotent `dispose()`. It cleans up its own partial construction if its factory throws. An optional `retired` promise resolves only once the backing storage is gone. A wider backing buffer or aliased output is rejected.
- `createCanvasRgbaSurface({ width, height, createCanvas })` draws with `drawImage(bitmap, 0, 0)` and `getImageData(0, 0, width, height)` using `willReadFrequently: true`, and returns `ImageData.data` directly. Supply a fresh canvas from the host document or an OffscreenCanvas realm. It resets both canvas dimensions on disposal and counts the canvas as retired once either reads zero. If both resets fail, a later `dispose()` retries. A factory failure keeps `retired` and `retryCleanup()` in `RgbaSurfaceCreationError`.
- Native readback is not raced against cancellation. The bitmap, canvas and output holds survive scope or broker invalidation until the native call completes, then every cleanup is attempted and failures are aggregated. A native promise that never settles keeps its input and allocations held.
- Success returns `HeldRgbaImage { width, height, data, retain(), close() }`. The bitmap stays borrowed and its owner closes it. The caller closes the pixels when done, or retains them first. Scope invalidation requests closure; retained users keep the charge and data until their last release. Don't use raw array references after the final close. `onCleanupFailure` reports late cleanup errors.
- Native decode options stay with the host. The map path used `premultiplyAlpha: none` and `colorSpaceConversion: default`. Readback changes no orientation, resampling or projection, and creates no worker, GPU device, cache, broker, timer or render loop.

## Saved media

Optional `SavedFiles.getBounded(url, { maxBytes, admit })` and `MediaStoreBackend.readBounded(requests)` read with admission before any body clone, using the exact immutable length or a trusted upper bound from the same transaction. A custom cache without it counts as a miss; the file service never calls the unbounded `get`. The older `get` and `read` remain unbounded, and callers must admit bytes themselves.

The IndexedDB adapter writes Blob rows in the `files-v2` store, database version 2, inside the `foss-earth-scene-media-v1` database. Blob size is admitted before `arrayBuffer()`, and metadata and the old row are read in one transaction. Batched materializations all finish before a failure releases their holds.

Version 1 ArrayBuffer rows are kept without migration or duplicate writes. A legacy row is read only if its group's byte bound fits both the response and encoded limits. Otherwise the loader falls back to the network and leaves the row, so a large legacy group can miss even for a small file until normal eviction removes it. Rows with safely observed lengths can be removed exactly when corrupt. Removing an unobserved legacy row keeps conservative group accounting until the whole group is evicted. An opener from before version 2 can't downgrade the database and falls back to the network on `VersionError`. Groups are cleared or deleted only through the explicit cache actions and user limits.

## Settings

`createImageResourceParameters({ keptGpuDefault })` returns the 14 common Loading and Saved parameters with their IDs, records, units, bounds, reasons and Scenes homes. The host supplies the kept-GPU default from the tiled-cubemap package or another policy. Preview-sheet, tiled, scene and 360-only settings are not included. `imageResourceForecast` estimates the cost of the widest image from the renderer limits. Importing the entry registers nothing.

## Node codecs

The Node entry exports `sniffImage`, `readJpegMetadata`, `readGPano`, `decodeJpeg`, `decodePng`, `encodeJpeg`, `encodePng`, `applyOrientation`, `colourIsSrgb`, `dropOpaqueAlpha`, `cropImage`, `srgbToLinear`, `linearToSrgb`, `toLinearImage`, `toSrgbImage` and `resizeArea`. Orientation and colour normalization happen once, before preparation of a representation. The [equirectangular](https://github.com/foss-earth/equirectangular) package owns its source pyramid, sampler and cardinal fixture generator. [cubemap](https://github.com/foss-earth/cubemap) and [tiled-cubemap](https://github.com/foss-earth/tiled-cubemap) own face and gutter preparation.

## Fixtures

`fixtures/media/cardinal-grid` holds synthetic test images: a north/east/south/west text sphere with a 30 degree grid and polar details, generated by the original Earth example tool. `fixtures/cardinal-provenance.json` records the tool, settings and output hashes. No photographs are included.

## Development

The package has no `@foss-earth/*` dependencies; `@foss-earth/ui` is an optional peer used for types by `./settings`. It also works standalone, with the scripts in `package.json`:

```sh
npm install
npm test            # vitest
npm run typecheck
npm run lint
npm run build
```

Libraries are also developed through the app, which uses them straight from their checkouts. See [local source](https://github.com/foss-earth/app#local-source).

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The JPEG codec files in `node/` are derived from jpeg-js and keep its BSD 3-Clause and Apache 2.0 terms; see [NOTICE](NOTICE) and [LICENSES](LICENSES). Third-party packages, map and terrain data, online services and trademarks have their own notices and terms.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
