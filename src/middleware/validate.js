import { badRequest } from "../lib/errors.js";

/* Parses `req.body` and REPLACES it with the result, so a route only sees
   checked, trimmed, defaulted values. `partial` is what PATCH uses: every key
   optional, so an update can send one field without restating the rest. */
export const validate =
  (schema, { partial = false } = {}) =>
  (req, _res, next) => {
    const shape = partial ? schema.partial() : schema;
    const result = shape.safeParse(req.body ?? {});
    if (!result.success) return next(result.error);

    if (partial && Object.keys(result.data).length === 0) {
      return next(badRequest("Nothing to update"));
    }

    req.body = result.data;
    return next();
  };

export default validate;
