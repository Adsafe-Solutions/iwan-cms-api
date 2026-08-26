/* ⚠ Must stay in step with `COUNTRIES` in the site's src/config/countries.js —
   a code here the site does not know is content nothing will render. Lowercase
   ISO 3166-1 alpha-2. */
export const COUNTRY_CODES = ["in", "ca"];

export const isCountryCode = (code) => COUNTRY_CODES.includes(code);

/* Stored as `countries: [String]` where EMPTY means every country — easy to
   query and to render as checkboxes. The site's contract is different (a single
   code, a list, or absent for everywhere), and serialising back to that shape is
   what lets the CMS drop into `resolveContent` untouched. */
export const countryOf = (countries = []) => {
  if (!countries || countries.length === 0) return null;
  return countries.length === 1 ? countries[0] : [...countries];
};

/* "Belongs to this country": global (empty list) or naming the code. An
   unknown code means no filtering, which is what the admin listing wants. */
export const countryQuery = (code) => {
  if (!isCountryCode(code)) return {};
  return { $or: [{ countries: { $size: 0 } }, { countries: code }] };
};

export default COUNTRY_CODES;
