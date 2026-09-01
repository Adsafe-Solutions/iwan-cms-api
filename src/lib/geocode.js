/* Address search for the CMS — turns what an editor types into a real place
   with coordinates, so nobody has to find a latitude by hand.

   ⚠ ONE PROVIDER, BEHIND ONE FUNCTION, deliberately. Photon is keyless, free
   and needs no account, which is why it is the default — but it reads
   OpenStreetMap, whose coverage of small Indian venues is thinner than
   Google's. Moving to Google Places or Mappls is a change to `search` below
   and NOTHING else: the route, the CMS field and the shape returned all stay
   as they are. That is the whole reason this file exists. */

const PHOTON = "https://photon.komoot.io/api";

/* A search HINT, not a filter — Photon ranks results near this point first.
   Bangalore rather than India's geographic centre, because that is where
   Iwan's venues are and a match in Madhya Pradesh is never the one meant. */
const BIAS = {
  in: [12.9716, 77.5946],
  ca: [43.6532, -79.3832],
};

/* Long enough that a stray keystroke does not spend a request, short enough
   that "IIM" or "MG Rd" still searches. */
export const MIN_QUERY = 3;

const RESULTS = 6;
const TIMEOUT_MS = 5000;

/* Photon returns POIs and plain addresses in the same list, with the parts
   split across properties. Joined here rather than in the browser so every
   provider ends up producing the same one-line address. */
const addressOf = (p = {}) => {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  return (
    [street, p.district, p.city, p.state, p.postcode, p.country]
      .filter(Boolean)
      /* ⚠ Deduped: Photon repeats the city as the district for a place that is
       its own district, which reads as "Bangalore, Bangalore, Karnataka". */
      .filter((part, i, all) => all.indexOf(part) === i)
      .join(", ")
  );
};

/* `label` is what the dropdown shows, `address` what lands in the field.
   They differ for a named place: the label leads with the venue's name so an
   editor can tell two branches apart, while the address stays postal. */
const normalise = (feature) => {
  const p = feature.properties ?? {};
  const [lng, lat] = feature.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const address = addressOf(p);
  if (!address && !p.name) return null;

  return {
    id: `${p.osm_type ?? "x"}${p.osm_id ?? `${lat},${lng}`}`,
    name: p.name ?? "",
    label: p.name && address ? `${p.name}, ${address}` : p.name || address,
    /* ⚠ The venue's NAME leads the address too when there is one — an Iwan
       hall's postal line alone does not say which building it is. */
    address: p.name && address ? `${p.name}, ${address}` : p.name || address,
    /* [lat, lng], the order the Event model stores and the site reads. Photon
       hands back GeoJSON, which is [lng, lat] — reversed here once so no
       caller has to remember. */
    coords: [Number(lat.toFixed(6)), Number(lng.toFixed(6))],
  };
};

export async function search(query, country) {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY) return [];

  const params = new URLSearchParams({ q, limit: String(RESULTS) });
  const bias = BIAS[country];
  if (bias) {
    params.set("lat", String(bias[0]));
    params.set("lon", String(bias[1]));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${PHOTON}?${params}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        /* Photon is a free service run as a courtesy; identifying the caller
           is the polite minimum its usage policy asks for. */
        "user-agent": "iwan-cms (https://iwan.community)",
      },
    });
    if (!res.ok) throw new Error(`Photon responded ${res.status}`);

    const body = await res.json();
    return (body.features ?? []).map(normalise).filter(Boolean);
  } catch (err) {
    /* ⚠ Never rethrow. Address search is an ASSIST — the editor can always
       type the address by hand, and the site falls back to searching that
       text. A geocoder being down must not stop an event being saved. */
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[geocode] search failed: ${err.name === "AbortError" ? `no response in ${TIMEOUT_MS}ms` : err.message}`
      );
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export default search;
