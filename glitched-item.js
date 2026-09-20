'use strict';

const ICON_SIZE = 32;
const TILE_SIZE = 4;
const TILE_COUNT = 64;
const BYTES_PER_PIXEL = 4;
const ICON_BYTES = ICON_SIZE * ICON_SIZE * BYTES_PER_PIXEL;

class XorShift32 {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    let state = this.state;
    state ^= state >>> 4;
    state ^= (state << 3) >>> 0;
    state ^= state >>> 27;
    this.state = state >>> 0;
    return this.state;
  }

  nextBounded(bound) {
    const value = this.next();
    return bound > 0 ? value % bound : 0;
  }
}

function deriveColorSeed(seed) {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return value || 0x6d2b79f5;
}

function generateGlitchBlocks(localRng, colorRng) {
  let sourceTile = 0;
  if (localRng.next() % 5 === 0) sourceTile = localRng.next() & 63;

  let sourceImage = 0;
  let renderParamIndex = 0;
  if (localRng.next() % 5 === 0) {
    renderParamIndex = colorRng.nextBounded(3) + 1;
  }

  const blocks = [];
  for (let blockIndex = 0; blockIndex < TILE_COUNT; blockIndex++) {
    blocks.push({ sourceTile, sourceImage, renderParamIndex });
    sourceTile++;

    if (localRng.next() % 12 === 0) {
      renderParamIndex = localRng.next() & 3;
    }

    let changeSource;
    if (sourceTile >= TILE_COUNT) {
      changeSource = true;
    } else {
      changeSource = localRng.next() % 12 === 0;
    }

    if (changeSource) {
      sourceImage = (sourceImage + 1) % 4;
      sourceTile = blockIndex;
      if (localRng.next() % 20 === 0) sourceTile = blockIndex + 1;

      renderParamIndex = 0;
      if (localRng.next() % 5 === 0) {
        renderParamIndex = localRng.nextBounded(3) + 1;
      }
    }
  }
  return blocks;
}

function randomFraction(rng) {
  return rng.next() / 0xffffffff;
}

function createColorParams(colorRng) {
  return [
    null,
    {
      type: 'channel',
      channel: colorRng.nextBounded(3),
      primaryScale: 1.2 + randomFraction(colorRng) * 0.55,
      secondaryScale: 0.45 + randomFraction(colorRng) * 0.35,
      offset: 20 + colorRng.nextBounded(45)
    },
    {
      type: 'hue',
      degrees: colorRng.nextBounded(360),
      saturationScale: 0.9 + randomFraction(colorRng) * 0.45,
      valueScale: 0.9 + randomFraction(colorRng) * 0.25
    },
    {
      type: 'corrupt',
      rotation: colorRng.nextBounded(2) + 1,
      invert: colorRng.nextBounded(2) === 0,
      mix: 0.55 + randomFraction(colorRng) * 0.3
    }
  ];
}

function createGlitchPlan(seed) {
  const localRng = new XorShift32(seed);
  const colorRng = new XorShift32(deriveColorSeed(seed));
  const blocks = generateGlitchBlocks(localRng, colorRng);
  const colorParams = createColorParams(colorRng);
  return { blocks, colorParams, localRng };
}

function validBitmap(bitmap) {
  return (Buffer.isBuffer(bitmap) || bitmap instanceof Uint8Array) && bitmap.length === ICON_BYTES;
}

function pickSourceImages(rng, candidates, loadImage, slotCount = 4, retryCount = 10) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('No collectible images are available.');
  }

  const images = [];
  const paths = [];
  for (let slot = 0; slot < slotCount; slot++) {
    let selectedImage;
    let selectedPath;

    for (let retry = 0; retry < retryCount; retry++) {
      const candidate = candidates[rng.nextBounded(candidates.length)];
      try {
        const image = loadImage(candidate);
        if (validBitmap(image)) {
          selectedImage = image;
          selectedPath = candidate;
          break;
        }
      } catch {}
    }

    if (!selectedImage && images.length > 0) {
      const fallback = slot % images.length;
      selectedImage = images[fallback];
      selectedPath = paths[fallback];
    }

    if (!selectedImage) {
      for (const candidate of candidates) {
        try {
          const image = loadImage(candidate);
          if (validBitmap(image)) {
            selectedImage = image;
            selectedPath = candidate;
            break;
          }
        } catch {}
      }
    }

    if (!selectedImage) throw new Error('No valid 32x32 collectible image could be loaded.');
    images.push(selectedImage);
    paths.push(selectedPath);
  }

  return { images, paths };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }

  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h, s, v) {
  const sector = Math.floor(h * 6);
  const fraction = h * 6 - sector;
  const p = v * (1 - s);
  const q = v * (1 - fraction * s);
  const t = v * (1 - (1 - fraction) * s);
  const options = [
    [v, t, p], [q, v, p], [p, v, t],
    [p, q, v], [t, p, v], [v, p, q]
  ];
  return options[sector % 6].map(channel => channel * 255);
}

