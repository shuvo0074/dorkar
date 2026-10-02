import {
  AttributeSchemaSchema,
  CatalogEvents,
  type AttributeSchema,
  type AttributeSpec,
  type NeedMode,
} from '@dorkar/contracts';
import { appendToOutbox, createEventFactory, type Migration } from '@dorkar/kernel';
import type { Kysely } from 'kysely';
import { categoryUpsertedPayload, type Category } from '../src/domain/category';
import type { CatalogDB } from '../src/infrastructure/db-schema';

/**
 * Reference category tree for Bangladesh. IDs are fixed (v7-format literals) so other services,
 * seeds and clients can refer to them; never change an ID once shipped — deactivate instead.
 * The `0192ca7a-0000-7000-8000-000000000XYY` pattern: X = top-level group, YY = child.
 */
const cid = (n: number) => `0192ca7a-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const label = (en: string, bn: string) => ({ en, bn });
const str = (en: string, bn: string, opts: { enum?: string[]; maxLength?: number } = {}) =>
  ({ type: 'string', label: label(en, bn), ...opts }) satisfies AttributeSpec;
const int = (en: string, bn: string, opts: { minimum?: number; maximum?: number; unit?: string }) =>
  ({ type: 'integer', label: label(en, bn), ...opts }) satisfies AttributeSpec;
const num = (en: string, bn: string, opts: { minimum?: number; maximum?: number; unit?: string }) =>
  ({ type: 'number', label: label(en, bn), ...opts }) satisfies AttributeSpec;
const bool = (en: string, bn: string) =>
  ({ type: 'boolean', label: label(en, bn) }) satisfies AttributeSpec;
const schema = (
  properties: Record<string, AttributeSpec>,
  required: string[] = [],
): AttributeSchema => AttributeSchemaSchema.parse({ properties, required });

const brand = (values: string[]) => str('Brand', 'ব্র্যান্ড', { enum: values });
const model = str('Model', 'মডেল', { maxLength: 80 });
const warranty = bool('Official warranty', 'অফিসিয়াল ওয়ারেন্টি');
const ramGb = int('RAM', 'র‍্যাম', { minimum: 1, maximum: 128, unit: 'GB' });
const storageGb = int('Storage', 'স্টোরেজ', { minimum: 1, maximum: 8192, unit: 'GB' });
const year = int('Year', 'সাল', { minimum: 1970, maximum: 2030 });
const mileageKm = int('Mileage', 'মাইলেজ', { minimum: 0, maximum: 2_000_000, unit: 'km' });
const eventType = str('Event type', 'অনুষ্ঠানের ধরন', {
  enum: ['Wedding', 'Holud', 'Birthday', 'Aqiqah', 'Corporate', 'Other'],
});
const quantityMin = int('Minimum order quantity', 'সর্বনিম্ন অর্ডার পরিমাণ', {
  minimum: 1,
  maximum: 10_000_000,
  unit: 'pcs',
});
const empty = schema({});

interface Seed {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  sort: number;
}

const group = (
  n: number,
  slug: string,
  nameEn: string,
  nameBn: string,
  modes: NeedMode[],
  children: Array<Omit<Seed, 'parentId' | 'sort' | 'id'> & { n: number }>,
): Seed[] => [
  { id: cid(n), parentId: null, slug, nameEn, nameBn, modes, attributeSchema: empty, sort: n },
  ...children.map(({ n: cn, ...c }, i) => ({ ...c, id: cid(cn), parentId: cid(n), sort: i + 1 })),
];

export const SEED_CATEGORIES: readonly Seed[] = [
  ...group(
    0x100,
    'electronics',
    'Electronics',
    'ইলেকট্রনিক্স',
    ['BUY', 'RENT', 'BORROW'],
    [
      {
        n: 0x101,
        slug: 'mobile-phones',
        nameEn: 'Mobile phones',
        nameBn: 'মোবাইল ফোন',
        modes: ['BUY', 'RENT', 'BORROW'],
        attributeSchema: schema(
          {
            brand: brand([
              'Samsung',
              'Apple',
              'Xiaomi',
              'Realme',
              'Oppo',
              'Vivo',
              'Infinix',
              'Tecno',
              'Symphony',
              'Walton',
              'OnePlus',
              'Google',
              'Nokia',
              'Motorola',
              'Other',
            ]),
            model,
            storageGb,
            ramGb,
            officialWarranty: warranty,
          },
          ['brand', 'model'],
        ),
      },
      {
        n: 0x102,
        slug: 'laptops',
        nameEn: 'Laptops',
        nameBn: 'ল্যাপটপ',
        modes: ['BUY', 'RENT', 'BORROW'],
        attributeSchema: schema(
          {
            brand: brand([
              'HP',
              'Dell',
              'Lenovo',
              'Asus',
              'Acer',
              'Apple',
              'MSI',
              'Walton',
              'Microsoft',
              'Other',
            ]),
            model,
            processor: str('Processor', 'প্রসেসর', { maxLength: 60 }),
            ramGb,
            storageGb,
            screenInch: num('Screen size', 'স্ক্রিন সাইজ', {
              minimum: 10,
              maximum: 20,
              unit: 'inch',
            }),
            officialWarranty: warranty,
          },
          ['brand'],
        ),
      },
    ],
  ),
  ...group(
    0x200,
    'vehicles',
    'Vehicles',
    'যানবাহন',
    ['BUY', 'RENT'],
    [
      {
        n: 0x201,
        slug: 'cars',
        nameEn: 'Cars',
        nameBn: 'গাড়ি',
        modes: ['BUY', 'RENT'],
        attributeSchema: schema(
          {
            brand: brand([
              'Toyota',
              'Honda',
              'Nissan',
              'Mitsubishi',
              'Suzuki',
              'Hyundai',
              'Kia',
              'Mazda',
              'Proton',
              'BMW',
              'Mercedes-Benz',
              'Other',
            ]),
            model,
            year,
            mileageKm,
            fuel: str('Fuel', 'জ্বালানি', {
              enum: ['Petrol', 'Diesel', 'Octane', 'CNG', 'Hybrid'],
            }),
            transmission: str('Transmission', 'গিয়ার', { enum: ['Manual', 'Automatic'] }),
          },
          ['brand', 'model', 'year'],
        ),
      },
      {
        n: 0x202,
        slug: 'motorbikes',
        nameEn: 'Motorbikes',
        nameBn: 'মোটরসাইকেল',
        modes: ['BUY', 'RENT'],
        attributeSchema: schema(
          {
            brand: brand([
              'Bajaj',
              'Hero',
              'Honda',
              'Yamaha',
              'Suzuki',
              'TVS',
              'Runner',
              'Walton',
              'Lifan',
              'Other',
            ]),
            model,
            year,
            engineCc: int('Engine', 'ইঞ্জিন', { minimum: 50, maximum: 1500, unit: 'cc' }),
            mileageKm,
          },
          ['brand', 'model'],
        ),
      },
    ],
  ),
  ...group(
    0x300,
    'home-living',
    'Home & living',
    'ঘর ও গৃহস্থালি',
    ['BUY', 'RENT', 'BORROW'],
    [
      {
        n: 0x301,
        slug: 'furniture',
        nameEn: 'Furniture',
        nameBn: 'আসবাবপত্র',
        modes: ['BUY', 'RENT'],
        attributeSchema: schema(
          {
            type: str('Type', 'ধরন', {
              enum: ['Bed', 'Sofa', 'Dining table', 'Wardrobe', 'Chair', 'Desk', 'Shelf', 'Other'],
            }),
            material: str('Material', 'উপাদান', {
              enum: ['Wood', 'Board', 'Steel', 'Plastic', 'Cane', 'Other'],
            }),
          },
          ['type'],
        ),
      },
      {
        n: 0x302,
        slug: 'home-appliances',
        nameEn: 'Home appliances',
        nameBn: 'গৃহস্থালি যন্ত্রপাতি',
        modes: ['BUY', 'RENT', 'BORROW'],
        attributeSchema: schema(
          {
            type: str('Type', 'ধরন', {
              enum: [
                'Refrigerator',
                'Washing machine',
                'Air conditioner',
                'Microwave oven',
                'Blender',
                'Fan',
                'Water purifier',
                'IPS',
                'Television',
                'Other',
              ],
            }),
            brand: str('Brand', 'ব্র্যান্ড', { maxLength: 60 }),
            officialWarranty: warranty,
          },
          ['type'],
        ),
      },
    ],
  ),
  ...group(
    0x400,
    'fashion',
    'Fashion',
    'ফ্যাশন',
    ['BUY', 'RENT'],
    [
      {
        n: 0x401,
        slug: 'clothing',
        nameEn: 'Clothing',
        nameBn: 'পোশাক',
        modes: ['BUY', 'RENT'],
        attributeSchema: schema(
          {
            type: str('Type', 'ধরন', {
              enum: [
                'Saree',
                'Salwar kameez',
                'Panjabi',
                'Shirt',
                'T-shirt',
                'Pants',
                'Sherwani',
                'Lehenga',
                'Other',
              ],
            }),
            gender: str('For', 'কার জন্য', { enum: ['Men', 'Women', 'Kids', 'Unisex'] }),
            size: str('Size', 'সাইজ', { enum: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Free size'] }),
          },
          ['type'],
        ),
      },
    ],
  ),
  ...group(
    0x500,
    'services',
    'Services',
    'সেবা',
    ['HIRE'],
    [
      {
        n: 0x501,
        slug: 'electrician',
        nameEn: 'Electrician',
        nameBn: 'ইলেকট্রিশিয়ান',
        modes: ['HIRE'],
        attributeSchema: schema({
          jobType: str('Job type', 'কাজের ধরন', {
            enum: ['Wiring', 'Repair', 'Installation', 'Inspection', 'Other'],
          }),
          urgent: bool('Urgent', 'জরুরি'),
        }),
      },
      {
        n: 0x502,
        slug: 'plumber',
        nameEn: 'Plumber',
        nameBn: 'প্লাম্বার',
        modes: ['HIRE'],
        attributeSchema: schema({
          jobType: str('Job type', 'কাজের ধরন', {
            enum: ['Leak repair', 'Pipe fitting', 'Bathroom fitting', 'Water pump', 'Other'],
          }),
          urgent: bool('Urgent', 'জরুরি'),
        }),
      },
      {
        n: 0x503,
        slug: 'ac-servicing',
        nameEn: 'AC servicing',
        nameBn: 'এসি সার্ভিসিং',
        modes: ['HIRE'],
        attributeSchema: schema(
          {
            serviceType: str('Service type', 'সেবার ধরন', {
              enum: ['Cleaning', 'Gas refill', 'Repair', 'Installation', 'Uninstallation'],
            }),
            acTon: num('AC capacity', 'এসির ক্ষমতা', { minimum: 0.5, maximum: 10, unit: 'ton' }),
            units: int('Number of units', 'ইউনিট সংখ্যা', { minimum: 1, maximum: 50 }),
          },
          ['serviceType'],
        ),
      },
      {
        n: 0x504,
        slug: 'photographer',
        nameEn: 'Photographer',
        nameBn: 'ফটোগ্রাফার',
        modes: ['HIRE'],
        attributeSchema: schema(
          {
            eventType,
            hours: int('Hours', 'ঘণ্টা', { minimum: 1, maximum: 24, unit: 'h' }),
            videography: bool('Videography', 'ভিডিওগ্রাফি'),
          },
          ['eventType'],
        ),
      },
      {
        n: 0x505,
        slug: 'tutor',
        nameEn: 'Tutor',
        nameBn: 'গৃহশিক্ষক',
        modes: ['HIRE'],
        attributeSchema: schema(
          {
            subject: str('Subject', 'বিষয়', {
              enum: [
                'Bangla',
                'English',
                'Mathematics',
                'Physics',
                'Chemistry',
                'Biology',
                'ICT',
                'Accounting',
                'Arabic',
                'All subjects',
                'Other',
              ],
            }),
            classLevel: str('Class level', 'শ্রেণি', {
              enum: [
                'Primary',
                'Class 6-8',
                'SSC',
                'HSC',
                'O Level',
                'A Level',
                'Admission',
                'University',
              ],
            }),
            medium: str('Medium', 'মাধ্যম', { enum: ['Bangla', 'English', 'English version'] }),
            daysPerWeek: int('Days per week', 'সপ্তাহে কত দিন', { minimum: 1, maximum: 7 }),
          },
          ['subject', 'classLevel'],
        ),
      },
      {
        n: 0x506,
        slug: 'driver',
        nameEn: 'Driver',
        nameBn: 'ড্রাইভার',
        modes: ['HIRE'],
        attributeSchema: schema(
          {
            vehicleType: str('Vehicle type', 'গাড়ির ধরন', {
              enum: ['Car', 'Microbus', 'Pickup', 'Truck', 'Bus'],
            }),
            duration: str('Duration', 'মেয়াদ', {
              enum: ['Hourly', 'Daily', 'Monthly', 'Permanent'],
            }),
          },
          ['vehicleType'],
        ),
      },
      {
        n: 0x507,
        slug: 'web-design',
        nameEn: 'Web & design',
        nameBn: 'ওয়েব ও ডিজাইন',
        modes: ['HIRE'],
        attributeSchema: schema({
          serviceType: str('Service type', 'সেবার ধরন', {
            enum: ['Website', 'Logo & branding', 'Social media design', 'Mobile app', 'Other'],
          }),
          deliveryDays: int('Delivery time', 'ডেলিভারির সময়', {
            minimum: 1,
            maximum: 365,
            unit: 'days',
          }),
        }),
      },
    ],
  ),
  ...group(
    0x600,
    'events',
    'Events',
    'অনুষ্ঠান',
    ['RENT', 'HIRE'],
    [
      {
        n: 0x601,
        slug: 'chairs-tents',
        nameEn: 'Chairs & tents',
        nameBn: 'চেয়ার ও প্যান্ডেল',
        modes: ['RENT'],
        attributeSchema: schema(
          {
            item: str('Item', 'আইটেম', {
              enum: ['Chairs', 'Tables', 'Tent / shamiana', 'Stage', 'Lighting', 'Generator'],
            }),
            quantity: int('Quantity', 'পরিমাণ', { minimum: 1, maximum: 10_000, unit: 'pcs' }),
            setupIncluded: bool('Setup included', 'সেটআপসহ'),
          },
          ['item'],
        ),
      },
      {
        n: 0x602,
        slug: 'decoration',
        nameEn: 'Decoration',
        nameBn: 'সাজসজ্জা',
        modes: ['HIRE', 'RENT'],
        attributeSchema: schema({ eventType, theme: str('Theme', 'থিম', { maxLength: 80 }) }, [
          'eventType',
        ]),
      },
    ],
  ),
  ...group(
    0x700,
    'sourcing',
    'Sourcing',
    'সোর্সিং',
    ['SOURCE'],
    [
      {
        n: 0x701,
        slug: 'bags-packaging',
        nameEn: 'Bags & packaging',
        nameBn: 'ব্যাগ ও প্যাকেজিং',
        modes: ['SOURCE'],
        attributeSchema: schema(
          {
            material: str('Material', 'উপাদান', { enum: ['Jute', 'Cotton', 'Paper', 'Plastic'] }),
            quantityMin,
            printed: bool('Custom printed', 'কাস্টম প্রিন্টেড'),
            size: str('Size', 'সাইজ', { maxLength: 60 }),
          },
          ['material', 'quantityMin'],
        ),
      },
      {
        n: 0x702,
        slug: 'garments',
        nameEn: 'Garments',
        nameBn: 'গার্মেন্টস',
        modes: ['SOURCE'],
        attributeSchema: schema(
          {
            productType: str('Product type', 'পণ্যের ধরন', {
              enum: [
                'T-shirt',
                'Polo shirt',
                'Shirt',
                'Denim',
                'Knitwear',
                'Sweater',
                'Uniform',
                'Other',
              ],
            }),
            fabric: str('Fabric', 'কাপড়', { maxLength: 60 }),
            quantityMin,
          },
          ['productType', 'quantityMin'],
        ),
      },
      {
        n: 0x703,
        slug: 'printing',
        nameEn: 'Printing',
        nameBn: 'প্রিন্টিং',
        modes: ['SOURCE'],
        attributeSchema: schema(
          {
            printType: str('Print type', 'প্রিন্টের ধরন', {
              enum: [
                'Business cards',
                'Flyers',
                'Banners',
                'Stickers',
                'Packaging',
                'Books',
                'Other',
              ],
            }),
            quantity: int('Quantity', 'পরিমাণ', { minimum: 1, maximum: 10_000_000, unit: 'pcs' }),
            colors: str('Colours', 'রং', { enum: ['1 colour', '2 colours', 'Full colour'] }),
          },
          ['printType'],
        ),
      },
    ],
  ),
];

export const m0002SeedCategories: Migration = {
  name: '0002_seed_categories',
  async up(trx) {
    const db = trx as unknown as Kysely<CatalogDB>;
    const event = createEventFactory('catalog');
    // Parents come first in SEED_CATEGORIES, so the FK holds row by row.
    const rows = await db
      .insertInto('categories')
      .values(
        SEED_CATEGORIES.map((c) => ({
          id: c.id,
          parent_id: c.parentId,
          slug: c.slug,
          name_en: c.nameEn,
          name_bn: c.nameBn,
          modes: c.modes,
          attribute_schema: JSON.stringify(c.attributeSchema),
          sort: c.sort,
          active: true,
        })),
      )
      .returningAll()
      .execute();
    // Announce the tree so demand/matching can build their projections from the stream.
    await appendToOutbox(
      trx,
      rows.map((r) => {
        const c: Category = {
          id: r.id,
          parentId: r.parent_id,
          slug: r.slug,
          nameEn: r.name_en,
          nameBn: r.name_bn,
          modes: r.modes,
          attributeSchema: r.attribute_schema,
          sort: r.sort,
          active: r.active,
          version: r.version,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
        return event(CatalogEvents.CategoryUpserted, c.id, categoryUpsertedPayload(c));
      }),
    );
  },
  async down(trx) {
    const db = trx as unknown as Kysely<CatalogDB>;
    const ids = SEED_CATEGORIES.map((c) => c.id);
    await db
      .deleteFrom('categories')
      .where('id', 'in', ids)
      .where('parent_id', 'is not', null)
      .execute();
    await db.deleteFrom('categories').where('id', 'in', ids).execute();
  },
};
