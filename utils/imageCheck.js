'use strict';

/**
 * Structural validation for card photographs.
 *
 * This exists because pdfkit's PNG decoder inflates image data inside a zlib
 * callback and rethrows there. That throw cannot be caught around the
 * doc.image() call, so a subtly corrupt photograph does not produce a broken
 * card -- it takes the whole process down, on every download, for as long as
 * the file sits on disk.
 *
 * So nothing reaches pdfkit unchecked. Inflating the image data here fails
 * synchronously, which is catchable, and the picture is rejected at enrolment
 * instead of becoming a crash later.
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 40e6;

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function bad(reason) {
  return { ok: false, reason };
}

function checkPng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return bad('not a PNG file');
  }

  let offset = 8;
  let header = null;
  const idat = [];
  let sawEnd = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (length > buffer.length || dataEnd + 4 > buffer.length) {
      return bad('truncated PNG chunk');
    }

    const declared = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer.subarray(offset + 4, dataEnd)) !== declared) {
      return bad(`corrupt PNG chunk (${type})`);
    }

    if (type === 'IHDR') {
      if (length !== 13) return bad('bad PNG header');
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!header) return bad('PNG has no header');
  if (!sawEnd) return bad('PNG is missing its end marker');
  if (!idat.length) return bad('PNG has no image data');
  if (!header.width || !header.height) return bad('PNG has no size');
  if (header.width * header.height > MAX_PIXELS) return bad('the photograph is too many pixels');
  if (header.interlace !== 0) return bad('interlaced PNGs are not supported on the card');

  // The check that matters: pdfkit will inflate this, and a bad adler32 here is
  // exactly the uncatchable crash described above.
  try {
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    if (!inflated.length) return bad('PNG image data is empty');
  } catch (err) {
    return bad('PNG image data is corrupt');
  }

  return { ok: true, format: 'png', width: header.width, height: header.height };
}

function checkJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return bad('not a JPEG file');
  }

  let offset = 2;
  let size = null;

  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // resynchronise over fill bytes
      continue;
    }
    const marker = buffer[offset + 1];

    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // end of image

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return bad('truncated JPEG segment');

    // Any start-of-frame marker carries the real dimensions.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      size = { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      break;
    }

    offset += 2 + length;
  }

  if (!size) return bad('JPEG has no frame header');
  if (!size.width || !size.height) return bad('JPEG has no size');
  if (size.width * size.height > MAX_PIXELS) return bad('the photograph is too many pixels');

  return { ok: true, format: 'jpeg', width: size.width, height: size.height };
}

/**
 * @param {Buffer} buffer
 * @param {string} [mimeType] when given, the bytes must match it
 */
function validateImage(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return bad('the photograph is empty');

  const looksPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const looksJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;

  if (mimeType === 'image/png' && !looksPng) return bad('the bytes are not a PNG');
  if (mimeType === 'image/jpeg' && !looksJpeg) return bad('the bytes are not a JPEG');

  if (looksPng) return checkPng(buffer);
  if (looksJpeg) return checkJpeg(buffer);
  return bad('only JPEG and PNG photographs can be printed on a card');
}

module.exports = { validateImage };
