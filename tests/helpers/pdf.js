'use strict';

/**
 * Helpers for asserting on a generated PDF.
 *
 * pdfkit compresses its content streams and writes text as hex-encoded `TJ`
 * arrays with kerning offsets mixed in, e.g.
 *   [<56> 90 <6f74657220636172> 20 <64> 0] TJ
 * so reading the text back means inflating each stream and stitching the hex
 * runs of every text-showing operator together.
 */

const zlib = require('zlib');
const { Writable } = require('stream');

/** Collects streamVoterCard's output into a single Buffer. */
function renderToBuffer(render) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      render(sink);
    } catch (err) {
      reject(err);
    }
  });
}

/** Inflates every stream object in the file and returns them joined. */
function contentStreams(pdf) {
  const latin = pdf.toString('latin1');
  const marker = /stream\r?\n/g;
  let out = '';
  let match;

  while ((match = marker.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = pdf.subarray(start, end);
    try {
      out += zlib.inflateSync(raw).toString('latin1');
    } catch {
      out += raw.toString('latin1');
    }
  }
  return out;
}

/** All visible text in the document, joined with newlines per operator. */
function extractText(pdf) {
  const content = contentStreams(pdf);
  const lines = [];

  // Hex TJ arrays: [<hex> kern <hex> ...] TJ
  for (const [, body] of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const text = [...body.matchAll(/<([0-9a-fA-F]*)>/g)]
      .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
      .join('');
    if (text) lines.push(text);
  }

  // Literal-string form, in case a glyph run is not kerned.
  for (const [, body] of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
    const text = body.replace(/\\([()\\])/g, '$1');
    if (text) lines.push(text);
  }

  return lines.join('\n');
}

module.exports = { renderToBuffer, contentStreams, extractText };
