/**
 * components/Globe/CableOverlay.jsx
 * ===================================
 * Submarine cable GeoJSON parsing utility and cable-loading hook.
 *
 * This module does NOT render any DOM — it exposes a helper function that
 * converts raw TeleGeography GeoJSON into the flat path array expected by
 * globe.gl's `pathsData` API.
 *
 * The actual fetch + globe update is done inside Globe.jsx so that the
 * loading-indicator state stays co-located with the globe instance.
 *
 * Exports
 * -------
 * parseCableGeoJSON(geojson) → Array<{ coords, color, name }>
 */

/**
 * Flatten a TeleGeography cable GeoJSON FeatureCollection into the flat
 * segment array that globe.gl's pathsData API expects.
 *
 * Each MultiLineString feature is split into its individual LineString
 * segments; segments with fewer than 2 points are silently discarded.
 *
 * @param {object} geojson  – raw parsed GeoJSON object
 * @returns {Array<{ coords: Array, color: string, name: string }>}
 */
export function parseCableGeoJSON(geojson) {
  const paths = [];
  for (const feature of geojson.features) {
    const { color, name }        = feature.properties;
    const { type, coordinates }  = feature.geometry;

    if (type === "MultiLineString") {
      for (const segment of coordinates) {
        if (segment.length >= 2) paths.push({ coords: segment, color, name });
      }
    } else if (type === "LineString") {
      if (coordinates.length >= 2) paths.push({ coords: coordinates, color, name });
    }
  }
  return paths;
}
