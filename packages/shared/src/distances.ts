import { z } from "zod";
import { METERS_PER_MILE } from "./units";

/**
 * The race and record distances the app knows, shortest first: best efforts and personal bests today,
 * goals later. Labels ("1K", "Half") are the web app's; the wire carries the key.
 */
export const distanceKeySchema = z.enum([
  "1k",
  "1mi",
  "2mi",
  "5k",
  "5mi",
  "10k",
  "15k",
  "10mi",
  "20k",
  "half",
  "marathon",
]);
export type DistanceKey = z.infer<typeof distanceKeySchema>;

/** Every distance key in meters; the half and the marathon are World Athletics' road distances. */
export const DISTANCE_METERS: Readonly<Record<DistanceKey, number>> = {
  "1k": 1000,
  "1mi": METERS_PER_MILE,
  "2mi": 2 * METERS_PER_MILE,
  "5k": 5000,
  "5mi": 5 * METERS_PER_MILE,
  "10k": 10000,
  "15k": 15000,
  "10mi": 10 * METERS_PER_MILE,
  "20k": 20000,
  half: 21097.5,
  marathon: 42195,
};
