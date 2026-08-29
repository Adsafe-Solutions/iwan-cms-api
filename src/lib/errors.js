/* middleware/error.js turns an HttpError into its status and anything else
   into a 500, so routes just throw and never build a response by hand. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (details) this.details = details;
  }
}

export const badRequest = (message = "Bad request", details) =>
  new HttpError(400, message, details);

export const unauthorized = (message = "Not signed in") => new HttpError(401, message);

export const forbidden = (message = "Not allowed") => new HttpError(403, message);

export const notFound = (message = "Not found") => new HttpError(404, message);

/* ⚠ Express 4 does not forward a rejected promise from an async handler — it
   hangs the request. Every async route is wrapped so errors reach the
   handler. */
export const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default HttpError;
