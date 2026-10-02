import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import {
  ImageDecodeError,
  type ContentSniffer,
  type ImageProcessor,
  type MalwareScanner,
  type ProcessedImage,
} from '../application/ports';
import { VARIANT_WIDTHS, type ImageType, type VariantName } from '../domain/media';

/** Magic-byte sniffing; the client's declared type and filename are never trusted. */
export const fileTypeSniffer: ContentSniffer = {
  async sniff(bytes) {
    return (await fileTypeFromBuffer(bytes))?.mime ?? null;
  },
};

/** Stops decompression bombs: a tiny file that decodes to billions of pixels. */
export const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;

/**
 * libvips via sharp. Decoding is bounded by `limitInputPixels`; output never carries the
 * input's metadata (sharp drops EXIF, GPS, XMP and ICC comments unless asked to keep them).
 */
export class SharpImageProcessor implements ImageProcessor {
  constructor(private readonly maxInputPixels = DEFAULT_MAX_INPUT_PIXELS) {}

  async process(bytes: Buffer, format: ImageType): Promise<ProcessedImage> {
    const input = () =>
      sharp(bytes, {
        limitInputPixels: this.maxInputPixels,
        failOn: 'error',
        autoOrient: true,
        pages: 1,
      });
    try {
      const encoded = input();
      switch (format) {
        case 'image/jpeg':
          encoded.jpeg({ quality: 85 });
          break;
        case 'image/png':
          encoded.png({ compressionLevel: 9 });
          break;
        case 'image/webp':
          encoded.webp({ quality: 85 });
          break;
      }
      const original = await encoded.toBuffer({ resolveWithObject: true });
      const variants = await Promise.all(
        (Object.entries(VARIANT_WIDTHS) as Array<[VariantName, number]>).map(
          async ([name, width]) => {
            const v = await input()
              .resize({ width, withoutEnlargement: true })
              .webp({ quality: 80 })
              .toBuffer({ resolveWithObject: true });
            return { name, body: v.data, width: v.info.width, height: v.info.height };
          },
        ),
      );
      return {
        original: { body: original.data, width: original.info.width, height: original.info.height },
        variants,
      };
    } catch (err) {
      throw new ImageDecodeError(err instanceof Error ? err.message : 'decode failed', {
        cause: err,
      });
    }
  }
}

/**
 * Default scanner: accepts everything. Production plugs a ClamAV adapter in here (stream the
 * bytes to clamd with INSTREAM and map `FOUND` to `{ clean: false, signature }`); the media
 * service calls it before any object becomes READY.
 */
export const noopScanner: MalwareScanner = {
  async scan() {
    return { clean: true };
  },
};
