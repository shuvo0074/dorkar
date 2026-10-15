import { z } from 'zod';
import { Districts, Divisions, type District, type Division } from './places';

export { Districts, Divisions, type District, type Division };

const districtKeys = Object.keys(Districts) as [District, ...District[]];
const divisionKeys = Object.keys(Divisions) as [Division, ...Division[]];

/** Location as stored and exchanged. Division is derived from the district, never trusted. */
export const LocationSchema = z
  .object({
    division: z.enum(divisionKeys).optional(),
    district: z.enum(districtKeys),
    area: z.string().trim().min(1).max(80).optional(),
  })
  .transform((l) => ({ ...l, division: Districts[l.district].division }));
export type Location = z.output<typeof LocationSchema>;
export const DistrictSchema = z.enum(districtKeys);
