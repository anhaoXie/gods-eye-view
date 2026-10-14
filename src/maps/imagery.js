import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

const ESRI_WORLD_IMAGERY_PATH = '/ArcGIS/rest/services/World_Imagery/MapServer';

// `server.` and `services.` are both official Esri front doors for the same
// World_Imagery service, but some networks can only reach one of them. Try them
// in order so a blocked host does not silently drop the basemap to OSM.
export const ESRI_IMAGERY_HOSTS = Object.freeze([
  'https://server.arcgisonline.com',
  'https://services.arcgisonline.com',
]);

export async function createEsriImagery() {
  let lastError = null;
  for (const host of ESRI_IMAGERY_HOSTS) {
    try {
      return await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        `${host}${ESRI_WORLD_IMAGERY_PATH}`,
        {
          credit:
            'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          enablePickFeatures: false,
        },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No reachable Esri World Imagery endpoint');
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}
