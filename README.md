# Hip Templater

Browser-based, automated pre-operative templating for **total hip arthroplasty (THA)** on a calibrated AP pelvis radiograph.

The app proposes the landmarks automatically and you confirm each with one click. It then templates the cup and a stem built from the manufacturer's dimension table to meet your leg-length and offset goals, and shows how the change in centre of rotation produces those results. Everything runs in the browser, so no images leave the machine.

> **Not a medical device.** This is a research and educational tool. Verify every plan clinically.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + end-to-end pipeline tests
npm run build      # static bundle in dist/ (can be hosted anywhere)
```

Click **Demo case** to load a synthetic radiograph (a left THA with the operative leg 6 mm short) and run the automatic proposals on it.

## Workflow

1. **Open image**: PNG, JPEG or DICOM. Uncompressed DICOM and JPEG-baseline DICOM work; MONOCHROME1 images are inverted, and rescale slope and intercept are applied.
2. **Automatic proposals.** As soon as the image opens, the app proposes the calibration marker, both teardrops, both femoral heads, both lesser trochanters and both femoral canals. A review card zooms to each point in turn. Press **OK** (or Enter), or drag the point first and then OK it. **OK all** accepts everything that is left. Points you haven't checked yet are marked "?".
3. **Case setup**: choose the operative hip and the display orientation (standard: the patient's right is on the viewer's left).
4. **Calibration**: the marker ball is found automatically (set its diameter, default 25 mm). Alternatives are a known length, the DICOM spacing ÷ magnification, or a manual mm/px value.
5. **Goals**, set per case:
   - **Leg length**: equal to the other side (plus any extra), or change by a set number of mm.
   - **Offset**: match the other side (plus any extra), or change by a set number of mm.
6. **Implants.** The app picks the stem size, standard or high-offset neck, seating depth and cup position that best meet the goals, always with the 0 mm head. You can override any of these:
   - force a stem size or neck
   - **drag the stem** to move it in the canal, or drag the dot at its tip to tilt it
   - **drag the cup centre** to move the cup
   - **Reset** returns the stem or cup to automatic placement
7. **Read the result.**
   - **Summary box** (center top): cup size, stem size, pre-op LLD, pre-op offset difference, post-op LLD and post-op offset difference. Values are for the operative side relative to the other side: − means shorter or less offset, + means longer or more offset.
   - **Implant legend** in the operative-side corner: cup in blue; stem name, size and offset in green.
   - **Templates:** the cup is blue and the stem green, each with its centre of rotation marked by a dot.
   - **Measurements:** in red and cyan. LLD is the height from the teardrop line to each lesser trochanter (A = affected side, NA = non-affected side).
   - **Clutter:** drag any label or the summary box out of the way. `M` or the **Measurements** button hides all measurements, and **Reset labels** puts everything back.
8. **Export**: **Download JPEG** saves the templated radiograph at full resolution, including the summary box and legend. You can also save or load the case as JSON.

Keyboard shortcuts: Enter confirms the point under review, `Esc` stops the review or cancels the current tool, `M` toggles measurements, `f` fits the image to the view.

**Stem orientation.** By default the stem template is upright to the inter-teardrop line: its axis is perpendicular to the line and its horizontal reference is parallel to it. The femoral shaft is usually adducted a few degrees, so an upright stem crosses the canal at that angle and may seat smaller than a canal-aligned one. Use **Stem orientation → Along femoral canal** to compare.

## Checking detection accuracy

Auto-detection uses no trained model, so measure it on your own films:

- **Per case:** the results panel's *Auto-detection check* lists how far you moved each proposed point before confirming it. That distance is the detector's error on that film. Saved case files keep both the proposed and the confirmed positions.
- **In batch:** put de-identified images and their saved `.plan.json` case files in one folder, then run:

  ```bash
  EVAL_DIR=/path/to/folder npm run eval
  ```

  It runs the detector on every image, compares the result with your confirmed points, and writes `eval-report.md`. The report gives the median and 90th-percentile error, % within 2 mm and 5 mm, and the miss rate, for each landmark type. Everything runs locally.

## Stems

The bundled stem is the **CATALYSTEM** (131° neck-shaft angle, sizes 0–12, standard and high-offset necks). Its numbers come from the technical specifications table in the surgical technique, using the 0 head column:

| per size | per neck (std / high) |
| --- | --- |
| length, ML width at resection, ML width distal | offset, neck length, leg length |

The 2D template is generated from these numbers:
- The body tapers from the ML width at resection to the distal ML width at 80% of the stem length, with a calcar flare on the medial side.
- The 0-head centre sits at (offset, leg length) from the stem axis and the resection level.
- The neck is drawn along the 131° axis using the table's neck length.

Use **Stem tables…** to add other stems: paste one row per size (tab- or comma-separated, header optional), check the preview, and save. Saved stems stay in this browser.

```
size  length  ML@resection  ML distal  std offset  std neck length  std leg length  high offset  high neck length  high leg length
```

## How the automation works

### Landmark proposals (`src/imaging/autoLandmarks.ts`)

No trained model is used. Detection runs on a copy of the image downsampled to about 1 mm/px:

- **Femoral heads and marker:** a gradient-direction circular Hough transform for bright discs, with one head per image half. Each head is then refined by the radial-edge circle fit.
- **Femoral shafts:** each row below the head is scanned for the bright cortex / darker canal / bright cortex pattern, and a robust line is fitted through the hits. That line seeds the canal detector.
- **Lesser trochanter:** the largest local protrusion of the medial bone edge below the head.
- **Teardrop:** the inferior tip of a bright structure (bright above, darker below), searched near its typical position relative to the head.

On the synthetic phantom every proposal is within 3 mm. Real radiographs vary much more: overlapping soft tissue, rotation and implants all reduce accuracy. That is why every point goes through the OK review.

### Canal and head fitting (`src/imaging/detect.ts`)

- **Head:** a radial edge search, then a RANSAC circle fit.
- **Canal:** endosteal and periosteal edges are found on profiles taken perpendicular to the shaft. The canal axis is a least-median-of-squares line through the midpoints.

### Reconstruction model (`src/planning/plan.ts`)

On the radiograph, the femur sits with its native head in the native acetabulum. After reduction, the prosthetic head centre S moves to the cup centre C, so the whole femur is translated by T = C − S in the pelvic frame:

- **leg-length change** = −T (vertical component); moving the femur distally lengthens the leg
- **global offset change** = T (horizontal component); moving the femur laterally adds offset

Each change is reported in two parts:
- **cup (COR):** cup centre minus the native head centre
- **stem:** native head centre minus the prosthetic head on the femur

The display also shows where the lesser trochanter ends up after reduction ("LT after").

### Automatic stem placement

Each stem size slides down the canal until it reaches cortical contact ("fit and fill"). To meet the leg-length goal between two discrete sizes, a stem may be left up to 4 mm proud of full contact; when that happens it is reported. The neck cut must lie between the lesser trochanter and the femoral head. If any stem level crosses the endosteal cortex, it is flagged as a breach in the fill table.

### Assumptions and limitations

- The analysis is 2D only. Femoral rotation, flexion contracture and pelvic tilt alter the projected offset and neck geometry.
- Template accuracy depends on the dimension table and the calibration. Marker balls must be at the level of the hip, not on the table.

## Implant library format

Besides the in-app table editor, a library can be loaded as JSON with **Load library**:

```jsonc
{
  "stems": [{
    "id": "my-stem", "name": "My stem (131°)", "neckShaftAngle": 131,
    "specs": [
      { "size": "1", "length": 95, "mlResection": 25, "mlDistal": 8,
        "necks": [
          { "id": "std",  "label": "Standard offset", "offset": 32, "neckLength": 28, "legLength": 26 },
          { "id": "high", "label": "High offset",     "offset": 38, "neckLength": 32, "legLength": 26 }
        ] }
    ]
  }],
  "cups": [{ "id": "my-cup", "name": "…", "fixation": "cementless",
             "sizes": [{ "outerDiameter": 50, "maxHeadDiameter": 32 }] }]
}
```

All dimensions are in mm with the 0 head. Leg length is the head-centre height above the resection level, and offset is measured from the stem axis to the head centre.

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
