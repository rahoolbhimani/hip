/**
 * Image loading: PNG/JPEG/WebP via the browser, DICOM via dicom-parser.
 * Everything is converted to a float GrayImage for analysis; the DICOM
 * spacing tags are surfaced so the calibration step can use them.
 */
import * as dicomParser from 'dicom-parser';
import { type GrayImage, createGray, fromRGBA } from './gray';

export interface LoadedImage {
  name: string;
  gray: GrayImage;
  /** Detector/imager pixel spacing in mm, if the file declares one. */
  pixelSpacingMm?: number;
  /** True if `pixelSpacingMm` already refers to the patient plane (PixelSpacing tag). */
  spacingAtPatient?: boolean;
  /** Estimated radiographic magnification factor (0018,1114), if present. */
  magnification?: number;
  /** Suggested display window (min, max) in image intensity units. */
  window?: [number, number];
  meta: Record<string, string>;
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (looksLikeDicom(buf, file.name)) return loadDicom(buf, file.name);
  const bitmap = await createImageBitmap(new Blob([buf], { type: file.type || 'image/png' }));
  return { name: file.name, gray: bitmapToGray(bitmap), meta: {} };
}

function looksLikeDicom(buf: Uint8Array, name: string): boolean {
  if (buf.length > 132 && buf[128] === 0x44 && buf[129] === 0x49 && buf[130] === 0x43 && buf[131] === 0x4d) return true;
  return /\.(dcm|dicom)$/i.test(name);
}

export function bitmapToGray(bitmap: ImageBitmap): GrayImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return fromRGBA(data, bitmap.width, bitmap.height);
}

const JPEG_BASELINE = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);
const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);

async function loadDicom(buf: Uint8Array, name: string): Promise<LoadedImage> {
  const ds = dicomParser.parseDicom(buf);
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  if (!rows || !cols) throw new Error('DICOM file has no image dimensions');
  const ts = ds.string('x00020010') ?? '1.2.840.10008.1.2';
  const photometric = (ds.string('x00280004') ?? 'MONOCHROME2').trim();
  const slope = ds.floatString('x00281053') ?? 1;
  const intercept = ds.floatString('x00281052') ?? 0;
  const pixelEl = ds.elements['x7fe00010'];
  if (!pixelEl) throw new Error('DICOM file has no pixel data');

  let gray: GrayImage;
  if (UNCOMPRESSED.has(ts)) {
    gray = decodeRaw(ds, pixelEl, rows, cols, ts === '1.2.840.10008.1.2.2');
  } else if (JPEG_BASELINE.has(ts)) {
    const frame = dicomParser.readEncapsulatedPixelData(ds, pixelEl, 0);
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(frame)], { type: 'image/jpeg' }));
    gray = bitmapToGray(bitmap);
  } else {
    throw new Error(`Unsupported DICOM transfer syntax ${ts}. Export the image as uncompressed DICOM, PNG or JPEG.`);
  }

  if (slope !== 1 || intercept !== 0) {
    for (let i = 0; i < gray.data.length; i++) gray.data[i] = gray.data[i] * slope + intercept;
  }
  if (photometric === 'MONOCHROME1') {
    let max = -Infinity;
    let min = Infinity;
    for (const v of gray.data) {
      if (v > max) max = v;
      if (v < min) min = v;
    }
    for (let i = 0; i < gray.data.length; i++) gray.data[i] = max + min - gray.data[i];
  }

  const meta: Record<string, string> = {};
  const add = (label: string, tag: string) => {
    const v = ds.string(tag);
    if (v) meta[label] = v;
  };
  add('Modality', 'x00080060');
  add('Study date', 'x00080020');
  add('Body part', 'x00180015');
  add('View', 'x00185101');

  // Prefer ImagerPixelSpacing (detector plane) — PixelSpacing may be either.
  const imager = ds.floatString('x00181164');
  const pixel = ds.floatString('x00280030');
  const mag = ds.floatString('x00181114');
  const wc = ds.floatString('x00281050');
  const ww = ds.floatString('x00281051');
  return {
    name,
    gray,
    pixelSpacingMm: imager ?? pixel,
    spacingAtPatient: !imager && !!pixel,
    magnification: mag && mag > 0.9 && mag < 2 ? mag : undefined,
    window: wc !== undefined && ww ? [wc - ww / 2, wc + ww / 2] : undefined,
    meta,
  };
}

function decodeRaw(ds: dicomParser.DataSet, el: dicomParser.Element, rows: number, cols: number, bigEndian: boolean): GrayImage {
  const bits = ds.uint16('x00280100') ?? 16;
  const signed = ds.uint16('x00280103') === 1;
  const samples = ds.uint16('x00280002') ?? 1;
  const g = createGray(cols, rows);
  const n = rows * cols;
  const view = new DataView(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length);
  if (samples === 3 && bits === 8) {
    const planar = ds.uint16('x00280006') === 1;
    for (let i = 0; i < n; i++) {
      const r = planar ? view.getUint8(i) : view.getUint8(i * 3);
      const gg = planar ? view.getUint8(n + i) : view.getUint8(i * 3 + 1);
      const b = planar ? view.getUint8(2 * n + i) : view.getUint8(i * 3 + 2);
      g.data[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    }
    return g;
  }
  if (bits === 8) {
    for (let i = 0; i < n; i++) g.data[i] = signed ? view.getInt8(i) : view.getUint8(i);
  } else if (bits === 16) {
    const le = !bigEndian;
    for (let i = 0; i < n; i++) g.data[i] = signed ? view.getInt16(i * 2, le) : view.getUint16(i * 2, le);
  } else {
    throw new Error(`Unsupported DICOM bit depth: ${bits}`);
  }
  return g;
}
