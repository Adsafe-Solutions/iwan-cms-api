import { badRequest } from "../lib/errors.js";

/* Parses `req.body` through a Zod schema and REPLACES it with the parsed
   result, so a route only ever sees values that have already been checked,
   trimmed and defaulted. A failure throws a ZodError, which middleware/error.js
   turns into a 400 listing the offending fields.

   `partial` is what PATCH uses: the same schema with every key optional, so an
   update can send one field without restating the whole document. */
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
