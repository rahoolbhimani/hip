# Hip Templater

Browser-based, automated pre-operative templating for **total hip arthroplasty (THA)** on a calibrated AP pelvis radiograph.

You place a handful of landmarks; the app detects the femoral head contour and femoral canal, takes the measurements, and generates a full plan (cup size and position, stem size, neck offset, head length and neck-cut level) that restores leg length and offset. Everything runs in the browser, so no images leave the machine.

> **Not a medical device.** This is a research and educational tool. The bundled implant templates are generic, not any manufacturer's specifications. Before any clinical use, load validated vendor templates and verify every plan.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + end-to-end pipeline tests
npm run build      # static bundle in dist/ (can be hosted anywhere)
```

Click **Demo case** to load a synthetic radiograph with the landmarks already placed: a left THA with the operative leg 6 mm short.

## Workflow

1. **Open image**: PNG, JPEG or DICOM. Uncompressed DICOM and JPEG-baseline DICOM work; MONOCHROME1 images are inverted, and rescale slope and intercept are applied.
2. **Case setup**: choose the operative hip and the display orientation (standard: the patient's right is on the viewer's left).
3. **Calibration**, in order of preference:
   - **Marker ball**: click the marker's centre, then its edge. The edge is refined automatically and you enter the diameter (default 25 mm).
   - **Known length**: click both ends of an object of known length.
   - **DICOM spacing ÷ magnification**: filled in automatically from `ImagerPixelSpacing`/`PixelSpacing` and `EstimatedRadiographicMagnificationFactor`. If the file has no magnification factor, 1.20 is assumed.
   - **Manual** mm/px.
4. **Landmarks**: the app moves to the next landmark after each one is placed.
   - Required: both teardrops (inferior tips), the operative femoral head (one click near its centre, then the contour is fitted automatically), the operative lesser trochanter, and the operative canal (two clicks inside the medullary canal: one at the LT level, one about 15 cm further down).
   - Recommended: the contralateral head, LT and canal. These give the leg-length difference and the offset target.
   - Optional: the acetabular sourcil edge (for cup coverage) and the greater trochanter tip.
5. **Review and adjust.** Every handle can be dragged and the plan recomputes live. You can change the cup inclination, placement strategy, oversizing, medial-wall offset, LLD correction and extra lengthening, and override any automatic choice (cup size, stem size, offset, head length).
6. **Export**: an annotated full-resolution PNG, a printable report, or the case saved as JSON. A saved case can be reloaded onto the same image.

Keyboard shortcuts: `n` places the next landmark, `Esc` cancels the current tool, `f` fits the image to the view.

## How the automation works

### Image analysis (`src/imaging/detect.ts`)

- **Femoral head and marker ball.** 72 rays are cast from the seed point. On each ray the strongest bright-to-dark transition within the plausible radius band is kept (15–34 mm for a head). A circle is then fitted to those edge points with RANSAC followed by a least-squares (Kåsa) refit. Edge support is reported as a confidence value. If detection fails, a default circle is placed and you drag its edge handle to fit.
- **Femoral canal.** Intensity profiles are sampled perpendicular to the line between the two seed points, every 2 mm. On each side, walking outward, the **endosteal** border is the first strong dark-to-bright rise and the **periosteal** border is the first strong fall after it. Levels whose width is an outlier are rejected. The anatomical axis is a least-median-of-squares line through the canal midpoints, and the isthmus is the narrowest level in the distal two-thirds.

### Measurements (`src/planning/measure.ts`)

All measurements are taken in a pelvic frame built on the inter-teardrop line:

- leg-length difference: the distance from each LT to the teardrop line
- acetabular offset: the horizontal distance from the teardrop to the head centre
- femoral offset: the perpendicular distance from the head centre to the anatomical axis
- global offset, COR height, pelvic obliquity, femoral shaft angle and isthmus width

### Plan (`src/planning/plan.ts`)

- **Cup.** The outer diameter is the head diameter plus the oversize setting (default 4 mm), rounded up to the next library size. By default the cup is placed using the teardrop: its medial wall sits against the teardrop (plus an adjustable offset) and its inferomedial rim is level with the teardrop's inferior tip, at the target inclination (default 40°). It can instead be centred on the native centre of rotation. If the acetabular edge was marked, lateral uncoverage is reported.
- **Stem.** Each size is fitted by "fit and fill": the stem axis is aligned with the femoral anatomical axis and slid down the canal profile until it would breach the endosteal cortex in the meta-diaphyseal region. That gives the depth at which a tapered wedge locks.
- **Reconstruction model.** In the standard 2D model the femur hangs from the centre of rotation:
  - leg-length change = (prosthetic head height on the femur − native head height on the femur) − (rise in the centre of rotation)
  - global-offset change = (femoral offset change) + (acetabular offset change)
- **Selection.** Every combination of size × offset option × head length is scored by its squared error against the leg-length and offset targets. Penalties apply for non-neutral heads, an implausible neck-cut level, and a stem that extends beyond the detected canal. The best combination is shown with its fill table and the next-best alternatives.
- **Targets.** By default the plan equalises leg length with the contralateral LT and matches the contralateral global offset. Without contralateral landmarks it keeps the current length and the operative side's own offset.

### Assumptions and limitations

- The analysis is 2D only. Femoral rotation, flexion contracture and pelvic tilt alter the projected offset and neck geometry. Check the lesser-trochanter profile and the pelvic position.
- When the two leg-length contributions are combined, the femoral axis is treated as parallel to the pelvic vertical. For typical 5–8° shaft angles the cosine error is under 1%.
- Canal detection needs the seeds to be inside the medullary canal. It can be confused by implants, cement, heavy osteopenia or overlying soft-tissue folds. Always inspect the green canal points.
- Accuracy depends on the calibration. Marker balls must be at the level of the hip, not on the table.
- Landmark placement is assisted, not fully autonomous. `src/imaging/detect.ts` is the place to plug in a learned landmark detector: it only needs to output the same `SideLandmarks` structure (`src/planning/types.ts`).

## Implant library format

Use **Export library** in the app to get the bundled generic library as JSON. Edit it with a vendor's template dimensions and load it with **Load implant library**.

```jsonc
{
  "stems": [{
    "id": "my-stem", "name": "…", "fixation": "cementless",
    "headLengths": [-3.5, 0, 3.5, 7],
    "sizes": [{
      "size": "1",
      "shoulderHeight": 12,
      // d: mm distal of the medial resection level; medial/lateral: half-widths from the stem axis
      "profile": [{ "d": 0, "medial": 13, "lateral": 7 }, { "d": 110, "medial": 2.2, "lateral": 2.2 }],
      // offset: axis → head centre; height: head centre above the resection level (0 mm head)
      "offsets": [{ "id": "std", "label": "Standard offset", "offset": 37, "height": 36, "neckShaftAngle": 132 }]
    }]
  }],
  "cups": [{ "id": "my-cup", "name": "…", "fixation": "cementless",
             "sizes": [{ "outerDiameter": 50, "maxHeadDiameter": 32 }] }]
}
```

## Project layout

```
src/
  geometry/   vectors, frames, circle/line fitting (RANSAC, LMedS)
  imaging/    grayscale images, DICOM/PNG loading, head & canal detection, synthetic phantom
  planning/   types, implant library, measurements, automatic plan
  app/        state store and landmark workflow
  ui/         canvas viewer, overlays, results panel
tests/        geometry unit tests and phantom-based end-to-end pipeline tests
```
