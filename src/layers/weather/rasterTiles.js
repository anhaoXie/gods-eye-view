/**
 * The level at which one tile covers `tileSize` source pixels exactly.
 *
 * Tiles below it would draw more source pixels than the tile has room for and
 * throw detail away; tiles above it only magnify the same pixels. Computing it
 * from the texture means a larger source image is displayed at its true
 * resolution instead of being downsampled.
 * @param {number} textureWidth
 * @param {number} tileSize
 * @returns {number}
 */
export function nativeTileLevel(textureWidth, tileSize = 256) {
  const ratio = Number(textureWidth) / Number(tileSize);
  if (!Number.isFinite(ratio) || ratio <= 1) return 0;
  // Floor, not round: this is the deepest level that still has at least one
  // source pixel per output pixel. Rounding up would magnify instead.
  return Math.floor(Math.log2(ratio));
}

/** Tile a bounded decoded canvas without network requests or scene state. */
export function createRasterTileProvider({
  cesium,
  texture,
  credit,
  createCanvas,
  rectangle = cesium.Rectangle.MAX_VALUE,
  tilingScheme = new cesium.GeographicTilingScheme({ rectangle }),
  tileSize = 256,
  // After tileSize, because destructuring defaults evaluate left to right.
  maximumLevel = nativeTileLevel(texture?.width, tileSize),
}) {
  return {
    tilingScheme,
    rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const tile = createCanvas();
      tile.width = tile.height = tileSize;
      const ctx = tile.getContext('2d');
      const width =
        texture.width / tilingScheme.getNumberOfXTilesAtLevel(level);
      const height =
        texture.height / tilingScheme.getNumberOfYTilesAtLevel(level);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        texture,
        x * width,
        y * height,
        width,
        height,
        0,
        0,
        tileSize,
        tileSize,
      );
      // ImageryLayer consumes requestImage results as promises.
      return Promise.resolve(tile);
    },
  };
}
