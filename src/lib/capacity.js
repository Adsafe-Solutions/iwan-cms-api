import { Registration } from "../models/Registration.js";

/* ⚠ The ONE definition of which registrations use up a place. The submit-time
   check and the public "full" flag must agree, or the site would offer a button
   the API then refuses (or the reverse). Cancelled and waitlisted don't count. */
export const COUNTED_STATUSES = ["new", "confirmed"];

export const hasCap = (event) => Number.isFinite(event.spots) && event.spots > 0;

/* ⚠ Below this many places left, the site says how many. Above it the count
   stays private — "37 spots left" is just a leak, not a nudge. */
export const LOW_SPOTS = 5;

/* Places remaining for each capped event in the list, keyed by id. Uncapped
   events are absent. One aggregate for the whole list, so a page of cards costs
   a single extra query. */
export async function spotsLeft(events) {
  const capped = events.filter(hasCap);
  const left = new Map();
  if (capped.length === 0) return left;

  const counts = await Registration.aggregate([
    {
      $match: {
        event: { $in: capped.map((e) => e._id) },
        status: { $in: COUNTED_STATUSES },
      },
    },
    { $group: { _id: "$event", taken: { $sum: 1 } } },
  ]);

  const taken = new Map(counts.map((c) => [String(c._id), c.taken]));
  for (const e of capped) {
    left.set(String(e._id), Math.max(0, e.spots - (taken.get(String(e._id)) ?? 0)));
  }
  return left;
}
