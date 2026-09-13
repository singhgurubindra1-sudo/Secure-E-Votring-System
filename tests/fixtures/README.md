# Test fixtures

Small images for the card photograph paths. None of them are photographs of a
person -- they are flat gradients.

| File | What it is | Used for |
| --- | --- | --- |
| `photo.png` | valid 8x8 PNG | the happy path |
| `photo.jpg` | valid 16x16 JPEG | the format the enrolment page actually produces |
| `corrupt.png` | 1x1 PNG with a bad IDAT checksum | the regression below |

`corrupt.png` is the widely copied "1x1 transparent PNG" whose deflate stream
fails its adler32 check. pdfkit's decoder rethrows that from inside a zlib
callback, so it cannot be caught around the `doc.image()` call and takes the
whole process down. `utils/imageCheck.js` exists to reject it at enrolment
instead, and the tests keep it that way.
