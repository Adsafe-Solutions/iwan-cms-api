/* ⚠ This list must stay in step with `COUNTRIES` in the public site's
   src/config/countries.js — the codes are the contract between the two, and a
   code here that the site does not know is content nothing will ever render.

   Codes are lowercase ISO 3166-1 alpha-2, same as the site's content folders. */
export const COUNTRY_CODES = ["in", "ca"];

export const isCountryCode = (code) => COUNTRY_CODES.includes(code);

/* How a country is stored vs how it is served.

   In Mongo every document carries `countries: [String]`, and an EMPTY array
   means "every country" — one representation, easy to query and easy to render
   as a set of checkboxes in the admin.

   The public site's existing contract is different: `country` is a single code,
   a list of codes, or null/absent for everywhere (see content/base/events.js).
   Serialising back to that shape is what lets the CMS drop into `resolveContent`
   without touching a single component. */
export const countryOf = (countries = []) => {
  if (!countries || countries.length === 0) return null;
  return countries.length === 1 ? countries[0] : [...countries];
};

/* The Mongo filter for "belongs to this country" — the document is global
   (empty list) or names the code. An unknown/absent code means no filtering,
   which is what the admin listing wants. */
export const countryQuery = (code) => {
  if (!isCountryCode(code)) return {};
  return { $or: [{ countries: { $size: 0 } }, { countries: code }] };
};

export default COUNTRY_CODES;