function applyColorEffect(r, g, b, effect) {
  if (!effect) return [r, g, b];

  if (effect.type === 'channel') {
    const channels = [r, g, b];
    return channels.map((channel, index) => index === effect.channel
      ? clampByte(channel * effect.primaryScale + effect.offset)
      : clampByte(channel * effect.secondaryScale));
  }

  if (effect.type === 'hue') {
    let [hue, saturation, value] = rgbToHsv(r, g, b);
    hue = (hue + effect.degrees / 360) % 1;
    saturation = Math.min(1, saturation * effect.saturationScale);
    value = Math.min(1, value * effect.valueScale);
    return hsvToRgb(hue, saturation, value).map(clampByte);
  }

  if (effect.type === 'corrupt') {
    const original = [r, g, b];
    const rotated = effect.rotation === 1 ? [g, b, r] : [b, r, g];
    const altered = effect.invert ? rotated.map(channel => 255 - channel) : rotated;
    return original.map((channel, index) => clampByte(
      channel * (1 - effect.mix) + altered[index] * effect.mix
    ));
  }

  return [r, g, b];
}

function copyPixel(source, sourceOffset, output, outputOffset, effect) {
  if (!effect) {
    for (let channel = 0; channel < BYTES_PER_PIXEL; channel++) {
      output[outputOffset + channel] = source[sourceOffset + channel];
    }
    return;
  }

  const alpha = source[sourceOffset + 3];
  if (alpha === 0) return;

  const unpremultiply = alpha < 255 ? 255 / alpha : 1;
  const blue = clampByte(source[sourceOffset] * unpremultiply);
  const green = clampByte(source[sourceOffset + 1] * unpremultiply);
  const red = clampByte(source[sourceOffset + 2] * unpremultiply);
  const [nextRed, nextGreen, nextBlue] = applyColorEffect(red, green, blue, effect);
  const premultiply = alpha / 255;

  output[outputOffset] = clampByte(nextBlue * premultiply);
  output[outputOffset + 1] = clampByte(nextGreen * premultiply);
  output[outputOffset + 2] = clampByte(nextRed * premultiply);
  output[outputOffset + 3] = alpha;
}

function composeGlitchedIcon(blocks, sourceImages, colorParams) {
  if (!Array.isArray(blocks) || blocks.length !== TILE_COUNT) {
    throw new Error(`Expected ${TILE_COUNT} glitch blocks.`);
  }
  if (!Array.isArray(sourceImages) || sourceImages.length < 4 || sourceImages.some(image => !validBitmap(image))) {
    throw new Error('Expected four 32x32 BGRA source images.');
  }

  const output = Buffer.alloc(ICON_BYTES);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (!Number.isInteger(block.sourceTile) || block.sourceTile < 0 || block.sourceTile >= TILE_COUNT) {
      throw new Error(`Invalid source tile at block ${blockIndex}.`);
    }
    if (!Number.isInteger(block.sourceImage) || block.sourceImage < 0 || block.sourceImage >= sourceImages.length) {
      throw new Error(`Invalid source image at block ${blockIndex}.`);
    }

    const source = sourceImages[block.sourceImage];
    const sourceTileX = block.sourceTile >> 3;
    const sourceTileY = block.sourceTile & 7;
    const destinationTileX = blockIndex >> 3;
    const destinationTileY = blockIndex & 7;
    const effect = colorParams[block.renderParamIndex] || null;

    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const sourceX = sourceTileX * TILE_SIZE + x;
        const sourceY = sourceTileY * TILE_SIZE + y;
        const destinationX = destinationTileX * TILE_SIZE + x;
        const destinationY = destinationTileY * TILE_SIZE + y;
        const sourceOffset = (sourceY * ICON_SIZE + sourceX) * BYTES_PER_PIXEL;
        const destinationOffset = (destinationY * ICON_SIZE + destinationX) * BYTES_PER_PIXEL;
        copyPixel(source, sourceOffset, output, destinationOffset, effect);
      }
    }
  }
  return output;
}

module.exports = {
  ICON_BYTES,
  ICON_SIZE,
  TILE_COUNT,
  XorShift32,
  composeGlitchedIcon,
  createGlitchPlan,
  deriveColorSeed,
  generateGlitchBlocks,
  pickSourceImages
};
