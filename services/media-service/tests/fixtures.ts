import sharp from 'sharp';

/** A real JPEG carrying camera EXIF and a GPS position (central Dhaka). */
export const jpegWithGps = (width = 2000, height = 1500) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 30 } } })
    .jpeg({ quality: 80 })
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Leaky 1', Copyright: 'secret owner' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '23/1 48/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '90/1 24/1 0/1',
      },
    })
    .toBuffer();

export const png = (width = 400, height = 300) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 120, b: 200, alpha: 1 } } })
    .png()
    .toBuffer();

/** A text file someone renamed to holiday.jpg. */
export const textAsJpg = () =>
  Buffer.from('this is not an image, just text pretending to be one\n');

/** Minimal bytes with a PDF header (magic-byte check only). */
export const pdf = () =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'),
    Buffer.from('1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  ]);

export const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};
