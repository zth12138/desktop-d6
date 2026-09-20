const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ICON_BYTES,
  XorShift32,
  composeGlitchedIcon,
  createGlitchPlan,
  pickSourceImages
} = require('../glitched-item');

function solidBitmap(blue, green, red, alpha = 255) {
  const bitmap = Buffer.alloc(ICON_BYTES);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = blue;
    bitmap[offset + 1] = green;
    bitmap[offset + 2] = red;
    bitmap[offset + 3] = alpha;
  }
  return bitmap;
}

test('xorshift 4,3,27 remains deterministic and unsigned', () => {
  const first = new XorShift32(0x12345678);
  const second = new XorShift32(0x12345678);
  const sequence = Array.from({ length: 8 }, () => first.next());
  assert.deepEqual(sequence, [
    0x8baf8bf6, 0x9bbee912, 0x022d3b9b, 0x1270a930,
    0x89eabeaa, 0x8ad4bf51, 0x91b65196, 0x5dc490fc
  ]);
  assert.deepEqual(sequence, Array.from({ length: 8 }, () => second.next()));
  assert.ok(sequence.every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff));
  assert.notEqual(new Set(sequence).size, 1);
});

test('bounded RNG consumes one value even when the bound is zero', () => {
  const bounded = new XorShift32(1234);
  const direct = new XorShift32(1234);
  assert.equal(bounded.nextBounded(0), 0);
  direct.next();
  assert.equal(bounded.next(), direct.next());
});

test('glitch plan has 64 valid blocks and preserves runs between changes', () => {
  const first = createGlitchPlan(0xdecafbad);
  const second = createGlitchPlan(0xdecafbad);
  assert.deepEqual(first.blocks, second.blocks);
  assert.equal(first.blocks.length, 64);
  assert.deepEqual(first.blocks.slice(0, 4), [
    { sourceTile: 0, sourceImage: 0, renderParamIndex: 0 },
    { sourceTile: 0, sourceImage: 1, renderParamIndex: 0 },
    { sourceTile: 1, sourceImage: 1, renderParamIndex: 0 },
    { sourceTile: 2, sourceImage: 1, renderParamIndex: 0 }
  ]);
  assert.equal(first.localRng.state, 0x8c945f7d);
  assert.ok(first.blocks.every(block =>
    block.sourceTile >= 0 && block.sourceTile < 64
    && block.sourceImage >= 0 && block.sourceImage < 4
    && block.renderParamIndex >= 0 && block.renderParamIndex < 4
  ));
  assert.ok(first.blocks.some((block, index) => index > 0
    && block.sourceImage === first.blocks[index - 1].sourceImage
    && block.sourceTile === first.blocks[index - 1].sourceTile + 1));
});

test('source selection retries invalid candidates and fills four slots', () => {
  const rng = new XorShift32(0x10203040);
  const valid = solidBitmap(10, 20, 30);
  const loaded = [];
  const result = pickSourceImages(rng, ['bad', 'good'], candidate => {
    loaded.push(candidate);
    if (candidate === 'bad') throw new Error('broken png');
    return valid;
  });
  assert.equal(result.images.length, 4);
  assert.equal(result.paths.length, 4);
  assert.ok(result.images.every(image => image === valid));
  assert.ok(loaded.includes('good'));
});

test('composition uses column-major tile coordinates', () => {
  const source = Buffer.alloc(ICON_BYTES);
  for (let tile = 0; tile < 64; tile++) {
    const tileX = tile >> 3;
    const tileY = tile & 7;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const offset = ((tileY * 4 + y) * 32 + tileX * 4 + x) * 4;
        source[offset] = tile;
        source[offset + 3] = 255;
      }
    }
  }
  const blocks = Array.from({ length: 64 }, (_, index) => ({
    sourceTile: 63 - index,
    sourceImage: 0,
    renderParamIndex: 0
  }));
  const output = composeGlitchedIcon(blocks, [source, source, source, source], [null]);
  const blueAt = (x, y) => output[(y * 32 + x) * 4];
  assert.equal(blueAt(0, 0), 63);
  assert.equal(blueAt(0, 4), 62);
  assert.equal(blueAt(4, 0), 55);
  assert.equal(blueAt(28, 28), 0);
});

test('color effects only affect selected blocks and preserve alpha', () => {
  const source = solidBitmap(20, 40, 60, 128);
  const blocks = Array.from({ length: 64 }, (_, index) => ({
    sourceTile: index,
    sourceImage: 0,
    renderParamIndex: index === 0 ? 1 : 0
  }));
  const colors = [null, {
    type: 'channel', channel: 0, primaryScale: 1.5, secondaryScale: 0.5, offset: 20
  }];
  const output = composeGlitchedIcon(blocks, [source, source, source, source], colors);
  assert.equal(output[3], 128);
  assert.notDeepEqual([...output.subarray(0, 3)], [...source.subarray(0, 3)]);
  const unaffectedOffset = (4 * 32) * 4;
  assert.deepEqual(
    [...output.subarray(unaffectedOffset, unaffectedOffset + 4)],
    [...source.subarray(unaffectedOffset, unaffectedOffset + 4)]
  );
});
