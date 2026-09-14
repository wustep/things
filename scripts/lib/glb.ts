/**
 * Shrink a Meshy GLB for the web. Meshy ships 2k PBR textures (easily 10 MB+ per model); on a
 * shelf where each thing is a couple of hundred pixels tall, 1k JPEGs look the same and load in
 * a fraction of the time. Geometry is quantized (KHR_mesh_quantization, which three.js reads
 * natively), duplicates merged and unused data pruned.
 */
import { Logger, NodeIO, type Document, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize } from '@gltf-transform/functions';
import { decode } from './images.ts';

/** Base colour and normal maps carry the detail. */
const MAX_TEXTURE = 1024;
/** Metallic-roughness, occlusion and emissive maps are smooth; a quarter of the texels is plenty. */
const SMALL_TEXTURE = 512;

type Role = 'baseColor' | 'normal' | 'metallicRoughness' | 'occlusion' | 'emissive' | 'other';

export async function slimGlb(glb: Buffer, log?: (msg: string) => void): Promise<Buffer> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(glb));
  doc.setLogger(new Logger(Logger.Verbosity.SILENT)); // the transforms narrate every pruned accessor otherwise

  for (const tex of doc.getRoot().listTextures()) {
    const image = tex.getImage();
    if (!image) continue;
    const role = roleOf(doc, tex);
    const maxSide = role === 'baseColor' || role === 'normal' ? MAX_TEXTURE : SMALL_TEXTURE;
    const keepAlpha = role === 'baseColor' && usesAlpha(doc, tex);
    try {
      const img = await decode(Buffer.from(image.buffer, image.byteOffset, image.byteLength));
      const { width, height } = img.bitmap;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      if (scale < 1) img.resize({ w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) });
      const out = keepAlpha
        ? await img.getBuffer('image/png')
        : await img.getBuffer('image/jpeg', { quality: role === 'normal' ? 92 : 86 });
      if (scale < 1 || out.length < image.byteLength) {
        tex.setImage(new Uint8Array(out)).setMimeType(keepAlpha ? 'image/png' : 'image/jpeg');
      }
    } catch (err) {
      log?.(`texture ${tex.getName() || role} left as-is: ${(err as Error).message}`);
    }
  }

  await doc.transform(dedup(), prune(), quantize());
  return Buffer.from(await io.writeBinary(doc));
}

function roleOf(doc: Document, tex: Texture): Role {
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getBaseColorTexture() === tex) return 'baseColor';
    if (m.getNormalTexture() === tex) return 'normal';
    if (m.getMetallicRoughnessTexture() === tex) return 'metallicRoughness';
    if (m.getOcclusionTexture() === tex) return 'occlusion';
    if (m.getEmissiveTexture() === tex) return 'emissive';
  }
  return 'other';
}

function usesAlpha(doc: Document, tex: Texture): boolean {
  return doc
    .getRoot()
    .listMaterials()
    .some((m) => m.getBaseColorTexture() === tex && m.getAlphaMode() !== 'OPAQUE');
}
