import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ImageDecodeError } from '../../src/application/ports';
import { fileTypeSniffer, SharpImageProcessor } from '../../src/infrastructure/processing';
import { jpegWithGps, pdf, png, textAsJpg } from '../fixtures';

const processor = new SharpImageProcessor();

describe('sniffing', () => {
  it('identifies files by magic bytes, not by name or claim', async () => {
    expect(await fileTypeSniffer.sniff(await jpegWithGps(64, 48))).toBe('image/jpeg');
    expect(await fileTypeSniffer.sniff(await png())).toBe('image/png');
    expect(await fileTypeSniffer.sniff(pdf())).toBe('application/pdf');
    expect(await fileTypeSniffer.sniff(textAsJpg())).toBeNull();
  });
});

describe('SharpImageProcessor', () => {
  it('re-encodes without EXIF/GPS and produces 320/1280 px WebP variants', async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processor.process(input, 'image/jpeg');
    const meta = await sharp(out.original.body).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.original.body.includes(Buffer.from('secret owner'))).toBe(false);
    expect(out.original).toMatchObject({ width: 2000, height: 1500 });

    const byName = Object.fromEntries(out.variants.map((v) => [v.name, v]));
    expect(byName['thumb']).toMatchObject({ width: 320, height: 240 });
    expect(byName['medium']).toMatchObject({ width: 1280, height: 960 });
    for (const v of out.variants) {
      const vm = await sharp(v.body).metadata();
      expect(vm.format).toBe('webp');
      expect(vm.exif).toBeUndefined();
    }
  });

  it('applies the EXIF orientation before dropping it', async () => {
    const rotated = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#888' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await processor.process(rotated, 'image/jpeg');
    expect(out.original).toMatchObject({ width: 300, height: 600 });
    expect((await sharp(out.original.body).metadata()).orientation).toBeUndefined();
  });

  it('never enlarges small images', async () => {
    const out = await processor.process(await png(200, 100), 'image/png');
    expect(out.variants.map((v) => v.width)).toEqual([200, 200]);
  });

  it('refuses decompression bombs (pixel limit) and corrupt data', async () => {
    const tiny = new SharpImageProcessor(1_000_000);
    await expect(tiny.process(await png(1200, 1000), 'image/png')).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
    const truncated = (await jpegWithGps(400, 300)).subarray(0, 600);
    await expect(processor.process(truncated, 'image/jpeg')).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });
});
